/**
 * ev-prices.js — Service for querying E&V market price data from Supabase.
 *
 * Table: ev_market_data
 * Columns: location_slug, location_name, parent_slug, parent_name, level,
 *          marketing_type (sale/rent), object_type (house/apartment),
 *          price_per_sqm, yoy_change_pct, year, quarter, data_type,
 *          scraped_at, source_url
 *
 * Used by: /prijs handler
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
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
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

// ─── Get current prices for a location ────────────────────────────────────

/**
 * Get current price data for a location (city or neighborhood).
 * Returns sale + rent prices for houses and apartments.
 *
 * @param {string} locationName - City or neighborhood name (e.g. "Marbella", "Nueva Andalucia")
 * @returns {Object} { location, prices: [...], neighborhoods: [...], found: boolean }
 */
async function getPricesForLocation(locationName) {
  const ts = new Date().toISOString();
  const slug = nameToSlug(locationName);
  console.log(`[${ts}] [EVPrices] Looking up prices for "${locationName}" (slug: "${slug}")`);

  try {
    // Step 1: Try exact slug match first (most reliable)
    let currentResult = await supabaseRequest('ev_market_data', {
      select: '*',
      data_type: 'eq.current',
      location_slug: `eq.${slug}`,
      limit: '20',
    });

    // Step 1b: If no exact match, try fuzzy match on name
    if (!Array.isArray(currentResult.data) || currentResult.data.length === 0) {
      currentResult = await supabaseRequest('ev_market_data', {
        select: '*',
        data_type: 'eq.current',
        or: `(location_slug.ilike.%${slug}%,location_name.ilike.%${locationName}%)`,
        limit: '20',
      });

      // Deduplicate: if multiple slugs match, prefer the exact city slug over municipality-of-X
      if (Array.isArray(currentResult.data) && currentResult.data.length > 4) {
        const slugGroups = {};
        for (const r of currentResult.data) {
          if (!slugGroups[r.location_slug]) slugGroups[r.location_slug] = [];
          slugGroups[r.location_slug].push(r);
        }
        const slugKeys = Object.keys(slugGroups);
        // Prefer the shortest slug (usually the city, not municipality-of-X)
        const bestSlug = slugKeys.sort((a, b) => a.length - b.length)[0];
        currentResult.data = slugGroups[bestSlug];
        console.log(`[${ts}] [EVPrices] Multiple slugs found, using: ${bestSlug}`);
      }
    }

    if (currentResult.status >= 400 || !Array.isArray(currentResult.data) || currentResult.data.length === 0) {
      // Try broader search — maybe it's a parent location
      const broadResult = await supabaseRequest('ev_market_data', {
        select: '*',
        data_type: 'eq.current',
        or: `(parent_name.ilike.%${locationName}%,parent_slug.ilike.%${slug}%)`,
        limit: '200',
      });

      if (broadResult.status >= 400 || !Array.isArray(broadResult.data) || broadResult.data.length === 0) {
        console.log(`[${ts}] [EVPrices] No data found for "${locationName}"`);
        return { location: locationName, prices: [], neighborhoods: [], found: false };
      }

      // This is a parent location — return all child locations
      console.log(`[${ts}] [EVPrices] Found ${broadResult.data.length} neighborhood records under "${locationName}"`);
      return {
        location: locationName,
        prices: [],
        neighborhoods: broadResult.data,
        found: true,
        isParent: true,
      };
    }

    const prices = currentResult.data;
    console.log(`[${ts}] [EVPrices] Found ${prices.length} current price records for "${locationName}"`);

    // Step 2: Check if this location has neighborhoods (sub-locations)
    const locationSlug = prices[0].location_slug;
    const neighborhoodResult = await supabaseRequest('ev_market_data', {
      select: '*',
      data_type: 'eq.current',
      parent_slug: `eq.${locationSlug}`,
      limit: '200',
    });

    const neighborhoods = (neighborhoodResult.status < 400 && Array.isArray(neighborhoodResult.data))
      ? neighborhoodResult.data
      : [];

    if (neighborhoods.length > 0) {
      console.log(`[${ts}] [EVPrices] Found ${neighborhoods.length} neighborhood records under "${locationName}"`);
    }

    return {
      location: prices[0].location_name || locationName,
      prices,
      neighborhoods,
      found: true,
    };

  } catch (error) {
    console.error(`[${ts}] [EVPrices] Lookup failed:`, error.message);
    return { location: locationName, prices: [], neighborhoods: [], found: false };
  }
}

// ─── Get historical price trend for a location ───────────────────────────

/**
 * Get annual price history for a location.
 *
 * @param {string} locationName - City name
 * @param {string} marketingType - 'sale' or 'rent' (optional, defaults to both)
 * @returns {Object[]} Array of historical records sorted by year
 */
