/**
 * NieuwbouwBot Scraper V2 — Idealista-only, obra nueva endpoint.
 * Scrapes new build projects from Idealista across all Costa Select regions.
 * Uses Claude to extract project names and developer info from titles/descriptions.
 */

const https = require('https');
const { LOCATION_MAP, resolveLocationId, CITY_SLUG_MAP } = require('./idealista-direct');

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const ACTOR_ID = 'sian.agency~smart-idealista-scraper';

/**
 * All Costa Select regions with their cities.
 */
const COSTA_SELECT_REGIONS = {
  'Costa del Sol': [
    'Estepona', 'Marbella', 'Mijas', 'Fuengirola', 'Benalmadena',
    'Torremolinos', 'Malaga', 'Nerja', 'Manilva', 'Casares',
    'Benahavis', 'Rincon de la Victoria', 'Velez-Malaga', 'Torrox',
  ],
  'Costa Blanca South': [
    'Torrevieja', 'Orihuela', 'Guardamar del Segura', 'Rojales',
    'Pilar de la Horadada', 'Santa Pola', 'Alicante', 'Elche',
  ],
  'Costa Blanca North': [
    'Javea', 'Denia', 'Moraira', 'Calpe', 'Altea', 'Benidorm',
  ],
  'Valencia': [
    'Valencia', 'Gandia',
  ],
};

/**
 * Municipality-to-region mapping (lowercase).
 * Used to map Idealista's municipality field to Costa Select regions.
 */
const MUNICIPALITY_TO_REGION = {};
for (const [region, cities] of Object.entries(COSTA_SELECT_REGIONS)) {
  for (const city of cities) {
    MUNICIPALITY_TO_REGION[city.toLowerCase()] = region;
  }
}
// Add common alternate spellings
MUNICIPALITY_TO_REGION['málaga'] = 'Costa del Sol';
MUNICIPALITY_TO_REGION['benalmádena'] = 'Costa del Sol';
MUNICIPALITY_TO_REGION['benahavís'] = 'Costa del Sol';
MUNICIPALITY_TO_REGION['vélez-málaga'] = 'Costa del Sol';
MUNICIPALITY_TO_REGION['rincón de la victoria'] = 'Costa del Sol';
MUNICIPALITY_TO_REGION['jávea'] = 'Costa Blanca North';
MUNICIPALITY_TO_REGION['dénia'] = 'Costa Blanca North';
MUNICIPALITY_TO_REGION['gandía'] = 'Valencia';
MUNICIPALITY_TO_REGION['san pedro de alcántara'] = 'Costa del Sol';
MUNICIPALITY_TO_REGION['san pedro de alcantara'] = 'Costa del Sol';
MUNICIPALITY_TO_REGION['nueva andalucia'] = 'Costa del Sol';
MUNICIPALITY_TO_REGION['nueva andalucía'] = 'Costa del Sol';
MUNICIPALITY_TO_REGION['orihuela costa'] = 'Costa Blanca South';

function getAllCities() {
  return Object.values(COSTA_SELECT_REGIONS).flat();
}

function getRegionForCity(city) {
  if (!city) return 'Overig';
  const normalized = city.toLowerCase().trim();
  if (MUNICIPALITY_TO_REGION[normalized]) return MUNICIPALITY_TO_REGION[normalized];

  // Partial match
  for (const [key, region] of Object.entries(MUNICIPALITY_TO_REGION)) {
    if (normalized.includes(key) || key.includes(normalized)) return region;
  }

  // Province-based fallback
  const provinceLower = city.toLowerCase();
  if (provinceLower.includes('málaga') || provinceLower.includes('malaga')) return 'Costa del Sol';
  if (provinceLower.includes('alicante')) return 'Costa Blanca South';
  if (provinceLower.includes('valencia')) return 'Valencia';

  return 'Overig';
}

/**
 * Get region from Idealista's raw item fields (municipality, province, district).
 */
