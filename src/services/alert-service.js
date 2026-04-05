// ─── Alert Service ─────────────────────────────────────────────────────────
// CRUD operations for alerts stored in Supabase + matching logic for new units

const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sqafsrknbfzhkbxqhqlu.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
const MAX_ALERTS_PER_USER = 10;

// ─── Supabase HTTP helper ──────────────────────────────────────────────────

function sbRequest(method, path, body = null, params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/rest/v1/${path}`, SUPABASE_URL);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
    });

    const bodyStr = body ? JSON.stringify(body) : null;

    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };

    // For PATCH with path filters, add merge-duplicates
    if (method === 'PATCH') {
      headers.Prefer = 'return=representation';
    }

    if (bodyStr) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers,
    };

    const req = https.request(options, (res) => {
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
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── CRUD Operations ───────────────────────────────────────────────────────

/**
 * Save a new alert. Checks max alerts per user first.
 */
async function saveAlert(alert) {
  const ts = new Date().toISOString();

  // Check alert limit per user
  const existing = await getAlertsForUser(alert.slack_user_id);
  if (existing.length >= MAX_ALERTS_PER_USER) {
    throw new Error(`Je hebt al ${MAX_ALERTS_PER_USER} actieve alerts. Verwijder er eerst een met \`/alert stop <id>\`.`);
  }

  const result = await sbRequest('POST', 'alerts', alert);
  if (result.status >= 400) {
    throw new Error(`Supabase ${result.status}: ${JSON.stringify(result.data)}`);
  }

  console.log(`[${ts}] [AlertService] Alert created for user ${alert.slack_user_id}: ${alert.location || 'any location'}`);
  return Array.isArray(result.data) ? result.data[0] : result.data;
}

/**
 * Get all active alerts (for the cron job).
 */
async function getActiveAlerts() {
  const result = await sbRequest('GET', 'alerts', null, {
    select: '*',
    is_active: 'eq.true',
  });
  if (result.status >= 400) throw new Error(`Supabase ${result.status}`);
  return result.data || [];
}

/**
 * Get all active alerts for a specific user.
 */
async function getAlertsForUser(slackUserId) {
  const result = await sbRequest('GET', 'alerts', null, {
    select: '*',
    slack_user_id: `eq.${slackUserId}`,
    is_active: 'eq.true',
    order: 'created_at.desc',
  });
  if (result.status >= 400) throw new Error(`Supabase ${result.status}`);
  return result.data || [];
}

/**
 * Deactivate an alert. Supports both full UUID and partial (8+ char) match.
 */
async function deactivateAlert(alertId, slackUserId) {
  const ts = new Date().toISOString();

  // If partial ID (< 36 chars), look up the full ID first
  let fullId = alertId;
  if (alertId.length < 36) {
    const userAlerts = await getAlertsForUser(slackUserId);
    const match = userAlerts.find(a => a.id.startsWith(alertId));
    if (!match) {
      throw new Error(`Geen alert gevonden met ID \`${alertId}\`. Gebruik \`/alert list\` om je alert IDs te bekijken.`);
    }
    fullId = match.id;
  }

  const result = await sbRequest('PATCH',
    `alerts?id=eq.${fullId}&slack_user_id=eq.${slackUserId}`, {
      is_active: false,
      updated_at: new Date().toISOString(),
    });

  if (result.status >= 400) throw new Error(`Supabase ${result.status}`);

  console.log(`[${ts}] [AlertService] Alert ${fullId.slice(0, 8)} deactivated by user ${slackUserId}`);
  return result.data;
}

/**
 * Update last_checked_at timestamp after processing an alert.
 */
async function updateLastChecked(alertId) {
  await sbRequest('PATCH', `alerts?id=eq.${alertId}`, {
    last_checked_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

// ─── Matching Logic ────────────────────────────────────────────────────────

/**
 * Find new units that match an alert's criteria.
 * Checks units added since the alert was last checked.
 */
async function getNewUnitsForAlert(alert) {
  // Default cutoff: 25 hours ago (slightly more than daily to avoid gaps)
  const cutoff = alert.last_checked_at
    ? new Date(alert.last_checked_at).toISOString()
    : new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

  const params = {
    select: '*,listing:listings(id,title,url,municipality,district,has_swimming_pool,has_terrace,has_garden,main_image_url)',
    first_seen_at: `gte.${cutoff}`,
    order: 'price.asc',
    limit: '50',
  };

  // Price filters
  if (alert.min_price && alert.max_price) {
    params['and'] = `(price.gte.${alert.min_price},price.lte.${alert.max_price})`;
  } else if (alert.min_price) {
    params['price'] = `gte.${alert.min_price}`;
  } else if (alert.max_price) {
    params['price'] = `lte.${alert.max_price}`;
  }

  // Room and size filters (applied at DB level)
  if (alert.min_rooms)   params['rooms']   = `gte.${alert.min_rooms}`;
  if (alert.min_size_m2) params['size_m2'] = `gte.${alert.min_size_m2}`;

  // Terrace and garden can be filtered at DB level on units table
  if (alert.has_terrace === true) params['has_terrace'] = 'eq.true';
  if (alert.has_garden  === true) params['has_garden']  = 'eq.true';

  const result = await sbRequest('GET', 'units', null, params);
  if (result.status >= 400) return [];

  let units = result.data || [];

  // Post-filter: location and listing-level features (not in units table)
  units = units.filter(u => {
    if (!u.listing) return false;

    // Location filter: check municipality and district
    if (alert.location) {
      const loc = alert.location.toLowerCase();
      const muni = (u.listing.municipality || '').toLowerCase();
      const dist = (u.listing.district || '').toLowerCase();
      if (!muni.includes(loc) && !dist.includes(loc) && !loc.includes(muni)) return false;
    }

    // Pool filter (only on listing level)
    if (alert.has_pool === true && !u.listing.has_swimming_pool) return false;

    return true;
  });

  return units;
}

/**
 * Find new resales properties that match an alert's criteria.
 * Checks resales_properties added since the alert was last checked.
 */
async function getNewResalesForAlert(alert) {
  const cutoff = alert.last_checked_at
    ? new Date(alert.last_checked_at).toISOString()
    : new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

  const params = {
    select: 'ref,price,currency,property_type,town,province,beds,baths,built_m2,pool,new_build,features,desc_nl,desc_en,images,url,first_seen_at',
    first_seen_at: `gte.${cutoff}`,
    price_freq:    'eq.sale',
    order:         'price.asc',
    limit:         '50',
  };

  if (alert.min_price) params['price'] = `gte.${alert.min_price}`;
  if (alert.max_price) params['price'] = `lte.${alert.max_price}`;
  if (alert.min_rooms) params['beds']  = `gte.${alert.min_rooms}`;
  if (alert.min_size_m2) params['built_m2'] = `gte.${alert.min_size_m2}`;
  if (alert.has_pool === true) params['pool'] = 'eq.true';

  const result = await sbRequest('GET', 'resales_properties', null, params);
  if (result.status >= 400) return [];

  let properties = result.data || [];

  // Post-filter op locatie
  if (alert.location) {
    const loc = alert.location.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    properties = properties.filter(p => {
      const town     = (p.town     || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const province = (p.province || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return town.includes(loc) || loc.includes(town) || province.includes(loc);
    });
  }

  return properties;
}

module.exports = {
  saveAlert,
  getActiveAlerts,
  getAlertsForUser,
  deactivateAlert,
  updateLastChecked,
  getNewUnitsForAlert,
  getNewResalesForAlert,
  MAX_ALERTS_PER_USER,
};
