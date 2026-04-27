/**
 * Supabase service for querying the nieuwbouw database.
 *
 * Tables:
 *   - listings (835 projects): property_code, title, price, municipality, description, features, etc.
 *   - units (1878 units): listing_id, price, size_m2, rooms, floor, terrace, garden, parking
 *   - price_history: price change tracking
 *
 * Used by:
 *   - /nieuwbouw handler: searchListings() for filtered project search
 *   - /project handler: findProject() + getProjectUnits() for project info
 */

const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sqafsrknbfzhkbxqhqlu.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';

// ─── Low-level Supabase REST helper ────────────────────────────────────────

function supabaseRequest(path, params = {}) {
  return new Promise((resolve, reject) => {
    if (!SUPABASE_KEY) {
      return reject(new Error('SUPABASE_ANON_KEY not set'));
    }

    const url = new URL(`/rest/v1/${path}`, SUPABASE_URL);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
    });

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'count=exact',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const count = res.headers['content-range'];
          const totalMatch = count ? count.match(/\/(\d+)$/) : null;
          const total = totalMatch ? parseInt(totalMatch[1]) : null;
          resolve({ status: res.statusCode, data: JSON.parse(data), total });
        } catch (e) {
          reject(new Error(`Supabase parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Supabase request timeout')); });
    req.end();
  });
}

// ─── Hybrid RPC search (Fase 5.1) ──────────────────────────────────────────

/**
 * Roept de `search_listings_hybrid` RPC aan (zie migrations/002_hybrid_search.sql).
 * Met `opts.queryEmbedding` rangschikt 'm op zachte-criteria similarity;
 * zonder embedding gedraagt 'm zich identiek aan de oude search (prijs ASC).
 */
async function searchListingsHybrid(filters = {}, opts = {}) {
  const ts = new Date().toISOString();

  if (!SUPABASE_KEY) {
    console.error(`[${ts}] [Supabase] SUPABASE_ANON_KEY not set`);
    return [];
  }

  const queryEmbedding = opts.queryEmbedding || null;
  const matchCount = opts.matchCount || (queryEmbedding ? 30 : 500);

  const body = {
    query_embedding: Array.isArray(queryEmbedding) ? `[${queryEmbedding.join(',')}]` : null,
    match_count: matchCount,
    filter_price_min: filters.price_min ?? null,
    filter_price_max: filters.price_max ?? null,
    filter_bedrooms_min: filters.bedrooms_min ?? null,
    filter_bathrooms_min: filters.bathrooms_min ?? null,
    filter_size_min: filters.size_min_m2 ?? null,
    filter_locations:
      Array.isArray(filters.locations) && filters.locations.length > 0
        ? filters.locations
        : null,
    filter_project_name: filters.project_name || null,
  };

  console.log(
    `[${ts}] [Supabase] RPC search_listings_hybrid — embedding=${queryEmbedding ? 'yes' : 'no'}, match_count=${matchCount}`
  );

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_listings_hybrid`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[${ts}] [Supabase] RPC ${res.status}: ${text.slice(0, 200)}`);
      return [];
    }

    const rows = await res.json();
    if (!Array.isArray(rows)) {
      console.error(`[${ts}] [Supabase] Unexpected RPC response type: ${typeof rows}`);
      return [];
    }

    console.log(`[${ts}] [Supabase] RPC returned ${rows.length} listings`);
    return rows;
  } catch (err) {
    console.error(`[${ts}] [Supabase] RPC fetch failed: ${err.message}`);
    return [];
  }
}

// ─── Search listings with filters ──────────────────────────────────────────

/**
 * Search the listings table with optional filters.
 * Returns project-level data (not individual units).
 *
 * @param {Object} filters
 * @param {string[]} filters.locations - City/municipality names
 * @param {number} filters.price_min - Minimum price
 * @param {number} filters.price_max - Maximum price
 * @param {number} filters.bedrooms_min - Minimum bedrooms
 * @param {string} filters.project_name - Search for specific project name
 * @returns {Object[]} Array of listing objects
 */
async function searchListings(filters = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [Supabase] Searching listings with filters:`, JSON.stringify(filters));

  const params = {
    select: 'id,property_code,url,title,description,price,price_per_m2,size_m2,rooms,bathrooms,province,municipality,district,address,latitude,longitude,property_type,is_new_development,has_lift,has_parking,has_swimming_pool,has_terrace,has_air_conditioning,has_garden,has_storage_room,num_photos,main_image_url,agency_name,first_seen_at,last_seen_at,is_active',
    is_active: 'eq.true',
    order: 'price.asc',
    limit: '500',
  };

  // Location filter — match municipality names (case-insensitive via ilike)
  if (filters.locations && filters.locations.length > 0) {
    // Build OR filter for municipalities
    const locationFilters = filters.locations.map(loc => {
      // Handle common name variations
      const clean = loc.trim();
      return `municipality.ilike.%${clean}%`;
    });
    params.or = `(${locationFilters.join(',')})`;
  }

  // Price filters
  if (filters.price_min) {
    params['price'] = `gte.${filters.price_min}`;
  }
  if (filters.price_max) {
    // Use a separate key for the second price filter
    if (filters.price_min) {
      // Both min and max — need to use 'and' filter
      params['and'] = `(price.gte.${filters.price_min},price.lte.${filters.price_max})`;
      delete params['price'];
    } else {
      params['price'] = `lte.${filters.price_max}`;
    }
  }

  // Bedrooms filter — filter at unit level, so we skip it here and filter after joining units
  // Project-level 'rooms' is often null for newDevelopments

  // Project name search
  if (filters.project_name) {
    const name = filters.project_name.trim();
    params.or = `(title.ilike.%${name}%,description.ilike.%${name}%,address.ilike.%${name}%)`;
  }

  try {
    const result = await supabaseRequest('listings', params);

    if (result.status >= 400) {
      console.error(`[${ts}] [Supabase] Error ${result.status}:`, JSON.stringify(result.data).substring(0, 200));
      return [];
    }

    const listings = Array.isArray(result.data) ? result.data : [];
    console.log(`[${ts}] [Supabase] Found ${listings.length} listings (total: ${result.total})`);
    return listings;

  } catch (error) {
    console.error(`[${ts}] [Supabase] Search failed:`, error.message);
    return [];
  }
}

// ─── Get units for specific listings ───────────────────────────────────────

/**
 * Get all units for one or more listing IDs.
 *
 * @param {string[]} listingIds - Array of listing UUIDs
 * @returns {Object[]} Array of unit objects
 */
async function getUnitsForListings(listingIds) {
  const ts = new Date().toISOString();

  if (!listingIds || listingIds.length === 0) return [];

  // Supabase 'in' filter
  const params = {
    select: '*',
    listing_id: `in.(${listingIds.join(',')})`,
    order: 'price.asc',
    limit: '1000',
  };

  try {
    const result = await supabaseRequest('units', params);

    if (result.status >= 400) {
      console.error(`[${ts}] [Supabase] Units error ${result.status}:`, JSON.stringify(result.data).substring(0, 200));
      return [];
    }

    const units = Array.isArray(result.data) ? result.data : [];
    console.log(`[${ts}] [Supabase] Found ${units.length} units for ${listingIds.length} listings`);
    return units;

  } catch (error) {
    console.error(`[${ts}] [Supabase] Units fetch failed:`, error.message);
    return [];
  }
}

// ─── Find a specific project by name ───────────────────────────────────────

/**
 * Find a project by name, searching title, description, and address.
 * Returns the best matching listing(s) with their units.
 *
 * @param {string} projectName - The project name to search for
 * @returns {Object} { listings: [...], units: [...], matched: true/false }
 */
async function findProject(projectName) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [Supabase] Finding project: "${projectName}"`);

  // Step 1: Search by project name in title, description, address
  const params = {
    select: '*',
    is_active: 'eq.true',
    or: `(title.ilike.%${projectName}%,description.ilike.%${projectName}%,address.ilike.%${projectName}%)`,
    limit: '20',
  };

  try {
    const result = await supabaseRequest('listings', params);

    if (result.status >= 400) {
      console.error(`[${ts}] [Supabase] Project search error:`, JSON.stringify(result.data).substring(0, 200));
      return { listings: [], units: [], matched: false };
    }

    const listings = Array.isArray(result.data) ? result.data : [];

    if (listings.length === 0) {
      console.log(`[${ts}] [Supabase] No project found for "${projectName}"`);
      return { listings: [], units: [], matched: false };
    }

    // Step 2: Score and rank matches
    const scored = listings.map(l => {
      let score = 0;
      const nameWords = projectName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const titleLower = (l.title || '').toLowerCase();
      const descLower = (l.description || '').toLowerCase();

      // Exact title match is best
      if (titleLower.includes(projectName.toLowerCase())) score += 100;

      // Word-level matching in title
      nameWords.forEach(w => {
        if (titleLower.includes(w)) score += 20;
        if (descLower.includes(w)) score += 5;
      });

      return { ...l, _score: score };
    });

    scored.sort((a, b) => b._score - a._score);

    // Take top matches (same score group or top 5)
    const topScore = scored[0]._score;
    const topMatches = scored.filter(l => l._score >= topScore * 0.7).slice(0, 10);

    console.log(`[${ts}] [Supabase] Found ${topMatches.length} matching projects (top score: ${topScore})`);

    // Step 3: Get units for matched listings
    const listingIds = topMatches.map(l => l.id);
    const units = await getUnitsForListings(listingIds);

    return {
      listings: topMatches,
      units,
      matched: true,
    };

  } catch (error) {
    console.error(`[${ts}] [Supabase] Project search failed:`, error.message);
    return { listings: [], units: [], matched: false };
  }
}

// ─── Search listings with units (enriched) ─────────────────────────────────

/**
 * Search listings and enrich with unit data.
 * Filters units by bedrooms if specified.
 *
 * @param {Object} filters - Same as searchListings
 * @returns {Object[]} Array of enriched listing objects with .units property
 */
async function searchListingsWithUnits(filters = {}, opts = {}) {
  const ts = new Date().toISOString();

  // Step 1: Get matching listings — hybrid (RPC) als embedding gegeven, anders legacy
  const listings = opts.queryEmbedding
    ? await searchListingsHybrid(filters, opts)
    : await searchListings(filters);

  if (listings.length === 0) return [];

  // Step 2: Get units for all matched listings
  const listingIds = listings.map(l => l.id);
  const allUnits = await getUnitsForListings(listingIds);

  // Step 3: Group units by listing_id
  const unitsByListing = {};
  for (const unit of allUnits) {
    if (!unitsByListing[unit.listing_id]) unitsByListing[unit.listing_id] = [];
    unitsByListing[unit.listing_id].push(unit);
  }

  // Step 4: Enrich listings with units and apply bedroom filter
  const bedroomsMin = filters.bedrooms_min || null;
  const enriched = listings.map(l => {
    let units = unitsByListing[l.id] || [];

    // Filter units by bedrooms if specified
    if (bedroomsMin && units.length > 0) {
      const filtered = units.filter(u => u.rooms && u.rooms >= bedroomsMin);
      if (filtered.length > 0) units = filtered;
      // If no units match bedrooms filter, keep all (project might still be relevant)
    }

    // Calculate price range from units
    const unitPrices = units.filter(u => u.price).map(u => u.price);
    const priceFrom = unitPrices.length > 0 ? Math.min(...unitPrices) : l.price;
    const priceTo = unitPrices.length > 0 ? Math.max(...unitPrices) : l.price;

    // Calculate room range from units
    const unitRooms = units.filter(u => u.rooms).map(u => u.rooms);
    const roomsFrom = unitRooms.length > 0 ? Math.min(...unitRooms) : l.rooms;
    const roomsTo = unitRooms.length > 0 ? Math.max(...unitRooms) : l.rooms;

    // Calculate size range from units
    const unitSizes = units.filter(u => u.size_m2).map(u => u.size_m2);
    const sizeFrom = unitSizes.length > 0 ? Math.min(...unitSizes) : l.size_m2;
    const sizeTo = unitSizes.length > 0 ? Math.max(...unitSizes) : l.size_m2;

    return {
      ...l,
      units,
      unit_count: units.length,
      price_from: priceFrom,
      price_to: priceTo,
      rooms_from: roomsFrom,
      rooms_to: roomsTo,
      size_from: sizeFrom,
      size_to: sizeTo,
    };
  });

  // Filter out listings where bedroom filter eliminates all units AND project has no matching rooms
  if (bedroomsMin) {
    const filtered = enriched.filter(l => {
      // Keep if any unit matches
      if (l.units.some(u => u.rooms && u.rooms >= bedroomsMin)) return true;
      // Keep if project-level rooms match
      if (l.rooms && l.rooms >= bedroomsMin) return true;
      // Keep if no room data at all (don't exclude unknowns)
      if (!l.rooms && l.units.every(u => !u.rooms)) return true;
      return false;
    });
    console.log(`[${ts}] [Supabase] Bedroom filter (>=${bedroomsMin}): ${enriched.length} → ${filtered.length} listings`);
    return filtered;
  }

  return enriched;
}

// ─── Format listings for Claude context ────────────────────────────────────

/**
 * Format enriched listings into a text context for Claude.
 *
 * @param {Object[]} listings - Enriched listings from searchListingsWithUnits
 * @returns {string} Formatted text
 */
function formatListingsForClaude(listings) {
  return listings.map((l, i) => {
    const features = [];
    if (l.has_swimming_pool) features.push('zwembad');
    if (l.has_terrace) features.push('terras');
    if (l.has_garden) features.push('tuin');
    if (l.has_parking) features.push('parking');
    if (l.has_lift) features.push('lift');
    if (l.has_air_conditioning) features.push('airco');
    if (l.has_storage_room) features.push('berging');

    const priceRange = l.price_from === l.price_to
      ? `€${Number(l.price_from || 0).toLocaleString('nl-NL')}`
      : `€${Number(l.price_from || 0).toLocaleString('nl-NL')} - €${Number(l.price_to || 0).toLocaleString('nl-NL')}`;

    const roomRange = l.rooms_from === l.rooms_to
      ? (l.rooms_from ? `${l.rooms_from} slpk` : '')
      : `${l.rooms_from || '?'}-${l.rooms_to || '?'} slpk`;

    const sizeRange = l.size_from === l.size_to
      ? (l.size_from ? `${l.size_from}m²` : '')
      : `${l.size_from || '?'}-${l.size_to || '?'}m²`;

    const parts = [
      `[${i + 1}] ${l.title || 'Onbekend project'}`,
      `Locatie: ${l.municipality}${l.district ? `, ${l.district}` : ''}`,
      `Prijs: ${priceRange}`,
      roomRange ? `Slaapkamers: ${roomRange}` : '',
      sizeRange ? `Oppervlakte: ${sizeRange}` : '',
      l.unit_count > 0 ? `Beschikbare units: ${l.unit_count}` : '',
      features.length > 0 ? `Features: ${features.join(', ')}` : '',
      l.agency_name ? `Ontwikkelaar/Agency: ${l.agency_name}` : '',
      l.url ? `URL: ${l.url}` : '',
    ].filter(Boolean);

    // Add unit details if available
    if (l.units && l.units.length > 0 && l.units.length <= 20) {
      parts.push('Units:');
      l.units.forEach((u, j) => {
        const unitFeatures = [];
        if (u.has_terrace) unitFeatures.push('terras');
        if (u.has_garden) unitFeatures.push('tuin');
        if (u.parking_included_in_price) unitFeatures.push('parking incl.');
        if (u.is_exterior) unitFeatures.push('buitenzijde');

        parts.push(`  Unit ${j + 1}: ${u.typology || 'woning'} | €${Number(u.price || 0).toLocaleString('nl-NL')} | ${u.rooms || '?'} slpk | ${u.size_m2 || '?'}m²${u.floor ? ` | Verd. ${u.floor}` : ''}${unitFeatures.length > 0 ? ` | ${unitFeatures.join(', ')}` : ''}`);
      });
    } else if (l.unit_count > 20) {
      parts.push(`(${l.unit_count} units beschikbaar, prijsrange hierboven)`);
    }

    return parts.join(' | ');
  }).join('\n\n');
}

/**
 * Check if Supabase is configured and available.
 * @returns {boolean}
 */
function isConfigured() {
  return Boolean(SUPABASE_KEY);
}

module.exports = {
  searchListings,
  searchListingsHybrid,
  searchListingsWithUnits,
  getUnitsForListings,
  findProject,
  formatListingsForClaude,
  isConfigured,
};
