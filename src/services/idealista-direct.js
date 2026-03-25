/**
 * idealista-direct.js — Idealista search via Apify igolaizola/idealista-scraper.
 *
 * This actor uses Idealista's internal API with NATIVE filters:
 *   - minPrice, maxPrice, minSize, maxSize
 *   - bedrooms[], bathrooms[], homeType[]
 *   - swimmingPool, garden, seaViews, terrace, etc.
 *   - condition: newDevelopment, good, renew
 *
 * Filters are applied SERVER-SIDE by Idealista — we only receive matching results.
 *
 * IMPORTANT: The actor requires Idealista Location IDs (not city names).
 * City names are resolved to IDs via the LOCATION_IDS mapping below.
 *
 * IMPORTANT: The actor output uses FLAT dot-notation keys for nested fields:
 *   item["contactInfo.commercialName"] NOT item.contactInfo.commercialName
 *   item["parkingSpace.hasParkingSpace"] NOT item.parkingSpace.hasParkingSpace
 *
 * Cost: $19/month actor fee + ~$0.03 compute per run.
 * Typical query: 3 cities × 100 items = ~$0.09
 */

const { ApifyClient } = require('apify-client');

// ─── Configuration ──────────────────────────────────────────────────────────

const APIFY_TOKEN = process.env.APIFY_API_TOKEN || process.env.APIFY_TOKEN || '';
const ACTOR_ID = 'igolaizola/idealista-scraper';
const MAX_ITEMS_PER_CITY = parseInt(process.env.IDEALISTA_MAX_ITEMS, 10) || 250;

if (!APIFY_TOKEN) {
  console.warn('[Idealista] WARNING: No APIFY_API_TOKEN set. Idealista searches will fail.');
}

const client = APIFY_TOKEN ? new ApifyClient({ token: APIFY_TOKEN }) : null;

// ─── Idealista Location ID Mapping ──────────────────────────────────────────
// Source: igolaizola.github.io/idealista-scraper/ (official Location Search Tool)
// Level: Municipio (city-level) — covers all listings within the municipality
// To add new cities: use the tool above, pick the "Municipio" level ID

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
  'albir':              '0-EU-ES-03-02-006-011',
  'alfaz del pi':       '0-EU-ES-03-02-006-011',
  "l'alfàs del pi":     '0-EU-ES-03-02-006-011',
  'benitachell':        '0-EU-ES-03-01-011-042',
  'benissa':            '0-EU-ES-03-01-010-041',
  'pedreguer':          '0-EU-ES-03-01-012-101',
  'la nucia':           '0-EU-ES-03-02-007-094',
  'villajoyosa':        '0-EU-ES-03-02-005-139',

  // Costa Blanca South
  'torrevieja':         '0-EU-ES-03-05-003-133',
  'orihuela':           '0-EU-ES-03-05-004-099',
  'orihuela costa':     '0-EU-ES-03-05-004-099',
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
  'san pedro de alcantara': '0-EU-ES-29-03-003-069',
  'nueva andalucia':    '0-EU-ES-29-03-003-069',
  'puerto banus':       '0-EU-ES-29-03-003-069',

  // Valencia / Alicante
  'valencia':           '0-EU-ES-46-02-002-250',
  'valència':           '0-EU-ES-46-02-002-250',

  // Other popular areas
  'madrid':             '0-EU-ES-28-07-001-079',
  'barcelona':          '0-EU-ES-08-01-001-019',
  'ronda':              '0-EU-ES-29-05-001-084',
  'antequera':          '0-EU-ES-29-04-001-015',
};

/**
 * Resolve a city name to an Idealista Location ID.
 * Returns the ID if found, or the original string as fallback.
 */
function resolveLocationId(locationName) {
  if (!locationName) return null;

  // If it already looks like a location ID, return as-is
  if (locationName.startsWith('0-EU-')) return locationName;

  // Normalize: lowercase, trim, strip accents for lookup
  const normalized = locationName.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Try exact match (with accents stripped on both sides)
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

  // Fallback: return the original name (actor may or may not resolve it)
  console.warn(`[Idealista] No Location ID found for "${locationName}" — passing raw name (may fail)`);
  return locationName;
}

