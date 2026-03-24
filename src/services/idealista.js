const https = require('https');

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const ACTOR_ID = 'sian.agency~smart-idealista-scraper';

/**
 * Verified Idealista location IDs.
 * Source: igolaizola.github.io/idealista-scraper (official Idealista location database).
 * Format: 0-EU-ES-{province}-{sub1}-{sub2}-{municipality}
 */
const LOCATION_MAP = {
  // Costa del Sol
  'estepona':       '0-EU-ES-29-07-001-051',
  'marbella':       '0-EU-ES-29-03-003-069',
  'san pedro de alcantara': '0-EU-ES-29-03-003-069',
  'malaga':         '0-EU-ES-29-02-001-067',
  'málaga':         '0-EU-ES-29-02-001-067',
  'fuengirola':     '0-EU-ES-29-08-003-054',
  'mijas':          '0-EU-ES-29-08-004-070',
  'benalmadena':    '0-EU-ES-29-08-002-025',
  'benalmádena':    '0-EU-ES-29-08-002-025',
  'torremolinos':   '0-EU-ES-29-08-001-901',
  'nerja':          '0-EU-ES-29-01-003-075',
  'manilva':        '0-EU-ES-29-07-003-068',
  'casares':        '0-EU-ES-29-07-002-041',
  'benahavis':      '0-EU-ES-29-03-001-023',
  'benahavís':      '0-EU-ES-29-03-001-023',
  'sotogrande':     '0-EU-ES-11-03-005-033',
  'rincon de la victoria': '0-EU-ES-29-01-006-082',
  'velez-malaga':   '0-EU-ES-29-01-005-094',
  'vélez-málaga':   '0-EU-ES-29-01-005-094',
  'torrox':         '0-EU-ES-29-01-004-091',

  // Costa Blanca South
  'torrevieja':     '0-EU-ES-03-05-003-133',
  'orihuela':       '0-EU-ES-03-05-004-099',
  'orihuela costa': '0-EU-ES-03-05-004-099',
  'guardamar del segura': '0-EU-ES-03-05-002-076',
  'rojales':        '0-EU-ES-03-05-007-113',
  'pilar de la horadada': '0-EU-ES-03-05-009-902',
  'santa pola':     '0-EU-ES-03-04-002-121',
  'elche':          '0-EU-ES-03-04-001-065',
  'alicante':       '0-EU-ES-03-03-001-014',
  'murcia':         '0-EU-ES-30-05-001-030',
  'cartagena':      '0-EU-ES-30-02-001-016',

  // Costa Blanca North
  'javea':          '0-EU-ES-03-01-004-082',
  'jávea':          '0-EU-ES-03-01-004-082',
  'denia':          '0-EU-ES-03-01-002-063',
  'dénia':          '0-EU-ES-03-01-002-063',
  'moraira':        '0-EU-ES-03-01-005-128',
  'teulada':        '0-EU-ES-03-01-005-128',
  'calpe':          '0-EU-ES-03-01-006-047',
  'altea':          '0-EU-ES-03-02-002-018',
  'benidorm':       '0-EU-ES-03-02-003-031',

  // Valencia
  'valencia':       '0-EU-ES-46-02-002-250',
  'gandia':         '0-EU-ES-46-04-002-131',
  'gandía':         '0-EU-ES-46-04-002-131',

  // Inland Málaga
  'ronda':          '0-EU-ES-29-05-002-084',
  'antequera':      '0-EU-ES-29-06-001-015',
  'coin':           '0-EU-ES-29-04-001-042',
  'coín':           '0-EU-ES-29-04-001-042',
  'alhaurin el grande': '0-EU-ES-29-04-004-008',

  // Major cities
  'madrid':         '0-EU-ES-28-07-001-079',
  'barcelona':      '0-EU-ES-08-13-001-019',
  'sevilla':        '0-EU-ES-41-08-001-091',
  'granada':        '0-EU-ES-18-05-001-087',
  'cadiz':          '0-EU-ES-11-01-001-012',
  'cádiz':          '0-EU-ES-11-01-001-012',
  'almeria':        '0-EU-ES-04-10-001-013',
  'almería':        '0-EU-ES-04-10-001-013',
  'palma':          '0-EU-ES-07-01-001-040',
  'palma de mallorca': '0-EU-ES-07-01-001-040',
  'ibiza':          '0-EU-ES-07-02-004-026',
};

/**
 * Resolve location to a locationId.
 */
function resolveLocationId(city) {
  const normalized = (city || '').toLowerCase().trim();
  if (normalized && LOCATION_MAP[normalized]) return LOCATION_MAP[normalized];

  // Try partial match
  for (const [key, id] of Object.entries(LOCATION_MAP)) {
    if (normalized.includes(key) || key.includes(normalized)) return id;
  }

  console.warn(`[Idealista] Location "${city}" not in mapping. Falling back to no location filter.`);
  return null;
}

