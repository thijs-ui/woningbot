const https = require('https');

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const ACTOR_ID = 'memo23~kyero-cheerio';

/**
 * Kyero location IDs for Costa Select regions.
 */
const KYERO_LOCATION_MAP = {
  // Costa del Sol
  'estepona': 31466, 'marbella': 31476, 'san pedro de alcantara': 31476,
  'malaga': 31473, 'málaga': 31473, 'fuengirola': 31468, 'mijas': 31479,
  'benalmadena': 31460, 'benalmádena': 31460, 'torremolinos': 31495,
  'nerja': 31481, 'manilva': 31475, 'casares': 31463,
  'benahavis': 31459, 'benahavís': 31459,
  'rincon de la victoria': 31487, 'velez-malaga': 31497, 'vélez-málaga': 31497,
  'torrox': 31496,

  // Costa Blanca South
  'torrevieja': 31326, 'orihuela': 31316, 'orihuela costa': 31316,
  'guardamar del segura': 31305, 'rojales': 31320,
  'pilar de la horadada': 31318, 'santa pola': 31323,
  'alicante': 31284, 'elche': 31299,

  // Costa Blanca North
  'javea': 31307, 'jávea': 31307, 'denia': 31297, 'dénia': 31297,
  'moraira': 31313, 'teulada': 31325, 'calpe': 31291,
  'altea': 31286, 'benidorm': 31289,

  // Valencia
  'valencia': 55529, 'gandia': 55539, 'gandía': 55539,

  // Inland Málaga
  'ronda': 31488, 'antequera': 31457, 'coin': 31465, 'coín': 31465,
  'alhaurin el grande': 31455,
};

function getPropertyTypeSuffix(type) {
  if (!type) return '';
  switch (type) {
    case 'apartment': case 'penthouse': case 'studio': case 'duplex': return 'g1';
    case 'villa': case 'townhouse': case 'bungalow': return 'g2';
    case 'finca': case 'country_house': return 'g4';
    default: return '';
  }
}

/**
 * Build a Kyero search URL for a single location.
 */
