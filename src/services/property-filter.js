/**
 * property-filter.js — Programmatic enforcement of hard filters.
 *
 * Claude is an LLM and sometimes ignores hard filter instructions.
 * This module provides deterministic pre-filtering (before Claude) and
 * post-validation (after Claude selection) to guarantee compliance.
 *
 * Fixes audit issues #1 and #5.
 */

/**
 * Pre-filter listings BEFORE sending to Claude.
 * Removes listings that clearly violate hard filters.
 * This reduces token usage and prevents Claude from selecting invalid properties.
 *
 * @param {Array} listings - All scraped listings
 * @param {object} hardFilters - hard_filters from Claude parser
 * @returns {Array} Filtered listings
 */
function preFilterListings(listings, hardFilters) {
  if (!listings || listings.length === 0) return [];
  if (!hardFilters) return listings;

  const before = listings.length;
  let removed = { price: 0, type: 0, bedrooms: 0, size: 0, plot: 0 };

  const filtered = listings.filter(listing => {
    // Price filter — strict, no tolerance
    if (hardFilters.price_max && listing.price && listing.price > hardFilters.price_max) {
      removed.price++;
      return false;
    }
    if (hardFilters.price_min && listing.price && listing.price < hardFilters.price_min) {
      removed.price++;
      return false;
    }

    // Property type filter
    if (hardFilters.property_type && listing.property_type) {
      if (!isPropertyTypeMatch(hardFilters.property_type, listing.property_type, listing.title)) {
        removed.type++;
        return false;
      }
    }

    // Bedrooms filter — only filter if both have data
    if (hardFilters.bedrooms_min && listing.bedrooms && listing.bedrooms < hardFilters.bedrooms_min) {
      removed.bedrooms++;
      return false;
    }
    if (hardFilters.bedrooms_max && listing.bedrooms && listing.bedrooms > hardFilters.bedrooms_max) {
      removed.bedrooms++;
      return false;
    }

    // Size filter
    if (hardFilters.size_min_m2 && listing.size_m2 && listing.size_m2 < hardFilters.size_min_m2) {
      removed.size++;
      return false;
    }
    if (hardFilters.size_max_m2 && listing.size_m2 && listing.size_m2 > hardFilters.size_max_m2) {
      removed.size++;
      return false;
    }

    // Plot filter — alleen actief als de listing plot_m2 levert. Idealista
    // search-API geeft geen plot-veld terug; die listings vallen door en
    // worden door de selector beoordeeld via de beschrijving.
    if (hardFilters.plot_min_m2 && listing.plot_m2 && listing.plot_m2 < hardFilters.plot_min_m2) {
      removed.plot++;
      return false;
    }
    if (hardFilters.plot_max_m2 && listing.plot_m2 && listing.plot_m2 > hardFilters.plot_max_m2) {
      removed.plot++;
      return false;
    }

    return true;
  });

  const totalRemoved = before - filtered.length;
  if (totalRemoved > 0) {
    console.log(`[PropertyFilter] Pre-filter: ${before} → ${filtered.length} (removed ${totalRemoved}: price=${removed.price}, type=${removed.type}, beds=${removed.bedrooms}, size=${removed.size}, plot=${removed.plot})`);
  }

  return filtered;
}

/**
 * Post-validate Claude's selections against hard filters.
 * Removes any selections that violate hard filters (Claude hallucination safety net).
 *
 * @param {Array} selections - Claude's selections (with property_id)
 * @param {Array} allProperties - All properties (to look up details)
 * @param {object} hardFilters - hard_filters from Claude parser
 * @returns {Array} Validated selections
 */
function postValidateSelections(selections, allProperties, hardFilters) {
  if (!selections || selections.length === 0) return [];
  if (!hardFilters) return selections;

  const validated = [];
  let rejected = 0;

  for (const sel of selections) {
    const prop = allProperties.find(p =>
      p.id === sel.property_id || p.url === sel.property_id || String(p.id) === String(sel.property_id)
    );

    if (!prop) {
      // Property not found — skip (Claude hallucinated an ID)
      console.warn(`[PropertyFilter] Post-validate: property_id "${sel.property_id}" not found in pool, skipping`);
      rejected++;
      continue;
    }

    let valid = true;
    const reasons = [];

    // Price check
    if (hardFilters.price_max && prop.price && prop.price > hardFilters.price_max) {
      valid = false;
      reasons.push(`price €${prop.price} > max €${hardFilters.price_max}`);
    }
    if (hardFilters.price_min && prop.price && prop.price < hardFilters.price_min) {
      valid = false;
      reasons.push(`price €${prop.price} < min €${hardFilters.price_min}`);
    }

    // Property type check
    if (hardFilters.property_type && prop.property_type) {
      if (!isPropertyTypeMatch(hardFilters.property_type, prop.property_type, prop.title)) {
        valid = false;
        reasons.push(`type "${prop.property_type}" ≠ requested "${hardFilters.property_type}"`);
      }
    }

    // Bedrooms check
    if (hardFilters.bedrooms_min && prop.bedrooms && prop.bedrooms < hardFilters.bedrooms_min) {
      valid = false;
      reasons.push(`bedrooms ${prop.bedrooms} < min ${hardFilters.bedrooms_min}`);
    }

    // Plot check (alleen als plot_m2 op de listing aanwezig is — Idealista
    // search-API levert het niet, dus die listings worden door de selector
    // beoordeeld op de beschrijving).
    if (hardFilters.plot_min_m2 && prop.plot_m2 && prop.plot_m2 < hardFilters.plot_min_m2) {
      valid = false;
      reasons.push(`plot ${prop.plot_m2}m² < min ${hardFilters.plot_min_m2}m²`);
    }
    if (hardFilters.plot_max_m2 && prop.plot_m2 && prop.plot_m2 > hardFilters.plot_max_m2) {
      valid = false;
      reasons.push(`plot ${prop.plot_m2}m² > max ${hardFilters.plot_max_m2}m²`);
    }

    if (valid) {
      validated.push(sel);
    } else {
      rejected++;
      console.log(`[PropertyFilter] Post-validate REJECTED: "${prop.title}" — ${reasons.join(', ')}`);
    }
  }

  if (rejected > 0) {
    console.log(`[PropertyFilter] Post-validate: ${selections.length} → ${validated.length} (rejected ${rejected})`);
  }

  return validated;
}

