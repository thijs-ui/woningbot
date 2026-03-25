// src/services/idealista-direct.js
// Idealista scraper via Apify igolaizola/idealista-scraper actor
// Uses Location IDs (not city names) for reliable results

const { ApifyClient } = require('apify-client');

const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN });

// ─── Idealista Location ID Mapping ──────────────────────────────────────────
// Source: igolaizola.github.io/idealista-scraper/ (Location Search Tool)
// Level: Municipio (city-level) — covers all listings within the municipality
const LOCATION_IDS = {
  // Costa Blanca North
  'denia':              '0-EU-ES-03-01-002-063',
  'dénia':              '0-EU-ES-03-01-002-063',
  'javea':              '0-EU-ES-03-01-004-082',
  'jávea':              '0-EU-ES-03-01-004-082',
  'xàbia':              '0-EU-ES-03-01-004-082',
  'moraira':            '0-EU-ES-03-01-013-628',
  'calpe':              '0-EU-ES-03-01-006-047',
  'calp':               '0-EU-ES-03-01-006-047',
  'altea':              '0-EU-ES-03-02-002-018',
  'benidorm':           '0-EU-ES-03-02-003-031',
  'albir':              '0-EU-ES-03-02-006-011',  // Alfaz del Pi municipality
  'alfaz del pi':       '0-EU-ES-03-02-006-011',
  'l\'alfàs del pi':    '0-EU-ES-03-02-006-011',
  'benitachell':        '0-EU-ES-03-01-011-042',
  'benissa':            '0-EU-ES-03-01-010-041',
  'pedreguer':          '0-EU-ES-03-01-012-101',
  'la nucia':           '0-EU-ES-03-02-007-094',
  'villajoyosa':        '0-EU-ES-03-02-005-139',

  // Costa Blanca South
  'torrevieja':         '0-EU-ES-03-05-003-133',
  'orihuela':           '0-EU-ES-03-05-004-099',
  'orihuela costa':     '0-EU-ES-03-05-004-099',  // District of Orihuela
  'guardamar':          '0-EU-ES-03-05-002-076',
  'guardamar del segura': '0-EU-ES-03-05-002-076',
  'santa pola':         '0-EU-ES-03-04-002-121',
  'alicante':           '0-EU-ES-03-03-001-014',
  'alacant':            '0-EU-ES-03-03-001-014',
  'elche':              '0-EU-ES-03-04-001-065',
  'pilar de la horadada': '0-EU-ES-03-05-001-104',
  'rojales':            '0-EU-ES-03-05-002-113',
  'san miguel de salinas': '0-EU-ES-03-05-003-120',

  // Costa del Sol
  'marbella':           '0-EU-ES-29-03-003-069',
  'estepona':           '0-EU-ES-29-07-001-051',
  'fuengirola':         '0-EU-ES-29-08-003-054',
  'benalmadena':        '0-EU-ES-29-08-002-025',
  'benalmádena':        '0-EU-ES-29-08-002-025',
  'malaga':             '0-EU-ES-29-02-001-067',
  'málaga':             '0-EU-ES-29-02-001-067',
  'mijas':              '0-EU-ES-29-08-004-070',
  'mijas costa':        '0-EU-ES-29-08-004-070',
  'benahavis':          '0-EU-ES-29-03-001-023',
  'benahavís':          '0-EU-ES-29-03-001-023',
  'nerja':              '0-EU-ES-29-01-003-075',
  'manilva':            '0-EU-ES-29-07-002-068',
  'casares':            '0-EU-ES-29-07-003-037',
  'torrox':             '0-EU-ES-29-01-004-091',
  'rincon de la victoria': '0-EU-ES-29-01-006-082',
  'torremolinos':       '0-EU-ES-29-08-001-090',
  'coin':               '0-EU-ES-29-06-001-042',
  'alhaurin de la torre': '0-EU-ES-29-06-002-008',
  'alhaurin el grande':  '0-EU-ES-29-06-003-009',
  'san pedro de alcantara': '0-EU-ES-29-03-003-069', // District of Marbella
  'nueva andalucia':    '0-EU-ES-29-03-003-069',     // District of Marbella
  'puerto banus':       '0-EU-ES-29-03-003-069',     // District of Marbella

  // Valencia / Alicante
  'valencia':           '0-EU-ES-46-02-002-250',
  'valència':           '0-EU-ES-46-02-002-250',

  // Other popular areas
  'madrid':             '0-EU-ES-28-07-001-079',
  'barcelona':          '0-EU-ES-08-01-001-019',
  'ronda':              '0-EU-ES-29-05-001-084',
  'antequera':          '0-EU-ES-29-04-001-015',
};

