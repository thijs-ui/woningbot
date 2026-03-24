/**
 * idealista-direct.js — Custom HTTP-based Idealista scraper.
 *
 * Replaces the expensive Apify marketplace actor ($0.15-0.25/page) with
 * direct HTTP requests + Cheerio parsing.
 *
 * Anti-blocking strategy:
 *   1. ScraperAPI proxy (handles IP rotation, residential IPs, geo-targeting)
 *   2. Realistic browser headers (rotated per request)
 *   3. Random delays between requests (3-7 seconds)
 *   4. Retry with exponential backoff on failure
 *   5. Graceful degradation (skip blocked pages, return partial results)
 *
 * Cost comparison:
 *   - Apify: $0.15-0.25 per page → $3-6 per multi-city query
 *   - This:  ~$0.0005 per page  → ~$0.01 per multi-city query
 */

const https = require('https');
const http = require('http');
const cheerio = require('cheerio');

// ─── Configuration ──────────────────────────────────────────────────────────

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '';
const USE_PROXY = !!SCRAPER_API_KEY;

const MAX_PAGES_PER_LOCATION = parseInt(process.env.IDEALISTA_MAX_PAGES, 10) || 5;
const REQUEST_DELAY_MIN_MS = 3000;
const REQUEST_DELAY_MAX_MS = 7000;
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 30000;

// ─── User-Agent rotation ────────────────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function randomDelay() {
  const ms = REQUEST_DELAY_MIN_MS + Math.random() * (REQUEST_DELAY_MAX_MS - REQUEST_DELAY_MIN_MS);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── City slug mapping (Idealista URL format) ───────────────────────────────
// Idealista URLs use: /venta-viviendas/{city-slug}/
// The slug is typically: {city-name}-{province-name}

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

  // Valencia
  'valencia':       'valencia-valencia',
  'gandia':         'gandia-valencia',
  'gandía':         'gandia-valencia',

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

const PROPERTY_TYPE_SLUG = {
  villa:         'con-chalets',
  apartment:     'con-pisos',
  penthouse:     'con-aticos',
  duplex:        'con-duplex',
  townhouse:     'con-adosados',
  finca:         'con-rusticas',
  country_house: 'con-rusticas',
  studio:        'con-estudios',
  bungalow:      'con-chalets',
  plot:          null, // uses different base path
};

// ─── URL Builder ────────────────────────────────────────────────────────────

function resolveCitySlug(city) {
  const normalized = (city || '').toLowerCase().trim();
  if (normalized && CITY_SLUG_MAP[normalized]) return CITY_SLUG_MAP[normalized];

  // Try partial match
  for (const [key, slug] of Object.entries(CITY_SLUG_MAP)) {
    if (normalized.includes(key) || key.includes(normalized)) return slug;
  }

  console.warn(`[Idealista-Direct] City "${city}" not in slug map — SKIPPING (auto-slug unreliable for Idealista).`);
  return null; // Return null so caller can skip this city
}

/**
 * Build Idealista search URL with filters encoded in the URL path.
 *
 * Idealista uses URL-path-based filtering:
 *   /en/venta-viviendas/{city-slug}/con-chalets/precio-hasta_500000/
 *
 * For price ranges, bedrooms, etc., Idealista uses query parameters on
 * the English version or path segments on the Spanish version.
 * We use the English version with query parameters for reliability.
 */
