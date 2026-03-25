/**
 * /nieuwbouw Slack command handler — Live scrape + Project Info version.
 *
 * Two modes based on intent detection:
 *
 * 1. SEARCH — scrapes Idealista + ThinkSpain for new-build listings
 *    /nieuwbouw marbella, estepona, max 400k
 *    /nieuwbouw 3 slaapkamers costa del sol met zwembad
 *
 * 2. PROJECT INFO — searches the web via Tavily for project details
 *    /nieuwbouw vertel mij alles over The View Marbella
 *    /nieuwbouw info over Residencial Albatros
 *    /nieuwbouw The View Marbella
 *
 * Follow-up in thread:
 *   "Wat weet je over Residencial Albatros?"
 *   "Welke projecten hebben zeezicht?"
 */

const Anthropic = require('@anthropic-ai/sdk');
const { searchIdealista } = require('../services/idealista-direct');
const { searchThinkSpain } = require('../services/thinkspain');
const { deduplicateListings } = require('../services/dedup');
const { preFilterListings } = require('../services/property-filter');
const { parseSearchQuery } = require('../services/claude-parser');
const { classifyIntent, getProjectInfo } = require('../services/project-info');
const { setThread, getThread, addConversation } = require('../store/thread-memory');
const {
  COSTA_SELECT_REGIONS,
  getRegionForCity,
  extractProjectName,
  groupIntoProjects,
  projectToDisplayRow,
} = require('../services/regions');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

// ─── System prompt for Claude Q&A in threads ────────────────────────────────

const NIEUWBOUW_SYSTEM_PROMPT = `Je bent de NieuwbouwBot van Costa Select, een Nederlandse makelaar in Spanje.
Je hebt zojuist nieuwbouwprojecten gescraped van Idealista en ThinkSpain op basis van de zoekopdracht van de consultant.

Je taak:
1. Beantwoord vragen over de gevonden nieuwbouwprojecten in het Nederlands
2. Als de consultant vraagt over een specifiek project, geef alle beschikbare details: naam, locatie, prijs, slaapkamers, m², features, beschrijving, URL
3. Vergelijk projecten als daarom gevraagd wordt
4. Wees eerlijk als informatie ontbreekt of als een specifiek project niet in de resultaten zit
5. Geef concrete, bruikbare antwoorden

Formatteer je antwoord voor Slack:
- Gebruik *bold* voor nadruk
- Gebruik bullet points voor lijsten
- Vermeld altijd de bron (Idealista/ThinkSpain) en de link
- Houd antwoorden beknopt maar volledig`;

const NIEUWBOUW_PROJECT_THREAD_PROMPT = `Je bent de NieuwbouwBot van Costa Select, een Nederlandse makelaar in Spanje.
Je hebt eerder informatie opgezocht over een specifiek nieuwbouwproject via het internet.

Je taak:
1. Beantwoord vervolgvragen over dit project op basis van de eerder gevonden informatie
2. Als de consultant naar iets vraagt dat niet in de bronnen staat, zeg dat eerlijk
3. Geef concrete, bruikbare antwoorden in het Nederlands

Formatteer je antwoord voor Slack:
- Gebruik *bold* voor nadruk
- Gebruik bullet points voor lijsten
- Vermeld bronnen met links waar relevant
- Houd antwoorden beknopt maar volledig`;

// ─── Region-to-cities mapping for broad searches ────────────────────────────

const REGION_CITIES = {
  'costa del sol': COSTA_SELECT_REGIONS['Costa del Sol'] || [],
  'costa blanca south': COSTA_SELECT_REGIONS['Costa Blanca South'] || [],
  'costa blanca north': COSTA_SELECT_REGIONS['Costa Blanca North'] || [],
  'valencia': COSTA_SELECT_REGIONS['Valencia'] || [],
  'costa blanca': [
    ...(COSTA_SELECT_REGIONS['Costa Blanca South'] || []),
    ...(COSTA_SELECT_REGIONS['Costa Blanca North'] || []),
  ],
};

/**
 * Expand region names to individual cities.
 */
function expandLocations(locations) {
  const expanded = [];
  for (const loc of locations) {
    const lower = loc.toLowerCase().trim();
    if (REGION_CITIES[lower]) {
      expanded.push(...REGION_CITIES[lower]);
    } else {
      expanded.push(loc);
    }
  }
  return [...new Set(expanded.map(c => c.toLowerCase()))].map(c =>
    c.charAt(0).toUpperCase() + c.slice(1)
  );
}

