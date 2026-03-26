/**
 * dedup.js — Cross-portal deduplication with fuzzy matching.
 *
 * Spanish property portals rarely provide exact addresses. The same property
 * often appears on Idealista and ThinkSpain with different titles, slightly
 * different prices, and no shared ID.
 *
 * Strategy:
 *   1. Exact URL dedup (same portal, same listing)
 *   2. Cross-portal fuzzy match: price + size + bedrooms + city
 *      → If price within 5%, size within 10%, same beds, same city → likely duplicate
 *   3. When duplicates found, keep the listing with the most data (features, images, description)
 */

/**
 * Deduplicate listings from multiple portals.
 *
 * @param {Array} listings - All listings from all portals combined
 * @returns {Array} Deduplicated listings, best version of each property kept
 */
function deduplicateListings(listings) {
  if (!listings || listings.length === 0) return [];

  // Phase 1: Exact URL dedup
  const urlDeduped = deduplicateByUrl(listings);

  // Phase 2: Cross-portal fuzzy dedup
  const fuzzyDeduped = deduplicateFuzzy(urlDeduped);

  console.log(`[Dedup] ${listings.length} → ${urlDeduped.length} (URL) → ${fuzzyDeduped.length} (fuzzy)`);
  return fuzzyDeduped;
}

/**
 * Phase 1: Remove exact URL duplicates (same portal, same listing).
 */
function deduplicateByUrl(listings) {
  const seen = new Set();
  const unique = [];

  for (const listing of listings) {
    const rawUrl = (listing.url || '').trim();
    const normalizedUrl = rawUrl
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '')
      .split('?')[0]
      .toLowerCase();

    if (!normalizedUrl || seen.has(normalizedUrl)) continue;

    seen.add(normalizedUrl);
    unique.push({ ...listing });
  }

  return unique;
}

/**
 * Phase 2: Cross-portal fuzzy matching.
 *
 * Groups listings by city, then within each city checks for matches
 * based on price proximity, size proximity, and bedroom count.
 */
function deduplicateFuzzy(listings) {
  // Group by normalized city
  const byCity = new Map();

  for (const listing of listings) {
    const city = normalizeCity(listing.location || listing.municipality || '');
    if (!byCity.has(city)) byCity.set(city, []);
    byCity.get(city).push(listing);
  }

  const result = [];

  for (const [city, cityListings] of byCity) {
    const kept = fuzzyDedupGroup(cityListings);
    result.push(...kept);
  }

  return result;
}

/**
 * Fuzzy dedup within a single city group.
 * Uses Union-Find to cluster duplicates, then picks the best from each cluster.
 */
function fuzzyDedupGroup(listings) {
  const n = listings.length;
  if (n <= 1) return listings;

  // Union-Find
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Compare all pairs within the city
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (isFuzzyMatch(listings[i], listings[j])) {
        union(i, j);
      }
    }
  }

  // Group by cluster root
  const clusters = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(listings[i]);
  }

  // Pick the best listing from each cluster
  const result = [];
  for (const [, cluster] of clusters) {
    if (cluster.length === 1) {
      result.push(cluster[0]);
    } else {
      const best = pickBestListing(cluster);
      result.push(best);
    }
  }

  return result;
}

/**
 * Check if two listings are likely the same property.
 *
 * Criteria (ALL must match):
 *   - Same number of bedrooms (if both have data)
 *   - Price within 5% (if both have price)
 *   - Size within 15% (if both have size)
 *   - At least 2 of the 3 numeric fields must be present on both
 *
 * This is conservative enough to avoid false positives while catching
 * the same property listed on different portals.
 */
