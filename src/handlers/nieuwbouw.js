/**
 * /nieuwbouw Slack command handler — Live scrape version.
 *
 * No daily sync, no Google Sheets. Scrapes Idealista obra nueva + ThinkSpain
 * newbuild listings on demand, groups into projects, and uses Claude to
 * answer questions about the results.
 *
 * Usage:
 *   /nieuwbouw marbella, estepona, max 400k
 *   /nieuwbouw 3 slaapkamers costa del sol met zwembad
 *
 * Follow-up in thread:
 *   "Wat weet je over Residencial Albatros?"
 *   "Welke projecten hebben zeezicht?"
 */

const Anthropic = require('@anthropic-ai/sdk');
const { searchIdealista } = require('../services/idealista-direct');
const { searchThinkSpain } = require('../services/thinkspain');
const { deduplicateListings } = require('../services/dedup');
const { parseSearchQuery } = require('../services/claude-parser');
const { setThread, getThread, addConversation } = require('../store/thread-memory');
const {
  COSTA_SELECT_REGIONS,
  getRegionForCity,
  MUNICIPALITY_TO_REGION,
} = require('../services/nieuwbouw-scraper');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── System prompt for Claude Q&A in threads ────────────────────────────────

const NIEUWBOUW_SYSTEM_PROMPT = `Je bent de NieuwbouwBot van Costa Select, een Nederlandse makelaar in Spanje.
Je hebt zojuist nieuwbouwprojecten gescraped van Idealista en ThinkSpain op basis van de zoekopdracht van de consultant.

Je taak:
1. Beantwoord vragen over de gevonden nieuwbouwprojecten in het Nederlands
2. Als de consultant vraagt over een specifiek project, geef alle beschikbare details: naam, locatie, prijs, slaapkamers, m², features, beschrijving, URL
3. Vergelijk projecten als daarom gevraagd wordt
4. Wees eerlijk als informatie ontbreekt
5. Geef concrete, bruikbare antwoorden

Formatteer je antwoord voor Slack:
- Gebruik *bold* voor nadruk
- Gebruik bullet points voor lijsten
- Vermeld altijd de bron (Idealista/ThinkSpain) en de link
- Houd antwoorden beknopt maar volledig`;

// ─── Region-to-cities mapping for broad searches ────────────────────────────

const REGION_CITIES = {
  'costa del sol': ['Estepona', 'Marbella', 'Mijas', 'Fuengirola', 'Benalmadena', 'Torremolinos', 'Malaga', 'Nerja', 'Manilva', 'Casares', 'Benahavis'],
  'costa blanca south': ['Torrevieja', 'Orihuela', 'Guardamar del Segura', 'Rojales', 'Pilar de la Horadada', 'Santa Pola', 'Alicante'],
  'costa blanca north': ['Javea', 'Denia', 'Moraira', 'Calpe', 'Altea', 'Benidorm'],
  'valencia': ['Valencia', 'Gandia'],
  'costa blanca': ['Torrevieja', 'Orihuela', 'Guardamar del Segura', 'Alicante', 'Javea', 'Denia', 'Moraira', 'Calpe', 'Altea', 'Benidorm'],
};