/**
 * Handle the /nieuwbouw slash command.
 */
async function handleNieuwbouw({ command, ack, client }) {
  await ack();

  const query = (command.text || '').trim();
  const channelId = command.channel_id;
  const userId = command.user_id;
  const ts = new Date().toISOString();

  console.log(`[${ts}] [Nieuwbouw] Query from ${userId}: "${query}"`);

  if (!query) {
    await client.chat.postMessage({
      channel: channelId,
      text: ':building_construction: *NieuwbouwBot — Gebruik:*\n\n' +
        '`/nieuwbouw Estepona, Marbella` — Zoek nieuwbouw in die steden\n' +
        '`/nieuwbouw costa del sol, max 400k, 2 slpk` — Zoek met filters\n' +
        '`/nieuwbouw vertel mij alles over The View Marbella` — Info over specifiek project\n\n' +
        'Na resultaten kun je in de thread vervolgvragen stellen.',
    });
    return;
  }

  // Send initial status
  let statusMsg;
  try {
    statusMsg = await client.chat.postMessage({
      channel: channelId,
      text: ':building_construction: *NieuwbouwBot*\n\n:mag: Zoekopdracht analyseren...',
    });
  } catch (e) {
    console.error(`[${ts}] [Nieuwbouw] Failed to send status:`, e.message);
  }

  const threadTs = statusMsg?.ts;

  try {
    // ─── Step 0: Classify intent ─────────────────────────────────────
    const { intent, project_name: detectedProject } = await classifyIntent(query);
    console.log(`[${ts}] [Nieuwbouw] Intent: ${intent}, detected project: ${detectedProject || 'none'}`);

    // ─── Branch: PROJECT INFO ────────────────────────────────────────
    if (intent === 'project_info' && detectedProject) {
      await handleProjectInfo(client, channelId, threadTs, query, detectedProject, ts);
      return;
    }

    // ─── Branch: SEARCH (existing flow) ──────────────────────────────
    await handleSearch(client, channelId, threadTs, query, ts);

  } catch (error) {
    console.error(`[${ts}] [Nieuwbouw] Error:`, error);
    const errorMsg = `:warning: Er ging iets mis: ${error.message}`;
    if (threadTs) {
      try {
        await client.chat.update({ channel: channelId, ts: threadTs, text: errorMsg });
      } catch (e) {
        await client.chat.postMessage({ channel: channelId, text: errorMsg });
      }
    } else {
      await client.chat.postMessage({ channel: channelId, text: errorMsg });
    }
  }
}

// ─── PROJECT INFO flow ──────────────────────────────────────────────────────

/**
 * Handle project info requests — search the web and summarize.
 */
async function handleProjectInfo(client, channelId, threadTs, query, projectName, ts) {
  console.log(`[${ts}] [Nieuwbouw] PROJECT INFO flow for "${projectName}"`);

  await updateStatus(client, channelId, threadTs,
    `:building_construction: *NieuwbouwBot — Project Info*\n\n` +
    `:dart: Project: *${projectName}*\n` +
    `:globe_with_meridians: Internet doorzoeken naar informatie...`);

  try {
    const result = await getProjectInfo(projectName, query);

    // Build source list
    const sourceList = result.sources.length > 0
      ? result.sources.map((s, i) => `${i + 1}. <${s.url}|${s.title}>`).join('\n')
      : '_Geen bronnen gevonden_';

    const finalText = `:building_construction: *NieuwbouwBot — ${projectName}*\n` +
      `_${result.source_count} bronnen gevonden en geanalyseerd_\n\n` +
      `${result.summary}\n\n` +
      `_:speech_balloon: Stel vervolgvragen in deze thread over dit project._`;

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
        type: 'nieuwbouw_project',
        project_name: projectName,
        sources: result.sources,
        raw_context: result.summary, // Store the summary as context for follow-ups
        source_count: result.source_count,
        conversation_history: [],
        channel_id: channelId,
        original_query: query,
        created_at: Date.now(),
      });
    }

    console.log(`[${ts}] [Nieuwbouw] Project info delivered for "${projectName}" (${result.source_count} sources)`);

  } catch (error) {
    console.error(`[${ts}] [Nieuwbouw] Project info failed:`, error);

    const errorMsg = `:building_construction: *NieuwbouwBot — ${projectName}*\n\n` +
      `:warning: Kon geen informatie ophalen: ${error.message}\n\n` +
      `_Tip: controleer of TAVILY_API_KEY is ingesteld in Railway Variables._`;

    if (threadTs) {
      try { await client.chat.update({ channel: channelId, ts: threadTs, text: errorMsg }); } catch (e) { /* ignore */ }
    }
  }
}

