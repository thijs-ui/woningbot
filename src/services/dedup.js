/**
 * Deduplication logic — URL-only.
 * Only removes exact duplicate URLs from the same portal.
 * No cross-portal matching (unreliable without addresses in Spain).
 */

function deduplicateListings(listings) {
  const seen = new Set();
  const unique = [];

  for (const listing of listings) {
    // Normalize URL: strip trailing slashes, query params, protocol
    const rawUrl = (listing.url || '').trim();
    const normalizedUrl = rawUrl
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '')
      .split('?')[0]
      .toLowerCase();

    // Skip if no URL or already seen
    if (!normalizedUrl || seen.has(normalizedUrl)) continue;

    seen.add(normalizedUrl);
    unique.push({ ...listing });
  }

  console.log(`[Dedup] ${listings.length} → ${unique.length} unique (URL-only)`);
  return unique;
}

module.exports = { deduplicateListings };
