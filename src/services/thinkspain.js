/**
 * thinkspain.js — Custom HTTP-based ThinkSpain scraper.
 *
 * ThinkSpain is an English-language property portal with 210,000+ listings in Spain.
 * Server-rendered HTML = no JS rendering needed = 1 ScraperAPI credit per page.
 *
 * Replaces Fotocasa (which needs JS rendering at 10-25 credits/page + CAPTCHA issues).
 *
 * Cost: ~1 credit per page via ScraperAPI (or free direct — no aggressive anti-bot).
 */

const https = require('https');
const http = require('http');
const cheerio = require('cheerio');

// ─── Configuration ──────────────────────────────────────────────────────────

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '';
const USE_PROXY = !!SCRAPER_API_KEY;

const MAX_PAGES_PER_LOCATION = parseInt(process.env.THINKSPAIN_MAX_PAGES, 10) || 5;
const REQUEST_DELAY_MIN_MS = 2000;
const REQUEST_DELAY_MAX_MS = 5000;
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 25000;
const LISTINGS_PER_PAGE = 16; // ThinkSpain shows ~16 per page

// ─── User-Agent rotation ────────────────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function randomDelay() {
  const ms = REQUEST_DELAY_MIN_MS + Math.random() * (REQUEST_DELAY_MAX_MS - REQUEST_DELAY_MIN_MS);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── City slug mapping (ThinkSpain URL format) ─────────────────────────────
// ThinkSpain URLs: /property-for-sale/{location-slug}

const CITY_SLUG_MAP = {
  // Costa del Sol
  'estepona':       'estepona',
  'marbella':       'marbella',
  'san pedro de alcantara': 'san-pedro-de-alcantara',
  'malaga':         'malaga-city',
  'málaga':         'malaga-city',
  'fuengirola':     'fuengirola',
  'mijas':          'mijas',
  'benalmadena':    'benalmadena',
  'benalmádena':    'benalmadena',
  'torremolinos':   'torremolinos',
  'nerja':          'nerja',
  'manilva':        'manilva',
  'casares':        'casares',
  'benahavis':      'benahavis',
  'benahavís':      'benahavis',
  'sotogrande':     'sotogrande',
  'rincon de la victoria': 'rincon-de-la-victoria',
  'velez-malaga':   'velez-malaga',
  'vélez-málaga':   'velez-malaga',
  'torrox':         'torrox',

  // Costa Blanca South
  'torrevieja':     'torrevieja',
  'orihuela':       'orihuela',
  'orihuela costa': 'orihuela-costa',
  'guardamar del segura': 'guardamar-del-segura',
  'guardamar':      'guardamar-del-segura',
  'rojales':        'rojales',
  'pilar de la horadada': 'pilar-de-la-horadada',
  'santa pola':     'santa-pola',
  'elche':          'elche',
  'alicante':       'alicante-city',
  'murcia':         'murcia-city',
  'cartagena':      'cartagena',

  // Costa Blanca North
  'javea':          'javea-xabia',
  'jávea':          'javea-xabia',
  'xabia':          'javea-xabia',
  'denia':          'denia',
  'dénia':          'denia',
  'moraira':        'moraira-teulada',
  'teulada':        'moraira-teulada',
  'calpe':          'calpe',
  'altea':          'altea',
  'benidorm':       'benidorm',

  // Valencia
  'valencia':       'valencia-city',
  'gandia':         'gandia',
  'gandía':         'gandia',

  // Inland Málaga
  'ronda':          'ronda',
  'antequera':      'antequera',
  'coin':           'coin',
  'coín':           'coin',
  'alhaurin el grande': 'alhaurin-el-grande',

  // Major cities
  'madrid':         'madrid-city',
  'barcelona':      'barcelona-city',
  'sevilla':        'seville',
  'granada':        'granada-city',
  'cadiz':          'cadiz',
  'cádiz':          'cadiz',
  'almeria':        'almeria-city',
  'almería':        'almeria-city',
  'palma':          'palma-de-mallorca',
  'palma de mallorca': 'palma-de-mallorca',
  'ibiza':          'ibiza',
};

// ─── Property type mapping ──────────────────────────────────────────────────
// ThinkSpain uses: types=1 (Houses & Apartments), types=2 (Plots), types=3 (Commercial), types=4 (Garages)
// No granular villa/apartment distinction in URL — handled by search results

