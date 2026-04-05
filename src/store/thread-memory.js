const https = require('https');

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://sqafsrknbfzhkbxqhqlu.supabase.co').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours

// In-memory cache for fast repeated access within a session
const cache = new Map();

function sbReq(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/rest/v1/${path}`, SUPABASE_URL);
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Supabase timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function persist(threadTs, data) {
  sbReq('POST', 'thread_store?on_conflict=thread_ts', {
    thread_ts: threadTs,
    data,
    created_at: data.created_at || Date.now(),
    expires_at: new Date(Date.now() + MAX_AGE_MS).toISOString(),
  }, { Prefer: 'resolution=merge-duplicates,return=minimal' })
    .catch(e => console.warn('[ThreadMemory] Write failed:', e.message));
}

async function getThread(threadTs) {
  if (cache.has(threadTs)) return cache.get(threadTs);

  try {
    const res = await sbReq('GET', `thread_store?thread_ts=eq.${encodeURIComponent(threadTs)}&select=data`);
    if (res.status === 200 && res.body?.length) {
      const data = res.body[0].data;
      if ((data.created_at || 0) > Date.now() - MAX_AGE_MS) {
        cache.set(threadTs, data);
        return data;
      }
    }
  } catch (e) {
    console.warn('[ThreadMemory] Read failed:', e.message);
  }
  return null;
}

function setThread(threadTs, data) {
  cache.set(threadTs, data);
  persist(threadTs, data);
}

async function updateThread(threadTs, updates) {
  const existing = cache.get(threadTs) || await getThread(threadTs);
  if (!existing) return false;
  const updated = { ...existing, ...updates };
  cache.set(threadTs, updated);
  persist(threadTs, updated);
  return true;
}

async function addConversation(threadTs, role, text) {
  const existing = cache.get(threadTs) || await getThread(threadTs);
  if (!existing) return false;
  existing.conversation_history.push({ role, text, timestamp: new Date().toISOString() });
  persist(threadTs, existing);
  return true;
}

function deleteThread(threadTs) {
  cache.delete(threadTs);
  sbReq('DELETE', `thread_store?thread_ts=eq.${encodeURIComponent(threadTs)}`)
    .catch(e => console.warn('[ThreadMemory] Delete failed:', e.message));
}

// Periodic in-memory cache cleanup
setInterval(() => {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [ts, data] of cache) {
    if ((data.created_at || 0) < cutoff) cache.delete(ts);
  }
}, 60 * 60 * 1000);

module.exports = { getThread, setThread, updateThread, addConversation, deleteThread };
