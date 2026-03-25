/**
 * project-info.js — Tavily-powered new-build project information service.
 *
 * When a consultant asks "vertel mij alles over The View Marbella", this service:
 *   1. Classifies the intent (search vs project_info)
 *   2. Searches the web via Tavily for project information
 *   3. Synthesizes the results into a comprehensive Dutch summary via Claude
 *
 * Dependencies:
 *   - Tavily API (TAVILY_API_KEY env var) — web search
 *   - Anthropic Claude (ANTHROPIC_API_KEY env var) — intent classification + summarization
 *
 * Cost per query: ~$0.01-0.05 (Tavily search + Claude summary)
 */

const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');

// ─── Configuration ──────────────────────────────────────────────────────────

const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

if (!TAVILY_API_KEY) {
  console.warn('[ProjectInfo] WARNING: No TAVILY_API_KEY set. Project info lookups will fail.');
}

// ─── Intent Classification ──────────────────────────────────────────────────

/**
 * Classify a /nieuwbouw query as either "search" or "project_info".
 *
 * "search" = the user wants to find new-build listings matching criteria
 *   Examples: "nieuwbouw Marbella 2 slaapkamers max 500k"
 *             "appartementen costa del sol met zwembad"
 *             "The View Marbella, 2 slaapkamers, max 500k" (search WITH project filter)
 *
 * "project_info" = the user wants information about a specific project
 *   Examples: "vertel mij alles over The View Marbella"
 *             "wat weet je over Residencial Albatros?"
 *             "info over Ocean Suites Benalmádena"
 *             "The View Marbella" (just a project name, no filters)
 *
 * Uses a lightweight Claude call (max_tokens: 100) for reliable classification.
 */
async function classifyIntent(query) {
  try {
    const response = await claude.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 100,
      system: `Je bent een intent classifier voor een nieuwbouw-zoekbot in Spanje.

Classificeer de query als:
- "search" → de gebruiker wil nieuwbouwwoningen ZOEKEN met criteria (prijs, slaapkamers, locatie, features)
- "project_info" → de gebruiker wil INFORMATIE over een specifiek nieuwbouwproject (naam, details, status)

Regels:
- Als de query filters bevat (prijs, slaapkamers, m², features) → altijd "search", ook als er een projectnaam in staat
- Als de query ALLEEN een projectnaam is, of vraagt om info/details over een project → "project_info"
- Woorden als "vertel", "info", "wat weet je over", "details over", "alles over" → "project_info"
- Bij twijfel: "search"

Antwoord ALLEEN met valid JSON: {"intent": "search" of "project_info", "project_name": "naam of null"}`,
      messages: [{ role: 'user', content: query }],
    });

    const text = response.content[0].text.trim();
    const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned);

    console.log(`[ProjectInfo] Intent: ${parsed.intent}, project: ${parsed.project_name || 'none'}`);
    return {
      intent: parsed.intent === 'project_info' ? 'project_info' : 'search',
      project_name: parsed.project_name || null,
    };
  } catch (err) {
    console.error(`[ProjectInfo] Intent classification failed: ${err.message}`);
    // Default to search on failure — safer fallback
    return { intent: 'search', project_name: null };
  }
}

// ─── Tavily Web Search ──────────────────────────────────────────────────────

/**
 * Search the web for information about a new-build project using Tavily.
 *
 * @param {string} projectName - The project name to search for
 * @returns {object} - { results: [{title, url, content}], raw_context: string }
 */
async function searchProjectInfo(projectName) {
  if (!TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY not configured. Set it in Railway Variables.');
  }

  // Build search queries — multiple angles for comprehensive results
  const queries = [
    `"${projectName}" nieuwbouw Spanje`,
    `"${projectName}" new build Spain property`,
    `"${projectName}" obra nueva precio`,
  ];

  console.log(`[ProjectInfo] Searching Tavily for "${projectName}" (${queries.length} queries)...`);

  const allResults = [];

  for (const query of queries) {
    try {
      const result = await tavilySearch(query);
      if (result && result.results) {
        allResults.push(...result.results);
      }
    } catch (err) {
      console.warn(`[ProjectInfo] Tavily query failed: "${query}" — ${err.message}`);
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  const uniqueResults = allResults.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  console.log(`[ProjectInfo] Found ${uniqueResults.length} unique sources for "${projectName}"`);

  // Build raw context for Claude
  const rawContext = uniqueResults.map((r, i) => {
    return `[Bron ${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content || ''}`;
  }).join('\n\n---\n\n');

  return {
    results: uniqueResults,
    raw_context: rawContext,
    source_count: uniqueResults.length,
  };
}

/**
 * Call the Tavily Search API.
 */
function tavilySearch(query) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      query,
      search_depth: 'advanced',
      include_answer: false,
      include_raw_content: false,
      max_results: 5,
      include_domains: [],
      exclude_domains: [],
    });

    const options = {
      hostname: 'api.tavily.com',
      path: '/search',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TAVILY_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Tavily API returned ${res.statusCode}: ${body.substring(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Tavily response parse error: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Tavily request timeout'));
    });
    req.write(payload);
    req.end();
  });
}