function mapPropertyTypeToParam(type) {
  switch (type) {
    case 'apartment': case 'studio': case 'penthouse': case 'duplex':
    case 'villa': case 'townhouse': case 'finca': case 'country_house': case 'bungalow':
      return '1'; // Houses & Apartments
    case 'plot':
      return '2'; // Plots of Land & Ruins
    default:
      return '1';
  }
}

// ─── URL Builder ────────────────────────────────────────────────────────────

function resolveCitySlug(city) {
  const normalized = (city || '').toLowerCase().trim();
  if (normalized && CITY_SLUG_MAP[normalized]) return CITY_SLUG_MAP[normalized];

  // Try partial match
  for (const [key, slug] of Object.entries(CITY_SLUG_MAP)) {
    if (normalized.includes(key) || key.includes(normalized)) return slug;
  }

  // ThinkSpain auto-slug is more reliable than Idealista, but still risky
  console.warn(`[ThinkSpain] City "${city}" not in slug map. Attempting auto-slug: ${normalized.replace(/\s+/g, '-')}`);
  return normalized.replace(/\s+/g, '-');
}

/**
 * Build ThinkSpain search URL with query parameters.
 *
 * URL format: /property-for-sale/{location}?param=value&page=N
 *
 * Available params:
 *   minprice, maxprice, beds (1, 1+, 2, 2+, 3, 3+, 4, 4+, 5+),
 *   baths (same format), types (1=houses, 2=plots, 3=commercial, 4=garages),
 *   pool=1, seaview=1, newbuild=1, parking=1, garden=1, terrace=1,
 *   lift=1, mountainviews=1, seafront=1, golf=1, groundfloor=1
 */
function buildSearchUrl(citySlug, hardFilters, pageNum = 1) {
  const basePath = hardFilters.operation === 'rent'
    ? 'property-to-rent'
    : 'property-for-sale';

  let url = `https://www.thinkspain.com/${basePath}/${citySlug}`;

  const params = new URLSearchParams();

  // Price
  if (hardFilters.price_min) params.set('minprice', hardFilters.price_min);
  if (hardFilters.price_max) params.set('maxprice', hardFilters.price_max);

  // Bedrooms — ThinkSpain uses "3+" format for minimum
  if (hardFilters.bedrooms_min) {
    params.set('beds', `${hardFilters.bedrooms_min}+`);
  }

  // Bathrooms
  if (hardFilters.bathrooms_min) {
    params.set('baths', `${hardFilters.bathrooms_min}+`);
  }

  // Property type
  if (hardFilters.property_type) {
    params.set('types', mapPropertyTypeToParam(hardFilters.property_type));
  }

  // Features
  if (hardFilters.features && hardFilters.features.length) {
    for (const feat of hardFilters.features) {
      switch (feat) {
        case 'pool':             params.set('pool', '1'); break;
        case 'garden':           params.set('garden', '1'); break;
        case 'terrace':          params.set('terrace', '1'); break;
        case 'garage':           params.set('parking', '1'); break;
        case 'elevator':         params.set('lift', '1'); break;
        case 'sea_view':         params.set('seaview', '1'); break;
        case 'mountain_view':    params.set('mountainviews', '1'); break;
        case 'security':         break; // Not available as filter
        case 'air_conditioning': break; // Not available as filter
        case 'storage':          params.set('storeroom', '1'); break;
      }
    }
  }

  // New build
  if (hardFilters.is_new_build) {
    params.set('newbuild', '1');
  }

  // Pagination
  if (pageNum > 1) {
    params.set('page', pageNum);
  }

  const queryString = params.toString();
  return `${url}${queryString ? '?' + queryString : ''}`;
}