// ─── homeType mapping ──────────────────────────────────────────────────────

const HOME_TYPE_MAP = {
  villa:         ['detachedHouse', 'villa'],
  apartment:     ['flat', 'apartment'],
  penthouse:     ['penthouse'],
  duplex:        ['duplex'],
  townhouse:     ['semiDetachedHouse', 'terracedHouse'],
  finca:         ['countryHouse'],
  country_house: ['countryHouse'],
  studio:        ['flat'],
  bungalow:      ['detachedHouse'],
  loft:          ['loft'],
};

// ─── Feature to Apify boolean param mapping ────────────────────────────────

const FEATURE_MAP = {
  pool:             'swimmingPool',
  garden:           'garden',
  terrace:          'terrace',
  garage:           'garage',
  air_conditioning: 'airConditioning',
  elevator:         'lift',
  storage:          'storageRoom',
  sea_view:         'seaViews',
};

// ─── Build Apify actor input from hardFilters ──────────────────────────────

function buildActorInput(location, hardFilters, isNewBuild = false) {
  // Resolve city name to Location ID
  const locationId = resolveLocationId(location);

  const input = {
    operation: 'sale',
    propertyType: isNewBuild ? 'newDevelopments' : 'homes',
    country: 'es',
    location: locationId,
    maxItems: MAX_ITEMS_PER_CITY,
    sortBy: 'mostRecent',
    fetchDetails: false,
    fetchStats: false,
    proxyConfiguration: {
      useApifyProxy: true,
      apifyProxyGroups: ['RESIDENTIAL'],
    },
  };

  // Price filters
  if (hardFilters.price_min) input.minPrice = String(hardFilters.price_min);
  if (hardFilters.price_max) input.maxPrice = String(hardFilters.price_max);

  // Size filters
  if (hardFilters.size_min_m2) input.minSize = String(hardFilters.size_min_m2);
  if (hardFilters.size_max_m2) input.maxSize = String(hardFilters.size_max_m2);

  // Bedrooms
  if (hardFilters.bedrooms_min) {
    const min = parseInt(hardFilters.bedrooms_min, 10);
    const beds = [];
    for (let i = min; i <= 4; i++) beds.push(String(i));
    input.bedrooms = beds;
  }

  // Bathrooms
  if (hardFilters.bathrooms_min) {
    const min = parseInt(hardFilters.bathrooms_min, 10);
    const baths = [];
    for (let i = min; i <= 3; i++) baths.push(String(i));
    input.bathrooms = baths;
  }

  // Home type
  if (hardFilters.property_type && HOME_TYPE_MAP[hardFilters.property_type]) {
    input.homeType = HOME_TYPE_MAP[hardFilters.property_type];
  }

  // Condition — for new build searches
  if (isNewBuild) {
    input.condition = ['newDevelopment'];
  }

  // Features (boolean flags)
  if (hardFilters.features && hardFilters.features.length) {
    for (const feat of hardFilters.features) {
      const apifyParam = FEATURE_MAP[feat];
      if (apifyParam) input[apifyParam] = true;
    }
  }

  return input;
}

// ─── Call Apify actor ──────────────────────────────────────────────────────

async function callApifyActor(actorInput) {
  if (!client) {
    throw new Error('APIFY_API_TOKEN not configured. Set it in Railway Variables.');
  }

  console.log(`[Idealista] Calling igolaizola actor for "${actorInput.location}" (maxItems=${actorInput.maxItems}, type=${actorInput.propertyType})`);
  if (actorInput.minPrice || actorInput.maxPrice) {
    console.log(`[Idealista]   Price: ${actorInput.minPrice || '0'} - ${actorInput.maxPrice || 'any'}`);
  }
  if (actorInput.homeType) {
    console.log(`[Idealista]   HomeType: ${actorInput.homeType.join(', ')}`);
  }
  if (actorInput.bedrooms) {
    console.log(`[Idealista]   Bedrooms: ${actorInput.bedrooms.join(', ')}`);
  }

  const run = await client.actor(ACTOR_ID).call(actorInput, {
    timeout: 300,
    memory: 1024,
  });

  if (!run || !run.defaultDatasetId) {
    console.error('[Idealista] Apify run failed — no dataset returned.');
    return [];
  }

  console.log(`[Idealista] Run ${run.id} completed (status: ${run.status}).`);

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  console.log(`[Idealista] Got ${items.length} items from Apify.`);

  return items;
}

