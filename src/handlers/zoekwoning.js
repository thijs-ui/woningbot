const { parseSearchQuery } = require('../services/claude-parser');
const { selectProperties } = require('../services/claude-selector');
const { searchIdealista } = require('../services/idealista-direct');
const { searchThinkSpain } = require('../services/thinkspain');
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
    // Step 2: Parse with Claude
    await updateStatus(client, channelId, threadTs,
      ':mag: *Stap 1/5* — Zoekopdracht analyseren met AI...');

    let clientProfile;
    try {
      clientProfile = await parseSearchQuery(queryText);
    } catch (parseErr) {
      console.error(`[${ts}] [ZoekWoning] Parse failed:`, parseErr.message);
      await updateStatus(client, channelId, threadTs,
        ':x: Kon de zoekopdracht niet begrijpen. Probeer het opnieuw met een duidelijkere omschrijving.');
      return;
    }

    const locations = clientProfile.hard_filters?.locations || [];
    const locationStr = locations.length > 0 ? locations.join(', ') : 'onbekend';
    const isNewBuild = clientProfile.hard_filters?.is_new_build;

    await updateStatus(client, channelId, threadTs,
      `:white_check_mark: *Begrepen:* ${clientProfile.search_summary || queryText}\n` +
      `:round_pushpin: Locatie(s): ${locationStr}${isNewBuild ? ' (incl. nieuwbouw)' : ''}\n\n` +
      `:mag: *Stap 2/5* — Zoeken op Idealista + ThinkSpain...`);

    // Step 3: Scrape all portals in parallel with progressive updates
    console.log(`[${ts}] [ZoekWoning] Scraping portals for ${locationStr}...`);

    const portalResults = { idealista: null, thinkspain: null };
    const errors = [];

    // Start both portals in parallel
    const idealistaPromise = searchIdealista(clientProfile.hard_filters)
      .then(r => { portalResults.idealista = r; return r; })
      .catch(err => { errors.push('Idealista'); console.error(`[${ts}] Idealista failed:`, err.message); return []; });

    const thinkspainPromise = searchThinkSpain(clientProfile.hard_filters)
      .then(r => { portalResults.thinkspain = r; return r; })
      .catch(err => { errors.push('ThinkSpain'); console.error(`[${ts}] ThinkSpain failed:`, err.message); return []; });

    // Progressive update: check every 10s which portals are done
    const allPromise = Promise.all([idealistaPromise, thinkspainPromise]);
    const progressInterval = setInterval(async () => {
      const parts = [];
      if (portalResults.idealista !== null) parts.push(`Idealista: ${portalResults.idealista.length}`);
      if (portalResults.thinkspain !== null) parts.push(`ThinkSpain: ${portalResults.thinkspain.length}`);

      const done = parts.length;
      const waiting = 2 - done;

      if (done > 0 && waiting > 0) {
        await updateStatus(client, channelId, threadTs,
          `:mag: *Stap 2/5* — Portals doorzoeken...\n` +
          `:white_check_mark: ${parts.join(' | ')}\n` +
          `:hourglass_flowing_sand: Nog ${waiting} portal(s) bezig...`);
      }
    }, 10000);

    const [idealistaListings, thinkspainListings] = await allPromise;
    clearInterval(progressInterval);

    // Combine and deduplicate
    const allRaw = [...idealistaListings, ...thinkspainListings];

    const stats = {
      totalScraped: allRaw.length,
      idealistaCount: idealistaListings.length,
      thinkspainCount: thinkspainListings.length,
    };

    await updateStatus(client, channelId, threadTs,
      `:white_check_mark: *Stap 2/5 klaar* — ${allRaw.length} woningen gevonden\n` +
      `Idealista: ${stats.idealistaCount} | ThinkSpain: ${stats.thinkspainCount}\n\n` +
      (errors.length > 0 ? `:warning: ${errors.join(' en ')} gaf een fout\n\n` : '') +
      `:broom: *Stap 3/5* — Duplicaten verwijderen...`);

    if (allRaw.length === 0) {
      if (errors.length > 0) {
        await updateStatus(client, channelId, threadTs,
          `:x: Er ging iets mis bij het zoeken op ${errors.join(', ')}. Probeer het over een paar minuten opnieuw.`);
      } else {
        await updateOrPost(client, channelId, threadTs, buildNoResultsBlocks());
      }
      return;
    }

    const allProperties = deduplicateListings(allRaw);

    console.log(`[${ts}] [ZoekWoning] ${allProperties.length} unique properties after dedup. Sending to Claude...`);

    // Step 4: AI selection
    await updateStatus(client, channelId, threadTs,
      `:white_check_mark: ${allProperties.length} unieke woningen na deduplicatie\n\n` +
      `:robot_face: *Stap 4/5* — AI selecteert de beste matches...`);

    let selectionResult;
    try {
      selectionResult = await selectProperties(clientProfile, allProperties);
    } catch (selErr) {
      console.error(`[${ts}] [ZoekWoning] Selection failed:`, selErr.message);
      await updateStatus(client, channelId, threadTs,
        ':x: De AI-selectie is mislukt. Probeer het opnieuw.');
      return;
    }

    const selections = selectionResult.selections || [];

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

    // Step 5: Photo analysis
    await updateStatus(client, channelId, threadTs,
      `:white_check_mark: *${selections.length} matches geselecteerd*\n\n` +
      `:camera: *Stap 5/5* — Foto's analyseren...`);

    let photoAssessments = new Map();
    try {
      photoAssessments = await analyzeSelectedPhotos(selections, allProperties);
    } catch (photoErr) {
      console.error(`[${ts}] [ZoekWoning] Photo analysis failed:`, photoErr.message);
    }

    // Step 6: Send formatted results
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

    // Store thread data for refinement
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
      await updateOrPost(client, channelId, threadTs,
        buildErrorBlocks('Er ging iets mis bij het zoeken. Probeer het over een paar minuten opnieuw.'));
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
