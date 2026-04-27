/**
 * /nieuwbouw Slack command handler — Search for new-build listings.
 *
 * Primary data source: Supabase (weekly scraped database, fast).
 * Fallback: Live Idealista scraping via Apify (slower, used when Supabase unavailable).
 *
 * Usage:
 *   /nieuwbouw marbella, estepona, max 400k
 *   /nieuwbouw 3 slaapkamers costa del sol met zwembad
 *   /nieuwbouw costa blanca, 2 slpk, max 300k
 *
 * For project-specific info, use /project instead.
 *
 * Follow-up in thread:
 *   "Welke projecten hebben zeezicht?"
 *   "Toon alleen projecten onder 400k"
 */

const Anthropic = require('@anthropic-ai/sdk');
const { claudeRetry } = require('../services/claude-retry');
const { searchIdealista } = require('../services/idealista-direct');
// const { searchThinkSpain } = require('../services/thinkspain');  // Temporarily disabled
const { deduplicateListings } = require('../services/dedup');
const { preFilterListings } = require('../services/property-filter');
const { parseSearchQuery } = require('../services/claude-parser');
const { embed: embedQuery, isConfigured: isEmbeddingConfigured } = require('../services/openai-embeddings');
const { buildSoftQueryInput } = require('../services/embedding-input');
const { expandLocations: expandCityAliases } = require('../services/location-aliases');
const { setThread, addConversation } = require('../store/thread-memory');
const supabase = require('../services/supabase');
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
Je hebt zojuist nieuwbouwprojecten opgezocht uit de Costa Select database op basis van de zoekopdracht van de consultant.

Je taak:
1. Beantwoord vragen over de gevonden nieuwbouwprojecten in het Nederlands
2. Als de consultant vraagt over een specifiek project, geef alle beschikbare details: naam, locatie, prijs, slaapkamers, m², features, beschrijving, URL
3. Vergelijk projecten als daarom gevraagd wordt
4. Wees eerlijk als informatie ontbreekt of als een specifiek project niet in de resultaten zit
5. Geef concrete, bruikbare antwoorden
6. Als er units beschikbaar zijn per project, toon de individuele units met prijs, slaapkamers, m² en features

