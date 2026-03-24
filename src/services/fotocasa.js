const https = require('https');

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const ACTOR_ID = 'civilized_float~my-actor'; // IB2e10JnFChHjHNI4

/**
 * Location name mapping for Fotocasa URLs.
 */
const FOTOCASA_LOCATION_MAP = {
  // Costa del Sol
  estepona: 'estepona', marbella: 'marbella', malaga: 'malaga', málaga: 'malaga',
  fuengirola: 'fuengirola', mijas: 'mijas', benalmadena: 'benalmadena', benalmádena: 'benalmadena',
  torremolinos: 'torremolinos', nerja: 'nerja', manilva: 'manilva', casares: 'casares',
  benahavis: 'benahavis', benahavís: 'benahavis',
  'rincon de la victoria': 'rincon-de-la-victoria', 'rincón de la victoria': 'rincon-de-la-victoria',
  'velez-malaga': 'velez-malaga', 'vélez-málaga': 'velez-malaga',
  torrox: 'torrox', ronda: 'ronda', antequera: 'antequera', coin: 'coin', coín: 'coin',
  'alhaurin el grande': 'alhaurin-el-grande', 'alhaurín el grande': 'alhaurin-el-grande',
  sotogrande: 'san-roque',

  // Costa Blanca South
  torrevieja: 'torrevieja', orihuela: 'orihuela', 'orihuela costa': 'orihuela',
  'guardamar del segura': 'guardamar-del-segura', guardamar: 'guardamar-del-segura',
  rojales: 'rojales', 'pilar de la horadada': 'pilar-de-la-horadada',
  'santa pola': 'santa-pola', alicante: 'alicante', elche: 'elche',
  murcia: 'murcia', cartagena: 'cartagena',

  // Costa Blanca North
  javea: 'javea', jávea: 'javea', xabia: 'javea',
  denia: 'denia', dénia: 'denia', moraira: 'moraira', teulada: 'teulada',
  calpe: 'calpe', altea: 'altea', benidorm: 'benidorm',

  // Valencia
  valencia: 'valencia', gandia: 'gandia', gandía: 'gandia',

  // Major cities
  madrid: 'madrid', barcelona: 'barcelona', sevilla: 'sevilla', granada: 'granada',
  cadiz: 'cadiz', cádiz: 'cadiz', almeria: 'almeria', almería: 'almeria',
  palma: 'palma-de-mallorca', 'palma de mallorca': 'palma-de-mallorca', ibiza: 'ibiza',
};

function mapPropertyTypeToPath(type) {
  switch (type) {
    case 'apartment': case 'studio': case 'penthouse': case 'duplex': return 'flats';
    case 'villa': case 'townhouse': case 'finca': case 'country_house': case 'bungalow': return 'homes';
    case 'plot': return 'land';
    default: return 'homes';
  }
}

/**
 * Build a Fotocasa search URL for a single location.
 */