/**
 * Expand region names to individual cities.
 * E.g., "costa del sol" → ['Estepona', 'Marbella', ...]
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
  // Deduplicate
  return [...new Set(expanded.map(c => c.toLowerCase()))].map(c => {
    // Capitalize first letter
    return c.charAt(0).toUpperCase() + c.slice(1);
  });
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
      text: '🏗️ *NieuwbouwBot — Gebruik:*\n\n' +
        '• `/nieuwbouw Estepona, Marbella` — Zoek nieuwbouw in die steden\n' +
        '• `/nieuwbouw costa del sol, max 400k, 2 slpk` — Zoek met filters\n' +
        '• `/nieuwbouw welke projecten onder 300k met zeezicht?` — Vrije vraag\n\n' +
        'Na resultaten kun je in de thread vervolgvragen stellen over specifieke projecten.',
    });
    return;
  }

  // Send initial status
  let statusMsg;
  try {
    statusMsg = await client.chat.postMessage({
      channel: channelId,
      text: '🏗️ *NieuwbouwBot*\n\n🔍 Zoekopdracht analyseren...',
    });
  } catch (e) {
    console.error(`[${ts}] [Nieuwbouw] Failed to send status:`, e.message);
  }

  const threadTs = statusMsg?.ts;

  try {
    // Step 1: Parse the query with Claude
    let clientProfile;
    try {
      clientProfile = await parseSearchQuery(query);
    } catch (parseErr) {
      console.error(`[${ts}] [Nieuwbouw] Parse failed:`, parseErr.message);
      // Fallback: treat the whole query as location names
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

    // Expand region names to cities
    const rawLocations = clientProfile.hard_filters.locations || [];
    if (rawLocations.length === 0) {
      // Default to all Costa Select regions
      clientProfile.hard_filters.locations = expandLocations(['costa del sol', 'costa blanca south', 'costa blanca north', 'valencia']);
    } else {
      clientProfile.hard_filters.locations = expandLocations(rawLocations);
    }

    const locations = clientProfile.hard_filters.locations;
    const locationStr = locations.slice(0, 5).join(', ') + (locations.length > 5 ? ` (+${locations.length - 5} meer)` : '');

    await updateStatus(client, channelId, threadTs,
      `🏗️ *NieuwbouwBot*\n\n` +
      `✅ *Begrepen:* ${clientProfile.search_summary || query}\n` +
      `📍 Locatie(s): ${locationStr}\n\n` +
      `🔍 Nieuwbouw zoeken op Idealista + ThinkSpain...`);

    // Step 2: Scrape both portals in parallel
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
      `🏗️ *NieuwbouwBot*\n\n` +
      `✅ ${allRaw.length} nieuwbouw listings gevonden\n` +
      `Idealista: ${idealistaListings.length} | ThinkSpain: ${thinkspainListings.length}\n\n` +
      (errors.length > 0 ? `⚠️ ${errors.join(' en ')} gaf een fout\n\n` : '') +
      `🧹 Duplicaten verwijderen en projecten groeperen...`);

    if (allRaw.length === 0) {
      await updateStatus(client, channelId, threadTs,
        `🏗️ *NieuwbouwBot*\n\n` +
        `❌ Geen nieuwbouwprojecten gevonden voor "${query}".\n` +
        `Probeer een bredere zoekopdracht of andere locatie.`);
      return;
    }

    // Step 3: Deduplicate
    const allProperties = deduplicateListings(allRaw);

    // Step 4: Group into projects (reuse logic from nieuwbouw-scraper)
    const { groupIntoProjects, projectToSheetRow } = require('../services/nieuwbouw-scraper');

    // Convert our normalized listings to the format groupIntoProjects expects
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

    const projects = groupIntoProjects(listingsForGrouping);
    const projectRows = projects.map(projectToSheetRow);

    console.log(`[${ts}] [Nieuwbouw] ${allProperties.length} listings → ${projectRows.length} projects`);

    // Step 5: Use Claude to present results
    await updateStatus(client, channelId, threadTs,
      `🏗️ *NieuwbouwBot*\n\n` +
      `✅ ${projectRows.length} nieuwbouwprojecten gevonden\n\n` +
      `🤖 Resultaten samenvatten...`);

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

    // Truncate if too long
    const maxContextLength = 80000;
    const truncatedContext = projectContext.length > maxContextLength
      ? projectContext.substring(0, maxContextLength) + '\n... (meer projecten beschikbaar, stel een specifiekere vraag in de thread)'
      : projectContext;

    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      system: NIEUWBOUW_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Er zijn ${projectRows.length} nieuwbouwprojecten gevonden (van ${allProperties.length} individuele listings):\n\n${truncatedContext}\n\n` +
          `Oorspronkelijke zoekopdracht: "${query}"\n\n` +
          `Geef een overzicht van de beste/meest relevante projecten. Groepeer per regio als er meerdere regio's zijn. ` +
          `Vermeld per project: naam, locatie, prijsrange, slaapkamers, features, en link. ` +
          `Maximaal 15 projecten tonen, tenzij de consultant om alles vraagt.`,
      }],
    });

    const answer = response.content[0].text.trim();

    // Send final result
    const finalText = `🏗️ *NieuwbouwBot — ${projectRows.length} projecten gevonden*\n` +
      `_Idealista: ${idealistaListings.length} | ThinkSpain: ${thinkspainListings.length} listings → ${projectRows.length} projecten_\n\n` +
      `${answer}\n\n` +
      `_💬 Stel vervolgvragen in deze thread over specifieke projecten._`;

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
        all_properties: allProperties,
        project_rows: projectRows,
        project_context: truncatedContext,
        conversation_history: [],
        channel_id: channelId,
        original_query: query,
        created_at: Date.now(),
      });
    }

    console.log(`[${ts}] [Nieuwbouw] Done! ${projectRows.length} projects sent.`);

  } catch (error) {
    console.error(`[${ts}] [Nieuwbouw] Error:`, error);
    const errorMsg = `⚠️ Er ging iets mis: ${error.message}`;
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
 * Handle follow-up questions in nieuwbouw threads.
 * Called from thread-reply handler when thread type is 'nieuwbouw'.
 */
