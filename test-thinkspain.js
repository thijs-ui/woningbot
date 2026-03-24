/**
 * Test suite for ThinkSpain scraper — unit tests with mock HTML.
 */

const { parseSearchResults, parseTotalResults, buildSearchUrl, resolveCitySlug } = require('./src/services/thinkspain');

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ ${testName}`);
    passed++;
  } else {
    console.log(`  ❌ ${testName}`);
    failed++;
  }
}

// ─── Mock HTML ──────────────────────────────────────────────────────────────

const MOCK_THINKSPAIN_HTML = `
<html>
<body class="property-search template-search-results twc__pagination"
      data-pagination-result-item-selector=".twc__grid-item">
<h1>Property for sale in Marbella</h1>
<div>1,179 found</div>

<div class="twc__grid">
  <div class="row">

    <!-- Listing 1: Full data -->
    <div class="twc__grid-item">
      <div class="twc__property--slider">
        <img data-src="https://cdn.thinkwebcontent.com/property/31184/9554128/photo1.jpg" />
        <div class="details">
          <div class="price-and-location">
            <button class="property__price">€ 298,000</button>
            <a class="property__title" href="/property-for-sale/9554128">Apartment for sale in Marbella</a>
          </div>
          <ul>
            <li>93 m2 Build</li>
            <li>2 Bedrooms</li>
            <li>2 Bathrooms</li>
          </ul>
          <p class="long-description property__description">
            This lovely apartment is located in Nueva Andalucia with pool and garden views.
          </p>
          <div class="property__tags">
            <ul>
              <li>New Build</li>
              <li>Communal Pool</li>
              <li>Sea View</li>
              <li>Parking/Garage</li>
              <li>Air Conditioning</li>
              <li>Lift</li>
              <li>Terrace/Balcony</li>
            </ul>
          </div>
          <a href="tel:+34951120551">+34 951 120 551</a>
          <a href="/property-for-sale/9554128">See More Details</a>
        </div>
      </div>
    </div>

    <!-- Listing 2: Villa with plot -->
    <div class="twc__grid-item">
      <div class="twc__property--slider">
        <img src="https://cdn.thinkwebcontent.com/property/22000/8877665/villa.jpg" />
        <div class="details">
          <div class="price-and-location">
            <button class="property__price">€ 1,250,000</button>
            <a class="property__title" href="/property-for-sale/8877665">Villa for sale in Estepona</a>
          </div>
          <ul>
            <li>350 m2 Build</li>
            <li>500 m2 Plot</li>
            <li>5 Bedrooms</li>
            <li>4 Bathrooms</li>
          </ul>
          <p class="long-description property__description">
            Stunning luxury villa with private pool and panoramic sea views.
          </p>
          <div class="property__tags">
            <ul>
              <li>Private Pool</li>
              <li>Garden</li>
              <li>Sea View</li>
              <li>Mountain Views</li>
              <li>South Orientation</li>
            </ul>
          </div>
          <a href="/property-for-sale/8877665">See More Details</a>
        </div>
      </div>
    </div>

    <!-- Listing 3: No price -->
    <div class="twc__grid-item">
      <div class="twc__property--slider">
        <div class="details">
          <div class="price-and-location">
            <button class="property__price">Price on request</button>
            <a class="property__title" href="/property-for-sale/7766554">Penthouse for sale in Marbella</a>
          </div>
          <ul>
            <li>200 m2 Build</li>
            <li>3 Bedrooms</li>
            <li>3 Bathrooms</li>
          </ul>
          <div class="property__tags">
            <ul>
              <li>Terrace/Balcony</li>
              <li>Fitted Wardrobes</li>
            </ul>
          </div>
          <a href="/property-for-sale/7766554">See More Details</a>
        </div>
      </div>
    </div>

  </div>