function isFuzzyMatch(a, b) {
  const samePortal = a.source === b.source;

  // Count how many comparable fields we have
  const hasBedrooms = a.bedrooms != null && b.bedrooms != null;
  const hasPrice = a.price != null && b.price != null && a.price > 0 && b.price > 0;
  const hasSize = a.size_m2 != null && b.size_m2 != null && a.size_m2 > 0 && b.size_m2 > 0;

  const comparableFields = (hasBedrooms ? 1 : 0) + (hasPrice ? 1 : 0) + (hasSize ? 1 : 0);

  // Fix #13: Same-portal fuzzy matching needs ALL 3 fields + stricter thresholds
  if (samePortal) {
    if (comparableFields < 3) return false;
    if (hasBedrooms && a.bedrooms !== b.bedrooms) return false;
    // Exact price match for same portal (same listing = same price)
    if (hasPrice && a.price !== b.price) return false;
    // Size within 2% (same portal should report same size)
    if (hasSize) {
      const sizeDiff = Math.abs(a.size_m2 - b.size_m2) / Math.max(a.size_m2, b.size_m2);
      if (sizeDiff > 0.02) return false;
    }
    return true;
  }

  // Cross-portal: need at least 2 comparable fields
  if (comparableFields < 2) return false;

  // Bedrooms must match exactly (if available)
  if (hasBedrooms && a.bedrooms !== b.bedrooms) return false;

  // Price within 5%
  if (hasPrice) {
    const priceDiff = Math.abs(a.price - b.price) / Math.max(a.price, b.price);
    if (priceDiff > 0.05) return false;
  }

  // Size within 15% (portals measure differently — built vs useful area)
  if (hasSize) {
    const sizeDiff = Math.abs(a.size_m2 - b.size_m2) / Math.max(a.size_m2, b.size_m2);
    if (sizeDiff > 0.15) return false;
  }

  return true;
}

/**
 * From a cluster of duplicate listings, pick the one with the most data.
 * Merge useful data from other listings into the winner.
 *
 * Scoring:
 *   - Has price: +3
 *   - Has description (>50 chars): +2
 *   - Has thumbnail: +1
 *   - Number of features: +1 each
 *   - Number of images: +1 each (max 5)
 *   - Has GPS coordinates: +3
 *   - Source priority: idealista +1 (largest portal)
 */
function pickBestListing(cluster) {
  let bestScore = -1;
  let bestIdx = 0;

  for (let i = 0; i < cluster.length; i++) {
    const l = cluster[i];
    let score = 0;

    if (l.price) score += 3;
    if (l.description && l.description.length > 50) score += 2;
    if (l.thumbnail) score += 1;
    if (l.features) score += l.features.length;
    if (l.images) score += Math.min(l.images.length, 5);
    if (l.latitude && l.longitude) score += 3;
    if (l.source === 'supabase')  score += 2; // Costa Select eigen database krijgt voorrang
    if (l.source === 'idealista') score += 1;

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  const best = { ...cluster[bestIdx] };

  // Merge data from other listings
  const others = cluster.filter((_, i) => i !== bestIdx);
  const alsoOn = others.map(l => l.source).filter(Boolean);

  // Add "also on" reference
  best.also_on = alsoOn;
  best.also_on_urls = others.map(l => ({ source: l.source, url: l.url }));

  // Merge missing fields from others
  for (const other of others) {
    if (!best.price && other.price) best.price = other.price;
    if (!best.bedrooms && other.bedrooms) best.bedrooms = other.bedrooms;
    if (!best.bathrooms && other.bathrooms) best.bathrooms = other.bathrooms;
    if (!best.size_m2 && other.size_m2) best.size_m2 = other.size_m2;
    if (!best.description && other.description) best.description = other.description;
    if (!best.thumbnail && other.thumbnail) best.thumbnail = other.thumbnail;
    if (!best.latitude && other.latitude) {
      best.latitude = other.latitude;
      best.longitude = other.longitude;
    }
    if (!best.agent_phone && other.agent_phone) best.agent_phone = other.agent_phone;

    // Merge features
    if (other.features && other.features.length) {
      const mergedFeatures = new Set([...(best.features || []), ...other.features]);
      best.features = [...mergedFeatures];
    }

    // Merge images
    if (other.images && other.images.length > (best.images || []).length) {
      best.images = other.images;
    }
  }

  // Recalculate price_per_m2 if we merged data
  if (best.price && best.size_m2) {
    best.price_per_m2 = Math.round(best.price / best.size_m2);
  }

  return best;
}

/**
 * Normalize city name for grouping.
 */
function normalizeCity(city) {
  return (city || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove accents
    .replace(/\s+/g, ' ');
}

module.exports = { deduplicateListings };
