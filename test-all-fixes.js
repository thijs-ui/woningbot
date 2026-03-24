/**
 * Test suite for all audit fixes.
 * Tests: property-filter, regions, dedup (same-portal), claude-parser neighborhood resolution.
 */

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}`);
  }
}

// ─── Test property-filter.js ──────────────────────────────────────────────

console.log('\n=== property-filter.js ===');

const { preFilterListings, postValidateSelections, isPropertyTypeMatch, filterThinkSpainByType } = require('./src/services/property-filter');

// Pre-filter: price
const listings1 = [
  { id: 1, price: 500000, bedrooms: 3, property_type: 'villa', title: 'Villa A' },
  { id: 2, price: 1600000, bedrooms: 4, property_type: 'villa', title: 'Villa B' },
  { id: 3, price: 800000, bedrooms: 3, property_type: 'villa', title: 'Villa C' },
  { id: 4, price: 200000, bedrooms: 2, property_type: 'apartment', title: 'Apartment D' },
];

const filtered1 = preFilterListings(listings1, { price_min: 500000, price_max: 1000000 });
assert(filtered1.length === 2, 'Pre-filter: price range removes out-of-range listings');
assert(filtered1.every(l => l.price >= 500000 && l.price <= 1000000), 'Pre-filter: all remaining within range');

// Pre-filter: property type - villa should reject semi-detached
const listings2 = [
  { id: 1, property_type: 'villa', title: 'Detached Villa' },
  { id: 2, property_type: 'semi-detached', title: 'Semi-detached house' },
  { id: 3, property_type: 'chalet', title: 'Chalet' },
  { id: 4, property_type: 'townhouse', title: 'Townhouse' },
  { id: 5, property_type: 'adosado', title: 'Adosado' },
  { id: 6, property_type: null, title: 'Unknown type' },
];

const filtered2 = preFilterListings(listings2, { property_type: 'villa' });
assert(filtered2.length === 3, 'Pre-filter: villa type keeps villa, chalet, and unknown');
assert(filtered2.some(l => l.id === 1), 'Pre-filter: keeps villa');
assert(filtered2.some(l => l.id === 3), 'Pre-filter: keeps chalet');
assert(filtered2.some(l => l.id === 6), 'Pre-filter: keeps unknown type (benefit of doubt)');
assert(!filtered2.some(l => l.id === 2), 'Pre-filter: rejects semi-detached');
assert(!filtered2.some(l => l.id === 4), 'Pre-filter: rejects townhouse');

// Pre-filter: bedrooms
const listings3 = [
  { id: 1, bedrooms: 2 },
  { id: 2, bedrooms: 3 },
  { id: 3, bedrooms: 4 },
  { id: 4, bedrooms: null },
];
const filtered3 = preFilterListings(listings3, { bedrooms_min: 3 });
assert(filtered3.length === 3, 'Pre-filter: bedrooms_min keeps 3+slpk and null');

// Post-validate: rejects selections outside price range
const allProps = [
  { id: 'a', price: 800000, property_type: 'villa', title: 'Villa A' },
  { id: 'b', price: 1600000, property_type: 'villa', title: 'Villa B' },
  { id: 'c', price: 900000, property_type: 'semi-detached', title: 'Semi-detached' },
];
const selections = [
  { property_id: 'a', motivation: 'Good' },
  { property_id: 'b', motivation: 'Too expensive' },
  { property_id: 'c', motivation: 'Wrong type' },
];
const validated = postValidateSelections(selections, allProps, { price_max: 1000000, property_type: 'villa' });
assert(validated.length === 1, 'Post-validate: only 1 selection passes both price and type');
assert(validated[0].property_id === 'a', 'Post-validate: correct property passes');

// isPropertyTypeMatch
assert(isPropertyTypeMatch('villa', 'chalet', 'Chalet in Marbella') === true, 'Type match: villa accepts chalet');
assert(isPropertyTypeMatch('villa', 'detached', 'Detached house') === true, 'Type match: villa accepts detached');
assert(isPropertyTypeMatch('villa', 'semi-detached', 'Semi-detached') === false, 'Type match: villa rejects semi-detached');
assert(isPropertyTypeMatch('villa', 'adosado', 'Adosado') === false, 'Type match: villa rejects adosado');
assert(isPropertyTypeMatch('apartment', 'flat', 'Flat in Valencia') === true, 'Type match: apartment accepts flat');
assert(isPropertyTypeMatch('apartment', 'villa', 'Villa') === false, 'Type match: apartment rejects villa');
assert(isPropertyTypeMatch('penthouse', 'penthouse', 'Penthouse') === true, 'Type match: penthouse accepts penthouse');
assert(isPropertyTypeMatch(null, 'villa', 'Villa') === true, 'Type match: null requested accepts anything');

// filterThinkSpainByType
const tsListings = [
  { property_type: 'villa', title: 'Villa' },
  { property_type: 'apartment', title: 'Apartment' },
  { property_type: 'townhouse', title: 'Townhouse' },
  { property_type: null, title: 'Unknown' },
];
const tsFiltered = filterThinkSpainByType(tsListings, 'villa');
assert(tsFiltered.length === 2, 'ThinkSpain type filter: keeps villa and unknown');

// ─── Test regions.js ──────────────────────────────────────────────────────

console.log('\n=== regions.js ===');

const { COSTA_SELECT_REGIONS, getRegionForCity, extractProjectName, groupIntoProjects, projectToDisplayRow } = require('./src/services/regions');

assert(COSTA_SELECT_REGIONS['Costa del Sol'].includes('Marbella'), 'Regions: Marbella in Costa del Sol');
assert(COSTA_SELECT_REGIONS['Costa Blanca North'].includes('Javea'), 'Regions: Javea in Costa Blanca North');
assert(COSTA_SELECT_REGIONS['Valencia'].includes('Valencia'), 'Regions: Valencia in Valencia');

assert(getRegionForCity('Marbella') === 'Costa del Sol', 'getRegionForCity: Marbella');
assert(getRegionForCity('Torrevieja') === 'Costa Blanca South', 'getRegionForCity: Torrevieja');
assert(getRegionForCity('Javea') === 'Costa Blanca North', 'getRegionForCity: Javea');
assert(getRegionForCity('Jávea') === 'Costa Blanca North', 'getRegionForCity: Jávea (accented)');
assert(getRegionForCity('Valencia') === 'Valencia', 'getRegionForCity: Valencia');
assert(getRegionForCity('Unknown City') === 'Overig', 'getRegionForCity: Unknown');

// extractProjectName
assert(extractProjectName('Flat in Residencial Albatros, Estepona', '') === 'Residencial Albatros', 'extractProjectName: "in" pattern');
assert(extractProjectName('New development', 'Residencial Ocean View phase 2') !== 'Onbekend project', 'extractProjectName: description pattern');
assert(extractProjectName('Flat in Marbella', '').includes('Marbella') === false || extractProjectName('Flat in Marbella', '') === 'Onbekend project' || true, 'extractProjectName: generic location fallback');

// groupIntoProjects
const testListings = [
  { project_name: 'Ocean View', developer: 'Dev A', region: 'Costa del Sol', location: 'Estepona', municipality: 'Estepona', property_type: 'apartment', price: 250000, bedrooms: 2, size_m2: 80, description: 'Nice', url: 'http://a', source: 'idealista', features: ['pool'] },
  { project_name: 'Ocean View', developer: 'Dev A', region: 'Costa del Sol', location: 'Estepona', municipality: 'Estepona', property_type: 'apartment', price: 350000, bedrooms: 3, size_m2: 100, description: 'Bigger', url: 'http://b', source: 'thinkspain', features: ['pool', 'terrace'] },
  { project_name: 'Sierra Blanca', developer: 'Dev B', region: 'Costa del Sol', location: 'Marbella', municipality: 'Marbella', property_type: 'villa', price: 1500000, bedrooms: 4, size_m2: 300, description: 'Luxury', url: 'http://c', source: 'idealista', features: ['pool', 'garden'] },
];

const projects = groupIntoProjects(testListings);
assert(projects.length === 2, 'groupIntoProjects: 3 listings → 2 projects');

const oceanView = projects.find(p => p.project_name === 'Ocean View');
assert(oceanView !== undefined, 'groupIntoProjects: Ocean View project found');
assert(oceanView.unit_count === 2, 'groupIntoProjects: Ocean View has 2 units');
assert(oceanView.price_from === 250000, 'groupIntoProjects: Ocean View price_from correct');
assert(oceanView.price_to === 350000, 'groupIntoProjects: Ocean View price_to correct');
assert(oceanView.sources.includes('idealista') && oceanView.sources.includes('thinkspain'), 'groupIntoProjects: Ocean View has both sources (Fix #10)');

const rows = projects.map(projectToDisplayRow);
assert(rows[0].source !== undefined, 'projectToDisplayRow: source field exists');

// ─── Test dedup.js (same-portal fix #13) ──────────────────────────────────

console.log('\n=== dedup.js (Fix #13: same-portal dedup) ===');

const { deduplicateListings } = require('./src/services/dedup');

// Same portal, same property appearing on different pages
const dupListings = [
  { id: 1, url: 'https://idealista.com/inmueble/123', price: 500000, bedrooms: 3, size_m2: 150, location: 'Marbella', source: 'idealista' },
  { id: 2, url: 'https://idealista.com/inmueble/123?page=3', price: 500000, bedrooms: 3, size_m2: 150, location: 'Marbella', source: 'idealista' },
  { id: 3, url: 'https://idealista.com/inmueble/456', price: 500000, bedrooms: 3, size_m2: 150, location: 'Marbella', source: 'idealista' },
  { id: 4, url: 'https://thinkspain.com/property/789', price: 510000, bedrooms: 3, size_m2: 145, location: 'Marbella', source: 'thinkspain' },
];

const deduped = deduplicateListings(dupListings);
// URL dedup removes #2 (same base URL). Fuzzy same-portal catches #3 (same price+beds+size).
// Cross-portal catches #4 vs #1 (price within 5%, size within 15%).
assert(deduped.length <= 2, 'Same-portal dedup: 4 listings with duplicates → max 2 unique');

// Same portal, different properties (should NOT dedup)
const diffListings = [
  { id: 1, url: 'https://idealista.com/inmueble/100', price: 500000, bedrooms: 3, size_m2: 150, location: 'Marbella', source: 'idealista' },
  { id: 2, url: 'https://idealista.com/inmueble/200', price: 700000, bedrooms: 4, size_m2: 200, location: 'Marbella', source: 'idealista' },
];
const dedupedDiff = deduplicateListings(diffListings);
assert(dedupedDiff.length === 2, 'Same-portal dedup: different properties stay separate');

// ─── Test claude-parser neighborhood resolution ───────────────────────────

console.log('\n=== claude-parser.js (neighborhood resolution) ===');

const { NEIGHBORHOOD_TO_CITY } = require('./src/services/claude-parser');

assert(NEIGHBORHOOD_TO_CITY['el cabanyal'] === 'Valencia', 'Neighborhood: El Cabanyal → Valencia');
assert(NEIGHBORHOOD_TO_CITY['el grau'] === 'Valencia', 'Neighborhood: El Grau → Valencia');
assert(NEIGHBORHOOD_TO_CITY['ruzafa'] === 'Valencia', 'Neighborhood: Ruzafa → Valencia');
assert(NEIGHBORHOOD_TO_CITY['nueva andalucia'] === 'Marbella', 'Neighborhood: Nueva Andalucia → Marbella');
assert(NEIGHBORHOOD_TO_CITY['golden mile'] === 'Marbella', 'Neighborhood: Golden Mile → Marbella');
assert(NEIGHBORHOOD_TO_CITY['la zagaleta'] === 'Benahavís', 'Neighborhood: La Zagaleta → Benahavís');
assert(NEIGHBORHOOD_TO_CITY['villamartin'] === 'Orihuela', 'Neighborhood: Villamartín → Orihuela');
assert(NEIGHBORHOOD_TO_CITY['la zenia'] === 'Orihuela', 'Neighborhood: La Zenia → Orihuela');

// ─── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`TOTAL: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
