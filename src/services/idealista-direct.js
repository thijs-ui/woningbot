/**
 * idealista-direct.js — Idealista search via Apify dz_omar actor.
 *
 * Uses the dz_omar/idealista-scraper-api actor on Apify marketplace.
 * This actor accepts Idealista search URLs and returns structured JSON.
 *
 * Cost: $0.50 per 1,000 results on Scale plan.
 * Typical query: 3 cities × 150 results = 450 results = ~$0.23
 *
 * Why Apify instead of self-scraping:
 *   - Idealista uses DataDome anti-bot → self-scraping is unreliable
 *   - Apify handles proxy rotation, CAPTCHA solving, and rendering
 *   - Structured JSON output → no HTML parsing needed
 *   - GPS coordinates, full images, contact info included
 */

const { ApifyClient } = require('apify-client');

// ─── Configuration ──────────────────────────────────────────────────────────

const APIFY_TOKEN = process.env.APIFY_API_TOKEN || process.env.APIFY_TOKEN || '';
const ACTOR_ID = 'dz_omar/idealista-scraper-api';
const RESULTS_PER_CITY = parseInt(process.env.IDEALISTA_RESULTS_PER_CITY, 10) || 150; // 5 pages × 30

if (!APIFY_TOKEN) {
  console.warn('[Idealista] WARNING: No APIFY_API_TOKEN set. Idealista searches will fail.');
}

const client = APIFY_TOKEN ? new ApifyClient({ token: APIFY_TOKEN }) : null;

// ─── City slug mapping (Idealista URL format) ───────────────────────────────

const CITY_SLUG_MAP = {
  // Costa del Sol
  'estepona':       'estepona-malaga',
  'marbella':       'marbella-malaga',
  'san pedro de alcantara': 'marbella-malaga',
  'malaga':         'malaga-malaga',
  'málaga':         'malaga-malaga',
  'fuengirola':     'fuengirola-malaga',
  'mijas':          'mijas-malaga',
  'benalmadena':    'benalmadena-malaga',
  'benalmádena':    'benalmadena-malaga',
  'torremolinos':   'torremolinos-malaga',
  'nerja':          'nerja-malaga',
  'manilva':        'manilva-malaga',
  'casares':        'casares-malaga',
  'benahavis':      'benahavis-malaga',
  'benahavís':      'benahavis-malaga',
  'sotogrande':     'san-roque-cadiz',
  'rincon de la victoria': 'rincon-de-la-victoria-malaga',
  'velez-malaga':   'velez-malaga-malaga',
  'vélez-málaga':   'velez-malaga-malaga',
  'torrox':         'torrox-malaga',

  // Costa Blanca South
  'torrevieja':     'torrevieja-alicante',
  'orihuela':       'orihuela-alicante',
  'orihuela costa': 'orihuela-alicante',
  'guardamar del segura': 'guardamar-del-segura-alicante',
  'rojales':        'rojales-alicante',
  'pilar de la horadada': 'pilar-de-la-horadada-alicante',
  'santa pola':     'santa-pola-alicante',
  'elche':          'elche-elx-alicante',
  'alicante':       'alicante-alicante',
  'murcia':         'murcia-murcia',
  'cartagena':      'cartagena-murcia',

  // Costa Blanca North
  'javea':          'javea-xabia-alicante',
  'jávea':          'javea-xabia-alicante',
  'denia':          'denia-alicante',
  'dénia':          'denia-alicante',
  'moraira':        'teulada-alicante',
  'teulada':        'teulada-alicante',
  'calpe':          'calpe-calp-alicante',
  'altea':          'altea-alicante',
  'benidorm':       'benidorm-alicante',
  'alfaz del pi':   'alfaz-del-pi-l-alicante',
  'villajoyosa':    'villajoyosa-la-vila-joiosa-alicante',

  // Valencia
  'valencia':       'valencia-valencia',
  'gandia':         'gandia-valencia',
  'gandía':         'gandia-valencia',
  'sagunto':        'sagunto-sagunt-valencia',

  // Inland Málaga
  'ronda':          'ronda-malaga',
  'antequera':      'antequera-malaga',
  'coin':           'coin-malaga',
  'coín':           'coin-malaga',
  'alhaurin el grande': 'alhaurin-el-grande-malaga',

  // Major cities
  'madrid':         'madrid-madrid',
  'barcelona':      'barcelona-barcelona',
  'sevilla':        'sevilla-sevilla',
  'granada':        'granada-granada',
  'cadiz':          'cadiz-cadiz',
  'cádiz':          'cadiz-cadiz',
  'almeria':        'almeria-almeria',
  'almería':        'almeria-almeria',
  'palma':          'palma-de-mallorca-baleares',
  'palma de mallorca': 'palma-de-mallorca-baleares',
  'ibiza':          'ibiza-baleares',
};

