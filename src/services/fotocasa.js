const https = require('https');

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const ACTOR_ID = 'igolaizola~fotocasa-scraper';

/**
 * Map our property_type to Fotocasa's propertyType.
 * Fotocasa types: home, newHome, premises, garages, office, boxRoom, land, building
 */
function mapPropertyType(type, isNewBuild) {
  if (isNewBuild) return 'newHome';
  if (!type) return 'home';
  switch (type) {
    case 'apartment':
    case 'villa':
    case 'townhouse':
    case 'penthouse':
    case 'duplex':
    case 'bungalow':
    case 'studio':
    case 'finca':
    case 'country_house':
      return 'home';
    case 'plot':
      return 'land';
    default:
      return 'home';
  }
}

/**
 * Map our operation to Fotocasa's operation.
 */
function mapOperation(op) {
  if (op === 'rent') return 'rent';
  return 'buy';
}

function buildFotocasaInput(hardFilters) {
  const isNewBuild = hardFilters.is_new_build === true;

  const input = {
    maxItems: 40,
    location: hardFilters.location || 'España',
    operation: mapOperation(hardFilters.operation),
    propertyType: mapPropertyType(hardFilters.property_type, isNewBuild),
    sortBy: 'rating',
  };

  if (hardFilters.price_min) input.minPrice = hardFilters.price_min;
  if (hardFilters.price_max) input.maxPrice = hardFilters.price_max;
  if (hardFilters.size_min_m2) input.minSize = hardFilters.size_min_m2;
  if (hardFilters.size_max_m2) input.maxSize = hardFilters.size_max_m2;

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
 * Search Fotocasa via Apify.
 * @param {object} hardFilters - hard_filters from Claude parser
 * @returns {Array} Normalized property listings
 */
async function searchFotocasa(hardFilters) {
  const apifyInput = buildFotocasaInput(hardFilters);
  console.log('[Fotocasa] Starting Apify run with input:', JSON.stringify(apifyInput, null, 2));

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
    console.log('[Fotocasa] Still running, waiting 30s more...');
    await new Promise((r) => setTimeout(r, 30000));
  }

  const datasetUrl = `https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${APIFY_TOKEN}&format=json&limit=80`;
  const datasetResponse = await makeRequest(datasetUrl, { method: 'GET' });

  if (datasetResponse.statusCode >= 400) {
    throw new Error(`Dataset fetch failed with status ${datasetResponse.statusCode}`);
  }

  const items = Array.isArray(datasetResponse.data) ? datasetResponse.data : [];
  console.log(`[Fotocasa] Retrieved ${items.length} items`);

  return items.slice(0, 30).map(normalizeFotocasa);
}

function normalizeFotocasa(item) {
  // Extract images from multimedia array
  const images = (item.multimedia || [])
    .filter(m => m.url)
    .map(m => m.url)
    .slice(0, 5);

  const thumbnail = images[0] || null;

  // Build location string
  const locationParts = [item.street, item.number, item.floor].filter(Boolean);
  const location = locationParts.join(' ') || item.address || '';

  // Build URL
  const url = item.url || (item.propertyId ? `https://www.fotocasa.es/es/comprar/vivienda/${item.propertyId}` : '');

  // Extract features from description
  const features = extractFotocasaFeatures(item);

  return {
    id: `fotocasa_${item.propertyId || Math.random().toString(36).substr(2, 9)}`,
    source: 'fotocasa',
    title: `${item.rooms || '?'} hab. ${item.surface || '?'} m² — Fotocasa`,
    price: item.transaction?.price || item.price || null,
    currency: '€',
    location: location,
    bedrooms: item.rooms || null,
    bathrooms: item.baths || null,
    size_m2: item.surface || null,
    url: url,
    thumbnail: thumbnail,
    features: features,
    property_type: item.propertyType || null,
    description: item.description || '',
    price_per_m2: item.surface && (item.transaction?.price || item.price)
      ? Math.round((item.transaction?.price || item.price) / item.surface)
      : null,
    address: location,
    province: '',
    municipality: '',
    latitude: item.location?.latitude ? parseFloat(item.location.latitude) : null,
    longitude: item.location?.longitude ? parseFloat(item.location.longitude) : null,
    images: images,
    agency: item.agency?.name || null,
    is_new_build: item.propertyType === 'newHome' || false,
  };
}

function extractFotocasaFeatures(item) {
  const features = [];
  const desc = (item.description || '').toLowerCase();

  // Extract from multimedia classifications
  const classifications = (item.multimedia || []).map(m => m.classification).filter(Boolean);
  if (classifications.includes('pool') || classifications.includes('piscina')) features.push('pool');
  if (classifications.includes('garden') || classifications.includes('jardin')) features.push('garden');
  if (classifications.includes('terrace') || classifications.includes('terraza')) features.push('terrace');

  // Extract from description
  if (!features.includes('pool') && (desc.includes('piscina') || desc.includes('swimming pool'))) features.push('pool');
  if (!features.includes('garden') && (desc.includes('jardín') || desc.includes('jardin') || desc.includes('garden'))) features.push('garden');
  if (!features.includes('terrace') && (desc.includes('terraza') || desc.includes('terrace'))) features.push('terrace');
  if (desc.includes('garaje') || desc.includes('parking') || desc.includes('garage')) features.push('garage');
  if (desc.includes('aire acondicionado') || desc.includes('air conditioning')) features.push('air_conditioning');
  if (desc.includes('ascensor') || desc.includes('elevator') || desc.includes('lift')) features.push('elevator');
  if (desc.includes('trastero') || desc.includes('storage')) features.push('storage');
  if (desc.includes('vista al mar') || desc.includes('vistas al mar') || desc.includes('sea view')) features.push('sea_view');

  return [...new Set(features)];
}

module.exports = { searchFotocasa };
