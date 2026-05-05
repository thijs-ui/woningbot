/**
 * REST API server for WoningBot.
 * Runs alongside the Slack Bot to serve the Costa Select platform.
 */

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');

const { parseSearchQuery } = require('./services/claude-parser');
const { selectProperties } = require('./services/claude-selector');
const { searchIdealista, enrichListingsWithDetails } = require('./services/idealista-direct');
const { searchSupabase } = require('./services/supabase-search');
const { deduplicateListings } = require('./services/dedup');
const { preFilterListings, postValidateSelections } = require('./services/property-filter');
const { refineSelection } = require('./services/claude-refiner');
const { getThread, setThread, updateThread, addConversation } = require('./store/thread-memory');
const { claudeRetry } = require('./services/claude-retry');
const { getPricesForLocation, getPriceHistory, comparePrices, formatPriceDataForClaude } = require('./services/ev-prices');
const { lookupProperty, getClientProperties, getAllClients } = require('./services/client-service');
const { scrapeCostaSelectPage } = require('./services/costaselect-scraper');
const { lookupIdealista } = require('./services/idealista-lookup');
const {
  saveAlert,
  getAlertsForUser,
  deactivateAlert,
  updateLastChecked,
} = require('./services/alert-service');
const { findMatches } = require('./services/alert-matcher');
const { WebClient: SlackWebClient } = require('@slack/web-api');
const {
  embed: embedQuery,
  embedBatch: embedListings,
  cosineSimilarity,
  isConfigured: isEmbeddingConfigured,
} = require('./services/openai-embeddings');
const {
  buildSoftQueryInput,
  buildListingPostMappedInput,
} = require('./services/embedding-input');
const { expandLocations: expandCityAliases } = require('./services/location-aliases');
const { QueryLogger } = require('./services/query-logger');
const { verifyFreshness } = require('./services/freshness');
const queryCache = require('./services/query-cache');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Slack WebClient voor users.lookupByEmail (alert-koppeling vanuit dashboard).
// Initieer lazy zodat de bot ook draait als SLACK_BOT_TOKEN niet gezet is.
let _slackClient = null;
function getSlackClient() {
  if (!_slackClient && process.env.SLACK_BOT_TOKEN) {
    _slackClient = new SlackWebClient(process.env.SLACK_BOT_TOKEN);
  }
  return _slackClient;
}
// Sprint 2: per-stap modellen. Routing (intent) krijgt Haiku, zware
// reasoning (selector / vergelijk / pitch / buurt / prijs / algemeen)
// blijft op Sonnet.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';
const CLAUDE_MODEL_INTENT = process.env.CLAUDE_MODEL_INTENT
  || process.env.CLAUDE_MODEL
  || 'claude-haiku-4-5-20251001';

const expressApp = express();
expressApp.use(cors());
expressApp.use(express.json());

// Simple API key auth
function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

expressApp.use('/api', authenticate);

// Health check (no auth)
expressApp.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'woningbot-api' });
});

// ─── Property Lookup (direct, no AI) ───────────────────────────────────────

expressApp.post('/api/lookup', async (req, res) => {
  const { url } = req.body;
  const ts = new Date().toISOString();

  if (!url) return res.status(400).json({ error: 'url is required' });

  console.log(`[${ts}] [API] Lookup: ${url}`);

  try {
    let prop = null;

    if (url.includes('idealista.com')) {
      prop = await lookupIdealista(url);
    } else if (url.includes('costaselect.com')) {
      prop = await scrapeCostaSelectPage(url);
    } else {
      // Try as ref number
      const refMatch = url.match(/\d{5,8}/);
      if (refMatch) {
        prop = await lookupProperty(refMatch[0]);
      }
    }

    if (!prop) {
      return res.status(404).json({ error: 'Property not found' });
    }

    return res.json({
      title: prop.title || prop.ref || '',
      price: prop.price || null,
      location: prop.location || prop.town || '',
      bedrooms: prop.bedrooms || prop.beds || null,
      bathrooms: prop.bathrooms || prop.baths || null,
      size_m2: prop.size_m2 || prop.built_m2 || null,
      plot_m2: prop.plot_m2 || null,
      property_type: prop.property_type || '',
      description: prop.desc_nl || prop.description || '',
      features: prop.features || [],
      url: prop.url || url,
      thumbnail: prop.thumbnail || (prop.images && prop.images[0]?.url) || null,
      images: (prop.images || []).map(img => img?.url || img).filter(Boolean).slice(0, 6),
      source: prop.source || '',
    });
  } catch (err) {
    console.error(`[${ts}] [API] Lookup failed:`, err.message);
    return res.status(500).json({ error: `Lookup failed: ${err.message}` });
  }
});

// ─── Intent Detection ──────────────────────────────────────────────────────

const INTENT_PROMPT = `Je bent een intent classifier voor een vastgoed-chatbot. Classificeer het bericht van de gebruiker.

Mogelijke intents:
- "zoekwoning" — Zoekt woningen (bestaande bouw of algemeen). Bevat locatie, budget, kenmerken.
- "nieuwbouw" — Zoekt specifiek nieuwbouwprojecten.
- "vergelijk" — Wil 2+ woningen vergelijken. Bevat URLs of referentienummers.
- "pitch" — Wil een verkooppitch/presentatie voor een woning. Bevat URL of referentienummer.
- "buurt" — Wil informatie over een buurt/wijk/stad.
- "prijs" — Wil prijsinformatie, marktdata, trends voor een locatie.
- "klant" — Wil klantgegevens bekijken, shortlist, of alle klanten.
- "alert" — Wil een alert aanmaken, bekijken of stoppen.
- "verfijn" — Verfijnt een eerdere zoekopdracht (alleen als er een actieve sessie is).
- "algemeen" — Iets anders, algemene vraag.

Antwoord ALLEEN met een JSON object:
{"intent": "...", "query": "de relevante zoekterm/input zonder het commando-deel"}

Voorbeelden:
- "Villa in Estepona, 3 slpk, 500k" → {"intent": "zoekwoning", "query": "villa in Estepona, 3 slpk, 500k"}
- "Nieuwbouw Costa del Sol, 2 slaapkamers" → {"intent": "nieuwbouw", "query": "Costa del Sol, 2 slaapkamers"}
- "Vergelijk https://idealista.com/123 en https://idealista.com/456" → {"intent": "vergelijk", "query": "https://idealista.com/123 https://idealista.com/456"}
- "Maak een pitch voor 771846" → {"intent": "pitch", "query": "771846"}
- "Hoe is de buurt in Jávea?" → {"intent": "buurt", "query": "Jávea"}
- "Wat zijn de prijzen in Marbella?" → {"intent": "prijs", "query": "Marbella"}
- "Shortlist van Jan Janssen" → {"intent": "klant", "query": "Jan Janssen"}
- "Alert voor nieuwbouw in Estepona, max 400k" → {"intent": "alert", "query": "nieuwbouw in Estepona, max 400k"}
- "Toon alleen villa's met zwembad" → {"intent": "verfijn", "query": "alleen villa's met zwembad"}`;