// ─── Map igolaizola output to internal format ──────────────────────────────

/**
 * Map a single igolaizola result item to our internal listing format.
 *
 * IMPORTANT: The actor returns FLAT dot-notation keys for nested fields:
 *   item["contactInfo.commercialName"] NOT item.contactInfo.commercialName
 *   item["parkingSpace.hasParkingSpace"] NOT item.parkingSpace.hasParkingSpace
 *
 * Some fields may exist in either flat or nested format depending on the
 * actor version/mode, so we check both.
 */
function mapApifyItem(item) {
  try {
    // Helper: safely get a value from either flat dot-notation or nested path
    const get = (dotKey) => {
      // First try flat dot-notation key (how the actor actually returns data)
      if (item[dotKey] !== undefined) return item[dotKey];

      // Fallback: try nested access (in case actor changes format)
      const parts = dotKey.split('.');
      let val = item;
      for (const part of parts) {
        if (val == null) return null;
        val = val[part];
      }
      return val ?? null;
    };

    // Skip items without price or URL
    const price = item.price || get('priceInfo.price.amount') || null;
    const url = item.url || null;
    if (!price || !url) return null;

    // ID
    const id = item.propertyCode || url.match(/\/inmueble\/(\d+)/)?.[1] || url;

    // Location
    const city = item.municipality || '';
    const province = item.province || '';
    const address = item.address || '';
    const district = item.district || '';

    // Property characteristics
    const bedrooms = item.rooms || null;
    const bathrooms = item.bathrooms || null;
    const size_m2 = item.size || null;
    const floor = item.floor || null;

    // Images — check both nested and flat format
    const images = [];
    if (item.multimedia && item.multimedia.images) {
      // Nested format (fetchDetails=true or future actor versions)
      for (const img of item.multimedia.images) {
        if (img.url) images.push(img.url);
      }
    }
    const thumbnail = item.thumbnail || (images.length > 0 ? images[0] : null);

    // Description
    const description = item.description || '';

    // Property type — from actor output
    const rawType = item.propertyType || get('detailedType.typology') || '';
    const propertyType = mapPropertyType(rawType);

    // Features — extract from both structured and flat fields + description
    const features = extractFeatures(item);

    // Contact info — check both flat and nested format
    const agency = get('contactInfo.commercialName') || get('contactInfo.contactName') || null;

    // New build
    const isNewBuild = item.newDevelopment === true || item.topNewDevelopment === true ||
      (item.status === 'newDevelopment') || false;

    // GPS
    const latitude = item.latitude || null;
    const longitude = item.longitude || null;

    // Price per m²
    const priceByArea = item.priceByArea || ((price && size_m2) ? Math.round(price / size_m2) : null);

    // Title — check both flat and nested format
    const title = get('suggestedTexts.title') ||
      `${propertyType || 'Property'} in ${city}${address ? ` — ${address}` : ''}`;

    // Tags
    const tags = [];
    if (isNewBuild) tags.push('Obra Nueva');
    if (item.topPlus) tags.push('TopPlus');
    if (item.preferenceHighlight) tags.push('Highlighted');

    return {
      id: String(id),
      source: 'idealista',
      title,
      price,
      currency: '€',
      location: city,
      bedrooms,
      bathrooms,
      size_m2,
      floor,
      url,
      thumbnail,
      features,
      property_type: propertyType,
      description: description.substring(0, 500),
      price_per_m2: priceByArea,
      address,
      district,
      province,
      municipality: city,
      latitude,
      longitude,
      images,
      agency,
      tags,
      is_new_build: isNewBuild,
    };
  } catch (err) {
    console.warn(`[Idealista] Failed to map item: ${err.message}`);
    return null;
  }
}

/**
 * Map Idealista property type to our internal type.
 */
