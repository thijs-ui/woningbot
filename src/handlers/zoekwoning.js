const { parseSearchQuery } = require('../services/claude-parser');
const { selectProperties } = require('../services/claude-selector');
const { searchIdealista, enrichListingsWithDetails } = require('../services/idealista-direct');
// const { searchThinkSpain } = require('../services/thinkspain');  // Temporarily disabled
const { searchSupabase } = require('../services/supabase-search');
const { embed: embedQuery, isConfigured: isEmbeddingConfigured } = require('../services/openai-embeddings');
const { buildSoftQueryInput } = require('../services/embedding-input');
const { expandLocations: expandCityAliases } = require('../services/location-aliases');
const { analyzeSelectedPhotos } = require('../services/claude-vision');
const { deduplicateListings } = require('../services/dedup');
const { preFilterListings, postValidateSelections, filterThinkSpainByType } = require('../services/property-filter');
const { setThread } = require('../store/thread-memory');
const {
  buildResultBlocks,
  splitBlocks,
  buildConfirmationBlocks,
  buildErrorBlocks,
  buildNoResultsBlocks,
} = require('../formatters/slack-blocks');

/**
 * Update the status message in Slack. Silent on failure.
 */
async function updateStatus(client, channelId, ts, statusText) {
  if (!ts) return;
  try {
    await client.chat.update({
      channel: channelId,
      ts,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: statusText } }],
      text: statusText.replace(/[*_~`]/g, ''),
    });
  } catch (e) { /* ignore update failure */ }
}

async function handleZoekwoning({ command, ack, respond, client }) {
  await ack();

  const queryText = command.text?.trim();
  const channelId = command.channel_id;
  const userId = command.user_id;
  const ts = new Date().toISOString();

  console.log(`[${ts}] [ZoekWoning] New search from ${userId}: "${queryText}"`);

  if (!queryText) {
    await respond({
      blocks: buildErrorBlocks(
        'Geef een zoekopdracht op. Bijvoorbeeld:\n' +
        '`/zoekwoning villa in Estepona of Mijas, budget 800k-1.2M, 3 slaapkamers, modern, zwembad`\n' +
        '`/zoekwoning nieuwbouw appartement Costa del Sol, 2 slpk, max 300k`'
      ),
      response_type: 'ephemeral',
    });
    return;
  }

  // Step 1: Send initial confirmation
  let confirmMsg;
  try {
    confirmMsg = await client.chat.postMessage({
      channel: channelId,
      blocks: buildConfirmationBlocks(),
      text: 'Zoekopdracht ontvangen, ik ga aan de slag...',
    });
  } catch (err) {
    console.error(`[${ts}] [ZoekWoning] Failed to send confirmation:`, err.message);
    await respond({
      blocks: buildConfirmationBlocks(),
      text: 'Zoekopdracht ontvangen...',
      response_type: 'in_channel',
    });
  }

  const threadTs = confirmMsg?.ts;

  try {
    // ─── Step 2: Parse with Claude ─────────────────────────────────────
    await updateStatus(client, channelId, threadTs,
      ':mag: *Stap 1/6* — Zoekopdracht analyseren met AI...');

    let clientProfile;
    try {
      clientProfile = await parseSearchQuery(queryText);
    } catch (parseErr) {
      console.error(`[${ts}] [ZoekWoning] Parse failed:`, parseErr.message);
      await updateStatus(client, channelId, threadTs,
        ':x: Kon de zoekopdracht niet begrijpen. Probeer het opnieuw met een duidelijkere omschrijving.');
      return;
    }

    const hardFilters = clientProfile.hard_filters || {};

    // Expandeer locaties naar bekende varianten (Javea ↔ Xàbia, Alicante ↔ Alacant)
    if (Array.isArray(hardFilters.locations) && hardFilters.locations.length > 0) {
      const before = hardFilters.locations;
      hardFilters.locations = expandCityAliases(before);
      if (hardFilters.locations.length > before.length) {
        console.log(`[${ts}] [ZoekWoning] Locaties uitgebreid: ${JSON.stringify(before)} → ${JSON.stringify(hardFilters.locations)}`);
      }
    }

    const locations = hardFilters.locations || [];
    const neighborhoods = hardFilters.neighborhoods || [];
    const locationStr = locations.length > 0 ? locations.join(', ') : 'onbekend';
    const isNewBuild = hardFilters.is_new_build;

    await updateStatus(client, channelId, threadTs,
      `:white_check_mark: *Begrepen:* ${clientProfile.search_summary || queryText}\n` +
      `:round_pushpin: Locatie(s): ${locationStr}${neighborhoods.length > 0 ? ` (wijken: ${neighborhoods.join(', ')})` : ''}${isNewBuild ? ' (incl. nieuwbouw)' : ''}\n\n` +
      `:mag: *Stap 2/6* — Zoeken op Idealista en Costa Select database...`);

    // ─── Step 3: Scrape all portals in parallel ────────────────────────
    console.log(`[${ts}] [ZoekWoning] Scraping portals for ${locationStr}...`);

    const errors = [];

    // Soft-criteria → embedding (Fase 5.1). Faalt stilletjes; zonder embedding
    // valt searchSupabase terug op legacy ranking (prijs ASC).
    let queryEmbedding = null;
    const softQueryText = buildSoftQueryInput(clientProfile.soft_criteria);
    if (softQueryText && isEmbeddingConfigured()) {
      try {
        queryEmbedding = await embedQuery(softQueryText);
        console.log(`[${ts}] [ZoekWoning] Soft query embedded (${queryEmbedding.length}d)`);
      } catch (embErr) {
        console.warn(`[${ts}] [ZoekWoning] Embedding failed: ${embErr.message}`);
      }
    }

    const [idealistaListings, supabaseListings] = await Promise.allSettled([
      searchIdealista(hardFilters),
      searchSupabase(hardFilters, { queryEmbedding }),
    ]).then(([idealista, supabase]) => {
      const idealistaResult = idealista.status === 'fulfilled' ? idealista.value : [];
      const supabaseResult  = supabase.status  === 'fulfilled' ? supabase.value  : [];

      if (idealista.status === 'rejected') {
        errors.push('Idealista');
        console.error(`[${ts}] Idealista failed:`, idealista.reason?.message);
      }
      if (supabase.status === 'rejected') {
        errors.push('Costa Select database');
        console.error(`[${ts}] Supabase failed:`, supabase.reason?.message);
      }

      return [idealistaResult, supabaseResult];
    });

    // ThinkSpain temporarily disabled
    const thinkspainListings = [];

    // Combine and deduplicate
    const allRaw = [...idealistaListings, ...supabaseListings, ...thinkspainListings];

    const stats = {
      totalScraped:   allRaw.length,
      idealistaCount: idealistaListings.length,
      supabaseCount:  supabaseListings.length,
      thinkspainCount: thinkspainListings.length,
    };

    await updateStatus(client, channelId, threadTs,
      `:white_check_mark: *Stap 2/6 klaar* — ${allRaw.length} woningen gevonden\n` +
      `Idealista: ${stats.idealistaCount} | Costa Select: ${stats.supabaseCount}\n\n` +
      (errors.length > 0 ? `:warning: ${errors.join(' en ')} gaf een fout\n\n` : '') +
      `:broom: *Stap 3/6* — Duplicaten verwijderen en filteren...`);

    if (allRaw.length === 0) {
      if (errors.length > 0) {
        await updateStatus(client, channelId, threadTs,
          `:x: Er ging iets mis bij het zoeken op ${errors.join(', ')}. Probeer het over een paar minuten opnieuw.`);
      } else {
        await updateOrPost(client, channelId, threadTs, buildNoResultsBlocks());
      }
      return;
    }

    // Deduplicate
    const deduplicated = deduplicateListings(allRaw);

    // Fix #1 & #5: Pre-filter — programmatically enforce hard filters BEFORE Claude
    const allProperties = preFilterListings(deduplicated, hardFilters);

    console.log(`[${ts}] [ZoekWoning] ${allRaw.length} raw → ${deduplicated.length} deduped → ${allProperties.length} after hard filter. Sending to Claude...`);

    if (allProperties.length === 0) {
      await updateOrPost(client, channelId, threadTs, buildNoResultsBlocks());
      return;
    }

    // ─── Step 4: AI selection ──────────────────────────────────────────
    await updateStatus(client, channelId, threadTs,
      `:white_check_mark: ${allProperties.length} woningen na deduplicatie en filtering\n\n` +
      `:robot_face: *Stap 4/6* — AI selecteert de beste matches...`);

    // Fix #12: Add neighborhood context to Claude selector
    const profileForClaude = { ...clientProfile };
    if (neighborhoods.length > 0) {
      profileForClaude.neighborhood_context =
        `De klant zoekt SPECIFIEK in de wijk(en): ${neighborhoods.join(', ')}. ` +
        `Geef STERKE voorkeur aan woningen in of nabij deze wijken. ` +
        `Vermeld in de motivatie of de woning in de gewenste wijk ligt.`;
    }

    let selectionResult;
    try {
      selectionResult = await selectProperties(profileForClaude, allProperties);
    } catch (selErr) {
      console.error(`[${ts}] [ZoekWoning] Selection failed:`, selErr.message);
      await updateStatus(client, channelId, threadTs,
        ':x: De AI-selectie is mislukt. Probeer het opnieuw.');
      return;
    }

    // Fix #1: Post-validate — reject any selections that violate hard filters
    const rawSelections = selectionResult.selections || [];
    const selections = postValidateSelections(rawSelections, allProperties, hardFilters);

    if (selections.length === 0) {
      await updateOrPost(client, channelId, threadTs, buildNoResultsBlocks());
      if (threadTs) {
        setThread(threadTs, {
          client_profile: clientProfile,
          all_properties: compactPropertiesForStorage(allProperties),
          current_selection: [],
          photo_assessments: {},
          conversation_history: [],
          channel_id: channelId,
          original_query: queryText,
          created_at: Date.now(),
        });
      }
      return;
    }

    // ─── Step 5: Detail scrape for selected properties ─────────────────
    await updateStatus(client, channelId, threadTs,
      `:white_check_mark: *${selections.length} matches geselecteerd*\n\n` +
      `:page_facing_up: *Stap 5/6* — Details ophalen van geselecteerde woningen...`);

    // Fix #7: Actually call the detail scrape
    try {
      const selectedProps = selections.map(s =>
        allProperties.find(p => p.id === s.property_id || p.url === s.property_id || String(p.id) === String(s.property_id))
      ).filter(Boolean);

      await enrichListingsWithDetails(selectedProps, 8);
      console.log(`[${ts}] [ZoekWoning] Detail scrape complete for ${selectedProps.length} properties`);
    } catch (detailErr) {
      console.warn(`[${ts}] [ZoekWoning] Detail scrape failed (non-fatal):`, detailErr.message);
    }

    // ─── Step 6: Photo analysis ────────────────────────────────────────
    await updateStatus(client, channelId, threadTs,
      `:camera: *Stap 6/6* — Foto's analyseren...`);

    let photoAssessments = new Map();
    try {
      photoAssessments = await analyzeSelectedPhotos(selections, allProperties);
    } catch (photoErr) {
      console.error(`[${ts}] [ZoekWoning] Photo analysis failed:`, photoErr.message);
    }

    // ─── Send formatted results ────────────────────────────────────────
    const blocks = buildResultBlocks(selections, allProperties, clientProfile, stats, photoAssessments);
    const chunks = splitBlocks(blocks);

    for (let i = 0; i < chunks.length; i++) {
      if (i === 0 && threadTs) {
        try {
          await client.chat.update({
            channel: channelId,
            ts: threadTs,
            blocks: chunks[i],
            text: `WoningBot — ${selections.length} matches gevonden`,
          });
        } catch (updateErr) {
          console.error(`[${ts}] Update failed, posting new:`, updateErr.message);
          await client.chat.postMessage({
            channel: channelId,
            blocks: chunks[i],
            text: `WoningBot — ${selections.length} matches gevonden`,
          });
        }
      } else {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs || undefined,
          blocks: chunks[i],
          text: 'WoningBot resultaten (vervolg)',
        });
      }
    }

    // Fix #6: Store compact thread data (only selected properties, not all 300+)
    const photoAssessmentsObj = {};
    for (const [key, value] of photoAssessments) {
      photoAssessmentsObj[key] = value;
    }

    if (threadTs) {
      setThread(threadTs, {
        client_profile: clientProfile,
        all_properties: compactPropertiesForStorage(allProperties),
        current_selection: selections,
        photo_assessments: photoAssessmentsObj,
        conversation_history: [],
        channel_id: channelId,
        original_query: queryText,
        created_at: Date.now(),
      });
    }

    // Note about partial errors
    if (errors.length > 0) {
      const working = ['Idealista', 'ThinkSpain'].filter(s => !errors.includes(s));
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs || undefined,
        text: `Let op: ${errors.join(' en ')} gaf een fout. Resultaten komen van ${working.join(' en ')}.`,
      });
    }

    console.log(`[${ts}] [ZoekWoning] Done! ${selections.length} matches sent.`);

  } catch (error) {
    const now = new Date().toISOString();
    console.error(`[${now}] [ZoekWoning] Unexpected error:`, error);
    try {
      await updateOrPost(client, channelId, ts,
        buildErrorBlocks('Er ging iets mis bij het zoeken. Probeer het over een paar minuten opnieuw.'));
    } catch (sendErr) {
      console.error(`[${now}] Failed to send error:`, sendErr.message);
    }
  }
}

/**
 * Compact properties for thread storage (Fix #6).
 * Only keep essential fields, drop full descriptions to save memory/disk.
 */
function compactPropertiesForStorage(properties) {
  return properties.map(p => ({
    id: p.id,
    title: p.title,
    price: p.price,
    property_type: p.property_type,
    location: p.location,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    size_m2: p.size_m2,
    features: p.features,
    url: p.url,
    source: p.source,
    thumbnail: p.thumbnail,
    is_new_build: p.is_new_build,
    municipality: p.municipality,
    // Drop: description, full_description, images, agent info — saves ~70% storage
  }));
}

async function updateOrPost(client, channelId, ts, blocks) {
  if (ts) {
    try {
      await client.chat.update({ channel: channelId, ts, blocks, text: 'WoningBot' });
      return;
    } catch (e) { /* fall through to post */ }
  }
  await client.chat.postMessage({ channel: channelId, blocks, text: 'WoningBot' });
}

module.exports = { handleZoekwoning };