// ─── Resolve location to Idealista Location ID ─────────────────────────────
function resolveLocationId(locationName) {
  if (!locationName) return null;

  // If it already looks like a location ID, return as-is
  if (locationName.startsWith('0-EU-')) return locationName;

  const normalized = locationName.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // strip accents for lookup

  // Try exact match first (with accents stripped)
  for (const [key, id] of Object.entries(LOCATION_IDS)) {
    const normalizedKey = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (normalizedKey === normalized) return id;
  }

  // Try partial match (city name contained in key or vice versa)
  for (const [key, id] of Object.entries(LOCATION_IDS)) {
    const normalizedKey = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (normalizedKey.includes(normalized) || normalized.includes(normalizedKey)) {
      return id;
    }
  }

  // Fallback: return the original name and let the actor try to resolve it
  // (may not work reliably — log a warning)
  console.warn(`[idealista] No Location ID found for "${locationName}" — passing raw name (may fail)`);
  return locationName;
}

// ─── Map property type from Claude output to Apify input ────────────────────
function mapPropertyType(claudeType) {
  const mapping = {
    'apartment': 'homes',
    'flat': 'homes',
    'villa': 'homes',
    'townhouse': 'homes',
    'finca': 'homes',
    'penthouse': 'homes',
    'studio': 'homes',
    'duplex': 'homes',
    'bungalow': 'homes',
    'country_house': 'homes',
    'chalet': 'homes',
    'house': 'homes',
    'plot': 'lands',
    'land': 'lands',
    'office': 'offices',
    'commercial': 'premises',
    'garage': 'garages',
    'storage': 'storageRooms',
    'new_construction': 'newDevelopments',
    'newbuild': 'newDevelopments',
    'nieuwbouw': 'newDevelopments',
  };
  return mapping[claudeType?.toLowerCase()] || 'homes';
}

// ─── Map homeType filter for specific property subtypes ─────────────────────
function mapHomeType(claudeType) {
  const mapping = {
    'villa': ['detachedHouse', 'villa'],
    'townhouse': ['terracedHouse', 'semiDetachedHouse'],
    'finca': ['countryHouse'],
    'country_house': ['countryHouse'],
    'penthouse': ['penthouse'],
    'duplex': ['duplex'],
    'apartment': ['flat', 'apartment'],
    'flat': ['flat', 'apartment'],
    'studio': ['flat'],
    'bungalow': ['flat'],
    'chalet': ['detachedHouse'],
  };
  return mapping[claudeType?.toLowerCase()] || [];
}

// ─── Map features from Claude to Apify boolean filters ──────────────────────
function mapFeatures(features) {
  if (!features || !Array.isArray(features)) return {};

  const featureMap = {
    'pool': 'swimmingPool',
    'swimming_pool': 'swimmingPool',
    'zwembad': 'swimmingPool',
    'garden': 'garden',
    'tuin': 'garden',
    'terrace': 'terrace',
    'terras': 'terrace',
    'garage': 'garage',
    'parking': 'garage',
    'air_conditioning': 'airConditioning',
    'airco': 'airConditioning',
    'elevator': 'lift',
    'lift': 'lift',
    'storage': 'storageRoom',
    'sea_view': 'seaViews',
    'zeezicht': 'seaViews',
    'luxury': 'luxury',
  };

  const result = {};
  for (const feature of features) {
    const key = featureMap[feature.toLowerCase()];
    if (key) result[key] = true;
  }
  return result;
}

// ─── Build Apify actor input from parsed Claude filters ─────────────────────
function buildApifyInput(filters) {
  const locationId = resolveLocationId(filters.location);
  const propertyType = mapPropertyType(filters.property_type);
  const homeType = mapHomeType(filters.property_type);
  const featureFlags = mapFeatures(filters.features);

  // Map bedrooms to array format: ["1","2","3","4"] etc.
  let bedrooms = [];
  if (filters.bedrooms_min) {
    const min = parseInt(filters.bedrooms_min);
    // Include from min up to 4+ (Idealista max filter)
    for (let i = Math.max(0, min); i <= 4; i++) {
      bedrooms.push(i === 0 ? 'studio' : String(i));
    }
  }

  // Map bathrooms to array format
  let bathrooms = [];
  if (filters.bathrooms_min) {
    const min = parseInt(filters.bathrooms_min);
    for (let i = min; i <= 3; i++) {
      bathrooms.push(String(i));
    }
  }

  const input = {
    operation: filters.operation || 'sale',
    propertyType: propertyType,
    country: 'es',
    location: locationId,
    maxItems: 250,  // 5 pages × 50 items = 250 (user requested 5 pages)
    sortBy: 'mostRecent',
    fetchDetails: false,
    fetchStats: false,

    // Price filters (as strings per actor docs)
    minPrice: filters.price_min ? String(filters.price_min) : '0',
    maxPrice: filters.price_max ? String(filters.price_max) : '0',

    // Size filters
    minSize: filters.size_min_m2 ? String(filters.size_min_m2) : '0',
    maxSize: filters.size_max_m2 ? String(filters.size_max_m2) : '0',

    // Bedrooms & bathrooms
    ...(bedrooms.length > 0 ? { bedrooms } : {}),
    ...(bathrooms.length > 0 ? { bathrooms } : {}),

    // Home type (villa, flat, etc.)
    ...(homeType.length > 0 ? { homeType } : {}),

    // Feature boolean flags
    ...featureFlags,

    // Condition filter
    ...(filters.condition === 'new_construction' ? { condition: ['newDevelopment'] } : {}),
    ...(filters.condition === 'good' ? { condition: ['good'] } : {}),
    ...(filters.condition === 'needs_renovation' ? { condition: ['renew'] } : {}),

    // Proxy configuration (residential recommended by actor docs)
    proxyConfiguration: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
    },
  };

  return input;
}

