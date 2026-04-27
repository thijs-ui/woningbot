/**
 * supabase-search.js — Zoekt resales in Supabase via de hybrid-search RPC.
 *
 * Roept `search_resales_hybrid` aan (zie migrations/002_hybrid_search.sql).
 * Optioneel met een query_embedding voor zachte-criteria ranking; zonder
 * embedding gedraagt 'm zich identiek aan de oude flow (prijs ASC).
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';

const DEFAULT_MATCH_COUNT_NO_EMBEDDING = 500; // legacy behavior
const DEFAULT_MATCH_COUNT_WITH_EMBEDDING = 30; // top-N per fase 5 plan

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('[SupabaseSearch] WARNING: SUPABASE_URL of SUPABASE_KEY niet ingesteld.');
}

// ─── Property type mapping ─────────────────────────────────────────────────

function mapPropertyType(type) {
  const t = (type || '').toLowerCase();
  if (t === 'apartment' || t === 'flat') return 'flat';
  if (t === 'villa')      return 'chalet';
  if (t === 'townhouse')  return 'townhouse';
  if (t === 'penthouse')  return 'penthouse';
  if (t === 'duplex')     return 'duplex';
  if (t === 'bungalow')   return 'bungalow';
  if (t === 'finca' || t === 'country_house') return 'countryHouse';
  return t || null;
}

const FEATURE_LABEL_MAP = {
  'sea view': 'sea_view',
  'new build': 'new_build',
  'bargain':   'bargain',
};

function mapFeatures(featuresArr, pool, newBuild) {
  const features = [];
  if (pool)     features.push('pool');
  if (newBuild) features.push('new_build');
  for (const f of (featuresArr || [])) {
    const mapped = FEATURE_LABEL_MAP[f?.toLowerCase()];
    if (mapped && !features.includes(mapped)) features.push(mapped);
  }
  return features;
}

// ─── Map RPC row to internal listing format ────────────────────────────────

function mapRow(row) {
  const images = (row.images || []).map(img => img?.url).filter(Boolean);
  const thumbnail = images[0] || null;
  const features = mapFeatures(row.features, row.pool, row.new_build);
  const description = (row.desc_nl || row.desc_en || '').substring(0, 500);
  const pricePerM2 = (row.price && row.built_m2)
    ? Math.round(row.price / row.built_m2)
    : null;

  return {
    id:            `sb_${row.ref}`,
    source:        'supabase',
    title:         `${mapPropertyType(row.property_type) || row.property_type || 'Property'} in ${row.town || row.province || '?'}`,
    price:         row.price,
    currency:      '€',
    location:      row.town || null,
    bedrooms:      row.beds,
    bathrooms:     row.baths,
    size_m2:       row.built_m2,
    floor:         null,
    url:           row.url || null,
    thumbnail,
    features,
    property_type: mapPropertyType(row.property_type),
    description,
    price_per_m2:  pricePerM2,
    address:       null,
    district:      null,
    province:      row.province || null,
    municipality:  row.town || null,
    latitude:      row.latitude,
    longitude:     row.longitude,
    images,
    agency:        null,
    tags:          row.new_build ? ['Obra Nueva'] : [],
    is_new_build:  row.new_build || false,
    similarity:    typeof row.similarity === 'number' ? row.similarity : null,
  };
}

// ─── Vector → pgvector text format ─────────────────────────────────────────

function vectorToPgString(vec) {
  if (!Array.isArray(vec)) return null;
  return `[${vec.join(',')}]`;
}

// ─── Main search ───────────────────────────────────────────────────────────

/**
 * @param {Object} hardFilters - parser output (price_min/max, bedrooms_min, etc.)
 * @param {Object} [opts]
 *   - queryEmbedding: number[1536] | null — vector voor zachte-criteria ranking
 *   - matchCount: int — aantal rijen (default 30 met embedding, 500 zonder)
 */
async function searchSupabase(hardFilters, opts = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn('[SupabaseSearch] Geen Supabase configuratie — zoeken overgeslagen.');
    return [];
  }

  const queryEmbedding = opts.queryEmbedding || null;
  const matchCount =
    opts.matchCount ||
    (queryEmbedding ? DEFAULT_MATCH_COUNT_WITH_EMBEDDING : DEFAULT_MATCH_COUNT_NO_EMBEDDING);

  const body = {
    query_embedding: vectorToPgString(queryEmbedding),
    match_count: matchCount,
    filter_price_min: hardFilters.price_min ?? null,
    filter_price_max: hardFilters.price_max ?? null,
    filter_bedrooms_min: hardFilters.bedrooms_min ?? null,
    filter_bathrooms_min: hardFilters.bathrooms_min ?? null,
    filter_size_min: hardFilters.size_min_m2 ?? null,
    filter_property_type: null, // bewust niet gefilterd op DB-niveau (parser-types ≠ DB-types)
    filter_locations:
      Array.isArray(hardFilters.locations) && hardFilters.locations.length > 0
        ? hardFilters.locations
        : null,
    filter_pool:
      Array.isArray(hardFilters.features) && hardFilters.features.includes('pool')
        ? true
        : null,
    filter_new_build:
      typeof hardFilters.is_new_build === 'boolean' ? hardFilters.is_new_build : null,
  };

  const url = `${SUPABASE_URL}/rest/v1/rpc/search_resales_hybrid`;
  console.log(
    `[SupabaseSearch] RPC search_resales_hybrid — embedding=${queryEmbedding ? 'yes' : 'no'}, match_count=${matchCount}`
  );

  const res = await fetch(url, {
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
    throw new Error(`Supabase RPC ${res.status}: ${text.slice(0, 200)}`);
  }

  const rows = await res.json();
  if (!Array.isArray(rows)) {
    console.error(`[SupabaseSearch] Onverwacht response-type:`, typeof rows);
    return [];
  }

  console.log(`[SupabaseSearch] ${rows.length} properties terug uit RPC`);
  return rows.map(mapRow).filter(Boolean);
}

module.exports = { searchSupabase };