async function detectIntent(message) {
  try {
    const response = await claude.messages.create({
      model: CLAUDE_MODEL_INTENT,
      max_tokens: 150,
      messages: [{ role: 'user', content: `${INTENT_PROMPT}\n\nBericht: "${message}"` }],
    });
    const text = response.content[0].text.trim();
    const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    return { intent: json.intent || 'algemeen', query: json.query || message };
  } catch (err) {
    console.error('[API] Intent detection failed:', err.message);
    return { intent: 'zoekwoning', query: message };
  }
}

// ─── Main Chat Endpoint ────────────────────────────────────────────────────

expressApp.post('/api/chat', async (req, res) => {
  const { message, sessionId, user_id: userId } = req.body;
  const ts = new Date().toISOString();

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }

  console.log(`[${ts}] [API] Chat: "${message.substring(0, 100)}" (session: ${sessionId || 'new'})`);

  const log = new QueryLogger({ userMessage: message, sessionId, userId, source: 'web' });

  try {
    // Detect intent
    const endIntent = log.startStep('intent_detection');
    const { intent, query } = await detectIntent(message);
    endIntent({ intent });
    log.setIntent(intent);
    console.log(`[${ts}] [API] Intent: ${intent}, Query: "${query.substring(0, 80)}"`);

    // If we have a session and intent is refinement, refine
    if (sessionId && (intent === 'verfijn' || intent === 'zoekwoning')) {
      const threadData = await getThread(sessionId);
      if (threadData && threadData.all_properties) {
        const result = await handleRefinement(sessionId, threadData, message, log);
        log.finish({ status: 'success' });
        return res.json(result);
      }
    }

    // Route to handler
    let result;
    switch (intent) {
      case 'zoekwoning':
        result = await handleNewSearch(query, log);
        break;
      case 'nieuwbouw':
        result = await handleNieuwbouw(query, log);
        break;
      case 'vergelijk':
        result = await handleVergelijk(query);
        break;
      case 'pitch':
        result = await handlePitch(query);
        break;
      case 'buurt':
        result = await handleBuurt(query);
        break;
      case 'prijs':
        result = await handlePrijs(query);
        break;
      case 'klant':
        result = await handleKlant(query);
        break;
      case 'alert':
        result = await handleAlert(query);
        break;
      default:
        result = await handleAlgemeen(message);
        break;
    }

    // Bepaal status uit resultaat (handlers kunnen 'response' meegeven met
    // foutboodschap maar geen properties — dat telt als no_results / parse_error)
    const isStructuredFail = result && /niet begrijpen|geen woningen vinden|geen daarvan voldoet|mislukt/i.test(result.response || '');
    const finalStatus = isStructuredFail
      ? (result.response.match(/niet begrijpen/i) ? 'parse_error' : 'no_results')
      : 'success';
    log.finish({ status: finalStatus });

    return res.json(result);

  } catch (error) {
    console.error(`[${ts}] [API] Error:`, error);
    log.finish({ status: 'exception', errorMessage: error.message || String(error) });
    return res.status(500).json({
      error: 'Er ging iets mis. Probeer het opnieuw.',
      sessionId: sessionId || null,
    });
  }
});

// ─── Klant-alerts vanuit dashboard ─────────────────────────────────────────

/**
 * Map dashboard email → Slack user_id via users.lookupByEmail.
 * Returnt null als email niet bestaat in de Slack workspace.
 */
async function lookupSlackUserByEmail(email) {
  const slack = getSlackClient();
  if (!slack) throw new Error('SLACK_BOT_TOKEN not configured');
  try {
    const result = await slack.users.lookupByEmail({ email });
    return result.user?.id || null;
  } catch (err) {
    if (err.data?.error === 'users_not_found') return null;
    throw err;
  }
}

/**
 * Stuur een test-batch DM met de huidige matches voor een net-aangemaakte alert.
 * Eenmalig direct na save zodat de gebruiker direct verifieert dat de alert werkt.
 * Daarna draait de daily cron normaal (delta-only via last_checked_at).
 */
async function sendInitialBatchDM(slackUserId, alert, matches) {
  const slack = getSlackClient();
  if (!slack) throw new Error('SLACK_BOT_TOKEN not configured');

  const filterParts = [];
  if (alert.location) filterParts.push(alert.location);
  if (alert.max_price) filterParts.push(`max €${Number(alert.max_price).toLocaleString('nl-NL')}`);
  if (alert.min_rooms) filterParts.push(`${alert.min_rooms}+ slpk`);
  const filterText = filterParts.length > 0 ? filterParts.join(', ') : 'alle criteria';
  const klantPrefix = alert.klant_naam ? `👤 *${alert.klant_naam}* — ` : '';

  if (matches.length === 0) {
    await slack.chat.postMessage({
      channel: slackUserId,
      text: `${klantPrefix.replace(/\*/g, '')}✨ Alert geactiveerd — momenteel 0 matches (${filterText})`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `${klantPrefix}✨ *Alert geactiveerd*\n` +
              `_Filter: ${filterText}_\n\n` +
              `Momenteel zijn er 0 woningen die aan deze criteria voldoen. ` +
              `Je krijgt automatisch een melding zodra er een nieuwe match binnenkomt.`,
          },
        },
      ],
    });
    return;
  }

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `${klantPrefix}✨ *Alert geactiveerd — ${matches.length} huidige match${matches.length > 1 ? 'es' : ''}*\n` +
          `_Filter: ${filterText}_\n` +
          `_Eenmalige test-batch. Daarna ontvang je alleen nieuwe woningen._`,
      },
    },
    { type: 'divider' },
  ];

  for (const m of matches) {
    const lines = [
      m.url ? `*<${m.url}|${m.title}>*` : `*${m.title}*`,
      m.location ? `📍 ${m.location}` : '',
      `💶 €${m.price.toLocaleString('nl-NL')}` +
        (m.beds ? `  🛏 ${m.beds} slpk` : '') +
        (m.size_m2 ? `  📐 ${m.size_m2}m²` : ''),
      m.type === 'unit' ? '_Nieuwbouw_' : '_Resale_',
    ].filter(Boolean);

    const block = { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } };
    if (m.image) {
      block.accessory = { type: 'image', image_url: m.image, alt_text: m.title };
    }
    blocks.push(block);
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `_Alert ID: \`${alert.id.slice(0, 8)}\` · Stop met \`/alert stop ${alert.id.slice(0, 8)}\`_`,
    }],
  });

  await slack.chat.postMessage({
    channel: slackUserId,
    blocks,
    text: `✨ Alert geactiveerd — ${matches.length} huidige match${matches.length > 1 ? 'es' : ''} (${filterText})`,
  });
}

