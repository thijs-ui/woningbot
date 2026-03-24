/**
 * Test script for idealista-direct.js
 * Tests URL building, HTML parsing, and (optionally) live fetching.
 */

const {
  searchIdealista,
  buildSearchUrl,
  CITY_SLUG_MAP,
  parseSearchResults,
  parseTotalResults,
} = require('./src/services/idealista-direct');

// ─── Test 1: URL Building ───────────────────────────────────────────────────

function testUrlBuilding() {
  console.log('\n=== TEST 1: URL Building ===\n');

  const tests = [
    {
      name: 'Basic search in Marbella',
      slug: 'marbella-malaga',
      filters: {},
      page: 1,
      newBuild: false,
    },
    {
      name: 'Villa in Estepona, max 500k',
      slug: 'estepona-malaga',
      filters: { property_type: 'villa', price_max: 500000 },
      page: 1,
      newBuild: false,
    },
    {
      name: 'Apartment in Torrevieja, 100k-200k, 2 bedrooms',
      slug: 'torrevieja-alicante',
      filters: { property_type: 'apartment', price_min: 100000, price_max: 200000, bedrooms_min: 2 },
      page: 1,
      newBuild: false,
    },
    {
      name: 'New build in Malaga, page 3',
      slug: 'malaga-malaga',
      filters: {},
      page: 3,
      newBuild: true,
    },
    {
      name: 'Villa with pool in Mijas, 300k-800k',
      slug: 'mijas-malaga',
      filters: { property_type: 'villa', price_min: 300000, price_max: 800000, features: ['pool', 'garden'] },
      page: 1,
      newBuild: false,
    },
    {
      name: 'Page 2 of search',
      slug: 'marbella-malaga',
      filters: { price_max: 1000000 },
      page: 2,
      newBuild: false,
    },
  ];

  for (const t of tests) {
    const url = buildSearchUrl(t.slug, t.filters, t.page, t.newBuild);
    console.log(`  ${t.name}`);
    console.log(`    → ${url}\n`);
  }

  console.log('  ✅ URL building tests passed\n');
}

// ─── Test 2: City Slug Map ──────────────────────────────────────────────────

function testCitySlugMap() {
  console.log('\n=== TEST 2: City Slug Map ===\n');

  const requiredCities = [
    'marbella', 'estepona', 'malaga', 'fuengirola', 'mijas',
    'torrevieja', 'alicante', 'javea', 'denia', 'valencia',
    'benidorm', 'calpe', 'orihuela', 'murcia',
  ];

  let allFound = true;
  for (const city of requiredCities) {
    const slug = CITY_SLUG_MAP[city];
    if (!slug) {
      console.log(`  ❌ Missing slug for: ${city}`);
      allFound = false;
    } else {
      console.log(`  ✅ ${city} → ${slug}`);
    }
  }

  console.log(`\n  ${allFound ? '✅' : '❌'} City slug map: ${Object.keys(CITY_SLUG_MAP).length} cities mapped\n`);
}

// ─── Test 3: HTML Parsing (with sample HTML) ────────────────────────────────

