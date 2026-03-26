/**
 * supabase-search.js — Zoekt properties in Supabase resales_properties tabel.
 *
 * Filtert op basis van hardFilters (locatie, prijs, kamers, type, etc.)
 * en geeft resultaten terug in hetzelfde formaat als Idealista listings.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('[SupabaseSearch] WARNING: SUPABASE_URL of SUPABASE_KEY niet ingesteld.');
}

// ─── Feature mapping ───────────────────────────────────────────────────────

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

// ─── Map Supabase row to internal listing format ───────────────────────────

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
    url:           null,
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
  };
}

// ─── Build Supabase query URL ──────────────────────────────────────────────

function buildQueryUrl(hardFilters) {
  const params = new URLSearchParams();

  // Altijd alleen verkoop
  params.set('price_freq', 'eq.sale');

  // Selecteer alleen benodigde kolommen
  params.set('select', [
    'ref', 'price', 'currency', 'price_freq', 'property_type',
    'town', 'province', 'latitude', 'longitude',
    'beds', 'baths', 'pool', 'new_build',
    'built_m2', 'plot_m2', 'features',
    'desc_nl', 'desc_en', 'images',
  ].join(','));

  // Prijsfilters
  if (hardFilters.price_min) params.set('price', `gte.${hardFilters.price_min}`);
  if (hardFilters.price_max) {
    // price kan maar één filter hebben via params, gebruik meerdere keys
    params.append('price', `lte.${hardFilters.price_max}`);
  }

  // Kamers
  if (hardFilters.bedrooms_min) {
    params.set('beds', `gte.${hardFilters.bedrooms_min}`);
  }

  // Badkamers
  if (hardFilters.bathrooms_min) {
    params.set('baths', `gte.${hardFilters.bathrooms_min}`);
  }

  // Oppervlakte
  if (hardFilters.size_min_m2) params.set('built_m2', `gte.${hardFilters.size_min_m2}`);

  // Nieuwbouw
  if (hardFilters.is_new_build === true) {
    params.set('new_build', 'eq.true');
  }

  // Zwembad
  if (hardFilters.features?.includes('pool')) {
    params.set('pool', 'eq.true');
  }

  // Limiet
  params.set('limit', '500');
  params.set('order', 'price.asc');

  return `${SUPABASE_URL}/rest/v1/resales_properties?${params.toString()}`;
}

// ─── Locatiefilter (post-filter, meerdere steden) ──────────────────────────

function matchesLocation(row, locations) {
  if (!locations || locations.length === 0) return true;

  const town     = (row.town     || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const province = (row.province || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  return locations.some(loc => {
    const l = loc.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return town.includes(l) || l.includes(town) || province.includes(l) || l.includes(province);
  });
}

// ─── Main search function ──────────────────────────────────────────────────

async function searchSupabase(hardFilters) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn('[SupabaseSearch] Geen Supabase configuratie — zoeken overgeslagen.');
    return [];
  }

  const url = buildQueryUrl(hardFilters);
  console.log(`[SupabaseSearch] Query: ${url}`);

  const res = await fetch(url, {
    headers: {
      apikey:        SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  }

  const rows = await res.json();
  console.log(`[SupabaseSearch] ${rows.length} rijen opgehaald uit Supabase`);

  // Post-filter op locatie (Supabase REST ondersteunt geen OR op meerdere ilike)
  const locations = hardFilters.locations || [];
  const filtered = locations.length > 0
    ? rows.filter(row => matchesLocation(row, locations))
    : rows;

  console.log(`[SupabaseSearch] ${filtered.length} properties na locatiefilter (${locations.join(', ') || 'alle'})`);

  return filtered.map(mapRow).filter(Boolean);
}

module.exports = { searchSupabase };
