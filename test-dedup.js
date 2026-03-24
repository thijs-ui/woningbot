/**
 * Test suite for improved deduplication service.
 */

const { deduplicateListings } = require('./src/services/dedup');

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

console.log('\n=== Dedup Tests ===\n');

// --- Test 1: Exact URL dedup ---
console.log('--- Exact URL Dedup ---');
{
  const listings = [
    { id: '1', source: 'idealista', url: 'https://www.idealista.com/inmueble/12345/', price: 300000, bedrooms: 3, size_m2: 100, location: 'marbella' },
    { id: '2', source: 'idealista', url: 'https://www.idealista.com/inmueble/12345', price: 300000, bedrooms: 3, size_m2: 100, location: 'marbella' },
    { id: '3', source: 'idealista', url: 'https://www.idealista.com/inmueble/99999/', price: 500000, bedrooms: 4, size_m2: 200, location: 'marbella' },
  ];
  const result = deduplicateListings(listings);
  assert(result.length === 2, `Exact URL dedup: ${result.length} (expected 2)`);
}

// --- Test 2: Cross-portal fuzzy match ---
console.log('\n--- Cross-Portal Fuzzy Match ---');
{
  const listings = [
    {
      id: 'idealista_12345', source: 'idealista',
      url: 'https://www.idealista.com/inmueble/12345/',
      price: 298000, bedrooms: 2, size_m2: 93, location: 'marbella',
      features: ['pool', 'sea_view'], description: 'Nice apartment in Marbella',
      thumbnail: 'https://img.idealista.com/photo1.jpg',
      images: ['photo1.jpg', 'photo2.jpg'],
    },
    {
      id: 'ts_9554128', source: 'thinkspain',
      url: 'https://www.thinkspain.com/property-for-sale/9554128',
      price: 298000, bedrooms: 2, size_m2: 93, location: 'marbella',
      features: ['pool', 'sea_view', 'terrace'], description: 'Lovely apartment in Nueva Andalucia',
      thumbnail: 'https://cdn.thinkwebcontent.com/photo1.jpg',
      images: ['photo1.jpg'],
    },
  ];
  const result = deduplicateListings(listings);
  assert(result.length === 1, `Cross-portal dedup: ${result.length} (expected 1)`);
  assert(result[0].also_on && result[0].also_on.length > 0, 'Has also_on reference');
  assert(result[0].features.includes('terrace'), 'Merged features from both portals');
}

// --- Test 3: Price within 5% tolerance ---
console.log('\n--- Price Tolerance ---');
{
  const listings = [
    { id: '1', source: 'idealista', url: 'https://idealista.com/1', price: 300000, bedrooms: 3, size_m2: 120, location: 'estepona' },
    { id: '2', source: 'thinkspain', url: 'https://thinkspain.com/1', price: 310000, bedrooms: 3, size_m2: 120, location: 'estepona' },
  ];
  const result = deduplicateListings(listings);
  assert(result.length === 1, `5% price tolerance match: ${result.length} (expected 1)`);
}

// --- Test 4: Price beyond 5% → no match ---
console.log('\n--- Price Beyond Tolerance ---');
{
  const listings = [
    { id: '1', source: 'idealista', url: 'https://idealista.com/1', price: 300000, bedrooms: 3, size_m2: 120, location: 'estepona' },
    { id: '2', source: 'thinkspain', url: 'https://thinkspain.com/1', price: 350000, bedrooms: 3, size_m2: 120, location: 'estepona' },
  ];
  const result = deduplicateListings(listings);
  assert(result.length === 2, `Beyond tolerance: ${result.length} (expected 2)`);
}

// --- Test 5: Different bedrooms → no match ---
console.log('\n--- Different Bedrooms ---');
{
  const listings = [
    { id: '1', source: 'idealista', url: 'https://idealista.com/1', price: 300000, bedrooms: 2, size_m2: 100, location: 'marbella' },
    { id: '2', source: 'thinkspain', url: 'https://thinkspain.com/1', price: 300000, bedrooms: 3, size_m2: 100, location: 'marbella' },
  ];
  const result = deduplicateListings(listings);
  assert(result.length === 2, `Different bedrooms: ${result.length} (expected 2)`);
}

// --- Test 6: Different cities → no match ---
console.log('\n--- Different Cities ---');
{
  const listings = [
    { id: '1', source: 'idealista', url: 'https://idealista.com/1', price: 300000, bedrooms: 3, size_m2: 120, location: 'marbella' },
    { id: '2', source: 'thinkspain', url: 'https://thinkspain.com/1', price: 300000, bedrooms: 3, size_m2: 120, location: 'estepona' },
  ];
  const result = deduplicateListings(listings);
  assert(result.length === 2, `Different cities: ${result.length} (expected 2)`);
}