function testHtmlParsing() {
  console.log('\n=== TEST 3: HTML Parsing ===\n');

  // Simulated Idealista search results HTML
  const sampleHtml = `
<!DOCTYPE html>
<html>
<head><title>Houses for sale in Marbella</title></head>
<body>
  <h1 id="h1-container">1,234 houses for sale in Marbella, Málaga</h1>
  <section class="items-list">
    <article class="item">
      <div class="item-info-container">
        <a class="item-link" href="/en/inmueble/12345678/" title="Villa for sale in Marbella Golden Mile">
          Villa for sale in Marbella Golden Mile
        </a>
        <span class="item-price">750,000<span>€</span></span>
        <div class="item-detail-char">
          <span class="item-detail">4 rooms</span>
          <span class="item-detail">250 m²</span>
          <span class="item-detail">3 bathrooms</span>
        </div>
        <div class="item-description">
          <p>Beautiful villa with swimming pool and garden in the heart of Marbella Golden Mile. Sea views, modern design.</p>
        </div>
        <div class="listing-tags-container">
          <span>Reduced price</span>
        </div>
        <picture class="logo-branding">
          <a href="/pro/agency123/" title="Luxury Homes Marbella">
            <img src="https://img3.idealista.com/logo/agency123.jpg" />
          </a>
        </picture>
      </div>
      <img src="https://img3.idealista.com/blur/WEB_LISTING-M/0/id12345678/photo1.jpg" />
    </article>

    <article class="item">
      <div class="item-info-container">
        <a class="item-link" href="/en/inmueble/87654321/" title="Apartment for sale in Nueva Andalucía">
          Apartment for sale in Nueva Andalucía
        </a>
        <span class="item-price">320,000<span>€</span></span>
        <div class="item-detail-char">
          <span class="item-detail">2 rooms</span>
          <span class="item-detail">95 m²</span>
          <span class="item-detail">2 bathrooms</span>
        </div>
        <div class="item-description">
          <p>Modern apartment with terrace and community pool. Close to all amenities.</p>
        </div>
        <span class="item-parking">Parking included</span>
      </div>
      <img src="https://img3.idealista.com/blur/WEB_LISTING-M/0/id87654321/photo1.jpg" />
    </article>

    <article class="item item--ad">
      <p class="adv_txt">Sponsored</p>
      <div class="item-info-container">
        <a class="item-link" href="/en/inmueble/99999999/" title="Ad listing">Ad listing</a>
      </div>
    </article>

    <article class="item">
      <div class="item-info-container">
        <a class="item-link" href="/en/inmueble/11112222/" title="Chalet independiente en venta en Elviria">
          Chalet independiente en venta en Elviria
        </a>
        <span class="item-price">1,250,000<span>€</span></span>
        <div class="item-detail-char">
          <span class="item-detail">5 hab.</span>
          <span class="item-detail">380 m²</span>
          <span class="item-detail">4 baños</span>
        </div>
        <div class="item-description">
          <p>Espectacular chalet con piscina privada, jardín y vistas al mar. Aire acondicionado, garaje doble.</p>
        </div>
        <div class="listing-tags-container">
          <span>Obra nueva</span>
        </div>
      </div>
      <img src="https://img3.idealista.com/blur/WEB_LISTING-M/0/id11112222/photo1.jpg" />
    </article>
  </section>

  <div class="pagination">
    <a class="pagination-link" href="pagina-2.htm">2</a>
    <a class="pagination-link" href="pagina-3.htm">3</a>
    <a class="pagination-link" href="pagina-41.htm">41</a>
  </div>
</body>
</html>`;

  const listings = parseSearchResults(sampleHtml, 'Marbella');
  const { total, maxPages } = parseTotalResults(sampleHtml);

  console.log(`  Total results parsed: ${total}`);
  console.log(`  Max pages: ${maxPages}`);
  console.log(`  Listings found: ${listings.length} (expected 3, ad should be skipped)\n`);

  if (listings.length !== 3) {
    console.log('  ❌ Expected 3 listings (ad should be filtered out)');
    return;
  }

  // Check listing 1
  const l1 = listings[0];
  console.log('  Listing 1:');
  console.log(`    Title: ${l1.title}`);
  console.log(`    Price: ${l1.price} (expected 750000)`);
  console.log(`    Bedrooms: ${l1.bedrooms} (expected 4)`);
  console.log(`    Size: ${l1.size_m2} m² (expected 250)`);
  console.log(`    Bathrooms: ${l1.bathrooms} (expected 3)`);
  console.log(`    URL: ${l1.url}`);
  console.log(`    Thumbnail: ${l1.thumbnail}`);
  console.log(`    Features: ${l1.features.join(', ')}`);
  console.log(`    Agency: ${l1.agency}`);
  console.log(`    Type: ${l1.property_type}`);
  console.log(`    ID: ${l1.id}`);

  const checks1 = [
    l1.price === 750000,
    l1.bedrooms === 4,
    l1.size_m2 === 250,
    l1.bathrooms === 3,
    l1.url.includes('12345678'),
    l1.features.includes('pool'),
    l1.features.includes('garden'),
    l1.features.includes('sea_view'),
    l1.agency === 'Luxury Homes Marbella',
  ];
  console.log(`    ${checks1.every(Boolean) ? '✅' : '❌'} All checks: ${checks1.filter(Boolean).length}/${checks1.length}\n`);

  // Check listing 2
  const l2 = listings[1];
  console.log('  Listing 2:');
  console.log(`    Price: ${l2.price} (expected 320000)`);
  console.log(`    Bedrooms: ${l2.bedrooms} (expected 2)`);
  console.log(`    Features: ${l2.features.join(', ')}`);
  const checks2 = [
    l2.price === 320000,
    l2.bedrooms === 2,
    l2.features.includes('terrace'),
    l2.features.includes('pool'),
    l2.features.includes('garage'),
  ];
  console.log(`    ${checks2.every(Boolean) ? '✅' : '❌'} All checks: ${checks2.filter(Boolean).length}/${checks2.length}\n`);

  // Check listing 3 (Spanish text, new build)
  const l3 = listings[2];
  console.log('  Listing 3 (Spanish):');
  console.log(`    Price: ${l3.price} (expected 1250000)`);
  console.log(`    Bedrooms: ${l3.bedrooms} (expected 5)`);
  console.log(`    Size: ${l3.size_m2} m² (expected 380)`);
  console.log(`    Type: ${l3.property_type} (expected chalet)`);
  console.log(`    Is new build: ${l3.is_new_build} (expected true)`);
  console.log(`    Features: ${l3.features.join(', ')}`);
  const checks3 = [
    l3.price === 1250000,
    l3.bedrooms === 5,
    l3.size_m2 === 380,
    l3.property_type === 'chalet',
    l3.is_new_build === true,
    l3.features.includes('pool'),
    l3.features.includes('garden'),
    l3.features.includes('sea_view'),
    l3.features.includes('air_conditioning'),
    l3.features.includes('garage'),
  ];
  console.log(`    ${checks3.every(Boolean) ? '✅' : '❌'} All checks: ${checks3.filter(Boolean).length}/${checks3.length}\n`);

  // Summary
  const allChecks = [...checks1, ...checks2, ...checks3];
  console.log(`  Overall: ${allChecks.filter(Boolean).length}/${allChecks.length} checks passed`);
  console.log(`  ${allChecks.every(Boolean) ? '✅ HTML parsing tests PASSED' : '❌ Some checks FAILED'}\n`);
}

