/**
 * Quick sanity-test voor query-normalizer.js.
 * Run: node test-normalizer.js
 */
const { normalizeQuery } = require('./src/services/query-normalizer');

const cases = [
  // [input, expected (substring of normalized)]
  ['Villa Marbella, 4 slpk, zwembad, 1M+',                  '1000000+'],
  ['appartement Marbella, €1M tot €2M',                      '1000000 tot 2000000'],
  ['tussen €600k en €800k',                                  'tussen 600000 en 800000'],
  ['1,5 miljoen',                                            '1500000'],
  ['vanaf 350k',                                             'vanaf 350000'],
  ['max €450K',                                              'max 450000'],
  ['€1.2M-€1.5M',                                            '1200000-1500000'],
  ['EUR 600000',                                             '600000'],
  ['rond 500 duizend euro',                                  '500000'],
  // Edge cases — must NOT break
  ['villa met 100m² woonoppervlak',                          '100m²'],
  ['appartement Marbella, 3 slpk',                           '3 slpk'],
  ['Kennismaking met 2K budget',                             '2000'],  // 2K still parsed (no letter after)
  ['tussen 600k-800k 3 slaapkamers',                         '600000-800000 3 slaapkamers'],
  ['villa 1mln in Estepona',                                 '1000000'],
];

let pass = 0, fail = 0;
for (const [input, expectedSubstring] of cases) {
  const { normalized, changed, replacements } = normalizeQuery(input);
  const ok = normalized.includes(expectedSubstring);
  if (ok) {
    pass++;
    console.log(`✓ "${input}"\n  → "${normalized}"`);
  } else {
    fail++;
    console.log(`✗ "${input}"\n  → got: "${normalized}"\n  → expected substring: "${expectedSubstring}"`);
  }
  if (replacements.length > 0) {
    console.log(`  replacements: ${replacements.map(r => `"${r.from}" → "${r.to}"`).join(', ')}`);
  }
  console.log();
}

console.log(`\n${pass}/${pass + fail} cases passed.`);
process.exit(fail === 0 ? 0 : 1);