function buildSearchUrl(citySlug, hardFilters, pageNum = 1, isNewBuild = false) {
  // Base path
  let basePath;
  if (hardFilters.property_type === 'plot') {
    basePath = isNewBuild ? 'obra-nueva' : 'venta-terrenos';
  } else {
    basePath = isNewBuild ? 'obra-nueva' : 'venta-viviendas';
  }

  // Property type segment
  let typeSegment = '';
  if (hardFilters.property_type && PROPERTY_TYPE_SLUG[hardFilters.property_type]) {
    typeSegment = PROPERTY_TYPE_SLUG[hardFilters.property_type] + '/';
  }

  // Build URL path
  let url = `https://www.idealista.com/en/${basePath}/${citySlug}/${typeSegment}`;

  // Build query parameters for filters
  const params = [];

  if (hardFilters.price_min) params.push(`minPrice=${hardFilters.price_min}`);
  if (hardFilters.price_max) params.push(`maxPrice=${hardFilters.price_max}`);
  if (hardFilters.size_min_m2) params.push(`minSize=${hardFilters.size_min_m2}`);
  if (hardFilters.size_max_m2) params.push(`maxSize=${hardFilters.size_max_m2}`);

  // Bedrooms filter
  if (hardFilters.bedrooms_min) {
    // Idealista uses: minRooms=3
    params.push(`minRooms=${hardFilters.bedrooms_min}`);
  }

  // Features as query params
  if (hardFilters.features && hardFilters.features.length) {
    for (const feat of hardFilters.features) {
      switch (feat) {
        case 'pool':             params.push('swimmingPool=true'); break;
        case 'garden':           params.push('garden=true'); break;
        case 'terrace':          params.push('terrace=true'); break;
        case 'garage':           params.push('garage=true'); break;
        case 'air_conditioning': params.push('airConditioning=true'); break;
        case 'elevator':         params.push('elevator=true'); break;
        case 'storage':          params.push('storeRoom=true'); break;
      }
    }
  }

  // Pagination
  if (pageNum > 1) {
    url += `pagina-${pageNum}.htm`;
  }

  // Append query params
  if (params.length > 0) {
    const separator = url.includes('?') ? '&' : '?';
    url += separator + params.join('&');
  }

  return url;
}

// ─── HTTP Request with proxy support ────────────────────────────────────────

/**
 * Fetch a URL, optionally through ScraperAPI proxy.
 * Returns { statusCode, body } or throws on failure.
 */
