/**
 * freshness.js — Snelle dead-link check op de top-10 selectie.
 *
 * Sprint 1 van de verbeterstrategie. Sub-set van punt 1.8: in plaats van
 * elke Supabase-property te verifiëren (kost veel HEAD-requests), checken
 * we alleen de geselecteerde top-10. Dat is laag-volume genoeg om bij
 * elke query te kunnen runnen.
 *
 * Idealista listings worden niet gecheckt — die zijn live gescraped en dus
 * vers per definitie. Alleen Supabase-properties (eigen DB, scraped_at
 * mogelijk weken oud) krijgen de behandeling.
 *
 * Returnt de filtered array + count gefilterd, voor logging.
 */

const TIMEOUT_MS = 5000;

/**
 * Doet een HEAD request en returnt true als de URL nog leeft (2xx of 3xx).
 * 4xx/5xx of network-fouten = dood.
 */
async function isAlive(url) {
  if (!url || typeof url !== 'string') return true; // Geen URL = niets om te checken

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Sommige portals weigeren bots zonder UA
        'User-Agent': 'Mozilla/5.0 (compatible; CostaSelectBot/1.0)',
      },
    });
    return res.ok || (res.status >= 300 && res.status < 400);
  } catch {
    // Network error of timeout — als HEAD-issue, niet meteen kapot verklaren
    // Want sommige sites blokkeren HEAD specifiek; dan is GET nog mogelijk.
    // Voor nu: bij twijfel laten staan (false positives wegen zwaarder
    // dan af en toe een dode link doorlaten).
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Filter de selecties op leefbare URLs.
 * Alleen Supabase-source krijgt verificatie; idealista is altijd vers.
 *
 * @param {Array} selections - mapSelections output
 * @returns {Promise<{ kept: Array, removed: number, deadUrls: string[] }>}
 */
async function verifyFreshness(selections) {
  const checks = selections.map(async (sel) => {
    const needsCheck = sel.source === 'supabase' && sel.url;
    if (!needsCheck) return { sel, alive: true };
    const alive = await isAlive(sel.url);
    return { sel, alive };
  });

  const results = await Promise.all(checks);
  const kept = results.filter(r => r.alive).map(r => r.sel);
  const dead = results.filter(r => !r.alive);

  if (dead.length > 0) {
    console.warn(`[Freshness] Removed ${dead.length} dead listings:`, dead.map(r => r.sel.url));
  }

  return {
    kept,
    removed: dead.length,
    deadUrls: dead.map(r => r.sel.url),
  };
}

module.exports = { verifyFreshness, isAlive };