Formatteer je antwoord voor Slack:
- Gebruik *bold* voor nadruk
- Gebruik bullet points voor lijsten
- Vermeld altijd de bron en de link
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
  'costa brava': [
    'Tossa de Mar', 'Lloret de Mar', 'Blanes', "Platja d'Aro", 'Begur',
    'Palafrugell', 'Pals', 'Roses', 'Cadaqués', 'Sant Feliu de Guíxols',
  ],
  'costa dorada':  ['Sitges', 'Vilanova i la Geltrú', 'Calafell', 'Salou', 'Cambrils', 'La Pineda', 'Tarragona'],
  'costa daurada': ['Sitges', 'Vilanova i la Geltrú', 'Calafell', 'Salou', 'Cambrils', 'La Pineda', 'Tarragona'],
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
        '`/nieuwbouw costa del sol, max 400k, 2 slpk` — Zoek met filters\n\n' +
        'Voor info over een specifiek project, gebruik `/project [naam]`.\n\n' +
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
      clientProfile.hard_filters.price_min = null;
      clientProfile.hard_filters.price_max = null;
      clientProfile.hard_filters.bedrooms_min = null;
    }

    // Expand region names to cities, dan city-aliases (Javea ↔ Xàbia)
    const rawLocations = clientProfile.hard_filters.locations || [];
    let regionExpanded;
    if (rawLocations.length === 0) {
      regionExpanded = expandLocations(['costa del sol', 'costa blanca south', 'costa blanca north', 'valencia']);
    } else {
      regionExpanded = expandLocations(rawLocations);
    }
    clientProfile.hard_filters.locations = expandCityAliases(regionExpanded);

    const locations = clientProfile.hard_filters.locations;
    const locationStr = locations.slice(0, 5).join(', ') + (locations.length > 5 ? ` (+${locations.length - 5} meer)` : '');

    await updateStatus(client, channelId, threadTs,
      `:building_construction: *NieuwbouwBot*\n\n` +
      `:white_check_mark: *Begrepen:* ${clientProfile.search_summary || query}\n` +
      `:round_pushpin: Locatie(s): ${locationStr}\n` +
      (projectName ? `:dart: Zoekt specifiek: "${projectName}"\n` : '') +
      `\n:mag: Nieuwbouw zoeken in database...`);

    // ─── Step 2: Search — Supabase (primary) or Idealista (fallback) ─

    let projectContext = '';
    let projectCount = 0;
    let sourceLabel = '';
    let threadStoreData = {};

    if (supabase.isConfigured()) {
      // ─── SUPABASE PATH (fast, preferred) ─────────────────────────
      console.log(`[${ts}] [Nieuwbouw] Using Supabase (${locations.length} locations)`);

      const filters = {
        locations: locations,
        price_min: clientProfile.hard_filters.price_min || null,
        price_max: clientProfile.hard_filters.price_max || null,
        bedrooms_min: clientProfile.hard_filters.bedrooms_min || null,
        project_name: projectName || null,
      };

      // Soft-criteria → embedding (Fase 5.1). Stille fallback bij errors.
      let queryEmbedding = null;
      const softQueryText = buildSoftQueryInput(clientProfile.soft_criteria);
      if (softQueryText && isEmbeddingConfigured()) {
        try {
          queryEmbedding = await embedQuery(softQueryText);
          console.log(`[${ts}] [Nieuwbouw] Soft query embedded (${queryEmbedding.length}d)`);
        } catch (embErr) {
          console.warn(`[${ts}] [Nieuwbouw] Embedding failed: ${embErr.message}`);
        }
      }

      const enrichedListings = await supabase.searchListingsWithUnits(filters, { queryEmbedding });

      if (enrichedListings.length === 0) {
        await updateStatus(client, channelId, threadTs,
          `:building_construction: *NieuwbouwBot*\n\n` +
          `:x: Geen nieuwbouwprojecten gevonden voor "${query}".\n` +
          `Probeer een bredere zoekopdracht of andere locatie.\n\n` +
          `_Database bevat ${locations.length > 3 ? 'alle Costa Select regio\'s' : locationStr}._`);
        return;
      }

      const totalUnits = enrichedListings.reduce((sum, l) => sum + (l.unit_count || 0), 0);
      projectCount = enrichedListings.length;
      sourceLabel = `Database: ${projectCount} projecten, ${totalUnits} units`;

      await updateStatus(client, channelId, threadTs,
        `:building_construction: *NieuwbouwBot*\n\n` +
        `:white_check_mark: ${projectCount} projecten gevonden (${totalUnits} units)\n\n` +
        `:robot_face: Resultaten samenvatten...`);

      projectContext = supabase.formatListingsForClaude(enrichedListings);

      // Store for thread follow-ups
      threadStoreData = {
        type: 'nieuwbouw',
        source: 'supabase',
        client_profile: clientProfile,
        project_count: projectCount,
        total_units: totalUnits,
        project_context: projectContext,
        conversation_history: [],
        channel_id: channelId,
        original_query: query,
        created_at: Date.now(),
      };

    } else {
      // ─── IDEALISTA FALLBACK (live scraping) ──────────────────────
      console.log(`[${ts}] [Nieuwbouw] Supabase not configured, falling back to Idealista scraping`);

      const errors = [];
      let idealistaListings = [];
      try {
        idealistaListings = await searchIdealista(clientProfile.hard_filters);
      } catch (err) {
        errors.push('Idealista');
        console.error(`[${ts}] Idealista failed:`, err.message);
      }

      const allRaw = [...idealistaListings];

      await updateStatus(client, channelId, threadTs,
        `:building_construction: *NieuwbouwBot*\n\n` +
        `:white_check_mark: ${allRaw.length} nieuwbouw listings gevonden\n` +
        `Idealista: ${idealistaListings.length}\n\n` +
        (errors.length > 0 ? `:warning: ${errors.join(' en ')} gaf een fout\n\n` : '') +
        `:broom: Duplicaten verwijderen en projecten groeperen...`);

      if (allRaw.length === 0) {
        await updateStatus(client, channelId, threadTs,
          `:building_construction: *NieuwbouwBot*\n\n` +
          `:x: Geen nieuwbouwprojecten gevonden voor "${query}".\n` +
          `Probeer een bredere zoekopdracht of andere locatie.`);
        return;
      }

      // Deduplicate and pre-filter
      const deduplicated = deduplicateListings(allRaw);
      const allProperties = projectName ? deduplicated : preFilterListings(deduplicated, clientProfile.hard_filters);

      // Group into projects
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
          projectRows = matchedProjects;
        }
      }

      projectCount = projectRows.length;
      sourceLabel = `Idealista: ${idealistaListings.length} listings → ${projectCount} projecten`;

      await updateStatus(client, channelId, threadTs,
        `:building_construction: *NieuwbouwBot*\n\n` +
        `:white_check_mark: ${projectCount} nieuwbouwprojecten gevonden\n\n` +
        `:robot_face: Resultaten samenvatten...`);

      projectContext = projectRows.map((p, i) => {
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

      // Store for thread follow-ups
      threadStoreData = {
        type: 'nieuwbouw',
        source: 'idealista',
        client_profile: clientProfile,
        all_properties: allProperties.map(p => ({
          id: p.id, title: p.title, price: p.price, property_type: p.property_type,
          location: p.location, bedrooms: p.bedrooms, size_m2: p.size_m2,
          features: p.features, url: p.url, source: p.source, thumbnail: p.thumbnail,
        })),
        project_rows: projectRows,
        project_count: projectCount,
        project_context: projectContext,
        conversation_history: [],
        channel_id: channelId,
        original_query: query,
        created_at: Date.now(),
      };
    }

    // ─── Step 3: Use Claude to present results ───────────────────────

    const maxContextLength = 80000;
    const truncatedContext = projectContext.length > maxContextLength
      ? projectContext.substring(0, maxContextLength) + '\n\n[... meer projecten beschikbaar, vraag in thread]'
      : projectContext;

    let claudePrompt;
    if (projectName) {
      claudePrompt = `De consultant zoekt specifiek naar het project "${projectName}".\n\n` +
        `Er zijn ${projectCount} projecten gevonden:\n\n${truncatedContext}\n\n` +
        `Als het project "${projectName}" in de resultaten staat, geef ALLE beschikbare details inclusief individuele units.\n` +
        `Als het project NIET gevonden is, zeg dat eerlijk en toon de meest vergelijkbare projecten in dezelfde locatie.`;
    } else {
      claudePrompt = `Er zijn ${projectCount} nieuwbouwprojecten gevonden:\n\n${truncatedContext}\n\n` +
        `Oorspronkelijke zoekopdracht: "${query}"\n\n` +
        `Geef een overzicht van de beste/meest relevante projecten. Groepeer per regio als er meerdere regio's zijn. ` +
        `Vermeld per project: naam, locatie, prijsrange, slaapkamers, m², features, beschikbare units, en link. ` +
        `Maximaal 15 projecten tonen, tenzij de consultant om alles vraagt.`;
    }

    const response = await claudeRetry(claude, {
      model: CLAUDE_MODEL,
      max_tokens: 3000,
      system: NIEUWBOUW_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: claudePrompt }],
    }, { label: 'NieuwbouwSummary' });

    const answer = response.content[0].text.trim();

    // Send final result
    const finalText = `:building_construction: *NieuwbouwBot — ${projectCount} projecten gevonden*\n` +
      `_${sourceLabel}_\n\n` +
      `${answer}\n\n` +
      `_:speech_balloon: Stel vervolgvragen in deze thread over specifieke projecten._`;

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
      threadStoreData.project_context = truncatedContext;
      setThread(threadTs, threadStoreData);
    }

    console.log(`[${ts}] [Nieuwbouw] Done! ${projectCount} projects sent.`);

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

/**
 * Handle follow-up questions in /nieuwbouw search threads.
 */
async function handleNieuwbouwThreadReply(threadData, feedback, client, channelId, threadTs) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [NieuwbouwThread] Follow-up: "${feedback}"`);

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

    const contextMessage = `Database bevat ${threadData.project_count || 'meerdere'} nieuwbouwprojecten:\n\n${threadData.project_context}\n\nOorspronkelijke zoekopdracht: "${threadData.original_query}"`;

    const messages = [
      { role: 'user', content: contextMessage },
      ...history,
      { role: 'user', content: feedback },
    ];

    const response = await claudeRetry(claude, {
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: NIEUWBOUW_SYSTEM_PROMPT,
      messages,
    }, { label: 'NieuwbouwThread' });

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

module.exports = { handleNieuwbouw, handleNieuwbouwThreadReply };