function fetchPage(url, retryCount = 0) {
  return new Promise((resolve, reject) => {
    let requestUrl;
    let options;

    if (USE_PROXY) {
      // Route through ScraperAPI
      const encodedUrl = encodeURIComponent(url);
      requestUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodedUrl}&country_code=es&render=false`;
      options = {
        method: 'GET',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache',
        },
        timeout: REQUEST_TIMEOUT_MS,
      };
    } else {
      // Direct request (fallback, likely to be blocked)
      requestUrl = url;
      options = {
        method: 'GET',
        headers: {
          'User-Agent': randomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,es;q=0.8,nl;q=0.7',
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
        },
        timeout: REQUEST_TIMEOUT_MS,
      };
    }

    const protocol = requestUrl.startsWith('https') ? https : http;

    const req = protocol.request(requestUrl, options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log(`[Idealista-Direct] Redirect ${res.statusCode} → ${res.headers.location}`);
        fetchPage(res.headers.location, retryCount).then(resolve).catch(reject);
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

/**
 * Fetch with retry and exponential backoff.
 */
async function fetchWithRetry(url, maxRetries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fetchPage(url, attempt);

      // Check for blocking indicators
      if (result.statusCode === 403 || result.statusCode === 429) {
        console.warn(`[Idealista-Direct] Blocked (${result.statusCode}) on attempt ${attempt + 1}/${maxRetries + 1}: ${url}`);
        if (attempt < maxRetries) {
          const backoff = (attempt + 1) * 5000 + Math.random() * 3000;
          console.log(`[Idealista-Direct] Waiting ${Math.round(backoff / 1000)}s before retry...`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        return null; // Give up gracefully
      }

      if (result.statusCode === 404) {
        console.warn(`[Idealista-Direct] 404 for: ${url}`);
        return null;
      }

      if (result.statusCode !== 200) {
        console.warn(`[Idealista-Direct] HTTP ${result.statusCode} for: ${url}`);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        return null;
      }

      // Check if we got a CAPTCHA / DataDome page
      if (result.body.includes('datadome') && result.body.includes('captcha')) {
        console.warn(`[Idealista-Direct] CAPTCHA detected on attempt ${attempt + 1}: ${url}`);
        if (attempt < maxRetries) {
          const backoff = (attempt + 1) * 8000 + Math.random() * 5000;
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        return null;
      }

      return result;
    } catch (err) {
      console.error(`[Idealista-Direct] Fetch error attempt ${attempt + 1}: ${err.message}`);
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
 * Parse Idealista search results HTML into structured property data.
 * Uses Cheerio (jQuery-like) selectors based on Idealista's HTML structure.
 */
function parseSearchResults(html, sourceCity) {
  const $ = cheerio.load(html);
  const listings = [];

  // Each property is an <article> with class "item" inside the items-list section
  $('article.item').each((i, el) => {
    const $el = $(el);

    // Skip ad/promoted listings
    if ($el.find('.adv_txt').length > 0) return;
    if ($el.hasClass('item--ad')) return;

    try {
      // Title and link
      const $link = $el.find('a.item-link');
      const title = ($link.attr('title') || $link.text() || '').trim();
      const href = $link.attr('href') || '';
      const fullUrl = href.startsWith('http') ? href : `https://www.idealista.com${href}`;

      // Extract property code from URL
      const codeMatch = fullUrl.match(/\/inmueble\/(\d+)\//);
      const propertyCode = codeMatch ? codeMatch[1] : null;

      // Price
      const priceText = $el.find('.item-price').first().text().trim();
      const priceClean = priceText.replace(/[^0-9]/g, '');
      const price = priceClean ? parseInt(priceClean, 10) : null;

      // Currency
      const currencyText = $el.find('.item-price span').last().text().trim();
      const currency = currencyText || '€';

      // Image / thumbnail — prefer the property photo, skip agency logos
      let thumbnail = null;

      // Strategy 1: Get image from multimedia container (most reliable)
      const $multimedia = $el.find('.item-multimedia-container img, .item-gallery img');
      if ($multimedia.length > 0) {
        thumbnail = $multimedia.first().attr('src') || $multimedia.first().attr('data-src') || null;
      }

      // Strategy 2: Get from picture source in multimedia
      if (!thumbnail || thumbnail.includes('placeholder') || thumbnail.includes('data:image')) {
        const $source = $el.find('.item-multimedia-container source, .item-gallery source');
        if ($source.length > 0) {
          thumbnail = $source.first().attr('srcset') || null;
        }
      }

      // Strategy 3: First img that is NOT inside logo-branding
      if (!thumbnail || thumbnail.includes('placeholder') || thumbnail.includes('data:image')) {
        $el.find('img').each((j, img) => {
          if (thumbnail && !thumbnail.includes('placeholder')) return false; // already found
          const $img = $(img);
          // Skip agency logos
          if ($img.closest('.logo-branding').length > 0) return;
          if ($img.closest('.advertiser-logo').length > 0) return;
          const src = $img.attr('src') || $img.attr('data-src') || $img.attr('data-ondemand-img');
          if (src && !src.includes('placeholder') && !src.includes('data:image') && !src.includes('logo')) {
            thumbnail = src;
          }
        });
      }

      // Clean up srcset (take first URL)
      if (thumbnail && thumbnail.includes(',')) {
        thumbnail = thumbnail.split(',')[0].trim().split(' ')[0];
      }

      // Details (rooms, m², floor)
      const details = [];
      $el.find('.item-detail-char span, .item-detail span').each((j, span) => {
        details.push($(span).text().trim());
      });

      // Parse bedrooms from details
      let bedrooms = null;
      let size_m2 = null;
      let bathrooms = null;
      let floor = null;

      for (const detail of details) {
        const roomMatch = detail.match(/(\d+)\s*(hab|room|bed|dorm)/i);
        if (roomMatch) bedrooms = parseInt(roomMatch[1], 10);

        const sizeMatch = detail.match(/(\d+[\.,]?\d*)\s*m[²2]/i);
        if (sizeMatch) size_m2 = parseFloat(sizeMatch[1].replace(',', '.'));

        const bathMatch = detail.match(/(\d+)\s*(ba[ñn]|bath)/i);
        if (bathMatch) bathrooms = parseInt(bathMatch[1], 10);

        const floorMatch = detail.match(/(\d+)[ºªa-z]*\s*(planta|floor)/i);
        if (floorMatch) floor = floorMatch[1];
      }

      // Description
      const description = ($el.find('.item-description p').text() ||
                           $el.find('.ellipsis').text() || '').trim().replace(/\n/g, ' ');

      // Tags (new, reduced price, etc.)
      const tags = [];
      $el.find('.listing-tags-container span, .item-highlight').each((j, span) => {
        tags.push($(span).text().trim());
      });

      // Agency / listing company
      const agency = $el.find('.logo-branding a').attr('title') ||
                     $el.find('.professional-name').text().trim() || null;

      // Parking
      const hasParking = $el.find('.item-parking').length > 0;

      // Check if new build
      const isNewBuild = tags.some(t =>
        t.toLowerCase().includes('obra nueva') ||
        t.toLowerCase().includes('new build') ||
        t.toLowerCase().includes('new development')
      );

      // Only add if we have at least a URL
      if (fullUrl && fullUrl.includes('idealista.com')) {
        listings.push({
          id: propertyCode || fullUrl,
          source: 'idealista',
          title: title || 'Woning op Idealista',
          price,
          currency,
          location: sourceCity || '',
          bedrooms,
          bathrooms,
          size_m2,
          floor,
          url: fullUrl,
          thumbnail,
          features: extractFeaturesFromDetails(details, description, hasParking, tags),
          property_type: guessPropertyType(title, details),
          description,
          price_per_m2: (price && size_m2) ? Math.round(price / size_m2) : null,
          address: '',
          province: '',
          municipality: sourceCity || '',
          latitude: null,
          longitude: null,
          images: thumbnail ? [thumbnail] : [],
          agency,
          tags,
          is_new_build: isNewBuild,
        });
      }
    } catch (parseErr) {
      console.warn(`[Idealista-Direct] Failed to parse listing ${i}:`, parseErr.message);
    }
  });

  return listings;
}