function buildFotocasaUrl(hardFilters, locationCity) {
  const operation = hardFilters.operation === 'rent' ? 'rental' : 'buy';
  const propertyPath = mapPropertyTypeToPath(hardFilters.property_type);

  const locationRaw = (locationCity || 'españa').toLowerCase().trim();
  const locationSlug = FOTOCASA_LOCATION_MAP[locationRaw] || locationRaw.replace(/\s+/g, '-');

  let path = `/en/${operation}/${propertyPath}/${locationSlug}/all-zones`;
  if (hardFilters.is_new_build) path += '/new-construction';
  path += '/l';

  const params = new URLSearchParams();
  if (hardFilters.price_min) params.set('minPrice', hardFilters.price_min);
  if (hardFilters.price_max) params.set('maxPrice', hardFilters.price_max);
  if (hardFilters.bedrooms_min) params.set('minRooms', hardFilters.bedrooms_min);
  if (hardFilters.size_min_m2) params.set('minSurface', hardFilters.size_min_m2);
  if (hardFilters.size_max_m2) params.set('maxSurface', hardFilters.size_max_m2);

  const queryString = params.toString();
  return `https://www.fotocasa.es${path}${queryString ? '?' + queryString : ''}`;
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
 * Search Fotocasa via Apify — supports multiple locations.
 * Builds one startUrl per location and sends them all in a single actor run.
 * @param {object} hardFilters - hard_filters from Claude parser (with locations array)
 * @returns {Array} Normalized property listings
 */
async function searchFotocasa(hardFilters) {
  const locations = hardFilters.locations || (hardFilters.location ? [hardFilters.location] : []);

  if (locations.length === 0) {
    console.warn('[Fotocasa] No locations specified. Skipping.');
    return [];
  }

  // Cap at 5 locations
  const searchLocations = locations.slice(0, 5);

  // Build one URL per location — send all as startUrls in a single run
  const startUrls = searchLocations.map(city => {
    const url = buildFotocasaUrl(hardFilters, city);
    console.log(`[Fotocasa] URL for ${city}: ${url}`);
    return { url };
  });

  const apifyInput = {
    startUrls,
    maxRequestsPerCrawl: 100 * searchLocations.length,
  };

  console.log(`[Fotocasa] Starting Apify run with ${startUrls.length} URL(s)`);

  const runUrl = `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}&waitForFinish=120`;
  const runResponse = await makeRequest(runUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, apifyInput);

  if (runResponse.statusCode >= 400) {
    console.error('[Fotocasa] Apify run failed:', JSON.stringify(runResponse.data));
    throw new Error(`Apify run failed with status ${runResponse.statusCode}`);
  }

  const run = runResponse.data.data;
  console.log(`[Fotocasa] Run status: ${run.status}, dataset: ${run.defaultDatasetId}`);

  if (run.status === 'RUNNING') {
    console.log('[Fotocasa] Still running, waiting 60s more...');
    await new Promise((r) => setTimeout(r, 60000));
  }

  const datasetUrl = `https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${APIFY_TOKEN}&format=json&limit=80`;
  const datasetResponse = await makeRequest(datasetUrl, { method: 'GET' });

  if (datasetResponse.statusCode >= 400) {
    throw new Error(`Dataset fetch failed with status ${datasetResponse.statusCode}`);
  }

  const items = Array.isArray(datasetResponse.data) ? datasetResponse.data : [];
  console.log(`[Fotocasa] Retrieved ${items.length} items from ${searchLocations.length} location(s)`);

  return items.slice(0, 30).map(normalizeFotocasa);
}

function normalizeFotocasa(item) {
  let price = null;
  const rawPrice = item['Monthly price'] || item.price || item.Price || '';
  if (rawPrice) {
    const cleaned = String(rawPrice).replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.');
    price = parseFloat(cleaned) || null;
  }

  let sizeM2 = null;
  const rawSize = item['Size in m²'] || item.size || item.Size || '';
  if (rawSize) {
    const cleaned = String(rawSize).replace(/[^0-9.,]/g, '').replace(',', '.');
    sizeM2 = parseFloat(cleaned) || null;
  }

  let bedrooms = null;
  const rawBedrooms = item['Number of bedrooms'] || item.bedrooms || item.Bedrooms || '';
  if (rawBedrooms) {
    bedrooms = parseInt(String(rawBedrooms).replace(/[^0-9]/g, ''), 10) || null;
  }

  const url = item['Direct link'] || item.url || item.URL || item.link || '';
  const title = item.Title || item.title || 'Fotocasa woning';
  const description = item.Description || item.description || '';
  const thumbnail = item['Main image URL'] || item.image || item.thumbnail || null;
  const features = extractFotocasaFeatures(description);
  const idBase = url ? url.replace(/[^a-zA-Z0-9]/g, '').slice(-12) : Math.random().toString(36).substr(2, 9);

  return {
    id: `fotocasa_${idBase}`,
    source: 'fotocasa',
    title, price, currency: '€',
    location: '',
    bedrooms, bathrooms: null, size_m2: sizeM2,
    url, thumbnail, features, property_type: null,
    description,
    price_per_m2: sizeM2 && price ? Math.round(price / sizeM2) : null,
    address: '', province: '', municipality: '',
    latitude: null, longitude: null,
    images: thumbnail ? [thumbnail] : [],
    agency: null, is_new_build: false,
  };
}

function extractFotocasaFeatures(description) {
  const features = [];
  const desc = (description || '').toLowerCase();
  if (desc.includes('piscina') || desc.includes('swimming pool') || desc.includes('pool')) features.push('pool');
  if (desc.includes('jardín') || desc.includes('jardin') || desc.includes('garden')) features.push('garden');
  if (desc.includes('terraza') || desc.includes('terrace')) features.push('terrace');
  if (desc.includes('garaje') || desc.includes('parking') || desc.includes('garage')) features.push('garage');
  if (desc.includes('aire acondicionado') || desc.includes('air conditioning')) features.push('air_conditioning');
  if (desc.includes('ascensor') || desc.includes('elevator') || desc.includes('lift')) features.push('elevator');
  if (desc.includes('trastero') || desc.includes('storage')) features.push('storage');
  if (desc.includes('vista al mar') || desc.includes('vistas al mar') || desc.includes('sea view')) features.push('sea_view');
  return [...new Set(features)];
}

module.exports = { searchFotocasa, buildFotocasaUrl };