/**
 * POST /api/alert/save
 * Body: { query_text, shortlist_id, klant_naam, user_email, label? }
 * Maakt een nieuwe alert aan, gekoppeld aan een dashboard-klant (shortlist).
 * Parsed de query naar hardFilters en saved met klant-context.
 */
expressApp.post('/api/alert/save', async (req, res) => {
  const { query_text, shortlist_id, klant_naam, user_email } = req.body;
  const ts = new Date().toISOString();

  if (!query_text || !user_email || !shortlist_id) {
    return res.status(400).json({
      error: 'query_text, user_email en shortlist_id zijn verplicht',
    });
  }

  // 1. Email → Slack user_id
  let slackUserId;
  try {
    slackUserId = await lookupSlackUserByEmail(user_email);
  } catch (err) {
    console.error(`[${ts}] [Alert] Slack lookup error:`, err.message);
    return res.status(500).json({ error: `Slack lookup faalde: ${err.message}` });
  }

  if (!slackUserId) {
    return res.status(404).json({
      error: `Email ${user_email} niet gevonden in Slack workspace. Kan alert niet koppelen aan een Slack-account.`,
    });
  }

  // 1b. Duplicate detection — zelfde query_text op zelfde shortlist?
  try {
    const sbUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const sbKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    const normalizedQuery = query_text.trim().toLowerCase();
    const checkUrl = `${sbUrl}/rest/v1/alerts?select=id,query_text&shortlist_id=eq.${encodeURIComponent(
      shortlist_id
    )}&is_active=eq.true`;
    const dupRes = await fetch(checkUrl, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
    });
    if (dupRes.ok) {
      const existing = await dupRes.json();
      const dup = Array.isArray(existing)
        ? existing.find(a => (a.query_text || '').trim().toLowerCase() === normalizedQuery)
        : null;
      if (dup) {
        return res.status(409).json({
          error: 'Er staat al een actieve alert voor deze klant met dezelfde zoekcriteria.',
          existing_alert_id: dup.id,
        });
      }
    }
  } catch (err) {
    // Niet-fataal — als de dedup-check faalt, ga door en laat de DB unique-constraint
    // (als die er ooit komt) of de gebruiker zelf duplicates oplossen.
    console.warn(`[${ts}] [Alert] Dedup check faalde (niet-fataal): ${err.message}`);
  }

  // 2. Parse query → hardFilters
  let parsed;
  try {
    parsed = await parseSearchQuery(query_text);
  } catch (err) {
    console.error(`[${ts}] [Alert] Parse error:`, err.message);
    return res.status(400).json({ error: `Kon query niet begrijpen: ${err.message}` });
  }

  const hf = parsed.hard_filters || {};
  const features = Array.isArray(hf.features) ? hf.features : [];

  // 3. Save alert
  try {
    const alert = await saveAlert({
      slack_user_id: slackUserId,
      slack_channel_id: slackUserId, // DM via user_id — alert-check.js DM't ook naar slack_user_id
      shortlist_id,
      klant_naam: klant_naam || null,
      query_text,
      dashboard_user_email: user_email,
      location: Array.isArray(hf.locations) && hf.locations.length > 0 ? hf.locations[0] : null,
      min_price: hf.price_min || null,
      max_price: hf.price_max || null,
      min_rooms: hf.bedrooms_min || null,
      min_size_m2: hf.size_min_m2 || null,
      has_pool: features.includes('pool') || null,
      has_terrace: features.includes('terrace') || null,
      has_garden: features.includes('garden') || null,
      is_active: true,
    });

    console.log(
      `[${ts}] [Alert] Saved for ${user_email} (Slack ${slackUserId}) — klant "${klant_naam}", shortlist ${shortlist_id}`
    );

    // 4. Initial-batch DM (test-modus): top 10 huidige matches versturen,
    // daarna last_checked_at=NOW zodat de daily cron alleen nieuwe listings ziet.
    // Faalt non-fataal: alert blijft staan ook als de DM struikelt.
    try {
      const matches = await findMatches(alert, { cutoff: null, limit: 10 });
      await sendInitialBatchDM(slackUserId, alert, matches);
      await updateLastChecked(alert.id);
      console.log(
        `[${ts}] [Alert] Initial-batch DM verstuurd voor ${alert.id.slice(0, 8)}: ${matches.length} matches`
      );
    } catch (dmErr) {
      console.error(`[${ts}] [Alert] Initial-batch DM faalde (niet-fataal):`, dmErr.message);
    }

    return res.json({ ok: true, alert });
  } catch (err) {
    console.error(`[${ts}] [Alert] Save error:`, err.message);
    // Detect max-alerts limit (saveAlert throwt met "actieve alerts" in de message)
    if (err.message && err.message.includes('actieve alerts')) {
      return res.status(429).json({
        error: 'Je hebt het maximum aantal actieve alerts bereikt. Deactiveer eerst een bestaande alert om er een nieuwe aan te maken.',
      });
    }
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/alert/by-shortlist?shortlist_id=...
 * Returnt actieve alerts voor een specifieke klant-shortlist.
 */
expressApp.get('/api/alert/by-shortlist', async (req, res) => {
  const { shortlist_id } = req.query;
  if (!shortlist_id) {
    return res.status(400).json({ error: 'shortlist_id is verplicht' });
  }

  try {
    const sbUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const sbKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
    const url = `${sbUrl}/rest/v1/alerts?select=*&shortlist_id=eq.${shortlist_id}&is_active=eq.true&order=created_at.desc`;
    const result = await fetch(url, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
    });
    if (!result.ok) {
      return res.status(500).json({ error: `Supabase ${result.status}` });
    }
    const rows = await result.json();
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/alert/:id
 * Body: { user_email } — owner-check via slack_user_id lookup.
 */
expressApp.delete('/api/alert/:id', async (req, res) => {
  const { id } = req.params;
  const { user_email } = req.body || {};

  if (!user_email) {
    return res.status(400).json({ error: 'user_email is verplicht voor owner-check' });
  }

  let slackUserId;
  try {
    slackUserId = await lookupSlackUserByEmail(user_email);
  } catch (err) {
    return res.status(500).json({ error: `Slack lookup faalde: ${err.message}` });
  }
  if (!slackUserId) {
    return res.status(404).json({ error: `Email ${user_email} niet gevonden in Slack` });
  }

  try {
    const result = await deactivateAlert(id, slackUserId);
    return res.json({ ok: true, deactivated: result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Handler: Zoekwoning (existing) ────────────────────────────────────────

/**
 * Idealista (en warm-cache) listings on-the-fly embedden + cosine similarity
 * berekenen vs query-embedding. Faalt stilletjes — bij error gewoon de
 * originele listings zonder similarity-veld.
 */
async function attachIdealistaSimilarity(listings, queryEmbedding) {
  if (!Array.isArray(listings) || listings.length === 0) return listings;
  if (!queryEmbedding) return listings;

  const inputs = [];
  const idxMap = [];
  for (let i = 0; i < listings.length; i++) {
    const text = buildListingPostMappedInput(listings[i]);
    if (text && text.trim().length > 20) {
      inputs.push(text);
      idxMap.push(i);
    }
  }
  if (inputs.length === 0) return listings;

  let vectors;
  try {
    vectors = await embedListings(inputs);
  } catch (err) {
    console.warn(`[API] Idealista similarity-embed faalde: ${err.message}`);
    return listings;
  }

  for (let j = 0; j < idxMap.length; j++) {
    listings[idxMap[j]].similarity = cosineSimilarity(queryEmbedding, vectors[j]);
  }
  console.log(`[API] ${idxMap.length} Idealista listings verrijkt met similarity`);
  return listings;
}

async function handleNewSearch(queryText, log = null) {
  const ts = new Date().toISOString();
  const sessionId = uuidv4();

  let clientProfile;
  const endParser = log?.startStep('parser');
  try {
    clientProfile = await parseSearchQuery(queryText);
    endParser?.({ ok: true });
  } catch (err) {
    endParser?.({ ok: false, error: err.message });
    console.error(`[${ts}] [API] Parse failed:`, err.message);
    return {
      response: 'Ik kon je zoekopdracht niet begrijpen. Probeer het anders te formuleren, bijvoorbeeld:\n\n"Villa in Estepona, budget 500k-800k, 3 slaapkamers, zwembad"',
      sessionId,
    };
  }

  const hardFilters = clientProfile.hard_filters || {};

  // Locatie-aliassen (Javea ↔ Xàbia, Alicante ↔ Alacant)
  if (Array.isArray(hardFilters.locations) && hardFilters.locations.length > 0) {
    const before = hardFilters.locations;
    hardFilters.locations = expandCityAliases(before);
    if (hardFilters.locations.length > before.length) {
      console.log(`[${ts}] [API] Locaties uitgebreid: ${JSON.stringify(before)} → ${JSON.stringify(hardFilters.locations)}`);
    }
  }

  const locations = hardFilters.locations || [];
  const locationStr = locations.length > 0 ? locations.join(', ') : 'onbekend';

  console.log(`[${ts}] [API] Searching for: ${locationStr}`);

  // Soft-criteria → embedding (fase 5.1). Faalt stilletjes; zonder embedding
  // valt searchSupabase terug op legacy ranking (prijs ASC).
  let queryEmbedding = null;
  const softQueryText = buildSoftQueryInput(clientProfile.soft_criteria);
  if (softQueryText && isEmbeddingConfigured()) {
    try {
      queryEmbedding = await embedQuery(softQueryText);
      console.log(`[${ts}] [API] Soft query embedded (${queryEmbedding.length}d)`);
    } catch (embErr) {
      console.warn(`[${ts}] [API] Embedding failed: ${embErr.message}`);
    }
  }

  // Cache-key met soft-criteria zodat verschillende vibey queries niet
  // dezelfde cached response krijgen
  const cacheKey = softQueryText
    ? { ...hardFilters, _soft: softQueryText }
    : hardFilters;

  // Sprint 2: cache-check vóór scraping
  const endCache = log?.startStep('cache_lookup');
  const cached = await queryCache.get(cacheKey);
  endCache?.({ hit: !!cached });
  if (cached) {
    console.log(`[${ts}] [API] Cache HIT — returning cached response`);
    log?.setCounts({
      totalFound: cached.stats?.total_found,
      selectedCount: cached.stats?.selected,
    });
    return { ...cached, sessionId, _cached: true };
  }

  // Sprint 2: probeer warm-cache (prewarm) per stad, scrape Apify alleen
  // voor steden die niet warm zijn.
  const warmListings = [];
  const warmedCities = [];
  const coldCities = [];
  for (const city of locations) {
    const warm = await queryCache.getWarmListings(city);
    if (warm && Array.isArray(warm) && warm.length > 0) {
      warmListings.push(...warm);
      warmedCities.push(city);
    } else {
      coldCities.push(city);
    }
  }
  if (warmedCities.length > 0) {
    console.log(`[${ts}] [API] Warm-cache hit: ${warmedCities.join(', ')} (${warmListings.length} listings)`);
  }

  const endIdealista = log?.startScrapeStep('idealista');
  const endSupabaseSearch = log?.startScrapeStep('supabase');
  // Apify alleen voor cold cities; supabase-search loopt voor alle locaties.
  // Idealista wordt na scrape on-the-fly geëmbed zodat selector semantic_match
  // krijgt op live results.
  const idealistaPromise = (async () => {
    const live = coldCities.length > 0
      ? await searchIdealista({ ...hardFilters, locations: coldCities })
      : [];
    const merged = [...warmListings, ...live];
    return queryEmbedding ? attachIdealistaSimilarity(merged, queryEmbedding) : merged;
  })();
  const [idealistaSettled, supabaseSettled] = await Promise.allSettled([
    idealistaPromise,
    searchSupabase(hardFilters, { queryEmbedding }),
  ]);
  const idealistaListings = idealistaSettled.status === 'fulfilled' ? idealistaSettled.value : [];
  const supabaseListings = supabaseSettled.status === 'fulfilled' ? supabaseSettled.value : [];
  endIdealista?.({
    count: idealistaListings.length,
    warm_used: warmedCities.length,
    apify_used: coldCities.length,
    error: idealistaSettled.status === 'rejected' ? String(idealistaSettled.reason?.message || idealistaSettled.reason) : null,
  });
  endSupabaseSearch?.({
    count: supabaseListings.length,
    error: supabaseSettled.status === 'rejected' ? String(supabaseSettled.reason?.message || supabaseSettled.reason) : null,
  });

  const allRaw = [...idealistaListings, ...supabaseListings];
  log?.setCounts({ totalFound: allRaw.length });

  if (allRaw.length === 0) {
    return {
      response: `Ik heb gezocht in ${locationStr} maar kon geen woningen vinden die aan je criteria voldoen. Probeer je zoekopdracht aan te passen.`,
      sessionId, properties: [],
    };
  }

  const endDedup = log?.startStep('dedup');
  const deduplicated = deduplicateListings(allRaw);
  endDedup?.({ before: allRaw.length, after: deduplicated.length });

  const endFilter = log?.startStep('filter');
  const allProperties = preFilterListings(deduplicated, hardFilters);
  endFilter?.({ before: deduplicated.length, after: allProperties.length });

  if (allProperties.length === 0) {
    return {
      response: `Ik vond ${allRaw.length} woningen, maar geen daarvan voldoet aan je harde criteria. Probeer ruimere filters.`,
      sessionId, properties: [],
    };
  }

  let selectionResult;
  const endSelector = log?.startStep('selector');
  try {
    selectionResult = await selectProperties(clientProfile, allProperties);
    endSelector?.({ ok: true, selected: (selectionResult.selections || []).length });
  } catch (err) {
    endSelector?.({ ok: false, error: err.message });
    console.error(`[${ts}] [API] Selection failed:`, err.message);
    return { response: 'De AI-selectie is mislukt. Probeer het opnieuw.', sessionId };
  }

  const selections = postValidateSelections(selectionResult.selections || [], allProperties, hardFilters);
  log?.setCounts({ selectedCount: selections.length });

  try {
    const selectedProps = selections.map(s =>
      allProperties.find(p => p.id === s.property_id || p.url === s.property_id || String(p.id) === String(s.property_id))
    ).filter(Boolean);
    await enrichListingsWithDetails(selectedProps, 8);
  } catch (err) {
    console.warn(`[${ts}] [API] Detail enrichment failed (non-fatal):`, err.message);
  }

  setThread(sessionId, {
    client_profile: clientProfile,
    all_properties: allProperties.map(p => ({
      id: p.id, title: p.title, price: p.price, property_type: p.property_type,
      location: p.location, bedrooms: p.bedrooms, bathrooms: p.bathrooms,
      size_m2: p.size_m2, features: p.features, url: p.url, source: p.source,
      thumbnail: p.thumbnail, is_new_build: p.is_new_build, municipality: p.municipality,
    })),
    current_selection: selections, photo_assessments: {},
    conversation_history: [], original_query: queryText,
    created_at: Date.now(), type: 'api',
  });

  const mapped = mapSelections(selections, allProperties);

  // Sprint 1: freshness check op Supabase-properties in top-10
  const endFreshness = log?.startStep('freshness');
  const freshness = await verifyFreshness(mapped);
  endFreshness?.({ removed: freshness.removed });
  const properties = freshness.kept;
  if (freshness.removed > 0) {
    log?.setCounts({ selectedCount: properties.length });
  }

  const summary = selectionResult.summary || `${properties.length} woningen gevonden in ${locationStr}`;

  const result = {
    response: summary, properties,
    stats: {
      total_found: allRaw.length,
      after_filter: allProperties.length,
      selected: properties.length,
      removed_dead: freshness.removed,
    },
  };

  // Sprint 2: stop response in cache (zonder sessionId — die is per request uniek)
  if (properties.length > 0) {
    void queryCache.set(cacheKey, result);
  }

  return { ...result, sessionId };
}

// ─── Handler: Nieuwbouw ────────────────────────────────────────────────────

async function handleNieuwbouw(queryText, log = null) {
  const ts = new Date().toISOString();

  let clientProfile;
  const endParser = log?.startStep('parser');
  try {
    clientProfile = await parseSearchQuery(queryText);
    endParser?.({ ok: true });
  } catch (err) {
    endParser?.({ ok: false, error: err.message });
    return { response: 'Ik kon je nieuwbouw-zoekopdracht niet begrijpen. Probeer: "nieuwbouw Costa del Sol, 2 slpk, max 300k"' };
  }

  const hardFilters = { ...(clientProfile.hard_filters || {}), is_new_build: true };

  const endIdealista = log?.startScrapeStep('idealista');
  const endSupabaseSearch = log?.startScrapeStep('supabase');
  const [idealistaSettled, supabaseSettled] = await Promise.allSettled([
    searchIdealista(hardFilters),
    searchSupabase(hardFilters),
  ]);
  const idealistaListings = idealistaSettled.status === 'fulfilled' ? idealistaSettled.value : [];
  const supabaseListings = supabaseSettled.status === 'fulfilled' ? supabaseSettled.value : [];
  endIdealista?.({
    count: idealistaListings.length,
    error: idealistaSettled.status === 'rejected' ? String(idealistaSettled.reason?.message || idealistaSettled.reason) : null,
  });
  endSupabaseSearch?.({
    count: supabaseListings.length,
    error: supabaseSettled.status === 'rejected' ? String(supabaseSettled.reason?.message || supabaseSettled.reason) : null,
  });

  const allRaw = [...idealistaListings, ...supabaseListings].filter(p => p.is_new_build !== false);
  log?.setCounts({ totalFound: allRaw.length });
  if (allRaw.length === 0) {
    return { response: 'Geen nieuwbouwprojecten gevonden voor deze criteria. Probeer een andere locatie of ruimer budget.' };
  }

  const endDedup = log?.startStep('dedup');
  const deduplicated = deduplicateListings(allRaw);
  endDedup?.({ before: allRaw.length, after: deduplicated.length });

  const endFilter = log?.startStep('filter');
  const allProperties = preFilterListings(deduplicated, hardFilters);
  endFilter?.({ before: deduplicated.length, after: allProperties.length });

  let selectionResult;
  const endSelector = log?.startStep('selector');
  try {
    selectionResult = await selectProperties(clientProfile, allProperties);
    endSelector?.({ ok: true, selected: (selectionResult.selections || []).length });
  } catch (err) {
    endSelector?.({ ok: false, error: err.message });
    return { response: 'De selectie is mislukt. Probeer het opnieuw.' };
  }

  const selections = selectionResult.selections || [];
  log?.setCounts({ selectedCount: selections.length });
  const properties = mapSelections(selections, allProperties);

  return {
    response: selectionResult.summary || `${selections.length} nieuwbouwprojecten gevonden`,
    properties,
    stats: { total_found: allRaw.length, after_filter: allProperties.length, selected: selections.length },
  };
}

// ─── Handler: Vergelijk ────────────────────────────────────────────────────

async function handleVergelijk(queryText) {
  const ts = new Date().toISOString();

  // Extract URLs or refs from query
  const urls = queryText.match(/https?:\/\/[^\s]+/g) || [];
  const refs = queryText.match(/\b\d{5,8}\b/g) || [];
  const inputs = [...urls, ...refs];

  if (inputs.length < 2) {
    return { response: 'Geef minimaal 2 woningen op om te vergelijken. Gebruik URLs of referentienummers.\n\nBijvoorbeeld: "Vergelijk https://idealista.com/inmueble/123 en https://idealista.com/inmueble/456"' };
  }

  // Resolve properties
  const properties = [];
  for (const input of inputs.slice(0, 3)) {
    try {
      let prop = null;
      if (input.includes('idealista.com')) {
        prop = await lookupIdealista(input);
      } else if (input.includes('costaselect.com')) {
        prop = await scrapeCostaSelectPage(input);
      } else {
        // Try as ref number from Supabase
        prop = await lookupProperty(input);
      }
      if (prop) properties.push(prop);
    } catch (err) {
      console.warn(`[${ts}] [API] Could not resolve: ${input}:`, err.message);
    }
  }

  if (properties.length < 2) {
    return { response: `Kon slechts ${properties.length} van de ${inputs.length} woningen ophalen. Controleer de URLs/referenties.` };
  }

  // Build comparison with Claude
  const propDescriptions = properties.map((p, i) => {
    const details = [
      `Woning ${i + 1}: ${p.title || p.ref || 'Onbekend'}`,
      p.price ? `Prijs: €${Number(p.price).toLocaleString('nl-NL')}` : null,
      p.location || p.town ? `Locatie: ${p.location || p.town}` : null,
      p.bedrooms || p.beds ? `Slaapkamers: ${p.bedrooms || p.beds}` : null,
      p.bathrooms || p.baths ? `Badkamers: ${p.bathrooms || p.baths}` : null,
      p.size_m2 || p.built_m2 ? `Oppervlakte: ${p.size_m2 || p.built_m2}m²` : null,
      p.features ? `Kenmerken: ${Array.isArray(p.features) ? p.features.join(', ') : p.features}` : null,
      p.url ? `URL: ${p.url}` : null,
    ].filter(Boolean).join('\n');
    return details;
  }).join('\n\n');

  const comparison = await claudeRetry(() => claude.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `Je bent een ervaren Spaanse vastgoedadviseur. Vergelijk deze woningen voor een Nederlandse koper. Geef een duidelijke vergelijking met plus- en minpunten per woning en een conclusie. Antwoord in het Nederlands.\n\n${propDescriptions}`,
    }],
  }));

  const answer = comparison.content[0].text;

  return {
    response: answer,
    properties: properties.map(p => ({
      id: p.ref || p.id || '',
      title: p.title || `${p.property_type || 'Woning'} in ${p.town || p.location || ''}`,
      price: p.price || null,
      location: p.location || p.town || '',
      bedrooms: p.bedrooms || p.beds || null,
      bathrooms: p.bathrooms || p.baths || null,
      size_m2: p.size_m2 || p.built_m2 || null,
      url: p.url || '',
      thumbnail: p.thumbnail || (p.images && p.images[0]?.url) || null,
      source: p.source || '',
      motivation: '',
      score: null,
    })),
  };
}

// ─── Handler: Pitch ────────────────────────────────────────────────────────

async function handlePitch(queryText) {
  const ts = new Date().toISOString();

  // Extract URL or ref
  const urlMatch = queryText.match(/https?:\/\/[^\s]+/);
  const refMatch = queryText.match(/\b\d{5,8}\b/);
  const input = urlMatch?.[0] || refMatch?.[0];

  if (!input) {
    return { response: 'Geef een woning-URL of referentienummer op.\n\nBijvoorbeeld: "Pitch voor https://idealista.com/inmueble/123" of "Pitch voor 771846"' };
  }

  // Resolve property
  let prop = null;
  try {
    if (input.includes('idealista.com')) {
      prop = await lookupIdealista(input);
    } else if (input.includes('costaselect.com')) {
      prop = await scrapeCostaSelectPage(input);
    } else {
      prop = await lookupProperty(input);
    }
  } catch (err) {
    console.warn(`[${ts}] [API] Pitch lookup failed:`, err.message);
  }

  if (!prop) {
    return { response: `Kon de woning niet ophalen: ${input}. Controleer de URL of het referentienummer.` };
  }

  // Extract buyer context from query (everything after the URL/ref)
  const buyerContext = queryText.replace(input, '').replace(/pitch|voor|maak/gi, '').trim();

  const propDetails = [
    prop.title || `${prop.property_type || 'Woning'} in ${prop.town || ''}`,
    prop.price ? `Prijs: €${Number(prop.price).toLocaleString('nl-NL')}` : null,
    prop.location || prop.town ? `Locatie: ${prop.location || prop.town}${prop.province ? `, ${prop.province}` : ''}` : null,
    prop.bedrooms || prop.beds ? `Slaapkamers: ${prop.bedrooms || prop.beds}` : null,
    prop.size_m2 || prop.built_m2 ? `Woonoppervlakte: ${prop.size_m2 || prop.built_m2}m²` : null,
    prop.plot_m2 ? `Perceel: ${prop.plot_m2}m²` : null,
    prop.features ? `Kenmerken: ${Array.isArray(prop.features) ? prop.features.join(', ') : prop.features}` : null,
    prop.desc_nl || prop.description ? `Beschrijving: ${(prop.desc_nl || prop.description || '').substring(0, 500)}` : null,
  ].filter(Boolean).join('\n');

  const pitchResponse = await claudeRetry(() => claude.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Je bent een senior vastgoedconsultant van Costa Select, een Nederlandse aankoopmakelaar in Spanje. Schrijf een overtuigende, professionele pitch voor deze woning. De pitch is bedoeld om aan een potentiële koper te sturen.

${buyerContext ? `Koperprofiel: ${buyerContext}\n` : ''}
Woninggegevens:
${propDetails}

Schrijf de pitch in het Nederlands. Maak het persoonlijk, professioneel en overtuigend. Benadruk de sterke punten en de unieke waardepropositie.`,
    }],
  }));

  return {
    response: pitchResponse.content[0].text,
    properties: [{
      id: prop.ref || prop.id || '',
      title: prop.title || `${prop.property_type || 'Woning'} in ${prop.town || ''}`,
      price: prop.price || null,
      location: prop.location || prop.town || '',
      bedrooms: prop.bedrooms || prop.beds || null,
      bathrooms: prop.bathrooms || prop.baths || null,
      size_m2: prop.size_m2 || prop.built_m2 || null,
      url: prop.url || '',
      thumbnail: prop.thumbnail || (prop.images && prop.images[0]?.url) || null,
      source: prop.source || '',
      motivation: '', score: null,
    }],
  };
}

// ─── Handler: Buurt ────────────────────────────────────────────────────────

async function handleBuurt(queryText) {
  const location = queryText.trim();
  if (!location) {
    return { response: 'Geef een locatie op. Bijvoorbeeld: "Buurt Jávea" of "Buurt Estepona"' };
  }

  // Get price data if available
  let priceContext = '';
  try {
    const priceData = await getPricesForLocation(location);
    if (priceData && priceData.length > 0) {
      priceContext = `\n\nMarktdata (Engel & Völkers):\n${formatPriceDataForClaude(priceData)}`;
    }
  } catch (err) {
    console.warn('[API] Price data for buurt failed:', err.message);
  }

  const buurtResponse = await claudeRetry(() => claude.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Je bent een expert in Spaans vastgoed en lokale wijken. Geef een uitgebreide buurtanalyse voor "${location}". Antwoord in het Nederlands.

Behandel:
1. Algemene sfeer en karakter van de buurt/stad
2. Type bewoners (expats, lokaal, toeristen, gepensioneerden)
3. Voorzieningen (supermarkten, restaurants, ziekenhuizen, scholen)
4. Bereikbaarheid (vliegveld, snelweg, OV)
5. Sterke punten voor Nederlandse kopers
6. Aandachtspunten of nadelen
7. Prijsindicatie en marktsituatie${priceContext}`,
    }],
  }));

  return { response: buurtResponse.content[0].text };
}

// ─── Handler: Prijs ────────────────────────────────────────────────────────

async function handlePrijs(queryText) {
  const location = queryText.trim();
  if (!location) {
    return { response: 'Geef een locatie op. Bijvoorbeeld: "Prijs Marbella" of "Prijzen Costa del Sol"' };
  }

  let priceData = null;
  let historyData = null;
  try {
    priceData = await getPricesForLocation(location);
    historyData = await getPriceHistory(location);
  } catch (err) {
    console.warn('[API] Price data failed:', err.message);
  }

  if (!priceData || priceData.length === 0) {
    return { response: `Geen marktdata beschikbaar voor "${location}". Probeer een andere locatie (bijv. een stad of regio in Spanje).` };
  }

  const priceContext = formatPriceDataForClaude(priceData);
  const historyContext = historyData && historyData.length > 0
    ? `\n\nHistorische data:\n${historyData.map(h => `${h.year} Q${h.quarter}: €${h.price_per_sqm}/m² (${h.yoy_change_pct > 0 ? '+' : ''}${h.yoy_change_pct}%)`).join('\n')}`
    : '';

  const prijsResponse = await claudeRetry(() => claude.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `Je bent een vastgoedmarktanalist gespecialiseerd in Spanje. Analyseer de marktdata voor "${location}" en geef een helder overzicht voor een Nederlandse koper/investeerder. Antwoord in het Nederlands.

Marktdata (bron: Engel & Völkers):
${priceContext}${historyContext}

Geef:
1. Huidige gemiddelde prijzen (koop en eventueel huur)
2. Prijsontwikkeling
3. Vergelijking met omliggende gebieden als relevant
4. Advies voor kopers/investeerders`,
    }],
  }));

  return { response: prijsResponse.content[0].text };
}

