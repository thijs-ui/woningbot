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
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '';

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Vind matchende properties voor een alert.
 *
 * @param {Object} alert - rij uit de `alerts` tabel.
 * @param {Object} [opts]
 * @param {string|null} [opts.cutoff=null] - ISO date. Indien gezet: alleen
 *   items met first_seen_at >= cutoff. Null = alle bestaande inventory.
 * @param {number} [opts.limit] - cap op totaal aantal matches na merge+sort.
 *   Niet gezet = geen cap (caller bepaalt of slicen nodig is).
 * @param {string[]} [opts.sources=['units','resales']] - welke bronnen.
 * @returns {Promise<Match[]>} normalized matches, sorted by price asc.
 */
async function findMatches(alert, opts = {}) {
  const { cutoff = null, limit, sources = ['units', 'resales'] } = opts;

  const tasks = [];
  if (sources.includes('units'))   tasks.push(matchUnits(alert, cutoff));
  if (sources.includes('resales')) tasks.push(matchResales(alert, cutoff));

  const lists = await Promise.all(tasks);
  const merged = lists.flat().sort((a, b) => a.price - b.price);
  return typeof limit === 'number' ? merged.slice(0, limit) : merged;
}

// ─── Source: nieuwbouw units (joined via listings) ─────────────────────────

async function matchUnits(alert, cutoff) {
  // Two-step: locatie zit op `listings`, niet op `units`. PostgREST embedded
  // filters filteren wel de embed maar niet de parent — dus eerst listing-IDs
  // ophalen die op locatie matchen, dán units ophalen via listing_id IN (...).
  let listingIds = null;
  if (alert.location) {
    const loc = sanitizeIlike(alert.location);
    const result = await sbGet('listings', {
      select: 'id',
      or: `(municipality.ilike.*${loc}*,district.ilike.*${loc}*)`,
      limit: '1000',
    });
    if (result.status >= 400) return [];
    listingIds = (result.data || []).map(r => r.id);
    if (listingIds.length === 0) return [];
  }

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

  if (alert.min_price && alert.max_price) {
    params.and = `(price.gte.${alert.min_price},price.lte.${alert.max_price})`;
  } else if (alert.min_price) {
    params.price = `gte.${alert.min_price}`;
  } else if (alert.max_price) {
    params.price = `lte.${alert.max_price}`;
  }

  if (alert.min_rooms)            params.rooms       = `gte.${alert.min_rooms}`;
  if (alert.min_size_m2)          params.size_m2     = `gte.${alert.min_size_m2}`;
  if (alert.has_terrace === true) params.has_terrace = 'eq.true';
  if (alert.has_garden === true)  params.has_garden  = 'eq.true';

  const result = await sbGet('units', params);
  if (result.status >= 400) return [];

  let units = (result.data || []).filter(u => u.listing);
  // has_pool zit alleen op listings-niveau, niet op units. Post-filter blijft
  // hier nodig — geen alternatief in het schema.
  if (alert.has_pool === true) {
    units = units.filter(u => u.listing.has_swimming_pool);
  }
  return units.map(normalizeUnit);
}

// ─── Source: Costa Select resales (flat tabel) ─────────────────────────────

async function matchResales(alert, cutoff) {
  const params = {
    select:
      'ref,price,currency,property_type,town,province,beds,baths,' +
      'built_m2,pool,new_build,features,desc_nl,desc_en,images,url,first_seen_at',
    price_freq: 'eq.sale',
    order: 'price.asc',
    limit: '500',
  };
  if (cutoff) params.first_seen_at = `gte.${cutoff}`;

  if (alert.location) {
    const loc = sanitizeIlike(alert.location);
    params.or = `(town.ilike.*${loc}*,province.ilike.*${loc}*)`;
  }

  if (alert.min_price && alert.max_price) {
    params.and = `(price.gte.${alert.min_price},price.lte.${alert.max_price})`;
  } else if (alert.min_price) {
    params.price = `gte.${alert.min_price}`;
  } else if (alert.max_price) {
    params.price = `lte.${alert.max_price}`;
  }

  if (alert.min_rooms)         params.beds     = `gte.${alert.min_rooms}`;
  if (alert.min_size_m2)       params.built_m2 = `gte.${alert.min_size_m2}`;
  if (alert.has_pool === true) params.pool     = 'eq.true';

  const result = await sbGet('resales_properties', params);
  if (result.status >= 400) return [];
  return (result.data || []).map(normalizeResale);
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

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Strip karakters die de PostgREST or=(...,...) syntax kunnen breken.
 * Spaces blijven (geldig in ilike-patterns).
 */
function sanitizeIlike(s) {
  return String(s).replace(/[(),*]/g, '').trim();
}

function sbGet(path, params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/rest/v1/${path}`, SUPABASE_URL);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
    });

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
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
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
};
