// ─── Alert Matcher ─────────────────────────────────────────────────────────
// Single source of truth voor alert-matching. findMatches() returns een
// normalized list van property-matches, gesorteerd op prijs asc. Source-detail
// (units vs resales) blijft beschikbaar op `match.type`.
//
// Alle filters (locatie, prijs, kamers, oppervlakte, features) worden DB-level
// toegepast. Geen "limit + post-filter" pattern — dat sloeg matches buiten de
// goedkoopste N globally over.
//
// Verbruikt door:
//   - jobs/alert-check.js (cron, delta-only via cutoff)
//   - api.js /api/alert/save (initial-batch, geen cutoff, top 10)

const https = require('https');

const SUPABASE_URL = (
  process.env.SUPABASE_URL || 'https://sqafsrknbfzhkbxqhqlu.supabase.co'
).replace(/\/$/, '');
// Service-role key heeft voorrang: deze service is server-side en moet RLS
// kunnen bypassen voor reads op listings/units/resales_properties. Anon key
// als fallback voor lokale dev. Aligned met alert-check.js precedence.
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';

// ─── Synoniemen-maps ───────────────────────────────────────────────────────
// Parser noemt iets "villa" terwijl Idealista (listings) "chalet" gebruikt en
// resales soms "detached house". Map naar alle bekende DB-varianten zodat we
// op DB-niveau via `in.()` kunnen filteren zonder false negatives.

const PROPERTY_TYPE_SYNONYMS = {
  villa:         ['villa', 'chalet', 'detachedhouse', 'detached_house', 'house'],
  apartment:     ['apartment', 'flat'],
  flat:          ['apartment', 'flat'],
  townhouse:     ['townhouse', 'semidetachedhouse', 'terracedhouse', 'semi_detached'],
  penthouse:     ['penthouse'],
  duplex:        ['duplex'],
  bungalow:      ['bungalow'],
  finca:         ['finca', 'countryhouse', 'country_house'],
  country_house: ['finca', 'countryhouse', 'country_house'],
  studio:        ['studio'],
  plot:          ['plot', 'land'],
};