// ─── Handler: Klant ────────────────────────────────────────────────────────

async function handleKlant(queryText) {
  const input = queryText.trim().toLowerCase();

  if (input === 'lijst' || input === 'alle' || input === 'all') {
    try {
      const clients = await getAllClients();
      if (!clients || clients.length === 0) {
        return { response: 'Geen klanten gevonden.' };
      }
      const list = clients.map(c => `• ${c.client_name} (${c.count || '?'} woningen)`).join('\n');
      return { response: `**Alle klanten:**\n\n${list}` };
    } catch (err) {
      return { response: 'Kon de klantenlijst niet ophalen.' };
    }
  }

  // Specific client
  const clientName = queryText.trim();
  if (!clientName) {
    return { response: 'Geef een klantnaam op of typ "lijst" voor alle klanten.\n\nBijvoorbeeld: "Klant Jan Janssen"' };
  }

  try {
    const properties = await getClientProperties(clientName);
    if (!properties || properties.length === 0) {
      return { response: `Geen opgeslagen woningen gevonden voor "${clientName}".` };
    }

    const propList = properties.map(row => {
      const p = row.property || {};
      return [
        p.price ? `€${Number(p.price).toLocaleString('nl-NL')}` : '',
        p.property_type || '',
        p.town || '',
        p.beds ? `${p.beds} slpk` : '',
        row.note ? `📝 ${row.note}` : '',
        row.url ? row.url : '',
      ].filter(Boolean).join(' · ');
    }).join('\n');

    return { response: `**Shortlist van ${clientName}** (${properties.length} woningen):\n\n${propList}` };
  } catch (err) {
    return { response: `Kon de shortlist van "${clientName}" niet ophalen.` };
  }
}