function mapPropertyTypeFlags(type) {
  const f = {};
  if (!type) return f;
  switch (type) {
    case 'villa':         f.chalet = true; break;
    case 'apartment':     f.flat = true; break;
    case 'penthouse':     f.penthouse = true; break;
    case 'duplex':        f.duplex = true; break;
    case 'townhouse':     f.semiDetachedHouse = true; f.terracedHouse = true; break;
    case 'finca':
    case 'country_house': f.countryHouse = true; break;
    case 'studio':        f.flat = true; break;
    case 'bungalow':      f.chalet = true; break;
  }
  return f;
}

function mapBedroomFlags(min) {
  if (!min) return {};
  const f = {};
  if (min >= 4) { f.bedrooms4 = true; }
  else if (min === 3) { f.bedrooms3 = true; f.bedrooms4 = true; }
  else if (min === 2) { f.bedrooms2 = true; f.bedrooms3 = true; f.bedrooms4 = true; }
  else if (min === 1) { f.bedrooms1 = true; f.bedrooms2 = true; f.bedrooms3 = true; f.bedrooms4 = true; }
  return f;
}

function mapFeatureFlags(features) {
  if (!features || !features.length) return {};
  const map = {
    pool: 'swimmingPool', garden: 'garden', terrace: 'terrace',
    garage: 'garage', air_conditioning: 'airConditioning',
    elevator: 'elevator', storage: 'storeRoom',
  };
  const f = {};
  for (const feat of features) { if (map[feat]) f[map[feat]] = true; }
  return f;
}

function buildApifyInput(hardFilters, locationCity, forceEndpoint = null) {
  const locationId = resolveLocationId(locationCity);

  let endpoint = 'listhomes';
  if (forceEndpoint) {
    endpoint = forceEndpoint;
  } else if (hardFilters.property_type === 'plot') {
    endpoint = 'listlands';
  }

  const input = {
    country: 'es',
    operation: hardFilters.operation || 'sale',
    endpoint,
    numPages: 2,
    language: 'en',
    locationName: locationCity || 'España',
  };

  if (locationId) {
    input.locationId = locationId;
  }

  if (hardFilters.price_min) input.minPrice = hardFilters.price_min;
  if (hardFilters.price_max) input.maxPrice = hardFilters.price_max;
  if (hardFilters.size_min_m2) input.minSize = hardFilters.size_min_m2;
  if (hardFilters.size_max_m2) input.maxSize = hardFilters.size_max_m2;

  Object.assign(input, mapPropertyTypeFlags(hardFilters.property_type));
  Object.assign(input, mapBedroomFlags(hardFilters.bedrooms_min));
  Object.assign(input, mapFeatureFlags(hardFilters.features));

  return input;
}

function makeRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { reject(new Error(`Failed to parse response: ${data.substring(0, 500)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(150000, () => { req.destroy(); reject(new Error('Request timeout (150s)')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Search Idealista via Apify — supports multiple locations.
 * If is_new_build is true, runs both resale + obra nueva per location.
 * @param {object} hardFilters - hard_filters from Claude parser (with locations array)
 * @returns {Array} Normalized property listings
 */
async function searchIdealista(hardFilters) {
  const locations = hardFilters.locations || (hardFilters.location ? [hardFilters.location] : []);
  const isNewBuild = hardFilters.is_new_build === true;

  if (locations.length === 0) {
    console.warn('[Idealista] No locations specified. Skipping.');
    return [];
  }

  // Cap at 5 locations to avoid excessive Apify usage
  const searchLocations = locations.slice(0, 5);
  console.log(`[Idealista] Searching ${searchLocations.length} location(s): ${searchLocations.join(', ')}${isNewBuild ? ' (incl. nieuwbouw)' : ''}`);

  const searchPromises = [];

  for (const city of searchLocations) {
    if (isNewBuild) {
      // Run both resale + new build for this city
      searchPromises.push(
        runSingleSearch(hardFilters, city, 'listhomes')
          .catch(err => { console.error(`[Idealista] Resale ${city} failed:`, err.message); return []; }),
        runSingleSearch(hardFilters, city, 'listnewhomes')
          .then(results => { results.forEach(p => { p.is_new_build = true; }); return results; })
          .catch(err => { console.error(`[Idealista] New build ${city} failed:`, err.message); return []; }),
      );
    } else {
      searchPromises.push(
        runSingleSearch(hardFilters, city)
          .catch(err => { console.error(`[Idealista] ${city} failed:`, err.message); return []; }),
      );
    }
  }

  const results = await Promise.allSettled(searchPromises);
  const allListings = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  console.log(`[Idealista] Total: ${allListings.length} properties from ${searchLocations.length} location(s)`);
  return allListings;
}

async function runSingleSearch(hardFilters, locationCity, forceEndpoint = null) {
  const apifyInput = buildApifyInput(hardFilters, locationCity, forceEndpoint);
  console.log(`[Idealista] Starting Apify run (${locationCity}, endpoint: ${apifyInput.endpoint})`);

  const runUrl = `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}&waitForFinish=120`;
  const runResponse = await makeRequest(runUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, apifyInput);

  if (runResponse.statusCode >= 400) {
    console.error(`[Idealista] Apify run failed for ${locationCity}:`, JSON.stringify(runResponse.data));
    throw new Error(`Apify run failed with status ${runResponse.statusCode}`);
  }

  const run = runResponse.data.data;
  console.log(`[Idealista] ${locationCity} run status: ${run.status}, dataset: ${run.defaultDatasetId}`);

  if (run.status === 'RUNNING') {
    console.log(`[Idealista] ${locationCity} still running, waiting 30s more...`);
    await new Promise((r) => setTimeout(r, 30000));
  }

  const datasetUrl = `https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${APIFY_TOKEN}&format=json&limit=80`;
  const datasetResponse = await makeRequest(datasetUrl, { method: 'GET' });

  if (datasetResponse.statusCode >= 400) {
    throw new Error(`Dataset fetch failed with status ${datasetResponse.statusCode}`);
  }

  const items = Array.isArray(datasetResponse.data) ? datasetResponse.data : [];
  const propertyItems = items.filter((item) => item.status === 'success' && item.propertyCode);

  console.log(`[Idealista] ${locationCity}: ${items.length} items, ${propertyItems.length} actual properties`);

  // Limit per location to keep total manageable
  const maxPerLocation = Math.max(15, Math.floor(30 / (hardFilters.locations?.length || 1)));
  return propertyItems.slice(0, maxPerLocation).map(normalizeIdealista);
}

function normalizeIdealista(item) {
  return {
    id: item.propertyCode || item.url,
    source: 'idealista',
    title: item.title || item.subtitle || 'Woning op Idealista',
    price: item.price || item.priceInfo?.price?.amount || null,
    currency: '€',
    location: [item.neighborhood, item.district, item.municipality].filter(Boolean).join(', ') || item.address || '',
    bedrooms: item.rooms || null,
    bathrooms: item.bathrooms || null,
    size_m2: item.size || null,
    url: item.url || (item.propertyCode ? `https://www.idealista.com/inmueble/${item.propertyCode}/` : ''),
    thumbnail: item.thumbnail || item.images?.[0]?.url || null,
    features: extractFeatures(item),
    property_type: item.propertyType || item.detailedType?.typology || null,
    description: item.description || '',
    price_per_m2: item.pricePerSqm || null,
    address: item.address || '',
    province: item.province || '',
    municipality: item.municipality || '',
    latitude: item.latitude || null,
    longitude: item.longitude || null,
    images: (item.images || item.allImages || []).map((img) => img.url || img).slice(0, 5),
    agency: item.agencyName || null,
  };
}

function extractFeatures(item) {
  const features = [];
  const feat = item.features || {};
  const desc = (item.description || '').toLowerCase();

  if (feat.hasSwimmingPool || item.hasSwimmingPool) features.push('pool');
  if (feat.hasGarden || item.hasGarden) features.push('garden');
  if (feat.hasTerrace || item.hasTerrace) features.push('terrace');
  if (item.parkingSpace?.hasParkingSpace || feat.hasGarage) features.push('garage');
  if (feat.hasAirConditioning || item.hasAirConditioning) features.push('air_conditioning');
  if (item.hasLift) features.push('elevator');
  if (feat.hasStorageRoom) features.push('storage');
  if (item.exterior) features.push('exterior');

  if (!features.includes('pool') && (desc.includes('piscina') || desc.includes('swimming pool'))) features.push('pool');
  if (!features.includes('garden') && (desc.includes('jardín') || desc.includes('jardin') || desc.includes('garden'))) features.push('garden');
  if (!features.includes('terrace') && (desc.includes('terraza') || desc.includes('terrace'))) features.push('terrace');
  if (desc.includes('vista al mar') || desc.includes('vistas al mar') || desc.includes('sea view')) features.push('sea_view');
  if (desc.includes('montaña') || desc.includes('mountain view')) features.push('mountain_view');
  if (desc.includes('seguridad') || desc.includes('vigilancia') || desc.includes('security')) features.push('security');

  return [...new Set(features)];
}

module.exports = { searchIdealista, buildApifyInput, LOCATION_MAP, resolveLocationId };