/**
 * Extract total number of results and max pages from the HTML.
 */
function parseTotalResults(html) {
  const $ = cheerio.load(html);

  // Try the h1 container: "1,234 houses for sale in Marbella"
  const h1Text = $('h1#h1-container').text() || $('h1').first().text() || '';
  const numMatch = h1Text.match(/([\d.,]+)\s/);
  if (numMatch) {
    const total = parseInt(numMatch[1].replace(/[.,]/g, ''), 10);
    const maxPages = Math.min(Math.ceil(total / 30), 60); // Idealista caps at 60 pages
    return { total, maxPages };
  }

  // Fallback: check pagination
  let maxPage = 1;
  $('a.pagination-link, .pagination a').each((i, el) => {
    const text = $(el).text().trim();
    const pageNum = parseInt(text, 10);
    if (!isNaN(pageNum) && pageNum > maxPage) maxPage = pageNum;
  });

  return { total: null, maxPages: maxPage };
}

// ─── Feature extraction helpers ─────────────────────────────────────────────

function extractFeaturesFromDetails(details, description, hasParking, tags) {
  const features = [];
  const allText = [...details, description, ...tags].join(' ').toLowerCase();

  if (allText.includes('piscina') || allText.includes('pool')) features.push('pool');
  if (allText.includes('jardín') || allText.includes('jardin') || allText.includes('garden')) features.push('garden');
  if (allText.includes('terraza') || allText.includes('terrace')) features.push('terrace');
  if (hasParking || allText.includes('garaje') || allText.includes('garage') || allText.includes('parking')) features.push('garage');
  if (allText.includes('aire acondicionado') || allText.includes('air conditioning') || allText.includes('a/c')) features.push('air_conditioning');
  if (allText.includes('ascensor') || allText.includes('elevator') || allText.includes('lift')) features.push('elevator');
  if (allText.includes('trastero') || allText.includes('storage')) features.push('storage');
  if (allText.includes('vista al mar') || allText.includes('vistas al mar') || allText.includes('sea view')) features.push('sea_view');
  if (allText.includes('montaña') || allText.includes('mountain view')) features.push('mountain_view');
  if (allText.includes('seguridad') || allText.includes('vigilancia') || allText.includes('security') || allText.includes('gated')) features.push('security');

  return [...new Set(features)];
}