/**
 * Check if a listing's property type matches the requested type.
 *
 * Key distinction: "villa" means ONLY detached villas/chalets.
 * NOT semi-detached, adosado, pareado, townhouse.
 */
function isPropertyTypeMatch(requestedType, listingType, listingTitle) {
  if (!requestedType) return true;

  const requested = requestedType.toLowerCase();
  const actual = (listingType || '').toLowerCase();
  const title = (listingTitle || '').toLowerCase();

  // Villa = only detached
  if (requested === 'villa') {
    // Reject semi-detached, townhouse, adosado, pareado
    const rejectTypes = ['townhouse', 'adosado', 'pareado', 'semi-detached', 'terraced'];
    if (rejectTypes.some(t => actual.includes(t))) return false;
    if (title.includes('semi-detached') || title.includes('adosado') || title.includes('pareado') ||
        title.includes('terraced') || title.includes('town house') || title.includes('townhouse')) return false;

    // Accept: chalet, villa, detached, independiente, house (generic)
    const acceptTypes = ['chalet', 'villa', 'detached', 'independiente', 'house'];
    // If we have a type and it's not in accept list, reject
    if (actual && !acceptTypes.some(t => actual.includes(t)) && actual !== 'null') return false;

    return true;
  }

  // Apartment = flat, piso, apartamento, apartment
  if (requested === 'apartment' || requested === 'flat') {
    const acceptTypes = ['flat', 'apartment', 'piso', 'apartamento'];
    if (actual && !acceptTypes.some(t => actual.includes(t)) && actual !== 'null') return false;
    return true;
  }

  // Penthouse — Idealista heeft geen vaste penthouse-categorie en levert
  // de title vaak als generieke fallback ("Flat in Estepona, ..."), zonder
  // 'penthouse'/'ático' hint. Strict op type/title filtert dan vrijwel
  // alles weg. Pragmatische pre-filter: laat alle flat/apartment types
  // door en laat de Claude-selector op basis van de beschrijving
  // bepalen of het echt een penthouse is. Reject alleen ondubbelzinnig
  // niet-flats (villa, townhouse, country house).
  if (requested === 'penthouse') {
    if (!actual || actual === 'null') return true;
    const rejectTypes = ['villa', 'chalet', 'detached', 'townhouse', 'adosado',
      'pareado', 'semi-detached', 'terraced', 'countryhouse', 'country_house',
      'finca', 'plot'];
    if (rejectTypes.some(t => actual.includes(t))) return false;
    return true;
  }

  // Townhouse
  if (requested === 'townhouse') {
    const acceptTypes = ['townhouse', 'adosado', 'pareado', 'semi-detached', 'terraced'];
    if (actual && !acceptTypes.some(t => actual.includes(t))) return false;
    return true;
  }

  // For other types, allow if type is null/unknown (benefit of the doubt)
  return true;
}

/**
 * Filter ThinkSpain results by property type from title.
 * ThinkSpain doesn't filter by type server-side (only types=1 for "houses & apartments").
 * Fix for audit issue #9.
 *
 * @param {Array} listings - ThinkSpain listings
 * @param {string|null} requestedType - Requested property type
 * @returns {Array} Filtered listings
 */
function filterThinkSpainByType(listings, requestedType) {
  if (!requestedType || !listings || listings.length === 0) return listings;

  const before = listings.length;
  const filtered = listings.filter(l => isPropertyTypeMatch(requestedType, l.property_type, l.title));

  if (filtered.length < before) {
    console.log(`[PropertyFilter] ThinkSpain type filter: ${before} → ${filtered.length} (requested: ${requestedType})`);
  }

  return filtered;
}

module.exports = {
  preFilterListings,
  postValidateSelections,
  isPropertyTypeMatch,
  filterThinkSpainByType,
};
