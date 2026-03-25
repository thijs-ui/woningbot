/**
 * /project Slack command handler — Project information via Supabase + Tavily.
 *
 * Combines:
 *   - Supabase: concrete units with prices, sizes, features (from weekly scrape)
 *   - Tavily: background info from the web (developer, status, facilities, etc.)
 *
 * Usage:
 *   /project The View Marbella
 *   /project Residencial Albatros Estepona
 *   /project Sierra Blanca Tower Málaga
 *
 * Follow-up in thread:
 *   "Wat zijn de prijzen voor 3 slaapkamers?"
 *   "Wie is de ontwikkelaar?"
 */

const Anthropic = require('@anthropic-ai/sdk');
const { claudeRetry } = require('../services/claude-retry');
const { searchProjectInfo, summarizeProjectInfo } = require('../services/project-info');
const supabase = require('../services/supabase');
const { setThread, addConversation } = require('../store/thread-memory');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

const PROJECT_THREAD_PROMPT = `Je bent de ProjectBot van Costa Select, een Nederlandse makelaar in Spanje.
Je hebt eerder informatie opgezocht over een specifiek nieuwbouwproject via het internet en de Costa Select database.

Je taak:
1. Beantwoord vervolgvragen over dit project op basis van de eerder gevonden informatie
2. Als er concrete units/woningen beschikbaar zijn, geef die met prijs, slaapkamers, m² en features
3. Als de consultant naar iets vraagt dat niet in de bronnen staat, zeg dat eerlijk
4. Geef concrete, bruikbare antwoorden in het Nederlands
5. Verzin GEEN informatie — als je het niet weet, zeg dat

Formatteer je antwoord voor Slack:
- Gebruik *bold* voor nadruk
- Gebruik bullet points voor lijsten
- Vermeld bronnen met links waar relevant
- Houd antwoorden beknopt maar volledig`;

/**
 * Handle the /project slash command.
 */
