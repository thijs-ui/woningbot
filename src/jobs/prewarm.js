/**
 * prewarm.js — Dagelijkse listing-cache voor de top-locaties.
 *
 * Sprint 2 van de verbeterstrategie. Scrape elke nacht Idealista voor
 * 20 populaire steden zonder filters, stop de raw listings in Redis
 * onder `wb:warm:{city}` met 24u TTL.
 *
 * `handleNewSearch` checkt deze cache vóór een live Apify-call en
 * gebruikt warme data waar beschikbaar. Filters (prijs, slpk etc.)
 * worden daarna in-memory toegepast door `preFilterListings`.
 *
 * Cost-saving:
 *   - 20 steden × 1 scrape/dag = 20 Apify-calls/dag (≈ $6/dag)
 *   - Gebruikersqueries voor deze steden kosten 0 Apify-calls (24u-window)
 *
 * Schedule: 04:00 UTC = 05:00 CET = 06:00 CEST. Voor het ochtend-werkverkeer.
 */

const { searchIdealista } = require('../services/idealista-direct');
const { setWarmListings } = require('../services/query-cache');

// Top-20 locaties zoals door Costa Select aangegeven (april 2026).
// Mix van Costa del Sol, Costa Blanca North, Valencia.
const PREWARM_LOCATIONS = [
  // Costa del Sol
  'Marbella', 'Estepona', 'Mijas', 'Fuengirola', 'Málaga',
  'Nerja', 'Manilva', 'Casares', 'Sotogrande',
  // Costa Blanca North
  'Jávea', 'Moraira', 'Altea', 'Benissa', 'Benitachell',
  'Jalón', 'Alcalalí', 'Dénia', 'Calpe',
  // Valencia / Costa Blanca
  'Valencia', 'Alicante',
];

/**
 * Scrape one city and store the raw listings in Redis.
 * Returns { city, count, error?: string, ms }.
 */
async function prewarmCity(city) {
  const start = Date.now();
  try {
    const listings = await searchIdealista({ locations: [city] });
    if (!Array.isArray(listings)) {
      return { city, count: 0, error: 'Niet-array response', ms: Date.now() - start };
    }
    await setWarmListings(city, listings);
    return { city, count: listings.length, ms: Date.now() - start };
  } catch (err) {
    return { city, count: 0, error: err.message || String(err), ms: Date.now() - start };
  }
}

/**
 * Run the prewarm voor alle locaties. Sequentieel om Apify rate-limits
 * te respecteren (parallel zou ~20 simultane Apify-runs starten).
 */
async function runPrewarm() {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [Prewarm] Starting daily prewarm for ${PREWARM_LOCATIONS.length} locations`);

  const results = [];
  for (const city of PREWARM_LOCATIONS) {
    const result = await prewarmCity(city);
    results.push(result);
    if (result.error) {
      console.warn(`[Prewarm] ${city}: FAIL — ${result.error} (${result.ms}ms)`);
    } else {
      console.log(`[Prewarm] ${city}: ${result.count} listings (${result.ms}ms)`);
    }
  }

  const total = results.reduce((s, r) => s + r.count, 0);
  const failed = results.filter(r => r.error).length;
  const durationS = Math.round(results.reduce((s, r) => s + r.ms, 0) / 1000);

  console.log(`[${ts}] [Prewarm] Done — ${total} listings cached, ${failed} cities failed, ${durationS}s total`);
  return { total, failed, durationS, results };
}

module.exports = { runPrewarm, prewarmCity, PREWARM_LOCATIONS };

// CLI: `node src/jobs/prewarm.js` voor handmatige run
if (require.main === module) {
  require('dotenv').config();
  runPrewarm().then(({ total, failed }) => {
    process.exit(failed > 0 ? 1 : 0);
  }).catch(err => {
    console.error('[Prewarm] Fatal:', err);
    process.exit(2);
  });
}