// ─── Handler: Alert ────────────────────────────────────────────────────────

async function handleAlert(queryText) {
  const input = queryText.trim().toLowerCase();

  if (input === 'lijst' || input === 'bekijk' || input === 'show') {
    return { response: 'Alerts bekijken is momenteel alleen beschikbaar via Slack (/alert lijst). Web-interface volgt binnenkort.' };
  }

  if (input.startsWith('stop')) {
    return { response: 'Alerts stoppen is momenteel alleen beschikbaar via Slack (/alert stop). Web-interface volgt binnenkort.' };
  }

  // Create alert — parse with Claude
  try {
    const parseResponse = await claudeRetry(() => claude.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Parse deze alert-criteria naar JSON. Geef ALLEEN JSON terug:\n{"location": string|null, "min_price": number|null, "max_price": number|null, "min_rooms": number|null, "has_pool": boolean|null, "has_sea_view": boolean|null}\n\nCriteria: "${queryText}"`,
      }],
    }));

    const text = parseResponse.content[0].text;
    const criteria = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');

    if (!criteria.location) {
      return { response: 'Geef een locatie op voor de alert. Bijvoorbeeld: "Alert nieuwbouw Estepona, max 400k, 2 slpk"' };
    }

    return {
      response: `Alert-criteria herkend:\n• Locatie: ${criteria.location}\n${criteria.max_price ? `• Max. prijs: €${criteria.max_price.toLocaleString('nl-NL')}\n` : ''}${criteria.min_rooms ? `• Min. slaapkamers: ${criteria.min_rooms}\n` : ''}\nAlerts aanmaken via het platform wordt binnenkort ondersteund. Gebruik voorlopig /alert in Slack.`,
    };
  } catch (err) {
    return { response: 'Kon de alert-criteria niet verwerken. Probeer: "Alert nieuwbouw Estepona, max 400k"' };
  }
}

// ─── Handler: Algemeen ─────────────────────────────────────────────────────

async function handleAlgemeen(message) {
  const response = await claudeRetry(() => claude.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1000,
    system: `Je bent WoningBot, de AI-assistent van Costa Select — een Nederlandse aankoopmakelaar in Spanje. Je helpt consultants met het zoeken en beoordelen van Spaans vastgoed. Antwoord altijd in het Nederlands en wees beknopt maar behulpzaam.

Je kunt helpen met:
• Woningen zoeken (bijv. "villa in Estepona, 3 slpk, 500k")
• Nieuwbouw zoeken (bijv. "nieuwbouw Costa del Sol")
• Woningen vergelijken (geef 2+ URLs)
• Verkooppitch maken (geef een URL of referentienummer)
• Buurtinformatie (bijv. "buurt Jávea")
• Prijsanalyse (bijv. "prijzen Marbella")
• Klant-shortlists bekijken
• Alerts instellen`,
    messages: [{ role: 'user', content: message }],
  }));

  return { response: response.content[0].text };
}

// ─── Handler: Refinement (existing) ────────────────────────────────────────

async function handleRefinement(sessionId, threadData, feedback, _log = null) {
  const ts = new Date().toISOString();
  addConversation(sessionId, 'consultant', feedback);

  const refinement = await refineSelection(threadData, feedback);

  if (refinement.needs_new_scrape && refinement.new_filters) {
    const mergedFilters = { ...threadData.client_profile.hard_filters, ...refinement.new_filters };
    let idealistaListings = [], supabaseListings = [];
    try {
      [idealistaListings, supabaseListings] = await Promise.all([
        searchIdealista(mergedFilters), searchSupabase(mergedFilters),
      ]);
    } catch (err) {
      console.error(`[${ts}] [API] Re-scrape failed:`, err.message);
    }

    const combined = [...threadData.all_properties, ...idealistaListings, ...supabaseListings];
    const deduped = deduplicateListings(combined);
    const updatedProfile = { ...threadData.client_profile, hard_filters: mergedFilters };
    updateThread(sessionId, { all_properties: deduped, client_profile: updatedProfile });

    const reselection = await selectProperties(updatedProfile, deduped);
    const selections = reselection.selections || [];
    updateThread(sessionId, { current_selection: selections });
    addConversation(sessionId, 'bot', refinement.response_to_consultant || 'Selectie aangepast.');

    return { response: refinement.response_to_consultant || 'Selectie aangepast.', sessionId, properties: mapSelections(selections, deduped) };
  }

  const selections = refinement.selections || [];
  updateThread(sessionId, { current_selection: selections });
  addConversation(sessionId, 'bot', refinement.response_to_consultant || 'Selectie aangepast.');

  return { response: refinement.response_to_consultant || 'Selectie aangepast.', sessionId, properties: mapSelections(selections, threadData.all_properties) };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function mapSelections(selections, allProperties) {
  return selections.map(s => {
    const prop = allProperties.find(p =>
      p.id === s.property_id || p.url === s.property_id || String(p.id) === String(s.property_id)
    );
    return {
      id: s.property_id,
      title: prop?.title || 'Onbekend',
      price: prop?.price || null,
      location: prop?.location || '',
      bedrooms: prop?.bedrooms || null,
      bathrooms: prop?.bathrooms || null,
      size_m2: prop?.size_m2 || null,
      url: prop?.url || '',
      thumbnail: prop?.thumbnail || null,
      source: prop?.source || '',
      motivation: s.motivation || '',
      score: s.match_score ?? s.score ?? null,
      // Sprint 1: structured selector output
      reasons_for: Array.isArray(s.reasons_for) ? s.reasons_for : [],
      reasons_against: Array.isArray(s.reasons_against) ? s.reasons_against : [],
      highlights: Array.isArray(s.highlights) ? s.highlights : [],
      // Cross-portal info (was al in dedup, niet eerder doorgegeven)
      also_on: prop?.also_on || [],
    };
  });
}

function startApiServer() {
  const port = process.env.API_PORT || 3001;
  expressApp.listen(port, () => {
    console.log(`🌐 WoningBot API running on port ${port}`);
  });
}

module.exports = { startApiServer };
