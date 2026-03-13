const { parseSearchQuery } = require('../services/claude-parser');
const { selectProperties } = require('../services/claude-selector');
const { searchIdealista } = require('../services/idealista');
const { searchFotocasa } = require('../services/fotocasa');
const { searchKyero } = require('../services/kyero');
const { analyzeSelectedPhotos } = require('../services/claude-vision');
const { deduplicateListings } = require('../services/dedup');
const { setThread } = require('../store/thread-memory');
const {
  buildResultBlocks,
  splitBlocks,
  buildConfirmationBlocks,
  buildErrorBlocks,
  buildNoResultsBlocks,
} = require('../formatters/slack-blocks');

async function handleZoekwoning({ command, ack, respond, client }) {
  // Step 1: Acknowledge immediately (within 3s)
  await ack();

  const queryText = command.text?.trim();
  const channelId = command.channel_id;
  const userId = command.user_id;
  const ts = new Date().toISOString();

  console.log(`[${ts}] [ZoekWoning] New search from ${userId}: "${queryText}"`);

  if (!queryText) {
    await respond({
      blocks: buildErrorBlocks('Geef een zoekopdracht op. Bijvoorbeeld:\n`/zoekwoning villa in Estepona, budget 800k-1.2M, 3 slaapkamers, modern, zwembad`'),
      response_type: 'ephemeral',
    });
    return;
  }

  // Step 2: Send confirmation
  let confirmMsg;
  try {
    confirmMsg = await client.chat.postMessage({
      channel: channelId,
      blocks: buildConfirmationBlocks(),
      text: '🔍 Ik ga zoeken op Idealista, Fotocasa en Kyero. Even geduld...',
    });
  } catch (err) {
    console.error(`[${ts}] [ZoekWoning] Failed to send confirmation:`, err.message);
    await respond({
      blocks: buildConfirmationBlocks(),
      text: '🔍 Ik ga zoeken...',
      response_type: 'in_channel',
    });
  }

  const threadTs = confirmMsg?.ts;

  try {
    // Step 3: Parse with Claude (hard filters + soft criteria)
    console.log(`[${ts}] [ZoekWoning] Parsing with Claude...`);
    let clientProfile;
    try {
      clientProfile = await parseSearchQuery(queryText);
    } catch (parseErr) {
      console.error(`[${ts}] [ZoekWoning] Parse failed:`, parseErr.message);
      await updateOrPost(client, channelId, threadTs,
        buildErrorBlocks('Kon de zoekopdracht niet begrijpen. Probeer het opnieuw met een duidelijkere omschrijving.'));
      return;
    }

    // Step 4: Update status — scraping
    try {
      if (threadTs) {
        await client.chat.update({
          channel: channelId,
          ts: threadTs,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `🔍 *Zoekopdracht begrepen:* ${clientProfile.search_summary || queryText}\n\n⏳ Bezig met zoeken op Idealista, Fotocasa en Kyero...` } }],
          text: 'Bezig met zoeken...',
        });
      }
    } catch (e) { /* ignore update failure */ }

    // Step 5: Scrape all portals in parallel
    console.log(`[${ts}] [ZoekWoning] Scraping portals...`);
    const errors = [];
    const [idealistaResult, fotocasaResult, kyeroResult] = await Promise.allSettled([
      searchIdealista(clientProfile.hard_filters),
      searchFotocasa(clientProfile.hard_filters),
      searchKyero(clientProfile.hard_filters),
    ]);

    let idealistaListings = [];
    let fotocasaListings = [];
    let kyeroListings = [];

    if (idealistaResult.status === 'fulfilled') {
      idealistaListings = idealistaResult.value;
    } else {
      errors.push('Idealista');
      console.error(`[${ts}] [ZoekWoning] Idealista failed:`, idealistaResult.reason?.message);
    }

    if (fotocasaResult.status === 'fulfilled') {
      fotocasaListings = fotocasaResult.value;
    } else {
      errors.push('Fotocasa');
      console.error(`[${ts}] [ZoekWoning] Fotocasa failed:`, fotocasaResult.reason?.message);
    }

    if (kyeroResult.status === 'fulfilled') {
      kyeroListings = kyeroResult.value;
    } else {
      errors.push('Kyero');
      console.error(`[${ts}] [ZoekWoning] Kyero failed:`, kyeroResult.reason?.message);
    }

    // Combine and deduplicate
    const allRaw = [...idealistaListings, ...fotocasaListings, ...kyeroListings];

    if (allRaw.length === 0) {
      if (errors.length > 0) {
        await updateOrPost(client, channelId, threadTs,
          buildErrorBlocks(`Er ging iets mis bij het zoeken op ${errors.join(', ')}. Probeer het over een paar minuten opnieuw.`));
      } else {
        await updateOrPost(client, channelId, threadTs, buildNoResultsBlocks());
      }
      return;
    }

    const allProperties = deduplicateListings(allRaw);
    const stats = {
      totalScraped: allProperties.length,
      idealistaCount: idealistaListings.length,
      fotocasaCount: fotocasaListings.length,
      kyeroCount: kyeroListings.length,
    };

    console.log(`[${ts}] [ZoekWoning] ${allProperties.length} unique properties. Sending to Claude for selection...`);

    // Step 6: Update status — AI selection
    try {
      if (threadTs) {
        await client.chat.update({
          channel: channelId,
          ts: threadTs,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `🔍 *${allProperties.length} woningen gevonden* (Idealista: ${stats.idealistaCount}, Fotocasa: ${stats.fotocasaCount}, Kyero: ${stats.kyeroCount})\n\n🤖 AI selecteert de beste matches...` } }],
          text: 'AI selecteert...',
        });
      }
    } catch (e) { /* ignore */ }

    // Step 7: AI selection
    let selectionResult;
    try {
      selectionResult = await selectProperties(clientProfile, allProperties);
    } catch (selErr) {
      console.error(`[${ts}] [ZoekWoning] Selection failed:`, selErr.message);
      await updateOrPost(client, channelId, threadTs,
        buildErrorBlocks('De AI-selectie is mislukt. Probeer het opnieuw.'));
      return;
    }

    const selections = selectionResult.selections || [];

    // Handle 0 good matches
    if (selections.length === 0) {
      await updateOrPost(client, channelId, threadTs, buildNoResultsBlocks());
      if (threadTs) {
        setThread(threadTs, {
          client_profile: clientProfile,
          all_properties: allProperties,
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

    // Step 8: Light photo analysis on selected properties
    console.log(`[${ts}] [ZoekWoning] Running photo analysis on ${selections.length} selected properties...`);
    try {
      if (threadTs) {
        await client.chat.update({
          channel: channelId,
          ts: threadTs,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `🤖 *${selections.length} matches geselecteerd*\n\n📸 Foto's worden geanalyseerd...` } }],
          text: 'Foto-analyse...',
        });
      }
    } catch (e) { /* ignore */ }

    let photoAssessments = new Map();
    try {
      photoAssessments = await analyzeSelectedPhotos(selections, allProperties);
    } catch (photoErr) {
      console.error(`[${ts}] [ZoekWoning] Photo analysis failed:`, photoErr.message);
      // Continue without photo analysis — it's a nice-to-have
    }

    // Step 9: Send formatted results
    const blocks = buildResultBlocks(selections, allProperties, clientProfile, stats, photoAssessments);
    const chunks = splitBlocks(blocks);

    for (let i = 0; i < chunks.length; i++) {
      if (i === 0 && threadTs) {
        try {
          await client.chat.update({
            channel: channelId,
            ts: threadTs,
            blocks: chunks[i],
            text: `🏠 WoningBot — ${selections.length} matches gevonden`,
          });
        } catch (updateErr) {
          console.error(`[${ts}] Update failed, posting new:`, updateErr.message);
          await client.chat.postMessage({
            channel: channelId,
            blocks: chunks[i],
            text: `🏠 WoningBot — ${selections.length} matches gevonden`,
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

    // Store thread data for refinement (including photo assessments)
    const photoAssessmentsObj = {};
    for (const [key, value] of photoAssessments) {
      photoAssessmentsObj[key] = value;
    }

    if (threadTs) {
      setThread(threadTs, {
        client_profile: clientProfile,
        all_properties: allProperties,
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
      const working = ['Idealista', 'Fotocasa', 'Kyero'].filter(s => !errors.includes(s));
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs || undefined,
        text: `ℹ️ Let op: ${errors.join(' en ')} gaf een fout. Resultaten komen van ${working.join(' en ')}.`,
      });
    }

    console.log(`[${ts}] [ZoekWoning] Done! ${selections.length} matches sent with photo analysis.`);

  } catch (error) {
    const now = new Date().toISOString();
    console.error(`[${now}] [ZoekWoning] Unexpected error:`, error);
    try {
      await updateOrPost(client, channelId, threadTs,
        buildErrorBlocks('Er ging iets mis bij het zoeken. Probeer het over een paar minuten opnieuw. Als het blijft falen, neem contact op met de beheerder.'));
    } catch (sendErr) {
      console.error(`[${now}] Failed to send error:`, sendErr.message);
    }
  }
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