// ─── HTTP Request ───────────────────────────────────────────────────────────

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    let requestUrl;
    let options;

    if (USE_PROXY) {
      const encodedUrl = encodeURIComponent(url);
      // ThinkSpain is server-rendered — no render needed = 1 credit
      requestUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodedUrl}&render=false`;
      options = {
        method: 'GET',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity',
        },
        timeout: REQUEST_TIMEOUT_MS,
      };
    } else {
      requestUrl = url;
      options = {
        method: 'GET',
        headers: {
          'User-Agent': randomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity',
          'Connection': 'keep-alive',
        },
        timeout: REQUEST_TIMEOUT_MS,
      };
    }

    const protocol = requestUrl.startsWith('https') ? https : http;

    const req = protocol.request(requestUrl, options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log(`[ThinkSpain] Redirect ${res.statusCode} → ${res.headers.location}`);
        fetchPage(res.headers.location).then(resolve).catch(reject);
        res.resume();
        return;
      }

      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body });
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.end();
  });
}

async function fetchWithRetry(url, maxRetries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fetchPage(url);

      if (result.statusCode === 403 || result.statusCode === 429) {
        console.warn(`[ThinkSpain] Blocked (${result.statusCode}) attempt ${attempt + 1}: ${url}`);
        if (attempt < maxRetries) {
          const backoff = (attempt + 1) * 4000 + Math.random() * 2000;
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        return null;
      }

      if (result.statusCode === 404) {
        console.warn(`[ThinkSpain] 404 for: ${url}`);
        return null;
      }

      if (result.statusCode !== 200) {
        console.warn(`[ThinkSpain] HTTP ${result.statusCode} for: ${url}`);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        return null;
      }

      return result;
    } catch (err) {
      console.error(`[ThinkSpain] Fetch error attempt ${attempt + 1}: ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      return null;
    }
  }
  return null;
}

// ─── HTML Parser ────────────────────────────────────────────────────────────

/**
 * Parse ThinkSpain search results HTML into structured property data.
 *
 * ThinkSpain card structure:
 *   .twc__grid-item → property card container
 *     .property__price → price button (e.g. "€ 298,000")
 *     .property__title → title link (e.g. "Apartment for sale in Marbella")
 *     a[href*="/property-for-sale/"] → detail link (e.g. "/property-for-sale/9554128")
 *     .details li → detail items ("93 m2 Build", "2 Bedrooms", "2 Bathrooms")
 *     .property__tags li → feature tags ("New Build", "Pool", "Sea View")
 *     .property__description / .long-description → description text
 *     img → property photo
 *     a[href^="tel:"] → phone number
 */
function parseSearchResults(html, sourceCity) {
  const $ = cheerio.load(html);
  const listings = [];

  $('.twc__grid-item').each((i, el) => {
    const $el = $(el);

    try {
      // Title
      const $title = $el.find('.property__title');
      const title = $title.text().trim().split('\n')[0].trim() || '';

      // Link to detail page
      const $detailLink = $el.find('a[href*="/property-for-sale/"], a[href*="/property-to-rent/"]');
      const href = $detailLink.first().attr('href') || '';
      if (!href) return; // Skip if no link (probably an ad)

      const fullUrl = href.startsWith('http') ? href : `https://www.thinkspain.com${href}`;

      // Extract property ID from URL
      const idMatch = href.match(/\/(\d+)$/);
      const propertyId = idMatch ? idMatch[1] : null;

      // Price
      const $price = $el.find('.property__price');
      const priceText = $price.text().trim();
      const priceClean = priceText.replace(/[^0-9]/g, '');
      const price = priceClean ? parseInt(priceClean, 10) : null;

      // Details (bedrooms, m², bathrooms)
      let bedrooms = null;
      let bathrooms = null;
      let size_m2 = null;
      let plot_m2 = null;

      $el.find('.details li').each((j, li) => {
        const text = $(li).text().trim();

        const sizeMatch = text.match(/(\d+[\.,]?\d*)\s*m2?\s*Build/i);
        if (sizeMatch) size_m2 = parseFloat(sizeMatch[1].replace(',', '.'));

        const plotMatch = text.match(/(\d+[\.,]?\d*)\s*m2?\s*Plot/i);
        if (plotMatch) plot_m2 = parseFloat(plotMatch[1].replace(',', '.'));

        const bedMatch = text.match(/(\d+)\s*Bedroom/i);
        if (bedMatch) bedrooms = parseInt(bedMatch[1], 10);

        const bathMatch = text.match(/(\d+)\s*Bathroom/i);
        if (bathMatch) bathrooms = parseInt(bathMatch[1], 10);
      });

      // Feature tags
      const tags = [];
      $el.find('.property__tags li').each((j, li) => {
        const tag = $(li).text().trim();
        if (tag) tags.push(tag);
      });

      // Description
      const description = ($el.find('.property__description').text() ||
                           $el.find('.long-description').text() || '').trim();

      // Image
      let thumbnail = null;
      const $img = $el.find('img').first();
      if ($img.length) {
        thumbnail = $img.attr('data-src') || $img.attr('src') || null;
        // Skip placeholder/lazy images
        if (thumbnail && (thumbnail.includes('data:image') || thumbnail.includes('placeholder'))) {
          thumbnail = null;
        }
      }

      // Phone
      const phone = ($el.find('a[href^="tel:"]').text() || '').trim();

      // Map ThinkSpain tags to our normalized features
      const features = mapThinkSpainTags(tags);

      // Check if new build
      const isNewBuild = tags.some(t => t.toLowerCase().includes('new build'));

      // Guess property type from title
      const propertyType = guessPropertyType(title);

      listings.push({
        id: propertyId ? `ts_${propertyId}` : `ts_${Math.random().toString(36).substr(2, 9)}`,
        source: 'thinkspain',
        title: title || 'Woning op ThinkSpain',
        price,
        currency: '€',
        location: sourceCity || '',
        bedrooms,
        bathrooms,
        size_m2,
        plot_m2,
        floor: null,
        url: fullUrl,
        thumbnail,
        features,
        property_type: propertyType,
        description,
        price_per_m2: (price && size_m2) ? Math.round(price / size_m2) : null,
        address: '',
        province: '',
        municipality: sourceCity || '',
        latitude: null,
        longitude: null,
        images: thumbnail ? [thumbnail] : [],
        agency: null,
        agent_phone: phone || null,
        tags,
        is_new_build: isNewBuild,
      });
    } catch (parseErr) {
      console.warn(`[ThinkSpain] Failed to parse listing ${i}:`, parseErr.message);
    }
  });

  return listings;
}

