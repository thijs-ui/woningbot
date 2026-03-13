/**
 * Fotocasa scraper module (placeholder for future integration).
 *
 * Available Apify actors for Fotocasa are URL-based (require full search URLs)
 * and have 0 reviews / low reliability. Building with Idealista only for now.
 *
 * To integrate Fotocasa later:
 * 1. Pick a reliable actor (e.g. stealth_mode/fotocasa-property-search-scraper)
 * 2. Implement buildFotocasaUrl(hardFilters) to construct search URLs
 *    Pattern: https://www.fotocasa.es/es/comprar/viviendas/{location}/todas-las-zonas/l
 * 3. Call the Apify actor with that URL
 * 4. Normalize results to match the same format as Idealista
 * 5. The handler already calls searchFotocasa in parallel — it will just work.
 */

async function searchFotocasa(hardFilters) {
  console.log('[Fotocasa] Not yet implemented. Returning empty results.');
  return [];
}

module.exports = { searchFotocasa };
