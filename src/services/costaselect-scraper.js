// ─── Costa Select page scraper ─────────────────────────────────────────────
// Haalt property data op rechtstreeks van costaselect.com als fallback
// wanneer de ref niet in Supabase staat.
//
// HTML structuur costaselect.com (OGonline CMS):
// - Specs als <dt>Label</dt><dd>Waarde</dd> paren
// - Beschrijving in sectie na "Omschrijving" header
// - Ref in <small>756790</small>

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
 * Bouw een map van dt→dd paren uit de pagina.
 * Geeft { "Prijs": "€ 1.295.000", "Aantal slaapkamers": "4", ... }
 */
function buildSpecMap($) {
  const map = {};
  $('dt').each((_, el) => {
    const key = $(el).text().trim();
    const val = $(el).next('dd').text().trim();
    if (key && val) map[key] = val;
  });
  return map;
}

function parsePrice(str) {
  if (!str) return null;
  const m = str.replace(/\./g, '').match(/[\d]+/);
  return m ? parseInt(m[0]) : null;
}

function parseInt2(str) {
  if (!str) return null;
  const m = str.match(/[\d]+/);
  return m ? parseInt(m[0]) : null;
}

/**
 * Scrape een costaselect.com property pagina.
 * Geeft een object terug in hetzelfde formaat als resales_properties.
 */
async function scrapeCostaSelectPage(url) {
  const html = await fetchPage(url);
  const $ = cheerio.load(html);

  // Ref uit <small> tag
  const refMatch = html.match(/<small[^>]*>\s*(\d{5,7})\s*<\/small>/i);
  const ref = refMatch?.[1] || null;

  // Specs via dt/dd map
  const specs = buildSpecMap($);

  const price = parsePrice(specs['Prijs'] || specs['Price'] || specs['Prix'] || specs['Preis'] || '');

  const beds  = parseInt2(specs['Aantal slaapkamers'] || specs['Bedrooms'] || specs['Schlafzimmer'] || specs['Chambres'] || '');
  const baths = parseInt2(specs['Aantal badkamers']   || specs['Bathrooms'] || specs['Badezimmer']  || specs['Salles de bain'] || '');

  const built_m2 = parseInt2(
    specs['Woonoppervlakte'] || specs['Bebouwde oppervlakte'] || specs['Built area'] ||
    specs['Wohnfläche'] || specs['Surface habitable'] || ''
  );
  const plot_m2 = parseInt2(
    specs['Perceeloppervlakte'] || specs['Plot size'] || specs['Grundstück'] ||
    specs['Surface terrain'] || ''
  );

  const town     = specs['Plaats']    || specs['Town']  || specs['Ort']    || specs['Ville']    || null;
  const province = specs['Provincie'] || specs['Province'] || specs['Provinz'] || specs['Province'] || null;

  const rawType = specs['Soort woonhuis'] || specs['Property type'] || specs['Tipo'] || null;

  // Pool
  const poolSpec = specs['Zwembad'] || specs['Pool'] || specs['Piscine'] || '';
  const hasPool = /ja|yes|oui|ja/i.test(poolSpec) || /pool|zwembad|piscina/i.test(html.substring(0, 50000));

  // Nieuwbouw
  const buildType = specs['Soort bouw'] || specs['Construction'] || '';
  const isNewBuild = /nieuwbouw|new build|obra nueva/i.test(buildType);

  // Beschrijving — zoek sectie na "Omschrijving" header
  let desc = '';
  $('h2, h3, strong').each((_, el) => {
    if (/omschrijving|description|beschrijving/i.test($(el).text())) {
      // Pak de tekst van de volgende sibling paragrafen
      let node = $(el).parent();
      const text = node.next().text().trim() || node.parent().find('p').text().trim();
      if (text.length > desc.length) desc = text;
    }
  });

  // Fallback beschrijving: langste <p> blok op de pagina
  if (desc.length < 100) {
    $('p').each((_, el) => {
      const t = $(el).text().trim();
      if (t.length > desc.length) desc = t;
    });
  }

  console.log(`[CostaScraper] ref=${ref}, price=${price}, beds=${beds}, baths=${baths}, built=${built_m2}, plot=${plot_m2}, town=${town}, province=${province}`);

  return {
    ref,
    url,
    price,
    property_type: rawType || null,
    town:          town || null,
    province:      province || null,
    beds,
    baths,
    built_m2,
    plot_m2,
    pool:          hasPool || null,
    new_build:     isNewBuild || null,
    features:      hasPool ? ['pool'] : [],
    desc_nl:       desc.substring(0, 1000) || null,
    desc_en:       null,
    _scraped:      true,
  };
}

module.exports = { scrapeCostaSelectPage };