function getRegionFromItem(item) {
  // Try municipality first (most specific)
  if (item.municipality) {
    const region = getRegionForCity(item.municipality);
    if (region !== 'Overig') return region;
  }
  // Try district
  if (item.district) {
    const region = getRegionForCity(item.district);
    if (region !== 'Overig') return region;
  }
  // Try province
  if (item.province) {
    const region = getRegionForCity(item.province);
    if (region !== 'Overig') return region;
  }
  return 'Overig';
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
 * Scrape new build projects from Idealista for a single city.
 * Uses the `listnewhomes` endpoint specifically for obra nueva.
 */
async function scrapeCity(city) {
  const locationId = resolveLocationId(city);
  if (!locationId) {
    console.warn(`[NieuwbouwScraper] No locationId for "${city}", skipping.`);
    return [];
  }

  const input = {
    country: 'es',
    operation: 'sale',
    endpoint: 'listnewhomes',  // KEY: obra nueva endpoint
    numPages: 3,               // More pages for comprehensive coverage
    language: 'en',
    locationName: city,
    locationId: locationId,
  };

  console.log(`[NieuwbouwScraper] Scraping ${city} (listnewhomes, locationId: ${locationId})`);

  const runUrl = `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}&waitForFinish=150`;
  const runResponse = await makeRequest(runUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, input);

  if (runResponse.statusCode >= 400) {
    throw new Error(`Apify run failed for ${city}: status ${runResponse.statusCode}`);
  }

  const run = runResponse.data.data;
  console.log(`[NieuwbouwScraper] ${city} run status: ${run.status}, dataset: ${run.defaultDatasetId}`);

  if (run.status === 'RUNNING') {
    console.log(`[NieuwbouwScraper] ${city} still running, waiting 30s...`);
    await new Promise(r => setTimeout(r, 30000));
  }

  const datasetUrl = `https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${APIFY_TOKEN}&format=json&limit=200`;
  const datasetResponse = await makeRequest(datasetUrl, { method: 'GET' });

  if (datasetResponse.statusCode >= 400) {
    throw new Error(`Dataset fetch failed for ${city}: status ${datasetResponse.statusCode}`);
  }

  const items = Array.isArray(datasetResponse.data) ? datasetResponse.data : [];
  const propertyItems = items.filter(item => item.status === 'success' && item.propertyCode);

  console.log(`[NieuwbouwScraper] ${city}: ${items.length} items, ${propertyItems.length} properties`);

  return propertyItems.map(item => normalizeRawItem(item, city));
}

/**
 * Normalize a raw Idealista item into our project format.
 * At this stage, project_name is extracted from title — Claude enrichment happens later.
 */
function normalizeRawItem(item, searchCity) {
  const title = item.title || item.subtitle || '';
  const desc = item.description || '';
  const municipality = item.municipality || searchCity;

  return {
    raw_title: title,
    raw_description: desc,
    project_name: extractProjectNameFromTitle(title, desc),
    developer: item.agencyName || 'Onbekend',
    region: getRegionFromItem(item) || getRegionForCity(searchCity),
    location: [item.neighborhood, item.district, municipality].filter(Boolean).join(', ') || searchCity,
    municipality: municipality,
    property_type: item.propertyType || 'onbekend',
    price: item.price || null,
    bedrooms: item.rooms || null,
    bathrooms: item.bathrooms || null,
    size_m2: item.size || null,
    description: desc.substring(0, 500),
    url: item.url || (item.propertyCode ? `https://www.idealista.com/inmueble/${item.propertyCode}/` : ''),
    source: 'idealista',
    thumbnail: item.thumbnail || (item.images && item.images[0] ? item.images[0].url || item.images[0] : '') || '',
    features: extractFeatures(item),
    address: item.address || '',
    province: item.province || '',
    latitude: item.latitude || null,
    longitude: item.longitude || null,
    is_new_build: true,
  };
}

/**
 * Extract project name from title.
 * Obra nueva titles often contain the project/development name.
 * Examples: "New development in Residencial Albatros", "Flat in ROYAL PARK RESIDENCE"
 */
function extractProjectNameFromTitle(title, desc) {
  if (!title) return 'Onbekend project';

  // Pattern 1: "in [Project Name]" — very common for obra nueva
  const inMatch = title.match(/\bin\s+([A-ZÀ-Ú][A-Za-zÀ-ÿ\s\-'&]{2,50}?)(?:\s*,|\s*$)/);
  if (inMatch) {
    const name = inMatch[1].trim();
    // Filter out city names and generic location words
    const cityNames = Object.keys(MUNICIPALITY_TO_REGION);
    const genericLocations = [
      'estepona', 'marbella', 'mijas', 'fuengirola', 'malaga', 'málaga',
      'torrevieja', 'alicante', 'benidorm', 'valencia', 'spain', 'españa',
      'nerja', 'manilva', 'casares', 'benahavis', 'benahavís', 'torrox',
      'torremolinos', 'benalmadena', 'benalmádena', 'javea', 'jávea',
      'denia', 'dénia', 'moraira', 'calpe', 'altea', 'gandia', 'gandía',
      'orihuela', 'rojales', 'santa pola', 'elche', 'guardamar',
      'nueva andalucia', 'nueva andalucía', 'san pedro de alcantara',
      'costa del sol', 'costa blanca', 'costa', 'andalucia', 'andalucía',
    ];
    if (!genericLocations.includes(name.toLowerCase()) && !cityNames.includes(name.toLowerCase())) return name;
    // If we matched "in [CityName]", this is not a project name — skip to description patterns only
  }

  // Pattern 2: Known project name patterns in description
  const descPatterns = [
    /(?:residencial|residencia|urbanización|urbanizacion|complejo|promoción|promocion|proyecto|project)\s+([A-ZÀ-Ú][A-Za-zÀ-ÿ\s\-'&]{2,40})/i,
    /(?:fase|phase)\s+\d+\s+(?:of|de)\s+([A-ZÀ-Ú][A-Za-zÀ-ÿ\s\-'&]{2,40})/i,
  ];

  const combined = `${title} ${desc}`;
  for (const pattern of descPatterns) {
    const match = combined.match(pattern);
    if (match) return match[1].trim();
  }

  // Pattern 3: Title starts with property type, rest might be project
  const typePrefix = /^(?:flat|house|apartment|penthouse|duplex|villa|chalet|semi-detached house|terraced house|detached house|studio|bungalow|ground floor)\s+/i;
  const afterType = title.replace(typePrefix, '').trim();
  if (afterType.length > 3 && afterType.length < 60 && afterType !== title) {
    // Check if it starts with "in" — extract what follows
    const afterIn = afterType.match(/^in\s+(.+)/i);
    if (afterIn) {
      const candidate = afterIn[1].split(',')[0].trim();
      // Filter out city names
      const cityNames = Object.keys(MUNICIPALITY_TO_REGION);
      const genericLocations = [
        'estepona', 'marbella', 'mijas', 'fuengirola', 'malaga', 'málaga',
        'torrevieja', 'alicante', 'benidorm', 'valencia', 'spain', 'españa',
        'nerja', 'manilva', 'casares', 'benahavis', 'benahavís', 'torrox',
        'torremolinos', 'benalmadena', 'benalmádena', 'javea', 'jávea',
        'denia', 'dénia', 'moraira', 'calpe', 'altea', 'gandia', 'gandía',
        'orihuela', 'rojales', 'santa pola', 'elche', 'guardamar',
        'nueva andalucia', 'nueva andalucía', 'san pedro de alcantara',
        'costa del sol', 'costa blanca', 'costa', 'andalucia', 'andalucía',
        'pilar de la horadada', 'guardamar del segura', 'rincon de la victoria',
        'velez-malaga', 'vélez-málaga',
      ];
      if (!genericLocations.includes(candidate.toLowerCase()) && !cityNames.includes(candidate.toLowerCase())) {
        return candidate;
      }
    }
  }

  // Check if title is just a generic property type or "[type] in [city]"
  const genericTypes = ['flat', 'house', 'apartment', 'penthouse', 'duplex', 'villa', 'chalet',
    'semi-detached house', 'terraced house', 'detached house', 'studio', 'bungalow',
    'ground floor', 'country house'];
  if (genericTypes.includes(title.toLowerCase().trim())) return 'Onbekend project';

  // Check if title is "[type] in [city]" — no real project name
  const typeInCityMatch = title.match(/^(?:flat|house|apartment|penthouse|duplex|villa|chalet|semi-detached house|terraced house|detached house|studio|bungalow|ground floor|country house)\s+in\s+(.+)/i);
  if (typeInCityMatch) {
    const afterIn = typeInCityMatch[1].split(',')[0].trim().toLowerCase();
    const allCityNames = Object.keys(MUNICIPALITY_TO_REGION);
    const allGenericLocations = [
      'estepona', 'marbella', 'mijas', 'fuengirola', 'malaga', 'm\u00e1laga',
      'torrevieja', 'alicante', 'benidorm', 'valencia', 'nerja', 'manilva',
      'casares', 'benahavis', 'benahav\u00eds', 'torrox', 'torremolinos',
      'benalmadena', 'javea', 'denia', 'moraira', 'calpe', 'altea', 'gandia',
      'orihuela', 'rojales', 'santa pola', 'elche', 'guardamar',
      'nueva andalucia', 'nueva andaluc\u00eda', 'san pedro de alcantara',
      'costa del sol', 'costa blanca', 'pilar de la horadada',
    ];
    if (allCityNames.includes(afterIn) || allGenericLocations.includes(afterIn)) {
      return 'Onbekend project';
    }
  }

  // Fallback: use the full title, truncated
  return title.substring(0, 60).trim() || 'Onbekend project';
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

  if (!features.includes('pool') && (desc.includes('piscina') || desc.includes('swimming pool') || desc.includes('pool'))) features.push('pool');
  if (!features.includes('garden') && (desc.includes('jardín') || desc.includes('jardin') || desc.includes('garden'))) features.push('garden');
  if (!features.includes('terrace') && (desc.includes('terraza') || desc.includes('terrace'))) features.push('terrace');
  if (desc.includes('vista al mar') || desc.includes('vistas al mar') || desc.includes('sea view')) features.push('sea_view');
  if (desc.includes('gym') || desc.includes('gimnasio')) features.push('gym');
  if (desc.includes('spa') || desc.includes('wellness')) features.push('spa');
  if (desc.includes('seguridad') || desc.includes('vigilancia') || desc.includes('security') || desc.includes('gated')) features.push('security');
  if (desc.includes('golf')) features.push('golf');

  return [...new Set(features)];
}

/**
 * Group individual units into projects.
 * Multiple units from the same development should become one project row.
 * Groups by: same developer + similar location + similar project name.
 */
function groupIntoProjects(listings) {
  const projects = new Map(); // key -> merged project

  for (const listing of listings) {
    const key = buildProjectKey(listing);

    if (projects.has(key)) {
      const existing = projects.get(key);
      // Merge: update price range, add unit types, keep best description
      if (listing.price) {
        if (!existing.price_from || listing.price < existing.price_from) existing.price_from = listing.price;
        if (!existing.price_to || listing.price > existing.price_to) existing.price_to = listing.price;
      }
      if (listing.bedrooms && !existing.bedroom_types.includes(listing.bedrooms)) {
        existing.bedroom_types.push(listing.bedrooms);
      }
      if (listing.property_type && !existing.unit_types.includes(listing.property_type)) {
        existing.unit_types.push(listing.property_type);
      }
      if (listing.description && listing.description.length > (existing.description || '').length) {
        existing.description = listing.description;
      }
      // Merge features
      for (const f of listing.features) {
        if (!existing.features.includes(f)) existing.features.push(f);
      }
      existing.unit_count++;
      // Keep the first URL (project-level)
      if (!existing.url && listing.url) existing.url = listing.url;
    } else {
      projects.set(key, {
        project_name: listing.project_name,
        developer: listing.developer,
        region: listing.region,
        location: listing.location,
        municipality: listing.municipality,
        price_from: listing.price,
        price_to: listing.price,
        bedroom_types: listing.bedrooms ? [listing.bedrooms] : [],
        unit_types: listing.property_type ? [listing.property_type] : [],
        size_m2: listing.size_m2,
        description: listing.description,
        url: listing.url,
        source: 'idealista',
        thumbnail: listing.thumbnail,
        features: [...listing.features],
        unit_count: 1,
      });
    }
  }

  return Array.from(projects.values());
}

/**
 * Build a grouping key for a listing.
 * Listings with the same key are considered part of the same project.
 */
function buildProjectKey(listing) {
  const dev = (listing.developer || 'unknown').toLowerCase().trim();
  const name = (listing.project_name || '').toLowerCase().trim()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '');
  const muni = (listing.municipality || '').toLowerCase().trim();

  // If we have a real project name (not generic), use it
  const genericNames = ['flat', 'house', 'apartment', 'penthouse', 'duplex', 'villa', 'chalet',
    'semi-detached house', 'terraced house', 'detached house', 'studio', 'bungalow',
    'ground floor', 'onbekend project'];
  const isGeneric = genericNames.includes(name) || name.length < 3;

  if (isGeneric) {
    // Group by developer + municipality (rough grouping)
    return `${dev}|${muni}|generic`;
  }

  // Group by project name + municipality
  return `${name}|${muni}`;
}

/**
 * Convert a grouped project into a Sheet row format.
 */
function projectToSheetRow(project) {
  const bedroomStr = project.bedroom_types.length > 0
    ? project.bedroom_types.sort((a, b) => a - b).join(', ')
    : '';
  const typeStr = project.unit_types.length > 0
    ? [...new Set(project.unit_types)].join(', ')
    : '';

  return {
    project_name: project.project_name || 'Onbekend project',
    developer: project.developer || 'Onbekend',
    region: project.region || 'Overig',
    location: project.location || '',
    property_type: typeStr,
    price_from: project.price_from || null,
    price_to: project.price_to || null,
    bedrooms: bedroomStr,
    size_m2: project.size_m2 || null,
    description: (project.description || '').substring(0, 300),
    url: project.url || '',
    source: project.source || 'idealista',
    thumbnail: project.thumbnail || '',
    features: project.features.join(', '),
    last_seen: new Date().toISOString().split('T')[0],
    first_seen: new Date().toISOString().split('T')[0],
    status: 'Actief',
  };
}

/**
 * Main scrape function: scrape all Costa Select cities, group into projects.
 * @param {string[]|null} cities - Specific cities to scrape (null = all)
 * @param {function} onProgress - Optional progress callback
 * @returns {Array} Grouped project rows ready for Google Sheets
 */
async function scrapeNewBuildProjects(cities = null, onProgress = null) {
  const targetCities = cities || getAllCities();
  const allListings = [];
  const errors = [];

  const log = (msg) => {
    console.log(`[NieuwbouwScraper] ${msg}`);
    if (onProgress) onProgress(msg);
  };

  log(`Starting obra nueva scrape for ${targetCities.length} cities (Idealista only)...`);

  // Process cities sequentially to avoid Apify rate limits
  for (let i = 0; i < targetCities.length; i++) {
    const city = targetCities[i];
    log(`[${i + 1}/${targetCities.length}] ${city}...`);

    try {
      const listings = await scrapeCity(city);
      allListings.push(...listings);
      log(`  → ${listings.length} listings (totaal: ${allListings.length})`);
    } catch (err) {
      errors.push(`${city}: ${err.message}`);
      log(`  → FOUT: ${err.message}`);
    }

    // Wait between cities to avoid rate limits
    if (i < targetCities.length - 1) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  log(`Scrape klaar: ${allListings.length} individuele listings van ${targetCities.length} steden`);

  // Group individual units into projects
  log('Listings groeperen tot projecten...');
  const projects = groupIntoProjects(allListings);
  log(`${allListings.length} listings → ${projects.length} unieke projecten`);

  // Convert to Sheet row format
  const projectRows = projects.map(projectToSheetRow);

  if (errors.length > 0) {
    log(`Fouten: ${errors.join('; ')}`);
  }

  return projectRows;
}

module.exports = {
  scrapeNewBuildProjects,
  scrapeCity,
  groupIntoProjects,
  projectToSheetRow,
  normalizeRawItem,
  extractProjectNameFromTitle,
  getAllCities,
  getRegionForCity,
  getRegionFromItem,
  COSTA_SELECT_REGIONS,
  MUNICIPALITY_TO_REGION,
};