function guessPropertyType(title, details) {
  const text = (title + ' ' + details.join(' ')).toLowerCase();
  if (text.includes('chalet') || text.includes('villa') || text.includes('independiente')) return 'chalet';
  if (text.includes('ático') || text.includes('atico') || text.includes('penthouse')) return 'penthouse';
  if (text.includes('dúplex') || text.includes('duplex')) return 'duplex';
  if (text.includes('adosado') || text.includes('pareado') || text.includes('townhouse')) return 'townhouse';
  if (text.includes('finca') || text.includes('rústica') || text.includes('rustica') || text.includes('country')) return 'countryHouse';
  if (text.includes('estudio') || text.includes('studio')) return 'studio';
  if (text.includes('piso') || text.includes('apartamento') || text.includes('apartment') || text.includes('flat')) return 'flat';
  return null;
}

// ─── Main search function ───────────────────────────────────────────────────

/**
 * Search Idealista — drop-in replacement for the Apify-based version.
 * Same interface: accepts hardFilters, returns normalized property array.
 *
 * @param {object} hardFilters - hard_filters from Claude parser
 * @returns {Array} Normalized property listings
 */
async function searchIdealista(hardFilters) {
  const locations = hardFilters.locations || (hardFilters.location ? [hardFilters.location] : []);
  const isNewBuild = hardFilters.is_new_build === true;

  if (locations.length === 0) {
    console.warn('[Idealista-Direct] No locations specified. Skipping.');
    return [];
  }

  // Cap at 15 locations (nieuwbouw can expand regions to 11+ cities)
  const searchLocations = locations.slice(0, 15);
  console.log(`[Idealista-Direct] Searching ${searchLocations.length} location(s): ${searchLocations.join(', ')}${isNewBuild ? ' (incl. nieuwbouw)' : ''}`);
  console.log(`[Idealista-Direct] Proxy: ${USE_PROXY ? 'ScraperAPI' : 'DIRECT (risky)'}`);

  const allListings = [];

  // Process locations sequentially to avoid rate limiting
  for (const city of searchLocations) {
    try {
      // Skip cities with no known slug (Fix #11)
      const testSlug = resolveCitySlug(city);
      if (!testSlug) {
        console.log(`[Idealista-Direct] Skipping unknown city: ${city}`);
        continue;
      }

      const cityListings = await scrapeCity(city, hardFilters, false);
      allListings.push(...cityListings);

      if (isNewBuild) {
        const newBuildListings = await scrapeCity(city, hardFilters, true);
        newBuildListings.forEach((p) => { p.is_new_build = true; });
        allListings.push(...newBuildListings);
      }

      // Delay between cities
      if (searchLocations.indexOf(city) < searchLocations.length - 1) {
        await randomDelay();
      }
    } catch (err) {
      console.error(`[Idealista-Direct] City ${city} failed:`, err.message);
      // Continue with other cities
    }
  }

  console.log(`[Idealista-Direct] Total: ${allListings.length} properties from ${searchLocations.length} location(s)`);
  return allListings;
}

/**
 * Scrape all pages for a single city.
 */