// ─── SEARCH flow (existing logic, unchanged) ────────────────────────────────

/**
 * Handle search requests — scrape Idealista + ThinkSpain for new-build listings.
 */
async function handleSearch(client, channelId, threadTs, query, ts) {
  console.log(`[${ts}] [Nieuwbouw] SEARCH flow for "${query}"`);

  // ─── Step 1: Parse the query with Claude ─────────────────────────
  let clientProfile;
  try {
    clientProfile = await parseSearchQuery(query);
  } catch (parseErr) {
    console.error(`[${ts}] [Nieuwbouw] Parse failed:`, parseErr.message);
    clientProfile = {
      hard_filters: {
        locations: query.split(',').map(s => s.trim()).filter(Boolean),
        is_new_build: true,
      },
      search_summary: query,
    };
  }

  // Force new build filter
  clientProfile.hard_filters.is_new_build = true;

  // Check for project_name search (search with project name as filter)
  const projectName = clientProfile.hard_filters.project_name || null;
  if (projectName) {
    console.log(`[${ts}] [Nieuwbouw] Project name filter: "${projectName}"`);
    // For project name searches, clear price filters to search broadly
    clientProfile.hard_filters.price_min = null;
    clientProfile.hard_filters.price_max = null;
    clientProfile.hard_filters.bedrooms_min = null;
  }

  // Expand region names to cities
  const rawLocations = clientProfile.hard_filters.locations || [];
  if (rawLocations.length === 0) {
    clientProfile.hard_filters.locations = expandLocations(['costa del sol', 'costa blanca south', 'costa blanca north', 'valencia']);
  } else {
    clientProfile.hard_filters.locations = expandLocations(rawLocations);
  }

  const locations = clientProfile.hard_filters.locations;
  const locationStr = locations.slice(0, 5).join(', ') + (locations.length > 5 ? ` (+${locations.length - 5} meer)` : '');

  await updateStatus(client, channelId, threadTs,
    `:building_construction: *NieuwbouwBot*\n\n` +
    `:white_check_mark: *Begrepen:* ${clientProfile.search_summary || query}\n` +
    `:round_pushpin: Locatie(s): ${locationStr}\n` +
    (projectName ? `:dart: Zoekt specifiek: "${projectName}"\n` : '') +
    `\n:mag: Nieuwbouw zoeken op Idealista + ThinkSpain...`);

  // ─── Step 2: Scrape both portals in parallel ─────────────────────
  console.log(`[${ts}] [Nieuwbouw] Scraping ${locations.length} locations for new build...`);

  const errors = [];

  const [idealistaResult, thinkspainResult] = await Promise.allSettled([
    searchIdealista(clientProfile.hard_filters),
    searchThinkSpain(clientProfile.hard_filters),
  ]);

  const idealistaListings = idealistaResult.status === 'fulfilled' ? idealistaResult.value : (() => { errors.push('Idealista'); return []; })();
  const thinkspainListings = thinkspainResult.status === 'fulfilled' ? thinkspainResult.value : (() => { errors.push('ThinkSpain'); return []; })();

  const allRaw = [...idealistaListings, ...thinkspainListings];

  await updateStatus(client, channelId, threadTs,
    `:building_construction: *NieuwbouwBot*\n\n` +
    `:white_check_mark: ${allRaw.length} nieuwbouw listings gevonden\n` +
    `Idealista: ${idealistaListings.length} | ThinkSpain: ${thinkspainListings.length}\n\n` +
    (errors.length > 0 ? `:warning: ${errors.join(' en ')} gaf een fout\n\n` : '') +
    `:broom: Duplicaten verwijderen en projecten groeperen...`);

  if (allRaw.length === 0) {
    await updateStatus(client, channelId, threadTs,
      `:building_construction: *NieuwbouwBot*\n\n` +
      `:x: Geen nieuwbouwprojecten gevonden voor "${query}".\n` +
      `Probeer een bredere zoekopdracht of andere locatie.`);
    return;
  }

  // ─── Step 3: Deduplicate and pre-filter ──────────────────────────
  const deduplicated = deduplicateListings(allRaw);
  const allProperties = projectName ? deduplicated : preFilterListings(deduplicated, clientProfile.hard_filters);

  // ─── Step 4: Group into projects ─────────────────────────────────
  const listingsForGrouping = allProperties.map(l => ({
    project_name: extractProjectName(l.title, l.description),
    developer: l.agency || 'Onbekend',
    region: getRegionForCity(l.location || l.municipality || ''),
    location: l.location || l.municipality || '',
    municipality: l.municipality || l.location || '',
    property_type: l.property_type || 'onbekend',
    price: l.price,
    bedrooms: l.bedrooms,
    bathrooms: l.bathrooms,
    size_m2: l.size_m2,
    description: l.description || '',
    url: l.url,
    source: l.source,
    thumbnail: l.thumbnail || '',
    features: l.features || [],
    is_new_build: true,
  }));

  let projects = groupIntoProjects(listingsForGrouping);
  let projectRows = projects.map(projectToDisplayRow);

  // Filter by project name if specified
  if (projectName) {
    const nameSearch = projectName.toLowerCase();
    const matchedProjects = projectRows.filter(p => {
      const pName = (p.project_name || '').toLowerCase();
      const pDesc = (p.description || '').toLowerCase();
      const pLocation = (p.location || '').toLowerCase();
      return pName.includes(nameSearch) || nameSearch.includes(pName) ||
             pDesc.includes(nameSearch) || pLocation.includes(nameSearch);
    });

    if (matchedProjects.length > 0) {
      console.log(`[${ts}] [Nieuwbouw] Project name "${projectName}" matched ${matchedProjects.length} projects`);
      projectRows = matchedProjects;
    } else {
      console.log(`[${ts}] [Nieuwbouw] Project name "${projectName}" not found in ${projectRows.length} projects`);
    }
  }

  console.log(`[${ts}] [Nieuwbouw] ${allProperties.length} listings → ${projectRows.length} projects`);

  // ─── Step 5: Use Claude to present results ───────────────────────
  await updateStatus(client, channelId, threadTs,
    `:building_construction: *NieuwbouwBot*\n\n` +
    `:white_check_mark: ${projectRows.length} nieuwbouwprojecten gevonden\n\n` +
    `:robot_face: Resultaten samenvatten...`);

  const projectContext = projectRows.map((p, i) => {
    const parts = [
      `[${i + 1}] ${p.project_name}`,
      p.developer !== 'Onbekend' ? `Ontwikkelaar: ${p.developer}` : '',
      p.region ? `Regio: ${p.region}` : '',
      p.location ? `Locatie: ${p.location}` : '',
      p.property_type ? `Type: ${p.property_type}` : '',
      p.price_from ? `Prijs vanaf: €${Number(p.price_from).toLocaleString('nl-NL')}` : '',
      p.price_to ? `Prijs tot: €${Number(p.price_to).toLocaleString('nl-NL')}` : '',
      p.bedrooms ? `Slaapkamers: ${p.bedrooms}` : '',
      p.size_m2 ? `m²: ${p.size_m2}` : '',
      p.features ? `Features: ${p.features}` : '',
      p.url ? `URL: ${p.url}` : '',
      p.source ? `Bron: ${p.source}` : '',
    ].filter(Boolean);
    return parts.join(' | ');
  }).join('\n');

  const maxContextLength = 80000;
  const truncatedContext = projectContext.length > maxContextLength
    ? projectContext.substring(0, maxContextLength) + '\n... (meer projecten beschikbaar, stel een specifiekere vraag in de thread)'
    : projectContext;

  // Build the Claude prompt based on whether this is a project name search
  let claudePrompt;
  if (projectName) {
    claudePrompt = `De consultant zoekt specifiek naar het project "${projectName}".\n\n` +
      `Er zijn ${projectRows.length} projecten gevonden:\n\n${truncatedContext}\n\n` +
      `Als het project "${projectName}" in de resultaten staat, geef ALLE beschikbare details.\n` +
      `Als het project NIET gevonden is, zeg dat eerlijk en toon de meest vergelijkbare projecten in dezelfde locatie.`;
  } else {
    claudePrompt = `Er zijn ${projectRows.length} nieuwbouwprojecten gevonden (van ${allProperties.length} individuele listings):\n\n${truncatedContext}\n\n` +
      `Oorspronkelijke zoekopdracht: "${query}"\n\n` +
      `Geef een overzicht van de beste/meest relevante projecten. Groepeer per regio als er meerdere regio's zijn. ` +
      `Vermeld per project: naam, locatie, prijsrange, slaapkamers, features, en link. ` +
      `Maximaal 15 projecten tonen, tenzij de consultant om alles vraagt.`;
  }

  const response = await claude.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 3000,
    system: NIEUWBOUW_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: claudePrompt }],
  });

  const answer = response.content[0].text.trim();

  // Send final result
  const finalText = `:building_construction: *NieuwbouwBot — ${projectRows.length} projecten gevonden*\n` +
    `_Idealista: ${idealistaListings.length} | ThinkSpain: ${thinkspainListings.length} listings → ${projectRows.length} projecten_\n\n` +
    `${answer}\n\n` +
    `_:speech_balloon: Stel vervolgvragen in deze thread over specifieke projecten._`;

  if (threadTs) {
    try {
      await client.chat.update({
        channel: channelId,
        ts: threadTs,
        text: finalText,
      });
    } catch (e) {
      await client.chat.postMessage({ channel: channelId, text: finalText });
    }
  } else {
    await client.chat.postMessage({ channel: channelId, text: finalText });
  }

  // Store thread data for follow-up questions
  if (threadTs) {
    setThread(threadTs, {
      type: 'nieuwbouw',
      client_profile: clientProfile,
      all_properties: allProperties.map(p => ({
        id: p.id, title: p.title, price: p.price, property_type: p.property_type,
        location: p.location, bedrooms: p.bedrooms, size_m2: p.size_m2,
        features: p.features, url: p.url, source: p.source, thumbnail: p.thumbnail,
      })),
      project_rows: projectRows,
      project_context: truncatedContext,
      conversation_history: [],
      channel_id: channelId,
      original_query: query,
      created_at: Date.now(),
    });
  }

  console.log(`[${ts}] [Nieuwbouw] Done! ${projectRows.length} projects sent.`);
}