function buildKyeroUrl(hardFilters, locationCity) {
  const city = (locationCity || '').toLowerCase().trim();
  let locationId = KYERO_LOCATION_MAP[city];

  // Try partial match
  if (!locationId) {
    for (const [key, id] of Object.entries(KYERO_LOCATION_MAP)) {
      if (city.includes(key) || key.includes(city)) {
        locationId = id;
        break;
      }
    }
  }

  if (!locationId) {
    console.warn(`[Kyero] Location "${city}" not in mapping. Skipping.`);
    return null;
  }

  const citySlug = city.replace(/\s+/g, '-').replace(/[áà]/g, 'a').replace(/[éè]/g, 'e').replace(/[íì]/g, 'i').replace(/[óò]/g, 'o').replace(/[úù]/g, 'u');
  const typeSuffix = getPropertyTypeSuffix(hardFilters.property_type);
  const operation = hardFilters.operation === 'rent' ? 'long-let-1' : 'for-sale-0';

  let typeLabel = 'property';
  if (typeSuffix === 'g1') typeLabel = 'apartments';
  else if (typeSuffix === 'g2') typeLabel = 'villas';
  else if (typeSuffix === 'g4') typeLabel = 'country-houses';

  let url = `https://www.kyero.com/en/${citySlug}-${typeLabel}-${operation}l${locationId}`;
  if (typeSuffix) url += typeSuffix;

  const params = [];
  if (hardFilters.price_min) params.push(`min_price=${hardFilters.price_min}`);
  if (hardFilters.price_max) params.push(`max_price=${hardFilters.price_max}`);
  if (hardFilters.bedrooms_min) params.push(`min_beds=${hardFilters.bedrooms_min}`);
  if (hardFilters.bedrooms_max) params.push(`max_beds=${hardFilters.bedrooms_max}`);

  if (params.length > 0) url += '?' + params.join('&');
  return url;
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
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('Request timeout (180s)')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Search Kyero via Apify — supports multiple locations.
 * Sends all location URLs as startUrls in a single actor run.
 * @param {object} hardFilters - hard_filters from Claude parser (with locations array)
 * @returns {Array} Normalized property listings
 */
async function searchKyero(hardFilters) {
  const locations = hardFilters.locations || (hardFilters.location ? [hardFilters.location] : []);

  if (locations.length === 0) {
    console.warn('[Kyero] No locations specified. Skipping.');
    return [];
  }

  // Build URLs for all locations, skip unmapped ones
  const searchLocations = locations.slice(0, 5);
  const startUrls = [];

  for (const city of searchLocations) {
    const url = buildKyeroUrl(hardFilters, city);
    if (url) {
      console.log(`[Kyero] URL for ${city}: ${url}`);
      startUrls.push(url);
    }
  }

  if (startUrls.length === 0) {
    console.log('[Kyero] No valid URLs could be built. Returning empty results.');
    return [];
  }

  const apifyInput = {
    startUrls,
    maxItems: 30,
    maxConcurrency: 10,
    minConcurrency: 1,
    maxRequestRetries: 3,
    proxy: {
      useApifyProxy: true,
    },
  };

  console.log(`[Kyero] Starting Apify run with ${startUrls.length} URL(s)`);

  const runUrl = `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}&waitForFinish=180`;
  const runResponse = await makeRequest(runUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, apifyInput);

  if (runResponse.statusCode >= 400) {
    console.error('[Kyero] Apify run failed:', JSON.stringify(runResponse.data));
    throw new Error(`Apify run failed with status ${runResponse.statusCode}`);
  }

  const run = runResponse.data.data;
  console.log(`[Kyero] Run status: ${run.status}, dataset: ${run.defaultDatasetId}`);

  if (run.status === 'RUNNING') {
    console.log('[Kyero] Still running, waiting 30s more...');
    await new Promise((r) => setTimeout(r, 30000));
  }

  const datasetUrl = `https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${APIFY_TOKEN}&format=json&limit=80`;
  const datasetResponse = await makeRequest(datasetUrl, { method: 'GET' });

  if (datasetResponse.statusCode >= 400) {
    throw new Error(`Dataset fetch failed with status ${datasetResponse.statusCode}`);
  }

  const items = Array.isArray(datasetResponse.data) ? datasetResponse.data : [];
  console.log(`[Kyero] Retrieved ${items.length} items from ${startUrls.length} location(s)`);

  const propertyItems = items.filter(item => item.price && (item.id || item.path));
  return propertyItems.slice(0, 30).map(normalizeKyero);
}

function normalizeKyero(item) {
  const images = (item.images || item.photos || []).slice(0, 5);
  const thumbnail = (item.photos || item.images || [])[0] || null;

  const features = (item.feature_keys || []).map(f => {
    const map = {
      pool: 'pool', terrace: 'terrace', garden: 'garden',
      lift: 'elevator', garage: 'garage', parking: 'garage',
      near_beach: 'near_beach', near_shops: 'near_shops',
      near_transport: 'near_transport', air_conditioning: 'air_conditioning',
      sea_view: 'sea_view', mountain_view: 'mountain_view', storage: 'storage',
    };
    return map[f] || f;
  });

  const isNewBuild = (item.feature_keys || []).includes('new_build') ||
    !(item.feature_keys || []).includes('resale_only');

  return {
    id: `kyero_${item.id || Math.random().toString(36).substr(2, 9)}`,
    source: 'kyero',
    title: item.name || 'Woning op Kyero',
    price: item.price || null,
    currency: '€',
    location: item.address || '',
    bedrooms: item.bedroom_count || (item.bedrooms ? parseInt(item.bedrooms) : null),
    bathrooms: item.bathroom_count || (item.bathrooms ? parseInt(item.bathrooms) : null),
    size_m2: item.built_m2 || (item.buildSize ? parseInt(item.buildSize) : null),
    url: item.path ? `https://www.kyero.com${item.path}` : '',
    thumbnail, features, property_type: item.property_type?.key || null,
    description: item.short_html_description || item.description || '',
    price_per_m2: item.built_m2 && item.price ? Math.round(item.price / item.built_m2) : null,
    address: item.address || '', province: '', municipality: '',
    latitude: null, longitude: null, images,
    agency: item.agent?.name || item.advertiser || null,
    is_new_build: isNewBuild, plot_m2: item.plot_m2 || null,
  };
}

module.exports = { searchKyero, KYERO_LOCATION_MAP };
