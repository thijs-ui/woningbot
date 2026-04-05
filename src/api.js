/**
 * REST API server for WoningBot.
 * Runs alongside the Slack Bot to serve the Costa Select platform.
 */

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const { parseSearchQuery } = require('./services/claude-parser');
const { selectProperties } = require('./services/claude-selector');
const { searchIdealista, enrichListingsWithDetails } = require('./services/idealista-direct');
const { searchSupabase } = require('./services/supabase-search');
const { deduplicateListings } = require('./services/dedup');
const { preFilterListings, postValidateSelections } = require('./services/property-filter');
const { refineSelection } = require('./services/claude-refiner');
const { getThread, setThread, updateThread, addConversation } = require('./store/thread-memory');

const app = express();
app.use(cors());
app.use(express.json());

// Simple API key auth
function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use('/api', authenticate);

// Health check (no auth)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'woningbot-api' });
});

/**
 * POST /api/chat
 * Body: { message: string, sessionId?: string }
 * Returns: { response: string, sessionId: string, properties?: array, step?: string }
 */
app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body;
  const ts = new Date().toISOString();

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }

  console.log(`[${ts}] [API] Chat message: "${message.substring(0, 100)}" (session: ${sessionId || 'new'})`);

  try {
    // If we have a session, this is a follow-up / refinement
    if (sessionId) {
      const threadData = await getThread(sessionId);
      if (threadData && threadData.all_properties) {
        // Refine existing search
        const result = await handleRefinement(sessionId, threadData, message);
        return res.json(result);
      }
    }

    // New search — run the full pipeline
    const result = await handleNewSearch(message);
    return res.json(result);

  } catch (error) {
    console.error(`[${ts}] [API] Error:`, error);
    return res.status(500).json({
      error: 'Er ging iets mis. Probeer het opnieuw.',
      sessionId: sessionId || null,
    });
  }
});

/**
 * Handle a new property search (equivalent to /zoekwoning)
 */
async function handleNewSearch(queryText) {
  const ts = new Date().toISOString();
  const sessionId = uuidv4();

  // Step 1: Parse query with Claude
  let clientProfile;
  try {
    clientProfile = await parseSearchQuery(queryText);
  } catch (err) {
    console.error(`[${ts}] [API] Parse failed:`, err.message);
    return {
      response: 'Ik kon je zoekopdracht niet begrijpen. Probeer het anders te formuleren, bijvoorbeeld:\n\n"Villa in Estepona, budget 500k-800k, 3 slaapkamers, zwembad"',
      sessionId,
    };
  }

  const hardFilters = clientProfile.hard_filters || {};
  const locations = hardFilters.locations || [];
  const locationStr = locations.length > 0 ? locations.join(', ') : 'onbekend';

  // Step 2: Search all portals
  console.log(`[${ts}] [API] Searching for: ${locationStr}`);

  const [idealistaListings, supabaseListings] = await Promise.allSettled([
    searchIdealista(hardFilters),
    searchSupabase(hardFilters),
  ]).then(([idealista, supabase]) => {
    return [
      idealista.status === 'fulfilled' ? idealista.value : [],
      supabase.status === 'fulfilled' ? supabase.value : [],
    ];
  });

  const allRaw = [...idealistaListings, ...supabaseListings];

  if (allRaw.length === 0) {
    return {
      response: `Ik heb gezocht in ${locationStr} maar kon geen woningen vinden die aan je criteria voldoen. Probeer je zoekopdracht aan te passen (bijv. ander budget of andere locatie).`,
      sessionId,
      properties: [],
    };
  }

  // Step 3: Deduplicate and filter
  const deduplicated = deduplicateListings(allRaw);
  const allProperties = preFilterListings(deduplicated, hardFilters);

  if (allProperties.length === 0) {
    return {
      response: `Ik vond ${allRaw.length} woningen, maar geen daarvan voldoet aan je harde criteria. Probeer ruimere filters.`,
      sessionId,
      properties: [],
    };
  }

  // Step 4: AI selection
  let selectionResult;
  try {
    selectionResult = await selectProperties(clientProfile, allProperties);
  } catch (err) {
    console.error(`[${ts}] [API] Selection failed:`, err.message);
    return {
      response: 'De AI-selectie is mislukt. Probeer het opnieuw.',
      sessionId,
    };
  }

  const selections = postValidateSelections(
    selectionResult.selections || [],
    allProperties,
    hardFilters
  );

  // Step 5: Enrich selected properties with details
  try {
    const selectedProps = selections.map(s =>
      allProperties.find(p => p.id === s.property_id || p.url === s.property_id || String(p.id) === String(s.property_id))
    ).filter(Boolean);
    await enrichListingsWithDetails(selectedProps, 8);
  } catch (err) {
    console.warn(`[${ts}] [API] Detail enrichment failed (non-fatal):`, err.message);
  }

  // Store session
  setThread(sessionId, {
    client_profile: clientProfile,
    all_properties: allProperties.map(p => ({
      id: p.id, title: p.title, price: p.price, property_type: p.property_type,
      location: p.location, bedrooms: p.bedrooms, bathrooms: p.bathrooms,
      size_m2: p.size_m2, features: p.features, url: p.url, source: p.source,
      thumbnail: p.thumbnail, is_new_build: p.is_new_build, municipality: p.municipality,
    })),
    current_selection: selections,
    photo_assessments: {},
    conversation_history: [],
    original_query: queryText,
    created_at: Date.now(),
    type: 'api',
  });

  // Build response
  const properties = selections.map(s => {
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
      score: s.score || null,
    };
  });

  const summary = selectionResult.summary || `${selections.length} woningen gevonden in ${locationStr}`;

  return {
    response: summary,
    sessionId,
    properties,
    stats: {
      total_found: allRaw.length,
      after_filter: allProperties.length,
      selected: selections.length,
    },
  };
}

