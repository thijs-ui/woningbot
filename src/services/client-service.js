// ─── Property Lookup ───────────────────────────────────────────────────────
// Lookup van resales-properties via ref. Voorheen ook klant-shortlist-CRUD
// (saveProperty/getClientProperties/...) maar die functionaliteit is verhuisd
// naar het dashboard; alleen lookupProperty wordt nog gebruikt door api.js.

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

async function lookupProperty(ref) {
  const rows = await sbFetch(
    `resales_properties?ref=eq.${encodeURIComponent(ref)}&select=ref,url,price,property_type,town,province,beds,baths,built_m2,pool,images&limit=1`
  );
  return rows?.[0] || null;
}

module.exports = { lookupProperty };