function getPropertyTypeSynonyms(parserType) {
  if (!parserType) return null;
  const key = String(parserType).toLowerCase().trim();
  return PROPERTY_TYPE_SYNONYMS[key] || [key];
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Vind matchende properties voor een alert.
 *
 * @param {Object} alert - rij uit de `alerts` tabel.
 * @param {Object} [opts]
 * @param {string|null} [opts.cutoff=null] - ISO date. Indien gezet: alleen
 *   items met first_seen_at >= cutoff. Null = alle bestaande inventory.
 * @param {number} [opts.limit] - cap op totaal aantal matches na merge+sort.
 * @param {string[]} [opts.sources=['units','resales']] - welke bronnen.
 * @returns {Promise<Match[]>} normalized matches, sorted by price asc.
 */
async function findMatches(alert, opts = {}) {
  const { cutoff = null, limit } = opts;
  let { sources = ['units', 'resales', 'idealista_resales'] } = opts;

  // Source-routing op alert-intent:
  //   - operation=rent → alleen Costa Select-resales kunnen rent zijn
  //     (units/nieuwbouw + listings hebben geen rent-marker → uitsluiten)
  //   - is_new_build=false → skip units (per definitie nieuwbouw)
  //   - is_new_build=true  → skip idealista_resales (per definitie resale)
  if (alert.operation === 'rent') {
    sources = sources.filter(s => s === 'resales');
  }
  if (alert.is_new_build === false) {
    sources = sources.filter(s => s !== 'units');
  }
  if (alert.is_new_build === true) {
    sources = sources.filter(s => s !== 'idealista_resales');
  }

  const tasks = [];
  if (sources.includes('units'))             tasks.push(matchUnits(alert, cutoff));
  if (sources.includes('resales'))           tasks.push(matchResales(alert, cutoff));
  if (sources.includes('idealista_resales')) tasks.push(matchIdealistaResales(alert, cutoff));

  const lists = await Promise.all(tasks);
  const merged = lists.flat().sort((a, b) => a.price - b.price);
  return typeof limit === 'number' ? merged.slice(0, limit) : merged;
}

// ─── Source: nieuwbouw units (joined via listings) ─────────────────────────

async function matchUnits(alert, cutoff) {
  const locations = effectiveLocations(alert);
  const neighborhoods = Array.isArray(alert.neighborhoods) ? alert.neighborhoods : [];
  const province = alert.province || null;

  // Step 1: listings-IDs filteren op alle listing-level criteria. Locatie zit
  // op listings (niet op units) dus daar móét step 1 al narrowen. Property-type,
  // is_new_build en alle has_*-features zijn ook listing-level → meenemen.
  const listingParams = { select: 'id', limit: '1000' };

  // Locatie + neighborhoods + province via and=(or(),or(),...) zodat alle
  // condities AND'd zijn maar binnen elke groep OR.
  const andClauses = [];
  if (locations.length > 0) {
    const ors = [];
    for (const loc of locations) {
      const safe = sanitizeIlike(loc);
      if (!safe) continue;
      ors.push(`municipality.ilike.%${safe}%`);
      ors.push(`district.ilike.%${safe}%`);
    }
    if (ors.length > 0) andClauses.push(`or(${ors.join(',')})`);
  }
  if (neighborhoods.length > 0) {
    const ors = [];
    for (const nh of neighborhoods) {
      const safe = sanitizeIlike(nh);
      if (!safe) continue;
      ors.push(`district.ilike.%${safe}%`);
    }
    if (ors.length > 0) andClauses.push(`or(${ors.join(',')})`);
  }
  // Province alleen als fallback wanneer geen specifieke stad is gegeven.
  // Anders is 't redundant met de location-filter en breekt 't bij accent-
  // mismatch (DB 'Malaga' vs user/parser 'Málaga' — ILIKE is accent-sensitive).
  if (province && locations.length === 0) {
    const safe = sanitizeIlike(province);
    if (safe) andClauses.push(`province.ilike.%${safe}%`);
  }
  if (andClauses.length === 1) {
    // Strip outer or() voor schone top-level or= als enige groep.
    const clause = andClauses[0];
    if (clause.startsWith('or(')) {
      listingParams.or = `(${clause.slice(3, -1)})`;
    } else {
      listingParams.and = `(${clause})`;
    }
  } else if (andClauses.length > 1) {
    listingParams.and = `(${andClauses.join(',')})`;
  }

  // Property type via synonym-list (case-sensitive in DB, dus we trusten
  // op lowercase-conventie; mapPropertyType in idealista-direct.js doet dit).
  const ptSynonyms = getPropertyTypeSynonyms(alert.property_type);
  if (ptSynonyms) {
    listingParams.property_type = `in.(${ptSynonyms.join(',')})`;
  }

  // is_new_build:
  //   true  → alleen expliciet nieuwbouw (eq.true sluit NULL uit, dat klopt:
  //           geen marker = niet nieuwbouw)
  //   false → "niet nieuwbouw": false OF null. Parser default is false ook
  //           als user 't niet expliciet zegt, dus eq.false zou te streng zijn.
  if (alert.is_new_build === true) {
    listingParams.is_new_development = 'eq.true';
  }

  // Listing-level features (mapped van parser-naam naar DB-kolom).
  if (alert.has_pool === true)             listingParams.has_swimming_pool   = 'eq.true';
  if (alert.has_terrace === true)          listingParams.has_terrace         = 'eq.true';
  if (alert.has_garden === true)           listingParams.has_garden          = 'eq.true';
  if (alert.has_garage === true)           listingParams.has_parking         = 'eq.true';
  if (alert.has_elevator === true)         listingParams.has_lift            = 'eq.true';
  if (alert.has_air_conditioning === true) listingParams.has_air_conditioning = 'eq.true';
  if (alert.has_storage === true)          listingParams.has_storage_room    = 'eq.true';

  // Bathrooms zit op listing-niveau (niet op units) — filter hier.
  if (alert.min_bathrooms) listingParams.bathrooms = `gte.${alert.min_bathrooms}`;

  let listingIds = null;
  // Alleen step 1 doen als we daadwerkelijk filters opleggen (anders doen we
  // 'k listings of zoek-id-ruis ophalen voor niets).
  const hasListingFilter =
    listingParams.or || listingParams.and ||
    listingParams.property_type || listingParams.is_new_development ||
    listingParams.has_swimming_pool || listingParams.has_terrace ||
    listingParams.has_garden || listingParams.has_parking ||
    listingParams.has_lift || listingParams.has_air_conditioning ||
    listingParams.has_storage_room || listingParams.bathrooms;

  if (hasListingFilter) {
    const result = await sbGet('listings', listingParams);
    if (result.status >= 400) {
      console.error(`[alert-matcher] listings query ${result.status}:`, JSON.stringify(result.data));
      return [];
    }
    listingIds = (result.data || []).map(r => r.id);
    if (listingIds.length === 0) return [];
  }

  // Step 2: units met listing_id IN + alle units-level filters.
  const params = {
    select:
      'id,price,rooms,size_m2,floor,has_terrace,has_garden,is_exterior,first_seen_at,' +
      'listing:listings(id,title,url,municipality,district,' +
      'has_swimming_pool,has_terrace,has_garden,main_image_url)',
    order: 'price.asc',
    limit: '500',
  };
  if (listingIds) params.listing_id = `in.(${listingIds.join(',')})`;
  if (cutoff)     params.first_seen_at = `gte.${cutoff}`;

  // Range-filters: min+max paren via and=(...,...,...). One-sided via top-level
  // simple filter. Top-level params + and=() worden door PostgREST AND'd.
  applyRangeFilters(params, [
    ['price',    alert.min_price,    alert.max_price],
    ['rooms',    alert.min_rooms,    alert.max_rooms],
    ['size_m2',  alert.min_size_m2,  alert.max_size_m2],
  ]);

  // Units-level features (zelden gezet maar wel ondersteund).
  if (alert.has_terrace === true) params.has_terrace = 'eq.true';
  if (alert.has_garden === true)  params.has_garden  = 'eq.true';

  const result = await sbGet('units', params);
  if (result.status >= 400) {
    console.error(`[alert-matcher] units query ${result.status}:`, JSON.stringify(result.data));
    return [];
  }
  return (result.data || []).filter(u => u.listing).map(normalizeUnit);
}

// ─── Source: Costa Select resales (flat tabel) ─────────────────────────────

async function matchResales(alert, cutoff) {
  const locations = effectiveLocations(alert);
  const province = alert.province || null;

  const params = {
    select:
      'ref,price,currency,property_type,town,province,beds,baths,' +
      'built_m2,pool,new_build,features,desc_nl,desc_en,images,url,first_seen_at',
    price_freq: alert.operation === 'rent' ? 'eq.rent' : 'eq.sale',
    order: 'price.asc',
    limit: '500',
  };
  if (cutoff) params.first_seen_at = `gte.${cutoff}`;

  // Locatie + province via and=(or(),...). Resales heeft geen district/wijk
  // veld, dus neighborhoods skippen we voor deze bron.
  const andClauses = [];
  if (locations.length > 0) {
    const ors = [];
    for (const loc of locations) {
      const safe = sanitizeIlike(loc);
      if (!safe) continue;
      ors.push(`town.ilike.%${safe}%`);
      ors.push(`province.ilike.%${safe}%`);
    }
    if (ors.length > 0) andClauses.push(`or(${ors.join(',')})`);
  }
  // Province alleen als fallback wanneer geen specifieke stad is gegeven.
  if (province && locations.length === 0) {
    const safe = sanitizeIlike(province);
    if (safe) andClauses.push(`province.ilike.%${safe}%`);
  }

  // is_new_build:
  //   true  → alleen expliciet nieuwbouw (eq.true)
  //   false → false OF null (de meeste resales hebben new_build=NULL i.p.v.
  //           expliciet false; parser default is false ook bij geen voorkeur).
  if (alert.is_new_build === true) {
    andClauses.push('new_build.eq.true');
  } else if (alert.is_new_build === false) {
    andClauses.push('or(new_build.eq.false,new_build.is.null)');
  }

  if (andClauses.length === 1) {
    const clause = andClauses[0];
    if (clause.startsWith('or(')) {
      params.or = `(${clause.slice(3, -1)})`;
    } else {
      params.and = `(${clause})`;
    }
  } else if (andClauses.length > 1) {
    params.and = `(${andClauses.join(',')})`;
  }

  // Property type
  const ptSynonyms = getPropertyTypeSynonyms(alert.property_type);
  if (ptSynonyms) {
    params.property_type = `in.(${ptSynonyms.join(',')})`;
  }

  applyRangeFilters(params, [
    ['price',    alert.min_price,    alert.max_price],
    ['beds',     alert.min_rooms,    alert.max_rooms],
    ['built_m2', alert.min_size_m2,  alert.max_size_m2],
  ]);

  if (alert.min_bathrooms)     params.baths = `gte.${alert.min_bathrooms}`;
  if (alert.has_pool === true) params.pool  = 'eq.true';

  const result = await sbGet('resales_properties', params);
  if (result.status >= 400) {
    console.error(`[alert-matcher] resales query ${result.status}:`, JSON.stringify(result.data));
    return [];
  }
  return (result.data || []).map(normalizeResale);
}

// ─── Source: Idealista resales (listings tabel direct) ────────────────────
// Idealista resales delen de `listings` tabel met nieuwbouw-projects. Het
// verschil zit in `is_new_development`: true = nieuwbouw (gedekt door
// matchUnits via units-tabel), false/null = resale. Hier filteren we
// expliciet op niet-nieuwbouw zodat we geen overlap met matchUnits krijgen.

async function matchIdealistaResales(alert, cutoff) {
  const locations = effectiveLocations(alert);
  const neighborhoods = Array.isArray(alert.neighborhoods) ? alert.neighborhoods : [];
  const province = alert.province || null;

  const params = {
    select:
      'id,price,rooms,bathrooms,size_m2,property_type,municipality,district,' +
      'province,has_swimming_pool,has_terrace,has_garden,has_lift,has_parking,' +
      'has_air_conditioning,has_storage_room,main_image_url,url,title,' +
      'first_seen_at,is_new_development',
    is_active: 'eq.true',
    order: 'price.asc',
    limit: '500',
  };
  if (cutoff) params.first_seen_at = `gte.${cutoff}`;

  const andClauses = [];

  if (locations.length > 0) {
    const ors = [];
    for (const loc of locations) {
      const safe = sanitizeIlike(loc);
      if (!safe) continue;
      ors.push(`municipality.ilike.%${safe}%`);
      ors.push(`district.ilike.%${safe}%`);
    }
    if (ors.length > 0) andClauses.push(`or(${ors.join(',')})`);
  }
  if (neighborhoods.length > 0) {
    const ors = [];
    for (const nh of neighborhoods) {
      const safe = sanitizeIlike(nh);
      if (!safe) continue;
      ors.push(`district.ilike.%${safe}%`);
    }
    if (ors.length > 0) andClauses.push(`or(${ors.join(',')})`);
  }
  if (province && locations.length === 0) {
    const safe = sanitizeIlike(province);
    if (safe) andClauses.push(`province.ilike.%${safe}%`);
  }

  // Sluit nieuwbouw uit (zit al in matchUnits via units-tabel).
  // false OF null — beide zijn 'niet expliciet nieuwbouw'.
  andClauses.push('or(is_new_development.eq.false,is_new_development.is.null)');

  if (andClauses.length === 1) {
    const clause = andClauses[0];
    if (clause.startsWith('or(')) {
      params.or = `(${clause.slice(3, -1)})`;
    } else {
      params.and = `(${clause})`;
    }
  } else if (andClauses.length > 1) {
    params.and = `(${andClauses.join(',')})`;
  }

  const ptSynonyms = getPropertyTypeSynonyms(alert.property_type);
  if (ptSynonyms) {
    params.property_type = `in.(${ptSynonyms.join(',')})`;
  }

  applyRangeFilters(params, [
    ['price',   alert.min_price,    alert.max_price],
    ['rooms',   alert.min_rooms,    alert.max_rooms],
    ['size_m2', alert.min_size_m2,  alert.max_size_m2],
  ]);

  if (alert.min_bathrooms) params.bathrooms = `gte.${alert.min_bathrooms}`;

  if (alert.has_pool === true)             params.has_swimming_pool    = 'eq.true';
  if (alert.has_terrace === true)          params.has_terrace          = 'eq.true';
  if (alert.has_garden === true)           params.has_garden           = 'eq.true';
  if (alert.has_garage === true)           params.has_parking          = 'eq.true';
  if (alert.has_elevator === true)         params.has_lift             = 'eq.true';
  if (alert.has_air_conditioning === true) params.has_air_conditioning = 'eq.true';
  if (alert.has_storage === true)          params.has_storage_room     = 'eq.true';

  const result = await sbGet('listings', params);
  if (result.status >= 400) {
    console.error(`[alert-matcher] idealista-resales query ${result.status}:`, JSON.stringify(result.data));
    return [];
  }
  return (result.data || []).map(normalizeIdealistaResale);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Pas range-filters (min+max paren) toe op een PostgREST params-object.
 * Min+max paren gaan in een gecombineerd and=(...) zodat één param meerdere
 * predicates op verschillende kolommen kan dragen. Eenzijdige filters gaan
 * direct als top-level param. Top-level params + and=() worden AND'd.
 *
 * @param {Object} params - mutable PostgREST params object
 * @param {Array<[string, any, any]>} ranges - tuples van [column, min, max]
 */
function applyRangeFilters(params, ranges) {
  const existingAnd = params.and ? params.and.slice(1, -1) : '';
  const andParts = existingAnd ? [existingAnd] : [];

  for (const [col, min, max] of ranges) {
    if (min && max) {
      andParts.push(`${col}.gte.${min}`);
      andParts.push(`${col}.lte.${max}`);
    } else if (min) {
      params[col] = `gte.${min}`;
    } else if (max) {
      params[col] = `lte.${max}`;
    }
  }

  if (andParts.length > 0) {
    params.and = `(${andParts.join(',')})`;
  }
}

/**
 * Single source van alert-locaties: locations[] indien gezet, anders fallback
 * naar [location] voor backward-compat met oude alerts (pre-migratie 004).
 */
function effectiveLocations(alert) {
  if (Array.isArray(alert.locations) && alert.locations.length > 0) {
    return alert.locations.filter(Boolean);
  }
  if (alert.location) return [alert.location];
  return [];
}

// ─── Normalizers ───────────────────────────────────────────────────────────

function normalizeUnit(u) {
  const listing = u.listing || {};
  return {
    type: 'unit',
    title: listing.title || 'Nieuwbouwproject',
    location: [listing.municipality, listing.district].filter(Boolean).join(', '),
    price: Number(u.price) || 0,
    beds: u.rooms || null,
    size_m2: u.size_m2 || null,
    url: listing.url || null,
    image: listing.main_image_url || null,
    features: {
      pool: !!listing.has_swimming_pool,
      terrace: !!(u.has_terrace || listing.has_terrace),
      garden: !!(u.has_garden || listing.has_garden),
      exterior: !!u.is_exterior,
      floor: u.floor || null,
      description: null,
    },
    raw: u,
  };
}

function normalizeResale(p) {
  const images = (p.images || []).map(img => img?.url).filter(Boolean);
  const desc = (p.desc_nl || p.desc_en || '').substring(0, 120);
  return {
    type: 'resale',
    title: `${p.property_type || 'Property'} in ${p.town || p.province || '?'}`,
    location: [p.town, p.province].filter(Boolean).join(', '),
    price: Number(p.price) || 0,
    beds: p.beds || null,
    size_m2: p.built_m2 || null,
    url: p.url || null,
    image: images[0] || null,
    features: {
      pool: !!p.pool,
      terrace: false,
      garden: false,
      exterior: false,
      floor: null,
      description: desc || null,
    },
    raw: p,
  };
}

function normalizeIdealistaResale(l) {
  return {
    type: 'idealista_resale',
    title: l.title || `${l.property_type || 'Property'} in ${l.municipality || l.province || '?'}`,
    location: [l.municipality, l.district].filter(Boolean).join(', '),
    price: Number(l.price) || 0,
    beds: l.rooms || null,
    size_m2: l.size_m2 || null,
    url: l.url || null,
    image: l.main_image_url || null,
    features: {
      pool: !!l.has_swimming_pool,
      terrace: !!l.has_terrace,
      garden: !!l.has_garden,
      exterior: false,
      floor: null,
      description: null,
    },
    raw: l,
  };
}

/**
 * Strip karakters die de PostgREST or=(...,...) syntax of ilike-pattern kunnen
 * breken. Spaces blijven (geldig in ilike-patterns); wildcards controleren we
 * zelf via de %-wrapping eromheen.
 */
function sanitizeIlike(s) {
  return String(s).replace(/[(),*%]/g, '').trim();
}

function sbGet(path, params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/rest/v1/${path}`, SUPABASE_URL);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
    });

    // Debug: log de exacte query (zonder hostname om de log korter te houden).
    console.log(`[alert-matcher] GET ${url.pathname}${url.search}`);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Accept: 'application/json',
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : null;
          const count = Array.isArray(parsed) ? parsed.length : (parsed ? 1 : 0);
          console.log(`[alert-matcher]   → ${res.statusCode}, ${count} rows`);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          reject(new Error(`Supabase parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Supabase timeout')); });
    req.end();
  });
}

module.exports = {
  findMatches,
  matchUnits,
  matchResales,
  matchIdealistaResales,
};