async function handleProject({ command, ack, client }) {
  await ack();

  const query = (command.text || '').trim();
  const channelId = command.channel_id;
  const userId = command.user_id;
  const ts = new Date().toISOString();

  console.log(`[${ts}] [Project] Query from ${userId}: "${query}"`);

  if (!query) {
    await client.chat.postMessage({
      channel: channelId,
      text: ':mag: *ProjectBot — Gebruik:*\n\n' +
        '`/project The View Marbella` — Info over een specifiek project\n' +
        '`/project Residencial Albatros Estepona` — Zoek alles wat online staat\n\n' +
        'Na resultaten kun je in de thread vervolgvragen stellen.',
    });
    return;
  }

  // The query IS the project name — no intent detection needed
  const projectName = query;

  // Send initial status
  let statusMsg;
  try {
    statusMsg = await client.chat.postMessage({
      channel: channelId,
      text: `:mag: *ProjectBot — ${projectName}*\n\n` +
        `:hourglass_flowing_sand: Database en internet doorzoeken...`,
    });
  } catch (e) {
    console.error(`[${ts}] [Project] Failed to send status:`, e.message);
  }

  const threadTs = statusMsg?.ts;

  try {
    // ─── Run Supabase + Tavily in parallel ───────────────────────────

    const [supabaseResult, tavilyResult] = await Promise.allSettled([
      // Supabase: find project and its units
      supabase.isConfigured()
        ? supabase.findProject(projectName)
        : Promise.resolve({ listings: [], units: [], matched: false }),

      // Tavily: search the web for background info
      searchProjectInfo(projectName).catch(err => {
        console.error(`[${ts}] [Project] Tavily search failed:`, err.message);
        return { results: [], raw_context: '', source_count: 0, idealista_results: [], idealista_count: 0 };
      }),
    ]);

    const dbResult = supabaseResult.status === 'fulfilled'
      ? supabaseResult.value
      : { listings: [], units: [], matched: false };

    const tavilyData = tavilyResult.status === 'fulfilled'
      ? tavilyResult.value
      : { results: [], raw_context: '', source_count: 0, idealista_results: [], idealista_count: 0 };

    const webSources = tavilyData.results || [];

    console.log(`[${ts}] [Project] Supabase: ${dbResult.listings.length} listings, ${dbResult.units.length} units | Tavily: ${webSources.length} sources`);

    const idealistaCount = (tavilyData.idealista_count || 0);

    if (dbResult.listings.length === 0 && webSources.length === 0) {
      const noResultText = `:mag: *ProjectBot — ${projectName}*\n\n` +
        `:x: Geen informatie gevonden over "${projectName}".\n\n` +
        `_Tip: controleer de spelling of probeer een andere naam._`;

      if (threadTs) {
        try { await client.chat.update({ channel: channelId, ts: threadTs, text: noResultText }); } catch (e) { /* ignore */ }
      } else {
        await client.chat.postMessage({ channel: channelId, text: noResultText });
      }
      return;
    }

    // ─── Build context for Claude ────────────────────────────────────

    // Format Supabase data
    let dbContext = '';
    if (dbResult.matched && dbResult.listings.length > 0) {
      dbContext = '\n\n=== COSTA SELECT DATABASE (actuele data) ===\n\n';

      for (const listing of dbResult.listings) {
        const features = [];
        if (listing.has_swimming_pool) features.push('zwembad');
        if (listing.has_terrace) features.push('terras');
        if (listing.has_garden) features.push('tuin');
        if (listing.has_parking) features.push('parking');
        if (listing.has_lift) features.push('lift');
        if (listing.has_air_conditioning) features.push('airco');
        if (listing.has_storage_room) features.push('berging');

        dbContext += `Project: ${listing.title}\n`;
        dbContext += `Gemeente: ${listing.municipality}${listing.district ? `, ${listing.district}` : ''}\n`;
        dbContext += `Adres: ${listing.address || 'Niet vermeld'}\n`;
        if (listing.price) dbContext += `Vanaf prijs: €${Number(listing.price).toLocaleString('nl-NL')}\n`;
        if (listing.agency_name) dbContext += `Agency/Ontwikkelaar: ${listing.agency_name}\n`;
        if (features.length > 0) dbContext += `Features: ${features.join(', ')}\n`;
        dbContext += `URL: ${listing.url}\n`;
        if (listing.description) {
          const desc = listing.description.substring(0, 500);
          dbContext += `Beschrijving: ${desc}${listing.description.length > 500 ? '...' : ''}\n`;
        }
        dbContext += '\n';
      }

      // Add units
      if (dbResult.units.length > 0) {
        dbContext += `\n--- Beschikbare woningen (${dbResult.units.length} units) ---\n\n`;

        for (const unit of dbResult.units) {
          const unitFeatures = [];
          if (unit.has_terrace) unitFeatures.push('terras');
          if (unit.has_garden) unitFeatures.push('tuin');
          if (unit.parking_included_in_price) unitFeatures.push('parking incl.');
          if (unit.is_exterior) unitFeatures.push('buitenzijde');

          dbContext += `• ${unit.typology || 'Woning'}: €${Number(unit.price || 0).toLocaleString('nl-NL')} | ` +
            `${unit.rooms || '?'} slpk | ${unit.size_m2 || '?'}m²` +
            `${unit.floor ? ` | Verd. ${unit.floor}` : ''}` +
            `${unitFeatures.length > 0 ? ` | ${unitFeatures.join(', ')}` : ''}\n`;
        }
      }
    }

    // Format Tavily data
    let webContext = '';
    if (webSources.length > 0) {
      webContext = '\n\n=== INTERNET BRONNEN ===\n\n';
      const idealista = webSources.filter(s => s.url && s.url.includes('idealista.com'));
      const other = webSources.filter(s => !s.url || !s.url.includes('idealista.com'));

      for (const source of [...idealista, ...other]) {
        const label = source.url && source.url.includes('idealista.com') ? '[Idealista]' : '[Web]';
        webContext += `${label} ${source.title || 'Bron'}\n`;
        webContext += `URL: ${source.url || ''}\n`;
        if (source.content) {
          const content = source.content.substring(0, 800);
          webContext += `${content}${source.content.length > 800 ? '...' : ''}\n`;
        }
        webContext += '\n';
      }
    }

    // ─── Update status ───────────────────────────────────────────────

    await updateStatus(client, channelId, threadTs,
      `:mag: *ProjectBot — ${projectName}*\n\n` +
      `:white_check_mark: ${dbResult.units.length > 0 ? `${dbResult.units.length} units in database` : 'Database doorzocht'}` +
      ` | ${webSources.length} webbronnen\n\n` +
      `:robot_face: Samenvatting maken...`);

    // ─── Summarize with Claude ───────────────────────────────────────

    const fullContext = dbContext + webContext;

    const summary = await summarizeProjectInfo(projectName, fullContext, webSources.length + (dbResult.matched ? 1 : 0), query);

    // ─── Build final message ─────────────────────────────────────────

    const sourceParts = [];
    if (dbResult.units.length > 0) sourceParts.push(`${dbResult.units.length} units in database`);
    if (webSources.length > 0) sourceParts.push(`${webSources.length} webbronnen`);
    const sourceNote = sourceParts.join(' + ');

    const finalText = `:mag: *ProjectBot — ${projectName}*\n` +
      `_${sourceNote}_\n\n` +
      `${summary}\n\n` +
      `_:speech_balloon: Stel vervolgvragen in deze thread._`;

    if (threadTs) {
      try {
        await client.chat.update({ channel: channelId, ts: threadTs, text: finalText });
      } catch (e) {
        await client.chat.postMessage({ channel: channelId, text: finalText });
      }
    } else {
      await client.chat.postMessage({ channel: channelId, text: finalText });
    }

    // Store thread data for follow-up questions
    if (threadTs) {
      setThread(threadTs, {
        type: 'project',
        project_name: projectName,
        sources: webSources,
        db_units: dbResult.units.length,
        raw_context: summary,
        full_context: fullContext,
        source_count: webSources.length,
        conversation_history: [],
        channel_id: channelId,
        original_query: query,
        created_at: Date.now(),
      });
    }

    console.log(`[${ts}] [Project] Done for "${projectName}" (${dbResult.units.length} DB units, ${webSources.length} web sources)`);

  } catch (error) {
    console.error(`[${ts}] [Project] Failed:`, error);

    const errorMsg = `:mag: *ProjectBot — ${projectName}*\n\n` +
      `:warning: Kon geen informatie ophalen: ${error.message}\n\n` +
      `_Tip: controleer of TAVILY_API_KEY en SUPABASE_ANON_KEY zijn ingesteld._`;

    if (threadTs) {
      try { await client.chat.update({ channel: channelId, ts: threadTs, text: errorMsg }); } catch (e) { /* ignore */ }
    } else {
      await client.chat.postMessage({ channel: channelId, text: errorMsg });
    }
  }
}