/**
 * Handle follow-up questions in nieuwbouw threads.
 * Supports both search threads (type: 'nieuwbouw') and project info threads (type: 'nieuwbouw_project').
 */
async function handleNieuwbouwThreadReply(threadData, feedback, client, channelId, threadTs) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [NieuwbouwThread] Follow-up (${threadData.type}): "${feedback}"`);

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

    let systemPrompt;
    let contextMessage;

    if (threadData.type === 'nieuwbouw_project') {
      // Project info thread — use project-specific context
      systemPrompt = NIEUWBOUW_PROJECT_THREAD_PROMPT;
      contextMessage = `Eerder opgezochte informatie over "${threadData.project_name}":\n\n${threadData.raw_context}\n\nBronnen: ${(threadData.sources || []).map(s => s.url).join(', ')}`;
    } else {
      // Search thread — use scraped project data
      systemPrompt = NIEUWBOUW_SYSTEM_PROMPT;
      contextMessage = `Database bevat ${threadData.project_rows.length} nieuwbouwprojecten:\n\n${threadData.project_context}\n\nOorspronkelijke zoekopdracht: "${threadData.original_query}"`;
    }

    const messages = [
      {
        role: 'user',
        content: contextMessage,
      },
      ...history,
      {
        role: 'user',
        content: feedback,
      },
    ];

    const response = await claude.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages,
    });

    const answer = response.content[0].text.trim();

    addConversation(threadTs, 'bot', answer);

    if (thinkingMsg) {
      try {
        await client.chat.update({
          channel: channelId,
          ts: thinkingMsg.ts,
          text: `:building_construction: ${answer}`,
        });
      } catch (e) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `:building_construction: ${answer}`,
        });
      }
    } else {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `:building_construction: ${answer}`,
      });
    }

  } catch (error) {
    console.error(`[${ts}] [NieuwbouwThread] Error:`, error);
    const errorMsg = `:warning: Er ging iets mis: ${error.message}`;
    if (thinkingMsg) {
      try { await client.chat.update({ channel: channelId, ts: thinkingMsg.ts, text: errorMsg }); } catch (e) { /* ignore */ }
    } else {
      try { await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: errorMsg }); } catch (e) { /* ignore */ }
    }
  }
}

async function updateStatus(client, channelId, ts, text) {
  if (!ts) return;
  try {
    await client.chat.update({ channel: channelId, ts, text });
  } catch (e) { /* ignore */ }
}

module.exports = { handleNieuwbouw, handleNieuwbouwThreadReply };