async function scrapeCity(city, hardFilters, isNewBuild) {
  const citySlug = resolveCitySlug(city);
  const label = isNewBuild ? `${city} (obra nueva)` : city;

  console.log(`[Idealista-Direct] Scraping ${label} → slug: ${citySlug}`);

  // Fetch page 1
  const page1Url = buildSearchUrl(citySlug, hardFilters, 1, isNewBuild);
  console.log(`[Idealista-Direct] Page 1: ${page1Url}`);

  const page1Result = await fetchWithRetry(page1Url);

  if (!page1Result || !page1Result.body) {
    console.warn(`[Idealista-Direct] Failed to fetch page 1 for ${label}`);
    return [];
  }

  // Parse page 1
  const page1Listings = parseSearchResults(page1Result.body, city);
  const { total, maxPages } = parseTotalResults(page1Result.body);

  console.log(`[Idealista-Direct] ${label}: ${total || '?'} total results, ${maxPages} pages available, got ${page1Listings.length} from page 1`);

  if (page1Listings.length === 0) {
    // Check if we got blocked or just no results
    if (page1Result.body.length < 5000) {
      console.warn(`[Idealista-Direct] ${label}: Very short response (${page1Result.body.length} bytes) — possible block`);
    }
    return [];
  }

  const allCityListings = [...page1Listings];

  // Determine how many more pages to scrape
  const pagesToScrape = Math.min(maxPages, MAX_PAGES_PER_LOCATION);

  // Scrape remaining pages sequentially with delays
  for (let page = 2; page <= pagesToScrape; page++) {
    await randomDelay();

    const pageUrl = buildSearchUrl(citySlug, hardFilters, page, isNewBuild);
    console.log(`[Idealista-Direct] ${label} page ${page}/${pagesToScrape}: ${pageUrl}`);

    const pageResult = await fetchWithRetry(pageUrl);

    if (!pageResult || !pageResult.body) {
      console.warn(`[Idealista-Direct] ${label} page ${page} failed, stopping pagination`);
      break;
    }

    const pageListings = parseSearchResults(pageResult.body, city);
    console.log(`[Idealista-Direct] ${label} page ${page}: ${pageListings.length} listings`);

    if (pageListings.length === 0) {
      console.log(`[Idealista-Direct] ${label}: No more listings on page ${page}, stopping`);
      break;
    }

    allCityListings.push(...pageListings);
  }

  console.log(`[Idealista-Direct] ${label}: ${allCityListings.length} total listings scraped`);
  return allCityListings;
}

// ─── Detail Scrape ─────────────────────────────────────────────────────────

/**
 * Scrape a single Idealista listing detail page for richer data.
 * Returns enriched property object with full description, all images, and extra details.
 * Costs 1 ScraperAPI credit per call.
 *
 * @param {string} listingUrl - Full Idealista listing URL
 * @returns {object|null} Enriched property data or null on failure
 */