async function handleNieuwbouwThreadReply(threadData, feedback, client, channelId, threadTs) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [NieuwbouwThread] Follow-up: "${feedback}"`);

  // Send thinking message
  let thinkingMsg;
  try {
    thinkingMsg = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: '🔄 Even kijken...',
    });
  } catch (e) { /* ignore */ }

  try {
    addConversation(threadTs, 'consultant', feedback);

    // Build conversation history for Claude
    const history = (threadData.conversation_history || []).map(msg => ({
      role: msg.role === 'consultant' ? 'user' : 'assistant',
      content: msg.content,
    }));

    // Add the project context and new question
    const messages = [
      {
        role: 'user',
        content: `Database bevat ${threadData.project_rows.length} nieuwbouwprojecten:\n\n${threadData.project_context}\n\nOorspronkelijke zoekopdracht: "${threadData.original_query}"`,
      },
      ...history,
      {
        role: 'user',
        content: feedback,
      },
    ];

    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: NIEUWBOUW_SYSTEM_PROMPT,
      messages,
    });

    const answer = response.content[0].text.trim();

    addConversation(threadTs, 'bot', answer);

    // Send answer
    if (thinkingMsg) {
      try {
        await client.chat.update({
          channel: channelId,
          ts: thinkingMsg.ts,
          text: `🏗️ ${answer}`,
        });
      } catch (e) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `🏗️ ${answer}`,
        });
      }
    } else {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `🏗️ ${answer}`,
      });
    }

  } catch (error) {
    console.error(`[${ts}] [NieuwbouwThread] Error:`, error);
    const errorMsg = `⚠️ Er ging iets mis: ${error.message}`;
    if (thinkingMsg) {
      try { await client.chat.update({ channel: channelId, ts: thinkingMsg.ts, text: errorMsg }); } catch (e) { /* ignore */ }
    } else {
      try { await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: errorMsg }); } catch (e) { /* ignore */ }
    }
  }
}

/**
 * Extract project name from listing title/description.
 * Simplified version of the nieuwbouw-scraper's extractProjectNameFromTitle.
 */
function extractProjectName(title, desc) {
  if (!title) return 'Onbekend project';

  // Pattern: "in [Project Name]"
  const inMatch = title.match(/\bin\s+([A-ZÀ-Ú][A-Za-zÀ-ÿ\s\-'&]{2,50}?)(?:\s*,|\s*$)/);
  if (inMatch) {
    const name = inMatch[1].trim();
    const genericLocations = Object.keys(MUNICIPALITY_TO_REGION);
    if (!genericLocations.includes(name.toLowerCase())) return name;
  }

  // Pattern: known project keywords in description
  const combined = `${title} ${desc || ''}`;
  const descMatch = combined.match(/(?:residencial|residencia|urbanización|urbanizacion|complejo|promoción|promocion|proyecto|project|resort|residence|gardens|village|park)\s+([A-ZÀ-Ú][A-Za-zÀ-ÿ\s\-'&]{2,40})/i);
  if (descMatch) return descMatch[1].trim();

  // Fallback: truncated title
  return title.substring(0, 60).trim() || 'Onbekend project';
}

async function updateStatus(client, channelId, ts, text) {
  if (!ts) return;
  try {
    await client.chat.update({ channel: channelId, ts, text });
  } catch (e) { /* ignore */ }
}

module.exports = { handleNieuwbouw, handleNieuwbouwThreadReply };