// --- Test 7: Same portal → fuzzy match when all 3 fields match exactly (Fix #13) ---
console.log('\n--- Same Portal Fuzzy (Fix #13) ---');
{
  const listings = [
    { id: '1', source: 'idealista', url: 'https://idealista.com/1', price: 300000, bedrooms: 3, size_m2: 120, location: 'marbella' },
    { id: '2', source: 'idealista', url: 'https://idealista.com/2', price: 300000, bedrooms: 3, size_m2: 120, location: 'marbella' },
  ];
  const result = deduplicateListings(listings);
  assert(result.length === 1, `Same portal fuzzy dedup: ${result.length} (expected 1 — Fix #13)`);
}

// --- Test 8: Insufficient data → no match ---
console.log('\n--- Insufficient Data ---');
{
  const listings = [
    { id: '1', source: 'idealista', url: 'https://idealista.com/1', price: 300000, bedrooms: null, size_m2: null, location: 'marbella' },
    { id: '2', source: 'thinkspain', url: 'https://thinkspain.com/1', price: 300000, bedrooms: null, size_m2: null, location: 'marbella' },
  ];
  const result = deduplicateListings(listings);
  assert(result.length === 2, `Insufficient data: ${result.length} (expected 2)`);
}

// --- Test 9: Best listing selection ---
console.log('\n--- Best Listing Selection ---');
{
  const listings = [
    {
      id: '1', source: 'thinkspain', url: 'https://thinkspain.com/1',
      price: 300000, bedrooms: 3, size_m2: 120, location: 'marbella',
      features: ['pool'], description: 'Short', thumbnail: null,
      images: [], latitude: null, longitude: null,
    },
    {
      id: '2', source: 'idealista', url: 'https://idealista.com/1',
      price: 298000, bedrooms: 3, size_m2: 118, location: 'marbella',
      features: ['pool', 'garden', 'terrace'], description: 'A much longer and more detailed description of this property',
      thumbnail: 'https://img.idealista.com/photo.jpg',
      images: ['photo1.jpg', 'photo2.jpg', 'photo3.jpg'],
      latitude: 36.5, longitude: -4.9,
    },
  ];
  const result = deduplicateListings(listings);
  assert(result.length === 1, `Best selection: ${result.length}`);
  assert(result[0].source === 'idealista', `Best is idealista (more data): ${result[0].source}`);
  assert(result[0].also_on.includes('thinkspain'), 'References thinkspain');
}

// --- Test 10: Size within 15% tolerance ---
console.log('\n--- Size Tolerance ---');
{
  const listings = [
    { id: '1', source: 'idealista', url: 'https://idealista.com/1', price: 300000, bedrooms: 3, size_m2: 100, location: 'marbella' },
    { id: '2', source: 'thinkspain', url: 'https://thinkspain.com/1', price: 300000, bedrooms: 3, size_m2: 110, location: 'marbella' },
  ];
  const result = deduplicateListings(listings);
  assert(result.length === 1, `Size 10% tolerance: ${result.length} (expected 1)`);
}

// --- Test 11: Large batch with mixed portals ---
console.log('\n--- Large Mixed Batch ---');
{
  const listings = [];
  // 20 unique Idealista listings
  for (let i = 0; i < 20; i++) {
    listings.push({
      id: `idealista_${i}`, source: 'idealista',
      url: `https://idealista.com/${i}`,
      price: 200000 + i * 50000, bedrooms: 2 + (i % 3), size_m2: 80 + i * 10,
      location: 'marbella', features: [],
    });
  }
  // 15 ThinkSpain listings, 5 of which are duplicates of Idealista
  for (let i = 0; i < 15; i++) {
    const isDup = i < 5;
    listings.push({
      id: `ts_${i}`, source: 'thinkspain',
      url: `https://thinkspain.com/${i}`,
      price: isDup ? (200000 + i * 50000) : (700000 + i * 30000),
      bedrooms: isDup ? (2 + (i % 3)) : (1 + (i % 4)),
      size_m2: isDup ? (80 + i * 10) : (60 + i * 15),
      location: 'marbella', features: [],
    });
  }
  const result = deduplicateListings(listings);
  // 5 intentional dupes + 4 accidental fuzzy matches from synthetic data = 9 deduped
  assert(result.length >= 25 && result.length <= 31, `Large batch: ${result.length} (expected 26-30, got deduped)`);
  assert(result.length < listings.length, `Fewer than input: ${result.length} < ${listings.length}`);
}

// --- Test 12: Accented city names match ---
console.log('\n--- Accented City Names ---');
{
  const listings = [
    { id: '1', source: 'idealista', url: 'https://idealista.com/1', price: 300000, bedrooms: 3, size_m2: 120, location: 'Málaga' },
    { id: '2', source: 'thinkspain', url: 'https://thinkspain.com/1', price: 300000, bedrooms: 3, size_m2: 120, location: 'malaga' },
  ];
  const result = deduplicateListings(listings);
  assert(result.length === 1, `Accented city match: ${result.length} (expected 1)`);
}

// --- Test 13: Empty input ---
console.log('\n--- Edge Cases ---');
{
  assert(deduplicateListings([]).length === 0, 'Empty array');
  assert(deduplicateListings(null).length === 0, 'Null input');
}

// --- Summary ---
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