// ─── Test 4: Live fetch (optional, requires proxy) ──────────────────────────

async function testLiveFetch() {
  console.log('\n=== TEST 4: Live Search ===\n');

  if (!process.env.SCRAPER_API_KEY) {
    console.log('  ⚠️  SCRAPER_API_KEY not set — skipping live test');
    console.log('  Set SCRAPER_API_KEY to run live tests\n');
    return;
  }

  console.log('  Testing single city search: Marbella, villas, max 1M...\n');

  try {
    const results = await searchIdealista({
      locations: ['marbella'],
      property_type: 'villa',
      price_max: 1000000,
    });

    console.log(`  Results: ${results.length} properties\n`);

    if (results.length > 0) {
      console.log('  Sample listing:');
      const sample = results[0];
      console.log(`    Title: ${sample.title}`);
      console.log(`    Price: €${sample.price}`);
      console.log(`    Bedrooms: ${sample.bedrooms}`);
      console.log(`    Size: ${sample.size_m2} m²`);
      console.log(`    URL: ${sample.url}`);
      console.log(`    Features: ${sample.features.join(', ')}`);
      console.log(`    Agency: ${sample.agency}`);
      console.log(`    Thumbnail: ${sample.thumbnail ? 'YES' : 'NO'}`);
      console.log(`\n  ✅ Live search test PASSED\n`);
    } else {
      console.log('  ⚠️  No results returned — possible blocking or empty search\n');
    }
  } catch (err) {
    console.error(`  ❌ Live search failed: ${err.message}\n`);
  }
}

// ─── Run all tests ──────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Idealista Direct Scraper — Test Suite       ║');
  console.log('╚══════════════════════════════════════════════╝');

  testUrlBuilding();
  testCitySlugMap();
  testHtmlParsing();
  await testLiveFetch();

  console.log('\n═══ All tests complete ═══\n');
}

main().catch(console.error);