/**
 * Extract total number of results from the page.
 */
function parseTotalResults(html) {
  const $ = cheerio.load(html);

  // Look for "1,179 found" text
  const headerText = $('h1').first().text() || '';
  const foundMatch = headerText.match(/([\d,]+)\s*(?:found|houses|properties|homes)/i);

  // Also check for "X found" near the header
  const foundText = $('body').text().match(/([\d,]+)\s+found/i);

  let total = null;
  if (foundMatch) {
    total = parseInt(foundMatch[1].replace(/,/g, ''), 10);
  } else if (foundText) {
    total = parseInt(foundText[1].replace(/,/g, ''), 10);
  }

  const maxPages = total ? Math.min(Math.ceil(total / LISTINGS_PER_PAGE), 60) : 5;
  return { total, maxPages };
}

// ─── Feature mapping ────────────────────────────────────────────────────────

/**
 * Map ThinkSpain's English feature tags to our normalized feature names.
 */
function mapThinkSpainTags(tags) {
  const features = [];
  const tagSet = new Set(tags.map(t => t.toLowerCase()));

  if (tagSet.has('communal pool') || tagSet.has('private pool') || tagSet.has('pool')) features.push('pool');
  if (tagSet.has('garden')) features.push('garden');
  if (tagSet.has('terrace/balcony') || tagSet.has('terrace')) features.push('terrace');
  if (tagSet.has('parking/garage') || tagSet.has('parking') || tagSet.has('garage')) features.push('garage');
  if (tagSet.has('air conditioning')) features.push('air_conditioning');
  if (tagSet.has('lift')) features.push('elevator');
  if (tagSet.has('storeroom') || tagSet.has('storage')) features.push('storage');
  if (tagSet.has('sea view') || tagSet.has('near beach/sea') || tagSet.has('seafront/beachfront')) features.push('sea_view');
  if (tagSet.has('mountain views')) features.push('mountain_view');
  if (tagSet.has('near golf') || tagSet.has('front line golf')) features.push('golf');
  if (tagSet.has('fitted wardrobes')) features.push('fitted_wardrobes');
  if (tagSet.has('south orientation')) features.push('south_facing');
  if (tagSet.has('wheelchair-friendly')) features.push('wheelchair_accessible');
  if (tagSet.has('ground floor')) features.push('ground_floor');
  if (tagSet.has('fireplace')) features.push('fireplace');

  return [...new Set(features)];
}

function guessPropertyType(title) {
  const text = title.toLowerCase();
  if (text.includes('villa')) return 'villa';
  if (text.includes('penthouse')) return 'penthouse';
  if (text.includes('duplex')) return 'duplex';
  if (text.includes('townhouse') || text.includes('town house') || text.includes('terraced')) return 'townhouse';
  if (text.includes('finca') || text.includes('country house') || text.includes('cortijo')) return 'countryHouse';
  if (text.includes('studio')) return 'studio';
  if (text.includes('bungalow')) return 'bungalow';
  if (text.includes('apartment') || text.includes('flat')) return 'flat';
  if (text.includes('plot') || text.includes('land')) return 'plot';
  if (text.includes('house') || text.includes('home')) return 'house';
  return null;
}