function mapPropertyType(rawType) {
  const t = (rawType || '').toLowerCase();
  if (t === 'flat' || t === 'apartment') return 'flat';
  if (t === 'penthouse') return 'penthouse';
  if (t === 'duplex') return 'duplex';
  if (t === 'detachedhouse' || t === 'villa' || t === 'chalet') return 'chalet';
  if (t === 'semidetachedhouse' || t === 'terracedhouse') return 'townhouse';
  if (t === 'countryhouse') return 'countryHouse';
  if (t === 'loft') return 'loft';
  if (t === 'studio') return 'studio';
  return t || null;
}

/**
 * Extract features from the item.
 *
 * Handles BOTH formats:
 * - Nested: item.features.hasSwimmingPool, item.parkingSpace.hasParkingSpace
 * - Flat dot-notation: item["features.hasSwimmingPool"], item["parkingSpace.hasParkingSpace"]
 *
 * Also extracts features from description text as fallback.
 */
function extractFeatures(item) {
  const features = [];

  // Helper for flat or nested access
  const get = (dotKey) => {
    if (item[dotKey] !== undefined) return item[dotKey];
    const parts = dotKey.split('.');
    let val = item;
    for (const part of parts) {
      if (val == null) return null;
      val = val[part];
    }
    return val ?? null;
  };

  // Structured features (nested or flat)
  if (get('features.hasSwimmingPool')) features.push('pool');
  if (get('features.hasGarden')) features.push('garden');
  if (get('features.hasTerrace')) features.push('terrace');
  if (get('features.hasAirConditioning')) features.push('air_conditioning');
  if (get('features.hasBoxRoom')) features.push('storage');

  // Top-level booleans (these are always flat)
  if (item.hasLift) features.push('elevator');
  if (get('parkingSpace.hasParkingSpace')) features.push('garage');
  if (item.exterior) features.push('exterior');

  // Description-based extraction as fallback
  const desc = (item.description || '').toLowerCase();
  if (!features.includes('pool') && (desc.includes('piscina') || desc.includes('pool'))) features.push('pool');
  if (!features.includes('garden') && (desc.includes('jardín') || desc.includes('jardin') || desc.includes('garden'))) features.push('garden');
  if (!features.includes('terrace') && (desc.includes('terraza') || desc.includes('terrace'))) features.push('terrace');
  if (!features.includes('garage') && (desc.includes('garaje') || desc.includes('garage') || desc.includes('parking'))) features.push('garage');
  if (!features.includes('air_conditioning') && (desc.includes('aire acondicionado') || desc.includes('air conditioning'))) features.push('air_conditioning');
  if (!features.includes('elevator') && desc.includes('ascensor')) features.push('elevator');
  if (!features.includes('storage') && desc.includes('trastero')) features.push('storage');

  // Sea view — always from description (not in features object)
  if (desc.includes('sea view') || desc.includes('vista al mar') || desc.includes('vistas al mar')) {
    features.push('sea_view');
  }

  return [...new Set(features)];
}

// ─── Main search function ──────────────────────────────────────────────────

/**
 * Search Idealista via Apify igolaizola actor.
 * Runs one actor call per city (actor accepts one location per run).
 *
 * Returns: Array of listing objects (always an array, even on error).
 */
