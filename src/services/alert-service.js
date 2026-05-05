// ─── Alert Service ─────────────────────────────────────────────────────────
// CRUD operations voor alerts in Supabase. Matching-logica leeft in
// src/services/alert-matcher.js (findMatches).

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

async function saveAlert(alert) {
  const ts = new Date().toISOString();

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

async function getActiveAlerts() {
  const result = await sbRequest('GET', 'alerts', null, {
    select: '*',
    is_active: 'eq.true',
  });
  if (result.status >= 400) throw new Error(`Supabase ${result.status}`);
  return result.data || [];
}

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

async function updateLastChecked(alertId) {
  await sbRequest('PATCH', `alerts?id=eq.${alertId}`, {
    last_checked_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

/**
 * Persisteer welke Idealista propertyCodes we al ge-DM'd hebben voor deze alert.
 * Cron vergelijkt huidige Apify-respons hiermee om alleen nieuwe te alerten.
 */
async function updateIdealistaSeenCodes(alertId, codes) {
  await sbRequest('PATCH', `alerts?id=eq.${alertId}`, {
    idealista_seen_codes: Array.from(new Set(codes || [])),
    updated_at: new Date().toISOString(),
  });
}

module.exports = {
  saveAlert,
  getActiveAlerts,
  getAlertsForUser,
  deactivateAlert,
  updateLastChecked,
  updateIdealistaSeenCodes,
  MAX_ALERTS_PER_USER,
};