</div>
</body>
</html>
`;

// ─── Tests ──────────────────────────────────────────────────────────────────

console.log('\n=== ThinkSpain Scraper Tests ===\n');

// --- URL Building ---
console.log('--- URL Building ---');

const url1 = buildSearchUrl('marbella', { price_min: 200000, price_max: 500000, bedrooms_min: 3 });
assert(url1.includes('/property-for-sale/marbella'), 'URL contains correct path');
assert(url1.includes('minprice=200000'), 'URL contains min price');
assert(url1.includes('maxprice=500000'), 'URL contains max price');
assert(url1.includes('beds=3%2B') || url1.includes('beds=3+'), 'URL contains bedrooms filter');

const url2 = buildSearchUrl('estepona', { features: ['pool', 'sea_view', 'garage'], is_new_build: true });
assert(url2.includes('pool=1'), 'URL contains pool filter');
assert(url2.includes('seaview=1'), 'URL contains sea view filter');
assert(url2.includes('parking=1'), 'URL contains parking filter');
assert(url2.includes('newbuild=1'), 'URL contains new build filter');

const url3 = buildSearchUrl('marbella', {}, 3);
assert(url3.includes('page=3'), 'URL contains page number');

const url4 = buildSearchUrl('marbella', { operation: 'rent' });
assert(url4.includes('/property-to-rent/'), 'Rental URL uses correct path');

// --- City Slug Resolution ---
console.log('\n--- City Slug Resolution ---');

assert(resolveCitySlug('marbella') === 'marbella', 'Marbella slug');
assert(resolveCitySlug('Marbella') === 'marbella', 'Case insensitive');
assert(resolveCitySlug('jávea') === 'javea-xabia', 'Jávea with accent');
assert(resolveCitySlug('orihuela costa') === 'orihuela-costa', 'Orihuela Costa');
assert(resolveCitySlug('málaga') === 'malaga-city', 'Málaga with accent');
assert(resolveCitySlug('valencia') === 'valencia-city', 'Valencia');

// --- HTML Parsing ---
console.log('\n--- HTML Parsing ---');

const listings = parseSearchResults(MOCK_THINKSPAIN_HTML, 'marbella');
assert(listings.length === 3, `Found 3 listings (got ${listings.length})`);

// Listing 1
const l1 = listings[0];
assert(l1.title === 'Apartment for sale in Marbella', `Title: ${l1.title}`);
assert(l1.price === 298000, `Price: ${l1.price}`);
assert(l1.bedrooms === 2, `Bedrooms: ${l1.bedrooms}`);
assert(l1.bathrooms === 2, `Bathrooms: ${l1.bathrooms}`);
assert(l1.size_m2 === 93, `Size: ${l1.size_m2}`);
assert(l1.url.includes('/property-for-sale/9554128'), `URL: ${l1.url}`);
assert(l1.id === 'ts_9554128', `ID: ${l1.id}`);
assert(l1.source === 'thinkspain', `Source: ${l1.source}`);
assert(l1.thumbnail && l1.thumbnail.includes('photo1.jpg'), `Thumbnail: ${l1.thumbnail}`);
assert(l1.is_new_build === true, `New build: ${l1.is_new_build}`);
assert(l1.property_type === 'flat', `Property type: ${l1.property_type}`);
assert(l1.agent_phone === '+34 951 120 551', `Phone: ${l1.agent_phone}`);

// Features
assert(l1.features.includes('pool'), 'Has pool feature');
assert(l1.features.includes('sea_view'), 'Has sea_view feature');
assert(l1.features.includes('garage'), 'Has garage feature');
assert(l1.features.includes('air_conditioning'), 'Has air_conditioning feature');
assert(l1.features.includes('elevator'), 'Has elevator feature');
assert(l1.features.includes('terrace'), 'Has terrace feature');

// Listing 2 (Villa)
const l2 = listings[1];
assert(l2.price === 1250000, `Villa price: ${l2.price}`);
assert(l2.bedrooms === 5, `Villa bedrooms: ${l2.bedrooms}`);
assert(l2.size_m2 === 350, `Villa size: ${l2.size_m2}`);
assert(l2.plot_m2 === 500, `Villa plot: ${l2.plot_m2}`);
assert(l2.property_type === 'villa', `Villa type: ${l2.property_type}`);
assert(l2.features.includes('pool'), 'Villa has pool');
assert(l2.features.includes('garden'), 'Villa has garden');
assert(l2.features.includes('mountain_view'), 'Villa has mountain_view');
assert(l2.features.includes('south_facing'), 'Villa has south_facing');

// Listing 3 (No price)
const l3 = listings[2];
assert(l3.price === null, `No price: ${l3.price}`);
assert(l3.property_type === 'penthouse', `Penthouse type: ${l3.property_type}`);
assert(l3.features.includes('terrace'), 'Penthouse has terrace');
assert(l3.features.includes('fitted_wardrobes'), 'Penthouse has fitted_wardrobes');

// --- Total Results Parsing ---
console.log('\n--- Total Results ---');

const { total, maxPages } = parseTotalResults(MOCK_THINKSPAIN_HTML);
assert(total === 1179, `Total: ${total}`);
assert(maxPages > 1, `Max pages > 1: ${maxPages}`);

// --- Price per m² ---
console.log('\n--- Price per m² ---');
assert(l1.price_per_m2 === Math.round(298000 / 93), `Price/m²: ${l1.price_per_m2}`);
assert(l2.price_per_m2 === Math.round(1250000 / 350), `Villa price/m²: ${l2.price_per_m2}`);

// --- Summary ---
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