// ─── Map a single Apify result item to our standard format ──────────────────
// IMPORTANT: igolaizola actor returns FLAT dot-notation keys for nested fields
// e.g. "contactInfo.commercialName" not contactInfo: { commercialName: ... }
function mapApifyItem(item) {
  // Helper to safely access flat dot-notation keys
  const get = (key) => item[key] ?? null;

  // Extract features from description (since flat format doesn't include features object)
  const desc = (get('description') || '').toLowerCase();
  const features = [];
  if (desc.includes('piscina') || desc.includes('pool') || get('swimmingPool')) features.push('pool');
  if (desc.includes('jardín') || desc.includes('garden') || get('garden')) features.push('garden');
  if (desc.includes('terraza') || desc.includes('terrace') || get('terrace')) features.push('terrace');
  if (desc.includes('garaje') || desc.includes('garage') || desc.includes('parking') || get('parkingSpace.hasParkingSpace')) features.push('garage');
  if (desc.includes('aire acondicionado') || desc.includes('air conditioning') || get('airConditioning')) features.push('air_conditioning');
  if (desc.includes('ascensor') || get('hasLift')) features.push('elevator');
  if (desc.includes('trastero') || desc.includes('storage') || get('storageRoom')) features.push('storage');
  if (desc.includes('vistas al mar') || desc.includes('sea view') || get('seaViews')) features.push('sea_view');
  if (desc.includes('vistas a la montaña') || desc.includes('mountain')) features.push('mountain_view');
  if (desc.includes('seguridad') || desc.includes('security') || desc.includes('vigilancia')) features.push('security');

  // Map property type to Dutch-friendly label
  const typeLabels = {
    'flat': 'Appartement',
    'apartment': 'Appartement',
    'penthouse': 'Penthouse',
    'duplex': 'Duplex',
    'detachedHouse': 'Villa',
    'semiDetachedHouse': 'Geschakelde woning',
    'terracedHouse': 'Rijtjeshuis',
    'countryHouse': 'Finca / Landhuis',
    'villa': 'Villa',
    'loft': 'Loft',
    'chalet': 'Chalet',
  };

  return {
    id: get('propertyCode'),
    source: 'idealista',
    title: typeLabels[get('propertyType')] || get('propertyType') || 'Woning',
    price: get('price'),
    pricePerM2: get('priceByArea'),
    location: get('municipality') || get('province') || '',
    province: get('province') || '',
    address: get('address') || '',
    bedrooms: get('rooms'),
    bathrooms: get('bathrooms'),
    size: get('size'),
    floor: get('floor'),
    exterior: get('exterior'),
    hasLift: get('hasLift'),
    hasParking: get('parkingSpace.hasParkingSpace') || false,
    propertyType: get('propertyType'),
    operation: get('operation'),
    url: get('url'),
    thumbnail: get('thumbnail'),
    description: get('description'),
    features: features,
    agencyName: get('contactInfo.commercialName') || get('contactInfo.contactName') || '',
    phone: get('contactInfo.phone1.phoneNumber') || '',
    rawData: item,  // Keep original for debugging
  };
}

// ─── Main search function ───────────────────────────────────────────────────
async function searchIdealista(filters) {
  const input = buildApifyInput(filters);

  console.log('[idealista] Starting Apify run with input:', JSON.stringify({
    ...input,
    proxyConfiguration: '(hidden)',
  }, null, 2));

  try {
    // Run the actor
    const run = await client.actor('igolaizola/idealista-scraper').call(input, {
      waitSecs: 180,  // Wait up to 3 minutes
    });

    console.log(`[idealista] Run finished: ${run.id}, status: ${run.status}`);

    if (run.status !== 'SUCCEEDED') {
      console.error(`[idealista] Run failed with status: ${run.status}`);
      return { results: [], error: `Apify run status: ${run.status}` };
    }

    // Fetch results from the dataset
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    console.log(`[idealista] Got ${items.length} raw items from Apify`);

    // Map items to our standard format
    const results = items.map(mapApifyItem).filter(r => r.id && r.price);

    console.log(`[idealista] Mapped ${results.length} valid results`);

    return {
      results,
      totalFound: items.length,
      locationUsed: input.location,
      error: null,
    };

  } catch (err) {
    console.error('[idealista] Apify error:', err.message);
    return {
      results: [],
      error: err.message,
    };
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────
module.exports = {
  searchIdealista,
  buildApifyInput,
  mapApifyItem,
  resolveLocationId,
  LOCATION_IDS,
};
