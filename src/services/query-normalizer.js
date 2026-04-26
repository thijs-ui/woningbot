/**
 * query-normalizer.js — Deterministische pre-processing van zoekqueries
 * voor `claude-parser.js`.
 *
 * Doel: laat Claude doen waar hij goed in is (intent + zachte criteria) en
 * de numeriek-parsen NIET door Claude doen. Pre-processed input geeft
 * stabielere resultaten dan vertrouwen op Claude's begrip van € en M-
 * suffixes.
 *
 * Sprint 1 van de verbeterstrategie. Dekt:
 *   - Euro-symbolen + EUR/euro woordvariant
 *   - "X miljoen" / "X mln" / standalone "M" → X*1.000.000
 *   - "X duizend" / "Xk" / "XK" → X*1.000
 *   - Dutch decimal komma (1,5 → 1.5) binnen suffix-matches
 *
 * Bewust NIET:
 *   - Lowercase "m" als miljoen — conflicteert met "m²" voor meter
 *   - Thousand-separator dots (1.500.000) — kost meer dan oplevert
 */

/**
 * Normaliseer een zoekquery. Retourneert nieuwe string + diff voor logging.
 *
 * @param {string} text  Originele user input
 * @returns {{ normalized: string, changed: boolean, replacements: Array<{from: string, to: string}> }}
 */
function normalizeQuery(text) {
  if (!text || typeof text !== 'string') {
    return { normalized: text || '', changed: false, replacements: [] };
  }

  const original = text;
  let s = text;
  const replacements = [];

  // 1. Strip currency symbols + woordvariant
  s = s.replace(/€/g, '');
  s = s.replace(/\bEUR\b/gi, '');
  s = s.replace(/\beuro\b/gi, '');
  s = s.replace(/\beuros\b/gi, '');

  // 2. Million suffixes
  // 2a. "miljoen" / "mln" — case-insensitief, na een getal
  s = s.replace(/(\d+(?:[.,]\d+)?)\s*(?:miljoen|mln)\b/gi, (m, num) => {
    const value = Math.round(parseFloat(num.replace(',', '.')) * 1000000);
    replacements.push({ from: m, to: String(value) });
    return String(value);
  });
  // 2b. Standalone uppercase "M" — niet gevolgd door letter (uitsluiten "Marbella")
  // en niet gevolgd door ² of "2" (uitsluiten "100m²" / "100M2")
  s = s.replace(/(\d+(?:[.,]\d+)?)\s*M(?![a-zA-Z²2])/g, (m, num) => {
    const value = Math.round(parseFloat(num.replace(',', '.')) * 1000000);
    replacements.push({ from: m, to: String(value) });
    return String(value);
  });

  // 3. Thousand suffixes
  // "Xk" / "XK" / "X duizend" — niet gevolgd door letter (uitsluiten "Kennismaking")
  s = s.replace(/(\d+(?:[.,]\d+)?)\s*(?:duizend\b|[kK](?![a-zA-Z]))/g, (m, num) => {
    const value = Math.round(parseFloat(num.replace(',', '.')) * 1000);
    replacements.push({ from: m, to: String(value) });
    return String(value);
  });

  // 4. Cleanup whitespace
  s = s.replace(/\s+/g, ' ').trim();

  return {
    normalized: s,
    changed: s !== original,
    replacements,
  };
}

module.exports = { normalizeQuery };
