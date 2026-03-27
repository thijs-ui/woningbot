// ─── Client Service ────────────────────────────────────────────────────────
// Beheert klant-property koppelingen in Supabase

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';

async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey:        SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * Sla een property op voor een klant.
 * Maakt de klant automatisch aan als die nog niet bestaat.
 */
async function saveProperty({ clientName, slackUserId, ref, url, note }) {
  const payload = {
    client_name:   clientName,
    slack_user_id: slackUserId,
    ref:           ref || null,
    url:           url || null,
    note:          note || null,
  };

  return sbFetch('client_properties', {
    method:  'POST',
    headers: { Prefer: 'return=representation' },
    body:    JSON.stringify(payload),
  });
}

/**
 * Haal alle opgeslagen properties op voor een klant.
 * Joined met resales_properties voor extra details.
 */
async function getClientProperties(clientName) {
  const encoded = encodeURIComponent(clientName);
  return sbFetch(
    `client_properties?client_name=ilike.${encoded}&select=*,property:resales_properties(ref,url,price,property_type,town,province,beds,baths,built_m2,pool,images)&order=saved_at.desc`
  );
}

/**
 * Haal alle unieke klanten op (voor /klant lijst).
 */
async function getAllClients() {
  const rows = await sbFetch(
    'client_properties?select=client_name,slack_user_id,saved_at&order=client_name.asc'
  );
  // Dedup op client_name, tel properties per klant
  const map = new Map();
  for (const row of (rows || [])) {
    if (!map.has(row.client_name)) {
      map.set(row.client_name, { client_name: row.client_name, count: 0 });
    }
    map.get(row.client_name).count++;
  }
  return [...map.values()];
}

/**
 * Verwijder een opgeslagen property.
 */
async function removeProperty(id, slackUserId) {
  return sbFetch(
    `client_properties?id=eq.${id}&slack_user_id=eq.${slackUserId}`,
    { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
  );
}

/**
 * Zoek resales property op via ref voor weergave.
 */
async function lookupProperty(ref) {
  const rows = await sbFetch(
    `resales_properties?ref=eq.${encodeURIComponent(ref)}&select=ref,url,price,property_type,town,province,beds,baths,built_m2,pool,images&limit=1`
  );
  return rows?.[0] || null;
}

module.exports = { saveProperty, getClientProperties, getAllClients, removeProperty, lookupProperty };
