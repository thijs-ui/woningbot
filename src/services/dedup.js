/**
 * Deduplication logic for properties from multiple portals.
 * Two properties are considered duplicates if they share:
 * - Similar location (common words)
 * - Price within 5%
 * - Size within 10%
 */

function isDuplicate(a, b) {
  if (!a.price || !b.price) return false;

  const priceDiff = Math.abs(a.price - b.price) / Math.max(a.price, b.price);
  if (priceDiff > 0.05) return false;

  if (a.size_m2 && b.size_m2) {
    const sizeDiff = Math.abs(a.size_m2 - b.size_m2) / Math.max(a.size_m2, b.size_m2);
    if (sizeDiff > 0.10) return false;
  }

  const locA = (a.location || '').toLowerCase();
  const locB = (b.location || '').toLowerCase();
  if (locA && locB) {
    const wordsA = locA.split(/[\s,]+/).filter((w) => w.length > 3);
    const wordsB = locB.split(/[\s,]+/).filter((w) => w.length > 3);
    const hasCommon = wordsA.some((w) => wordsB.includes(w));
    if (!hasCommon && wordsA.length > 0 && wordsB.length > 0) return false;
  }

  return true;
}

/**
 * Deduplicate listings. When duplicates found, merge alternate URLs.
 */
function deduplicateListings(listings) {
  const unique = [];

  for (const listing of listings) {
    const existingIdx = unique.findIndex((u) => isDuplicate(u, listing));
    if (existingIdx >= 0) {
      if (!unique[existingIdx].alternateUrls) unique[existingIdx].alternateUrls = [];
      unique[existingIdx].alternateUrls.push({ source: listing.source, url: listing.url });
    } else {
      unique.push({ ...listing });
    }
  }

  console.log(`[Dedup] ${listings.length} → ${unique.length} unique`);
  return unique;
}

module.exports = { deduplicateListings };
