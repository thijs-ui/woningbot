/**
 * NieuwbouwBot Scraper — scrapes new build projects from Idealista, Fotocasa, and Kyero
 * across all Costa Select regions. Designed for daily/weekly batch runs.
 */

const { searchIdealista, LOCATION_MAP } = require('./idealista');
const { searchFotocasa } = require('./fotocasa');
const { searchKyero } = require('./kyero');

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
 * Get all cities across all regions as a flat array.
 */
function getAllCities() {
  return Object.values(COSTA_SELECT_REGIONS).flat();
}

/**
 * Get the region name for a city.
 */
function getRegionForCity(city) {
  const normalized = city.toLowerCase().trim();
  for (const [region, cities] of Object.entries(COSTA_SELECT_REGIONS)) {
    if (cities.some(c => c.toLowerCase() === normalized)) return region;
  }
  return 'Overig';
}

/**
 * Scrape new build projects from all portals for a batch of cities.
 * Processes cities in batches to avoid overwhelming Apify.
 * @param {string[]} cities - List of cities to scrape (default: all Costa Select cities)
 * @param {function} onProgress - Optional callback: (message) => void
 * @returns {Array} All scraped new build listings (normalized)
 */
async function scrapeNewBuildProjects(cities = null, onProgress = null) {
  const targetCities = cities || getAllCities();
  const allResults = [];
  const errors = [];

  const log = (msg) => {
    console.log(`[NieuwbouwScraper] ${msg}`);
    if (onProgress) onProgress(msg);
  };

  log(`Starting scrape for ${targetCities.length} cities across 3 portals...`);

  // Process in batches of 5 cities to stay within Apify limits
  const batchSize = 5;
  for (let i = 0; i < targetCities.length; i += batchSize) {
    const batch = targetCities.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(targetCities.length / batchSize);

    log(`Batch ${batchNum}/${totalBatches}: ${batch.join(', ')}`);

    // Build hard_filters for new build search
    const hardFilters = {
      locations: batch,
      operation: 'sale',
      is_new_build: true,
      property_type: null, // All types
      price_min: null,
      price_max: null,
      bedrooms_min: null,
      bedrooms_max: null,
      size_min_m2: null,
      size_max_m2: null,
      features: [],
    };

    // Run all 3 portals in parallel per batch
    const [idealistaResult, fotocasaResult, kyeroResult] = await Promise.allSettled([
      searchIdealista(hardFilters).catch(err => {
        errors.push(`Idealista batch ${batchNum}: ${err.message}`);
        return [];
      }),
      searchFotocasa(hardFilters).catch(err => {
        errors.push(`Fotocasa batch ${batchNum}: ${err.message}`);
        return [];
      }),
      searchKyero(hardFilters).catch(err => {
        errors.push(`Kyero batch ${batchNum}: ${err.message}`);
        return [];
      }),
    ]);

    const batchResults = [
      ...(idealistaResult.status === 'fulfilled' ? idealistaResult.value : []),
      ...(fotocasaResult.status === 'fulfilled' ? fotocasaResult.value : []),
      ...(kyeroResult.status === 'fulfilled' ? kyeroResult.value : []),
    ];

    // Mark all as new build and add region info
    for (const item of batchResults) {
      item.is_new_build = true;
      // Try to assign region from the batch cities
      if (item.location) {
        item.region = getRegionForCity(item.location.split(',')[0].trim()) || getRegionForCity(batch[0]);
      } else {
        item.region = getRegionForCity(batch[0]);
      }
    }

    allResults.push(...batchResults);
    log(`Batch ${batchNum} done: ${batchResults.length} results (total: ${allResults.length})`);

    // Wait between batches to avoid rate limits
    if (i + batchSize < targetCities.length) {
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  log(`Scrape complete: ${allResults.length} total results from ${targetCities.length} cities`);
  if (errors.length > 0) {
    log(`Errors: ${errors.join('; ')}`);
  }

  return allResults;
}

/**
 * Extract project name from a listing title/description.
 * New build projects often have names like "Residencial Albatros", "Marbella Lake", etc.
 */
function extractProjectName(listing) {
  const title = listing.title || '';
  const desc = listing.description || '';

  // Common patterns for project names in Spain
  const patterns = [
    /(?:residencial|residencia)\s+([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)*)/i,
    /(?:urbanización|urbanizacion)\s+([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)*)/i,
    /(?:complejo|complex)\s+([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)*)/i,
    /(?:promoción|promocion|promotion)\s+([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)*)/i,
    /(?:proyecto|project)\s+([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)*)/i,
  ];

  for (const pattern of patterns) {
    const match = title.match(pattern) || desc.match(pattern);
    if (match) return match[1].trim();
  }

  // If no pattern matches, return the first part of the title (often the project name)
  const titleParts = title.split(/\s+(?:in|en|a|de|del)\s+/i);
  if (titleParts.length > 1 && titleParts[0].length > 3 && titleParts[0].length < 50) {
    return titleParts[0].trim();
  }

  return title.substring(0, 60).trim() || 'Onbekend project';
}

/**
 * Extract developer/promoter name from a listing.
 */
function extractDeveloper(listing) {
  // Agency name is often the developer for new builds
  if (listing.agency) return listing.agency;

  const desc = (listing.description || '').toLowerCase();
  const patterns = [
    /(?:promotor|developer|developed by|promovido por|construido por)\s*:?\s*([A-ZÀ-Ú][^\n,.]{2,40})/i,
    /(?:by|por)\s+([A-Z][a-zA-Z\s&]+(?:S\.?L\.?|S\.?A\.?|Group|Homes|Properties|Inmobiliaria))/i,
  ];

  for (const pattern of patterns) {
    const match = desc.match(pattern) || (listing.description || '').match(pattern);
    if (match) return match[1].trim();
  }

  return listing.agency || 'Onbekend';
}

/**
 * Normalize a scraped listing into a new build project row for Google Sheets.
 */
function normalizeToProjectRow(listing) {
  return {
    project_name: extractProjectName(listing),
    developer: extractDeveloper(listing),
    region: listing.region || '',
    location: listing.location || listing.municipality || '',
    property_type: listing.property_type || 'onbekend',
    price_from: listing.price || null,
    price_to: null, // Will be filled by dedup/merge
    bedrooms: listing.bedrooms || null,
    size_m2: listing.size_m2 || null,
    description: (listing.description || '').substring(0, 300),
    url: listing.url || '',
    source: listing.source || '',
    thumbnail: listing.thumbnail || '',
    features: (listing.features || []).join(', '),
    last_seen: new Date().toISOString().split('T')[0],
    first_seen: new Date().toISOString().split('T')[0],
    status: 'Actief',
  };
}

module.exports = {
  scrapeNewBuildProjects,
  normalizeToProjectRow,
  extractProjectName,
  extractDeveloper,
  getAllCities,
  getRegionForCity,
  COSTA_SELECT_REGIONS,
};