/**
 * Handle a refinement in an existing session (equivalent to thread reply)
 */
async function handleRefinement(sessionId, threadData, feedback) {
  const ts = new Date().toISOString();

  addConversation(sessionId, 'consultant', feedback);

  const refinement = await refineSelection(threadData, feedback);

  if (refinement.needs_new_scrape && refinement.new_filters) {
    // Run new scrape with updated filters
    const mergedFilters = { ...threadData.client_profile.hard_filters, ...refinement.new_filters };

    let idealistaListings = [];
    let supabaseListings = [];
    try {
      [idealistaListings, supabaseListings] = await Promise.all([
        searchIdealista(mergedFilters),
        searchSupabase(mergedFilters),
      ]);
    } catch (err) {
      console.error(`[${ts}] [API] Re-scrape failed:`, err.message);
    }

    const newListings = [...idealistaListings, ...supabaseListings];
    const combined = [...threadData.all_properties, ...newListings];
    const deduped = deduplicateListings(combined);

    const updatedProfile = { ...threadData.client_profile, hard_filters: mergedFilters };
    updateThread(sessionId, { all_properties: deduped, client_profile: updatedProfile });

    const { selectProperties } = require('./services/claude-selector');
    const reselection = await selectProperties(updatedProfile, deduped);
    const selections = reselection.selections || [];

    updateThread(sessionId, { current_selection: selections });
    addConversation(sessionId, 'bot', refinement.response_to_consultant || 'Selectie aangepast.');

    const properties = selections.map(s => {
      const prop = deduped.find(p =>
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
        score: s.score || null,
      };
    });

    return {
      response: refinement.response_to_consultant || 'Selectie aangepast met nieuwe resultaten.',
      sessionId,
      properties,
    };
  }

  // No new scrape — just refined selection
  const selections = refinement.selections || [];
  updateThread(sessionId, { current_selection: selections });
  addConversation(sessionId, 'bot', refinement.response_to_consultant || 'Selectie aangepast.');

  const properties = selections.map(s => {
    const prop = threadData.all_properties.find(p =>
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
      score: s.score || null,
    };
  });

  return {
    response: refinement.response_to_consultant || 'Selectie aangepast.',
    sessionId,
    properties,
  };
}

function startApiServer() {
  const port = process.env.API_PORT || 3001;
  app.listen(port, () => {
    console.log(`🌐 WoningBot API running on port ${port}`);
  });
}

module.exports = { startApiServer };