async function getPriceHistory(locationName, marketingType = null) {
  const ts = new Date().toISOString();
  const slug = nameToSlug(locationName);

  // Try exact slug match first
  let params = {
    select: '*',
    data_type: 'eq.annual',
    location_slug: `eq.${slug}`,
    order: 'year.asc',
    limit: '100',
  };

  if (marketingType) {
    params.marketing_type = `eq.${marketingType}`;
  }

  try {
    let result = await supabaseRequest('ev_market_data', params);

    // Fallback to fuzzy match
    if (!Array.isArray(result.data) || result.data.length === 0) {
      delete params.location_slug;
      params.or = `(location_slug.ilike.%${slug}%,location_name.ilike.%${locationName}%)`;
      result = await supabaseRequest('ev_market_data', params);
    }

    if (result.status >= 400 || !Array.isArray(result.data)) {
      console.log(`[${ts}] [EVPrices] No history found for "${locationName}"`);
      return [];
    }

    // Deduplicate: keep only one record per year+marketing_type+object_type
    const seen = new Set();
    const deduped = result.data.filter(r => {
      const key = `${r.year}_${r.marketing_type}_${r.object_type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`[${ts}] [EVPrices] Found ${deduped.length} historical records for "${locationName}" (${result.data.length} raw)`);
    return deduped;

  } catch (error) {
    console.error(`[${ts}] [EVPrices] History lookup failed:`, error.message);
    return [];
  }
}

// ─── Get prices for multiple locations (comparison) ──────────────────────

/**
 * Get current prices for multiple locations for comparison.
 *
 * @param {string[]} locationNames - Array of city/neighborhood names
 * @returns {Object[]} Array of { location, prices, found } objects
 */
async function comparePrices(locationNames) {
  const results = [];
  for (const name of locationNames) {
    const data = await getPricesForLocation(name);
    results.push(data);
  }
  return results;
}

// ─── Format price data for Claude context ─────────────────────────────────

/**
 * Format price data into a structured text context for Claude.
 *
 * @param {Object} priceData - Result from getPricesForLocation
 * @param {Object[]} history - Result from getPriceHistory
 * @returns {string} Formatted text
 */
function formatPriceDataForClaude(priceData, history = []) {
  const parts = [];

  parts.push(`=== PRIJSDATA: ${priceData.location} ===`);
  parts.push(`Bron: Engel & Völkers marktdata`);
  parts.push('');

  // Current prices
  if (priceData.prices.length > 0) {
    parts.push('--- Huidige prijzen ---');
    for (const p of priceData.prices) {
      const type = p.marketing_type === 'sale' ? 'Koop' : 'Huur';
      const obj = p.object_type === 'house' ? 'Woning' : 'Appartement';
      const price = p.price_per_sqm ? `€${Number(p.price_per_sqm).toLocaleString('nl-NL', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}/m²` : 'onbekend';
      const yoy = p.yoy_change_pct ? ` (${p.yoy_change_pct > 0 ? '+' : ''}${p.yoy_change_pct}% j-o-j)` : '';
      parts.push(`${type} ${obj}: ${price}${yoy}`);
    }
    parts.push('');
  }

  // Neighborhoods
  if (priceData.neighborhoods.length > 0) {
    parts.push('--- Wijken / Deelgebieden ---');

    // Group by neighborhood
    const byNeighborhood = {};
    for (const n of priceData.neighborhoods) {
      const key = n.location_name || n.location_slug;
      if (!byNeighborhood[key]) byNeighborhood[key] = [];
      byNeighborhood[key].push(n);
    }

    for (const [name, records] of Object.entries(byNeighborhood)) {
      const details = records.map(r => {
        const type = r.marketing_type === 'sale' ? 'Koop' : 'Huur';
        const obj = r.object_type === 'house' ? 'Woning' : 'Apt';
        const price = r.price_per_sqm ? `€${Number(r.price_per_sqm).toLocaleString('nl-NL', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}/m²` : '?';
        return `${type} ${obj}: ${price}`;
      }).join(' | ');
      parts.push(`  ${name}: ${details}`);
    }
    parts.push('');
  }

  // Historical data
  if (history.length > 0) {
    parts.push('--- Prijsontwikkeling (per jaar) ---');

    // Group by marketing_type + object_type
    const byType = {};
    for (const h of history) {
      const key = `${h.marketing_type}_${h.object_type}`;
      if (!byType[key]) byType[key] = [];
      byType[key].push(h);
    }

    for (const [key, records] of Object.entries(byType)) {
      const [mType, oType] = key.split('_');
      const label = `${mType === 'sale' ? 'Koop' : 'Huur'} ${oType === 'house' ? 'Woning' : 'Appartement'}`;
      const trend = records
        .sort((a, b) => a.year - b.year)
        .map(r => `${r.year}: €${Number(r.price_per_sqm).toLocaleString('nl-NL', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}/m²`)
        .join(' → ');
      parts.push(`  ${label}: ${trend}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Convert a location name to a URL-friendly slug.
 * E.g. "Nueva Andalucía" → "nueva-andalucia"
 */
function nameToSlug(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/[^a-z0-9]+/g, '-')     // replace non-alphanumeric with hyphens
    .replace(/^-|-$/g, '');           // trim hyphens
}

/**
 * Check if the E&V price data is available in Supabase.
 * @returns {boolean}
 */
function isConfigured() {
  return Boolean(SUPABASE_KEY);
}

module.exports = {
  getPricesForLocation,
  getPriceHistory,
  comparePrices,
  formatPriceDataForClaude,
  isConfigured,
};