// ─── Claude Summarization ───────────────────────────────────────────────────

const PROJECT_INFO_SYSTEM_PROMPT = `Je bent de NieuwbouwBot van Costa Select, een Nederlandse makelaar in Spanje.
Je hebt zojuist het internet doorzocht naar informatie over een specifiek nieuwbouwproject.

Je taak:
1. Geef een uitgebreide samenvatting van het project op basis van de gevonden bronnen
2. Structureer je antwoord duidelijk met de volgende secties (voor zover informatie beschikbaar):

*Projectoverzicht*
- Naam, locatie, ontwikkelaar
- Status (in aanbouw / opgeleverd / gepland / in verkoop)
- Type woningen (appartementen, villa's, penthouses, etc.)

*Prijzen & Specificaties*
- Prijsrange (vanaf-tot)
- Oppervlaktes (m²)
- Slaapkamers / badkamers
- Beschikbare typologieën

*Kenmerken & Faciliteiten*
- Gemeenschappelijke faciliteiten (zwembad, gym, tuin, etc.)
- Woningkenmerken (terras, parkeerplaats, berging, etc.)
- Uitzicht, oriëntatie, ligging

*Locatie & Omgeving*
- Exacte locatie / wijk
- Afstand tot strand, centrum, luchthaven
- Omliggende voorzieningen

*Bronnen*
- Vermeld alle gebruikte bronnen met URL

3. Wees eerlijk als informatie ontbreekt of tegenstrijdig is
4. Als er weinig informatie gevonden is, zeg dat en geef suggesties (bijv. "bezoek de website van de ontwikkelaar")

Formatteer voor Slack:
- Gebruik *bold* voor kopjes en nadruk
- Gebruik bullet points voor lijsten
- Vermeld altijd bronnen met links
- Houd het professioneel maar leesbaar`;

/**
 * Summarize project information using Claude.
 *
 * @param {string} projectName - The project name
 * @param {string} rawContext - Raw text from Tavily search results
 * @param {number} sourceCount - Number of sources found
 * @param {string} originalQuery - The original user query
 * @returns {string} - Formatted summary text for Slack
 */
async function summarizeProjectInfo(projectName, rawContext, sourceCount, originalQuery) {
  const userPrompt = `De consultant vraagt: "${originalQuery}"

Project: "${projectName}"
Aantal bronnen gevonden: ${sourceCount}

${sourceCount > 0 ? `Gevonden informatie:\n\n${rawContext}` : 'Er is geen informatie gevonden op het internet over dit project.'}

Geef een uitgebreide samenvatting van dit nieuwbouwproject.${sourceCount === 0 ? ' Vermeld dat er geen informatie gevonden is en geef suggesties.' : ''}`;

  // Truncate context if too long
  const maxLength = 80000;
  const truncatedPrompt = userPrompt.length > maxLength
    ? userPrompt.substring(0, maxLength) + '\n\n... (meer bronnen beschikbaar)'
    : userPrompt;

  const response = await claude.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 3000,
    system: PROJECT_INFO_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: truncatedPrompt }],
  });

  return response.content[0].text.trim();
}

// ─── Main project info function ─────────────────────────────────────────────

/**
 * Full project info pipeline: search + summarize.
 *
 * @param {string} projectName - The project name to research
 * @param {string} originalQuery - The original user query
 * @returns {object} - { summary: string, sources: [{title, url}], source_count: number }
 */
async function getProjectInfo(projectName, originalQuery) {
  // Step 1: Search the web
  const searchResults = await searchProjectInfo(projectName);

  // Step 2: Summarize with Claude
  const summary = await summarizeProjectInfo(
    projectName,
    searchResults.raw_context,
    searchResults.source_count,
    originalQuery
  );

  return {
    summary,
    sources: searchResults.results.map(r => ({ title: r.title, url: r.url })),
    source_count: searchResults.source_count,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  classifyIntent,
  searchProjectInfo,
  summarizeProjectInfo,
  getProjectInfo,
  // Expose for testing
  tavilySearch,
};