// ─── Property type URL segments ─────────────────────────────────────────────

const PROPERTY_TYPE_PARAMS = {
  villa:         'con-chalets-independientes',
  apartment:     'con-pisos',
  penthouse:     'con-aticos',
  duplex:        'con-duplex',
  townhouse:     'con-adosados',
  finca:         'con-rusticas',
  country_house: 'con-rusticas',
  studio:        'con-estudios',
  bungalow:      'con-chalets',
};

// ─── Feature URL params ─────────────────────────────────────────────────────

const FEATURE_PARAMS = {
  pool:             'swimmingPool=true',
  garden:           'garden=true',
  terrace:          'terrace=true',
  garage:           'garage=true',
  air_conditioning: 'airConditioning=true',
  elevator:         'elevator=true',
  storage:          'storeRoom=true',
};

// ─── URL Builder ────────────────────────────────────────────────────────────

function resolveCitySlug(city) {
  const normalized = (city || '').toLowerCase().trim();
  if (normalized && CITY_SLUG_MAP[normalized]) return CITY_SLUG_MAP[normalized];

  // Try partial match
  for (const [key, slug] of Object.entries(CITY_SLUG_MAP)) {
    if (normalized.includes(key) || key.includes(normalized)) return slug;
  }

  console.warn(`[Idealista] City "${city}" not in slug map — SKIPPING.`);
  return null;
}

/**
 * Build an Idealista search URL using English format with query params.
 * This is the format that Apify's dz_omar actor expects and handles reliably.
 *
 * Example: https://www.idealista.com/en/venta-viviendas/marbella-malaga/con-chalets-independientes/?minPrice=800000&maxPrice=1000000&minRooms=3&swimmingPool=true
 */
function buildSearchUrl(citySlug, hardFilters, isNewBuild = false) {
  // Base path
  let basePath;
  if (hardFilters.property_type === 'plot') {
    basePath = isNewBuild ? 'obra-nueva' : 'venta-terrenos';
  } else {
    basePath = isNewBuild ? 'obra-nueva' : 'venta-viviendas';
  }

  // Property type path segment
  const typeSlug = hardFilters.property_type && PROPERTY_TYPE_PARAMS[hardFilters.property_type]
    ? `${PROPERTY_TYPE_PARAMS[hardFilters.property_type]}/`
    : '';

  // Query parameters
  const params = [];
  if (hardFilters.price_min) params.push(`minPrice=${hardFilters.price_min}`);
  if (hardFilters.price_max) params.push(`maxPrice=${hardFilters.price_max}`);
  if (hardFilters.bedrooms_min) params.push(`minRooms=${hardFilters.bedrooms_min}`);
  if (hardFilters.size_min_m2) params.push(`minSize=${hardFilters.size_min_m2}`);
  if (hardFilters.size_max_m2) params.push(`maxSize=${hardFilters.size_max_m2}`);

  // Features
  if (hardFilters.features && hardFilters.features.length) {
    for (const feat of hardFilters.features) {
      if (FEATURE_PARAMS[feat]) params.push(FEATURE_PARAMS[feat]);
    }
  }

  let url = `https://www.idealista.com/en/${basePath}/${citySlug}/${typeSlug}`;
  if (params.length > 0) {
    url += `?${params.join('&')}`;
  }

  return url;
}

// ─── Apify Actor Call ───────────────────────────────────────────────────────

/**
 * Call the dz_omar Apify actor with a list of search URLs.
 * Returns raw Apify items (structured JSON).
 */
async function callApifyActor(urls, desiredResults = RESULTS_PER_CITY) {
  if (!client) {
    throw new Error('APIFY_API_TOKEN not configured. Set it in Railway Variables.');
  }

  const propertyUrls = urls.map(url => ({ url }));

  console.log(`[Idealista] Calling Apify actor with ${urls.length} URL(s), desiredResults=${desiredResults}`);
  urls.forEach((u, i) => console.log(`[Idealista]   URL ${i + 1}: ${u}`));

  const run = await client.actor(ACTOR_ID).call(
    {
      Property_urls: propertyUrls,
      desiredResults,
    },
    {
      timeout: 300, // 5 minute timeout
      memory: 512,
    }
  );

  if (!run || !run.defaultDatasetId) {
    console.error('[Idealista] Apify run failed — no dataset returned.');
    return [];
  }

  console.log(`[Idealista] Apify run ${run.id} completed (status: ${run.status}). Fetching dataset...`);

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  console.log(`[Idealista] Got ${items.length} items from Apify.`);

  return items;
}