// ─── Main search function ───────────────────────────────────────────────────

/**
 * Search ThinkSpain — same interface as searchIdealista.
 * Accepts hardFilters, returns normalized property array.
 *
 * @param {object} hardFilters - hard_filters from Claude parser
 * @returns {Array} Normalized property listings
 */
async function searchThinkSpain(hardFilters) {
  const locations = hardFilters.locations || (hardFilters.location ? [hardFilters.location] : []);

  if (locations.length === 0) {
    console.warn('[ThinkSpain] No locations specified. Skipping.');
    return [];
  }

  // Cap at 15 locations (nieuwbouw can expand regions to 11+ cities)
  const searchLocations = locations.slice(0, 15);
  console.log(`[ThinkSpain] Searching ${searchLocations.length} location(s): ${searchLocations.join(', ')}`);
  console.log(`[ThinkSpain] Proxy: ${USE_PROXY ? 'ScraperAPI' : 'DIRECT'}`);

  const allListings = [];

  for (const city of searchLocations) {
    try {
      // Check slug exists
      const testSlug = resolveCitySlug(city);
      if (!testSlug) {
        console.log(`[ThinkSpain] Skipping unknown city: ${city}`);
        continue;
      }

      const cityListings = await scrapeCity(city, hardFilters);
      allListings.push(...cityListings);

      // Delay between cities
      if (searchLocations.indexOf(city) < searchLocations.length - 1) {
        await randomDelay();
      }
    } catch (err) {
      console.error(`[ThinkSpain] City ${city} failed:`, err.message);
    }
  }

  console.log(`[ThinkSpain] Total: ${allListings.length} properties from ${searchLocations.length} location(s)`);
  return allListings;
}

/**
 * Scrape all pages for a single city.
 */
async function scrapeCity(city, hardFilters) {
  const citySlug = resolveCitySlug(city);
  console.log(`[ThinkSpain] Scraping ${city} → slug: ${citySlug}`);

  // Fetch page 1
  const page1Url = buildSearchUrl(citySlug, hardFilters, 1);
  console.log(`[ThinkSpain] Page 1: ${page1Url}`);

  const page1Result = await fetchWithRetry(page1Url);

  if (!page1Result || !page1Result.body) {
    console.warn(`[ThinkSpain] Failed to fetch page 1 for ${city}`);
    return [];
  }

  const page1Listings = parseSearchResults(page1Result.body, city);
  const { total, maxPages } = parseTotalResults(page1Result.body);

  console.log(`[ThinkSpain] ${city}: ${total || '?'} total results, ${maxPages} pages available, got ${page1Listings.length} from page 1`);

  if (page1Listings.length === 0) {
    return [];
  }

  const allCityListings = [...page1Listings];

  // Scrape remaining pages
  const pagesToScrape = Math.min(maxPages, MAX_PAGES_PER_LOCATION);

  for (let page = 2; page <= pagesToScrape; page++) {
    await randomDelay();

    const pageUrl = buildSearchUrl(citySlug, hardFilters, page);
    console.log(`[ThinkSpain] ${city} page ${page}/${pagesToScrape}: ${pageUrl}`);

    const pageResult = await fetchWithRetry(pageUrl);

    if (!pageResult || !pageResult.body) {
      console.warn(`[ThinkSpain] ${city} page ${page} failed, stopping pagination`);
      break;
    }

    const pageListings = parseSearchResults(pageResult.body, city);
    console.log(`[ThinkSpain] ${city} page ${page}: ${pageListings.length} listings`);

    if (pageListings.length === 0) {
      console.log(`[ThinkSpain] ${city}: No more listings on page ${page}, stopping`);
      break;
    }

    allCityListings.push(...pageListings);
  }

  console.log(`[ThinkSpain] ${city}: ${allCityListings.length} total listings scraped`);
  return allCityListings;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  searchThinkSpain,
  buildSearchUrl,
  CITY_SLUG_MAP,
  resolveCitySlug,
  // Expose for testing
  parseSearchResults,
  parseTotalResults,
};
