// ─── Costa Select page scraper ─────────────────────────────────────────────
// Haalt property data op rechtstreeks van costaselect.com als fallback
// wanneer de ref niet in Supabase staat.

const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} bij ophalen ${url}`);
  return res.text();
}

/**
 * Probeer JSON-LD structured data te extraheren.
 */
function extractJsonLd($) {
  let result = {};
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).text());
      const obj = Array.isArray(data) ? data[0] : data;
      if (obj['@type'] && (obj['@type'].includes('RealEstate') || obj['@type'].includes('Product') || obj['@type'].includes('Place'))) {
        result = obj;
      }
      // Neem altijd de eerste niet-lege match
      if (!result['@type'] && obj) result = obj;
    } catch { /* ignore */ }
  });
  return result;
}

/**
 * Extraheer prijs uit HTML — zoekt naar meest voorkomende patronen op OGonline sites.
 */
function extractPrice($, html) {
  // JSON-LD price
  let price = null;

  // Probeer diverse selectors
  const priceSelectors = [
    '[class*="price"] [class*="amount"]',
    '[class*="price"]',
    '[itemprop="price"]',
    '[class*="Price"]',
  ];
  for (const sel of priceSelectors) {
    const text = $(sel).first().text().trim();
    const match = text.match(/[\d.,]+/);
    if (match) {
      const num = parseFloat(match[0].replace(/\./g, '').replace(',', '.'));
      if (num > 10000) { price = num; break; }
    }
  }

  // Fallback: regex op hele HTML
  if (!price) {
    const m = html.match(/[€$]\s*([\d]{3,}[\d.,]*)/);
    if (m) price = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
  }

  return price || null;
}

/**
 * Extraheer een getal uit tekst voor een specifiek kenmerk.
 */
function extractStat($, html, keywords) {
  for (const kw of keywords) {
    // Zoek naar getal vlak bij het keyword in de HTML
    const re = new RegExp(`(\\d+)\\s*${kw}|${kw}[^\\d]*(\\d+)`, 'i');
    const m = html.match(re);
    if (m) return parseInt(m[1] || m[2]);
  }
  return null;
}

/**
 * Scrape een costaselect.com property pagina.
 * Geeft een object terug in hetzelfde formaat als resales_properties.
 */
async function scrapeCostaSelectPage(url) {
  const html = await fetchPage(url);
  const $ = cheerio.load(html);

  const jsonLd = extractJsonLd($);

  // Ref uit <small> tag
  const refMatch = html.match(/<small[^>]*>\s*(\d{5,7})\s*<\/small>/i);
  const ref = refMatch?.[1] || null;

  // Prijs
  const price = extractPrice($, html);

  // Beschrijving — probeer meta description en content blokken
  const metaDesc = $('meta[name="description"]').attr('content') || '';
  const ogDesc = $('meta[property="og:description"]').attr('content') || '';

  // Zoek langere beschrijvingstekst in de pagina
  let desc = '';
  const descSelectors = [
    '[class*="description"]',
    '[class*="Description"]',
    '[class*="content"] p',
    '[class*="details"] p',
    'article p',
  ];
  for (const sel of descSelectors) {
    const text = $(sel).text().trim();
    if (text.length > desc.length && text.length > 50) desc = text;
  }
  if (!desc) desc = ogDesc || metaDesc;

  // Titel / type
  const ogTitle = $('meta[property="og:title"]').attr('content') || '';
  const h1 = $('h1').first().text().replace(/\s*\d{5,7}\s*$/, '').trim();
  const title = ogTitle || h1 || '';

  // Locatie — uit URL of titel
  const urlParts = url.split('/').filter(Boolean);
  const town = urlParts[urlParts.length - 2]
    ? decodeURIComponent(urlParts[urlParts.length - 2]).replace(/-/g, ' ')
    : null;

  // Property type uit URL of titel
  let property_type = null;
  if (/villa/i.test(title + url)) property_type = 'Villa';
  else if (/appartement|apartment/i.test(title + url)) property_type = 'Appartement';
  else if (/townhouse|rijtjeshuis/i.test(title + url)) property_type = 'Townhouse';
  else if (/finca/i.test(title + url)) property_type = 'Finca';

  // Kenmerken via stats
  const beds = extractStat($, html, ['slaapkamers?', 'bedrooms?', 'dormitorios?', 'chambres?']);
  const baths = extractStat($, html, ['badkamers?', 'bathrooms?', 'ba[ñn]os?', 'salles? de bain']);
  const built_m2 = extractStat($, html, ['m[²2]\\s*bebouwd', 'm[²2]\\s*woon', 'built\\s*m[²2]', 'superficie construida']);
  const plot_m2 = extractStat($, html, ['m[²2]\\s*perceel', 'plot\\s*m[²2]', 'superficie parcela', 'terrain']);

  // Pool
  const hasPool = /zwembad|pool|piscina/i.test(html);

  console.log(`[CostaScraper] ref=${ref}, price=${price}, beds=${beds}, built=${built_m2}, town=${town}`);

  return {
    ref,
    url,
    price,
    property_type,
    town: town
      ? town.charAt(0).toUpperCase() + town.slice(1)
      : null,
    province: null,
    beds,
    baths,
    built_m2,
    plot_m2,
    pool: hasPool || null,
    new_build: /nieuwbouw|new build|obra nueva/i.test(html) || null,
    features: hasPool ? ['pool'] : [],
    desc_nl: /\bnl\b|\bnederlands\b/i.test(url) ? desc.substring(0, 1000) : null,
    desc_en: desc.substring(0, 1000),
    _scraped: true, // markeer als live gescraped (geen Supabase data)
  };
}

module.exports = { scrapeCostaSelectPage };