async function scrapeListingDetail(listingUrl) {
  if (!listingUrl || !listingUrl.includes('idealista.com')) return null;

  console.log(`[Idealista-Detail] Scraping: ${listingUrl}`);

  const result = await fetchWithRetry(listingUrl);
  if (!result || !result.body) {
    console.warn(`[Idealista-Detail] Failed to fetch: ${listingUrl}`);
    return null;
  }

  try {
    const $ = cheerio.load(result.body);

    // Full description
    const fullDescription = ($('.comment p').text() || $('.adCommentsBody').text() || '').trim();

    // All images
    const images = [];
    $('img[data-ondemand-img], .detail-image-gallery img, .multimedia-gallery img').each((i, img) => {
      const src = $(img).attr('data-ondemand-img') || $(img).attr('src') || $(img).attr('data-src');
      if (src && !src.includes('logo') && !src.includes('placeholder') && !src.includes('data:image')) {
        // Try to get full-size image URL
        const fullSrc = src.replace(/WEB_DETAIL-S/g, 'WEB_DETAIL-L')
                           .replace(/WEB_LISTING/g, 'WEB_DETAIL-L')
                           .replace(/blur\//, '');
        images.push(fullSrc);
      }
    });

    // Also check picture sources for webp
    $('picture source[srcset]').each((i, source) => {
      const srcset = $(source).attr('srcset') || '';
      const urls = srcset.split(',').map(s => s.trim().split(' ')[0]).filter(Boolean);
      for (const u of urls) {
        if (!u.includes('logo') && !u.includes('placeholder') && !images.includes(u)) {
          images.push(u);
        }
      }
    });

    // Energy rating
    const energyRating = $('.icon-energy-rating-icon').text().trim() ||
                         $('[class*="energy"]').first().text().trim() || null;

    // Features list from detail page
    const detailFeatures = [];
    $('.details-property_features li, .details-property-feature-one li').each((i, li) => {
      detailFeatures.push($(li).text().trim());
    });

    // Address / location info
    const address = ($('#headerMap .main-info__title-minor').text() ||
                    $('.header-map-info').text() || '').trim();

    // Agent info
    const agentName = ($('.professional-name').text() ||
                       $('.about-advertiser-name').text() || '').trim();
    const agentPhone = ($('.contact-phones a').first().text() || '').trim();

    // Map coordinates from script tags
    let latitude = null;
    let longitude = null;
    $('script').each((i, script) => {
      const text = $(script).html() || '';
      const latMatch = text.match(/"latitude"\s*:\s*([\d.]+)/);
      const lngMatch = text.match(/"longitude"\s*:\s*([\d.-]+)/);
      if (latMatch && lngMatch) {
        latitude = parseFloat(latMatch[1]);
        longitude = parseFloat(lngMatch[1]);
      }
    });

    // Construction year
    let constructionYear = null;
    const yearMatch = result.body.match(/(?:construido en|built in|año de construcción|construction year)[:\s]*(\d{4})/i);
    if (yearMatch) constructionYear = parseInt(yearMatch[1], 10);

    // Community fees
    let communityFees = null;
    const feeMatch = result.body.match(/(?:comunidad|community fee)[:\s]*€?\s*([\d.,]+)/i);
    if (feeMatch) communityFees = parseFloat(feeMatch[1].replace('.', '').replace(',', '.'));

    console.log(`[Idealista-Detail] Enriched: ${images.length} images, ${detailFeatures.length} features`);

    return {
      full_description: fullDescription || null,
      images: [...new Set(images)].slice(0, 30), // cap at 30
      detail_features: detailFeatures,
      address,
      agent_name: agentName || null,
      agent_phone: agentPhone || null,
      latitude,
      longitude,
      energy_rating: energyRating,
      construction_year: constructionYear,
      community_fees: communityFees,
    };
  } catch (err) {
    console.error(`[Idealista-Detail] Parse error: ${err.message}`);
    return null;
  }
}

/**
 * Enrich an array of selected listings with detail page data.
 * Only scrapes Idealista listings. Adds delay between requests.
 *
 * @param {Array} listings - Array of listing objects (must have .url and .source)
 * @param {number} maxListings - Max listings to enrich (default 8)
 * @returns {Map} Map of listing.id → enrichment data
 */
async function enrichListingsWithDetails(listings, maxListings = 8) {
  const enrichments = new Map();
  const toEnrich = listings
    .filter(l => l.source === 'idealista' && l.url)
    .slice(0, maxListings);

  console.log(`[Idealista-Detail] Enriching ${toEnrich.length} listings...`);

  for (let i = 0; i < toEnrich.length; i++) {
    const listing = toEnrich[i];
    try {
      const detail = await scrapeListingDetail(listing.url);
      if (detail) {
        enrichments.set(listing.id, detail);

        // Merge images back into listing
        if (detail.images.length > 0) {
          listing.images = detail.images;
        }
        if (detail.full_description) {
          listing.full_description = detail.full_description;
        }
        if (detail.latitude) listing.latitude = detail.latitude;
        if (detail.longitude) listing.longitude = detail.longitude;
        if (detail.address) listing.address = detail.address;
      }
    } catch (err) {
      console.warn(`[Idealista-Detail] Failed to enrich ${listing.id}: ${err.message}`);
    }

    // Delay between detail requests
    if (i < toEnrich.length - 1) {
      await randomDelay();
    }
  }

  console.log(`[Idealista-Detail] Enriched ${enrichments.size}/${toEnrich.length} listings`);
  return enrichments;
}

// ─── Exports ────────────────────────────────────────────────────────────────

// Export the same interface as the Apify-based idealista.js
// Also export LOCATION_MAP for backward compatibility (used by other modules)
const LOCATION_MAP = Object.fromEntries(
  Object.entries(CITY_SLUG_MAP).map(([city]) => {
    // Keep the old format for any code that checks LOCATION_MAP
    return [city, city];
  })
);

function resolveLocationId(city) {
  return resolveCitySlug(city);
}

module.exports = {
  searchIdealista,
  scrapeListingDetail,
  enrichListingsWithDetails,
  buildSearchUrl,
  CITY_SLUG_MAP,
  LOCATION_MAP,
  resolveLocationId,
  // Expose for testing
  parseSearchResults,
  parseTotalResults,
  fetchWithRetry,
  randomDelay,
};