/**
 * Helper to update status messages.
 */
async function updateStatus(client, channelId, threadTs, text) {
  if (threadTs) {
    try {
      await client.chat.update({ channel: channelId, ts: threadTs, text });
    } catch (e) { /* ignore */ }
  }
}

/**
 * Handle follow-up questions in /project threads.
 */
async function handleProjectThreadReply(threadData, feedback, client, channelId, threadTs) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [ProjectThread] Follow-up for "${threadData.project_name}": "${feedback}"`);

  let thinkingMsg;
  try {
    thinkingMsg = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: ':arrows_counterclockwise: Even kijken...',
    });
  } catch (e) { /* ignore */ }

  try {
    addConversation(threadTs, 'consultant', feedback);

    const history = (threadData.conversation_history || []).map(msg => ({
      role: msg.role === 'consultant' ? 'user' : 'assistant',
      content: msg.content,
    }));

    // Use full_context (DB + web) if available, otherwise fall back to raw_context (summary)
    const context = threadData.full_context || threadData.raw_context || '';
    const contextMessage = `Eerder opgezochte informatie over "${threadData.project_name}":\n\n${context}\n\nBronnen: ${(threadData.sources || []).map(s => s.url).join(', ')}`;

    const messages = [
      { role: 'user', content: contextMessage },
      ...history,
      { role: 'user', content: feedback },
    ];

    const response = await claudeRetry(claude, {
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: PROJECT_THREAD_PROMPT,
      messages,
    }, { label: 'ProjectThread' });

    const answer = response.content[0].text.trim();

    addConversation(threadTs, 'bot', answer);

    if (thinkingMsg) {
      try {
        await client.chat.update({
          channel: channelId,
          ts: thinkingMsg.ts,
          text: `:mag: ${answer}`,
        });
      } catch (e) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `:mag: ${answer}`,
        });
      }
    } else {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `:mag: ${answer}`,
      });
    }

  } catch (error) {
    console.error(`[${ts}] [ProjectThread] Error:`, error);
    const errorMsg = `:warning: Er ging iets mis: ${error.message}`;
    if (thinkingMsg) {
      try { await client.chat.update({ channel: channelId, ts: thinkingMsg.ts, text: errorMsg }); } catch (e) { /* ignore */ }
    } else {
      try { await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: errorMsg }); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { handleProject, handleProjectThreadReply };