// ─── Map Apify output to internal format ────────────────────────────────────

/**
 * Map a single Apify result item to our internal listing format.
 * The dz_omar actor returns rich structured data — we normalize it.
 */
function mapApifyItem(item, sourceCity) {
  try {
    // Skip items with errors
    if (item.status === 'error' || !item.price) return null;

    const price = item.price || item.priceInfo?.amount || null;
    const currency = item.priceInfo?.currencySuffix || '€';

    // Location info
    const ubication = item.ubication || {};
    const city = ubication.administrativeAreaLevel2 || sourceCity || '';
    const province = ubication.administrativeAreaLevel1 || '';
    const address = ubication.title || '';
    const latitude = ubication.latitude || null;
    const longitude = ubication.longitude || null;

    // Property characteristics
    const chars = item.moreCharacteristics || {};
    const bedrooms = chars.roomNumber || null;
    const bathrooms = chars.bathNumber || null;
    const size_m2 = chars.constructedArea || chars.usableArea || null;
    const floor = chars.floor || null;

    // Images
    const images = (item.multimedia?.images || []).map(img => img.url).filter(Boolean);
    const thumbnail = images[0] || null;

    // Property type mapping
    const extType = (item.extendedPropertyType || '').toLowerCase();
    const propertyType = mapPropertyType(extType);

    // Features
    const features = extractFeatures(chars, item);

    // URL
    const url = item.detailWebLink || (item.adid ? `https://www.idealista.com/en/inmueble/${item.adid}/` : null);

    // Title
    const title = item.suggestedTexts?.title || item.title || `${propertyType || 'Property'} in ${city}`;

    // Description
    const description = item.suggestedTexts?.subtitle || item.propertyComment || '';

    // Agency
    const contactInfo = item.contactInfo || {};
    const agency = contactInfo.contactName || null;

    // New build detection
    const isNewBuild = !!(item.newDevelopment || item.isNewDevelopment ||
      (item.labels || []).some(l => (l || '').toLowerCase().includes('obra nueva') || (l || '').toLowerCase().includes('new')));

    // Tags
    const tags = [];
    if (item.labels) tags.push(...item.labels);
    if (item.priceDropPercentage) tags.push(`-${item.priceDropPercentage}%`);
    if (item.isNewDevelopment || item.newDevelopment) tags.push('Obra Nueva');

    if (!url) return null;

    return {
      id: item.adid || item.propertyCode || url,
      source: 'idealista',
      title,
      price,
      currency,
      location: city,
      bedrooms,
      bathrooms,
      size_m2,
      floor,
      url,
      thumbnail,
      features,
      property_type: propertyType,
      description,
      price_per_m2: (price && size_m2) ? Math.round(price / size_m2) : null,
      address,
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
    console.warn(`[Idealista] Failed to map item:`, err.message);
    return null;
  }
}

/**
 * Map Idealista's extendedPropertyType to our internal types.
 */
function mapPropertyType(extType) {
  const map = {
    'flat': 'flat',
    'apartment': 'flat',
    'penthouse': 'penthouse',
    'duplex': 'duplex',
    'studio': 'studio',
    'chalet': 'chalet',
    'villa': 'chalet',
    'independenthouse': 'chalet',
    'semidetachedhouse': 'townhouse',
    'terraced': 'townhouse',
    'terraced_house': 'townhouse',
    'countryhouse': 'countryHouse',
    'rustic': 'countryHouse',
    'bungalow': 'bungalow',
  };
  return map[extType] || extType || null;
}

/**
 * Extract features from Apify's moreCharacteristics and other fields.
 */
function extractFeatures(chars, item) {
  const features = [];

  if (chars.hasSwimmingPool || item.hasSwimmingPool) features.push('pool');
  if (chars.hasGarden || item.hasGarden) features.push('garden');
  if (chars.hasTerrace || item.hasTerrace) features.push('terrace');
  if (chars.hasGarage || item.parkingSpace?.hasParkingSpace) features.push('garage');
  if (chars.hasAirConditioning || item.hasAirConditioning) features.push('air_conditioning');
  if (chars.hasLift || chars.lift) features.push('elevator');
  if (chars.hasStoreRoom || item.hasStoreRoom) features.push('storage');
  if (chars.exterior) features.push('exterior');

  // Check description for sea view / mountain view
  const desc = (item.propertyComment || item.suggestedTexts?.subtitle || '').toLowerCase();
  if (desc.includes('sea view') || desc.includes('vista al mar') || desc.includes('vistas al mar')) features.push('sea_view');
  if (desc.includes('mountain') || desc.includes('montaña')) features.push('mountain_view');
  if (desc.includes('security') || desc.includes('gated') || desc.includes('vigilancia')) features.push('security');

  return [...new Set(features)];
}

// ─── Main search function ───────────────────────────────────────────────────

/**
 * Search Idealista via Apify — drop-in replacement for the self-scraping version.
 * Same interface: accepts hardFilters, returns normalized property array.
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

  // Build URLs for all valid cities
  const urls = [];
  const cityMap = new Map(); // url → city name for source tracking

  for (const city of searchLocations) {
    const slug = resolveCitySlug(city);
    if (!slug) continue;

    const url = buildSearchUrl(slug, hardFilters, isNewBuild);
    urls.push(url);
    cityMap.set(url, city);
  }

  if (urls.length === 0) {
    console.warn('[Idealista] No valid city slugs found. Returning empty.');
    return [];
  }

  // Call Apify with all URLs at once (more efficient than per-city)
  let items;
  try {
    items = await callApifyActor(urls, RESULTS_PER_CITY);
  } catch (err) {
    console.error(`[Idealista] Apify call failed:`, err.message);

    // Detect auth errors
    if (err.message?.includes('401') || err.message?.includes('403') || err.message?.includes('token')) {
      console.error('[Idealista] ⚠️ APIFY_API_TOKEN is invalid or expired. Check Railway Variables.');
    }

    return [];
  }

  // Map all items to our internal format
  const allListings = items
    .map(item => {
      // Try to determine source city from the item's location
      const city = item.ubication?.administrativeAreaLevel2 || '';
      return mapApifyItem(item, city);
    })
    .filter(Boolean);

  console.log(`[Idealista] Total: ${allListings.length} properties from ${urls.length} URL(s) (${items.length} raw items)`);
  return allListings;
}

// ─── Detail scrape (now via Apify individual URL) ───────────────────────────

/**
 * Enrich listings with full details by calling Apify with individual listing URLs.
 * This gets full descriptions, all images, GPS coordinates, etc.
 */
async function enrichListingsWithDetails(listings, maxListings = 8) {
  if (!client || !listings || listings.length === 0) return new Map();

  const enrichments = new Map();
  const toEnrich = listings
    .filter(l => l.source === 'idealista' && l.url)
    .slice(0, maxListings);

  if (toEnrich.length === 0) return enrichments;

  console.log(`[Idealista-Detail] Enriching ${toEnrich.length} listings via Apify...`);

  try {
    const urls = toEnrich.map(l => l.url);
    const items = await callApifyActor(urls, 1);

    // Match items back to listings
    for (const item of items) {
      const adid = String(item.adid || '');
      const detailUrl = item.detailWebLink || '';

      const matchedListing = toEnrich.find(l =>
        String(l.id) === adid ||
        l.url === detailUrl ||
        l.url.includes(adid)
      );

      if (matchedListing) {
        const images = (item.multimedia?.images || []).map(img => img.url).filter(Boolean);
        const fullDesc = item.propertyComment || '';
        const ubication = item.ubication || {};

        enrichments.set(matchedListing.id, {
          images,
          full_description: fullDesc,
          latitude: ubication.latitude || null,
          longitude: ubication.longitude || null,
          address: ubication.title || '',
          energy_rating: item.energyCertification?.energyConsumption?.type || null,
        });

        // Merge back into listing
        if (images.length > 0) matchedListing.images = images;
        if (fullDesc) matchedListing.full_description = fullDesc;
        if (ubication.latitude) matchedListing.latitude = ubication.latitude;
        if (ubication.longitude) matchedListing.longitude = ubication.longitude;
        if (ubication.title) matchedListing.address = ubication.title;
      }
    }

    console.log(`[Idealista-Detail] Enriched ${enrichments.size}/${toEnrich.length} listings`);
  } catch (err) {
    console.warn(`[Idealista-Detail] Enrichment failed (non-fatal): ${err.message}`);
  }

  return enrichments;
}

// ─── Exports ────────────────────────────────────────────────────────────────

const LOCATION_MAP = Object.fromEntries(
  Object.entries(CITY_SLUG_MAP).map(([city]) => [city, city])
);

function resolveLocationId(city) {
  return resolveCitySlug(city);
}

module.exports = {
  searchIdealista,
  enrichListingsWithDetails,
  buildSearchUrl,
  CITY_SLUG_MAP,
  LOCATION_MAP,
  resolveLocationId,
  // Expose for testing
  mapApifyItem,
  callApifyActor,
};