async function searchIdealista(hardFilters) {
  const locations = hardFilters.locations || (hardFilters.location ? [hardFilters.location] : []);
  const isNewBuild = hardFilters.is_new_build === true;

  if (locations.length === 0) {
    console.warn('[Idealista] No locations specified. Skipping.');
    return [];
  }

  // Cap at 15 locations
  const searchLocations = locations.slice(0, 15);
  console.log(`[Idealista] Searching ${searchLocations.length} location(s): ${searchLocations.join(', ')}${isNewBuild ? ' (nieuwbouw)' : ''}`);

  const allListings = [];

  // Run one actor call per city (igolaizola accepts one location per run)
  for (const city of searchLocations) {
    try {
      const actorInput = buildActorInput(city, hardFilters, isNewBuild);

      // Safety check: if location resolved to null, skip this city
      if (!actorInput.location) {
        console.error(`[Idealista] Location "${city}" resolved to null — skipping.`);
        continue;
      }

      console.log(`[Idealista] ${city} → Location ID: ${actorInput.location}`);

      const items = await callApifyActor(actorInput);

      let mapped = 0;
      let failed = 0;
      for (const item of items) {
        const listing = mapApifyItem(item);
        if (listing) {
          allListings.push(listing);
          mapped++;
        } else {
          failed++;
        }
      }

      console.log(`[Idealista] ${city}: ${mapped} mapped, ${failed} skipped (${items.length} raw)`);
    } catch (err) {
      console.error(`[Idealista] Error searching ${city}: ${err.message}`);

      // Detect auth errors
      if (err.message?.includes('401') || err.message?.includes('403') || err.message?.includes('token')) {
        console.error('[Idealista] APIFY_API_TOKEN is invalid or expired. Check Railway Variables.');
      }
      // Detect subscription errors
      if (err.message?.includes('402') || err.message?.includes('payment') || err.message?.includes('subscription')) {
        console.error('[Idealista] Actor subscription required. Subscribe at https://apify.com/igolaizola/idealista-scraper');
      }
    }
  }

  console.log(`[Idealista] Total: ${allListings.length} properties from ${searchLocations.length} location(s)`);
  return allListings;
}

// ─── Detail scrape via propertyCodes ───────────────────────────────────────

/**
 * Enrich listings with full details using the propertyCodes feature.
 * When propertyCodes is provided, the actor fetches individual listings
 * and always returns _details for each.
 */
async function enrichListingsWithDetails(listings, maxListings = 8) {
  if (!client || !listings || listings.length === 0) return new Map();

  const enrichments = new Map();
  const toEnrich = listings
    .filter(l => l.source === 'idealista' && l.id)
    .slice(0, maxListings);

  if (toEnrich.length === 0) return enrichments;

  console.log(`[Idealista-Detail] Enriching ${toEnrich.length} listings via propertyCodes...`);

  try {
    const codes = toEnrich.map(l => String(l.id));

    const run = await client.actor(ACTOR_ID).call({
      operation: 'sale',
      propertyType: 'homes',
      country: 'es',
      location: '0-EU-ES-28-07-001-079', // Madrid — required but ignored when propertyCodes is set
      propertyCodes: codes,
      proxyConfiguration: {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
      },
    }, {
      timeout: 300,
      memory: 1024,
    });

    if (!run || !run.defaultDatasetId) {
      console.warn('[Idealista-Detail] No dataset returned.');
      return enrichments;
    }

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    for (const detailItem of items) {
      const code = String(detailItem.propertyCode || '');
      const matchedListing = toEnrich.find(l => String(l.id) === code);

      if (matchedListing) {
        // Handle both flat and nested image formats
        const images = [];
        if (detailItem.multimedia && detailItem.multimedia.images) {
          for (const img of detailItem.multimedia.images) {
            if (img.url) images.push(img.url);
          }
        }

        const details = detailItem._details || {};

        enrichments.set(matchedListing.id, {
          images,
          full_description: details.propertyComment || detailItem.description || '',
          latitude: detailItem.latitude || null,
          longitude: detailItem.longitude || null,
          address: detailItem.address || '',
          energy_rating: details.energyCertification?.energyConsumption?.type || null,
        });

        // Merge back into listing
        if (images.length > 0) matchedListing.images = images;
        if (details.propertyComment) matchedListing.full_description = details.propertyComment;
        if (detailItem.latitude) matchedListing.latitude = detailItem.latitude;
        if (detailItem.longitude) matchedListing.longitude = detailItem.longitude;
      }
    }

    console.log(`[Idealista-Detail] Enriched ${enrichments.size}/${toEnrich.length} listings`);
  } catch (err) {
    console.warn(`[Idealista-Detail] Enrichment failed (non-fatal): ${err.message}`);
  }

  return enrichments;
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  searchIdealista,
  enrichListingsWithDetails,
  buildActorInput,
  resolveLocationId,
  LOCATION_IDS,
  // Expose for testing
  mapApifyItem,
  mapPropertyType,
  extractFeatures,
};
