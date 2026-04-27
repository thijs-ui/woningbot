/**
 * query-cache.js — Redis-cache voor zoekqueries.
 *
 * Sprint 2 van de verbeterstrategie: zelfde genormaliseerde query van
 * twee consultants kort na elkaar = één Apify-call én één antwoord uit
 * cache (~200ms i.p.v. ~30-180s).
 *
 * Storage: Upstash Redis (zelfde KV-instance als rate-limiter op het
 * dashboard). Vereist op Railway:
 *   KV_REST_API_URL
 *   KV_REST_API_TOKEN
 *
 * Geen creds = cache uit (alle calls gaan door, niets opgeslagen).
 *
 * Cache key: SHA256 van JSON-stringified hard_filters van de parsed query.
 * Door dit AFTER-parser te doen, krijg je dezelfde hit voor "villa Estepona
 * 600k 3 slpk" en "Estepona villa met 3 slaapkamers €600.000" — beide
 * leveren dezelfde filters op.
 */

const { createHash } = require('crypto');

const TTL_SECONDS = 6 * 60 * 60; // 6 uur — vastgoed beweegt langzaam
const WARM_TTL_SECONDS = 24 * 60 * 60; // 24 uur voor prewarm-data
const IDEALISTA_TTL_SECONDS = 60 * 60; // 1 uur — Idealista per (stad + filters)
const KEY_PREFIX = 'wb:query:';
const WARM_PREFIX = 'wb:warm:';
const IDEALISTA_PREFIX = 'wb:ideal:';

let _redis = null;
function getRedis() {
  if (_redis !== null) return _redis;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.warn('[QueryCache] KV_REST_API_URL/TOKEN niet gezet — cache uit');
    _redis = false;
    return null;
  }
  try {
    const { Redis } = require('@upstash/redis');
    _redis = new Redis({ url, token });
    console.log('[QueryCache] Redis cache enabled');
    return _redis;
  } catch (err) {
    console.warn('[QueryCache] Could not init Redis:', err.message);
    _redis = false;
    return null;
  }
}

/**
 * Bereken de cache key uit hard_filters.
 * Sorteert keys deterministisch zodat {a:1,b:2} en {b:2,a:1} dezelfde hash geven.
 */
function computeKey(hardFilters) {
  const normalized = canonicalize(hardFilters || {});
  const json = JSON.stringify(normalized);
  const hash = createHash('sha256').update(json).digest('hex').slice(0, 16);
  return KEY_PREFIX + hash;
}

function canonicalize(obj) {
  if (Array.isArray(obj)) return obj.map(canonicalize).sort((a, b) => {
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  if (obj && typeof obj === 'object') {
    const sorted = {};
    Object.keys(obj).sort().forEach(k => {
      const v = obj[k];
      if (v == null) return; // skip nulls — matchen ze als afwezig zodat lege filters dezelfde key krijgen
      sorted[k] = canonicalize(v);
    });
    return sorted;
  }
  return obj;
}

/**
 * Probeer een gecachte response op te halen voor deze hard_filters.
 * @returns {Promise<object|null>} Gecachte response, of null bij miss/error/disabled
 */
async function get(hardFilters) {
  const r = getRedis();
  if (!r) return null;
  try {
    const key = computeKey(hardFilters);
    const value = await r.get(key);
    if (value) {
      console.log(`[QueryCache] HIT ${key}`);
      return typeof value === 'string' ? JSON.parse(value) : value;
    }
    console.log(`[QueryCache] MISS ${key}`);
    return null;
  } catch (err) {
    console.warn('[QueryCache] get failed:', err.message);
    return null;
  }
}

/**
 * Sla de response op voor deze hard_filters.
 */
async function set(hardFilters, response) {
  const r = getRedis();
  if (!r) return;
  try {
    const key = computeKey(hardFilters);
    // Upstash accepteert objecten direct; serializeer voor zekerheid
    await r.set(key, JSON.stringify(response), { ex: TTL_SECONDS });
    console.log(`[QueryCache] SET ${key} (TTL ${TTL_SECONDS}s)`);
  } catch (err) {
    console.warn('[QueryCache] set failed:', err.message);
  }
}

/**
 * Per-stad listing cache (gevuld door prewarm-cron).
 * Sla raw Idealista-listings op zonder filters; handleNewSearch past
 * filters daarna in-memory toe.
 */
async function getWarmListings(city) {
  const r = getRedis();
  if (!r || !city) return null;
  try {
    const key = WARM_PREFIX + city.toLowerCase();
    const value = await r.get(key);
    if (!value) return null;
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (err) {
    console.warn(`[QueryCache] warm get failed for ${city}:`, err.message);
    return null;
  }
}

async function setWarmListings(city, listings) {
  const r = getRedis();
  if (!r || !city) return;
  try {
    const key = WARM_PREFIX + city.toLowerCase();
    await r.set(key, JSON.stringify(listings || []), { ex: WARM_TTL_SECONDS });
    console.log(`[QueryCache] warm SET ${key} (${listings?.length || 0} listings, TTL ${WARM_TTL_SECONDS}s)`);
  } catch (err) {
    console.warn(`[QueryCache] warm set failed for ${city}:`, err.message);
  }
}

/**
 * Per-(stad + filters) Idealista cache. 1 uur TTL.
 *
 * Key bevat alleen de filters die het Apify-resultaat beïnvloeden:
 * price-bucket, bedrooms_min, bathrooms_min, size_min_m2, is_new_build,
 * property_type, features. Soft-criteria (zacht ranking) zit hier nooit in.
 */
function computeIdealistaKey(city, hardFilters) {
  const f = hardFilters || {};
  // Round price-buckets to 25k zodat 510k en 525k dezelfde cache-entry delen
  const priceMinBucket = f.price_min ? Math.floor(f.price_min / 25000) * 25000 : null;
  const priceMaxBucket = f.price_max ? Math.ceil(f.price_max / 25000) * 25000 : null;

  const subset = {
    price_min: priceMinBucket,
    price_max: priceMaxBucket,
    bedrooms_min: f.bedrooms_min || null,
    bathrooms_min: f.bathrooms_min || null,
    size_min_m2: f.size_min_m2 || null,
    is_new_build: f.is_new_build === true ? true : null,
    property_type: f.property_type || null,
    features: Array.isArray(f.features) && f.features.length > 0
      ? [...f.features].sort()
      : null,
  };
  const json = JSON.stringify(canonicalize(subset));
  const hash = createHash('sha256').update(json).digest('hex').slice(0, 12);
  return IDEALISTA_PREFIX + city.toLowerCase() + ':' + hash;
}

async function getIdealistaCity(city, hardFilters) {
  const r = getRedis();
  if (!r || !city) return null;
  try {
    const key = computeIdealistaKey(city, hardFilters);
    const value = await r.get(key);
    if (value) {
      console.log(`[QueryCache] Idealista HIT ${key}`);
      return typeof value === 'string' ? JSON.parse(value) : value;
    }
    console.log(`[QueryCache] Idealista MISS ${key}`);
    return null;
  } catch (err) {
    console.warn(`[QueryCache] Idealista get failed for ${city}:`, err.message);
    return null;
  }
}

async function setIdealistaCity(city, hardFilters, listings) {
  const r = getRedis();
  if (!r || !city) return;
  try {
    const key = computeIdealistaKey(city, hardFilters);
    await r.set(key, JSON.stringify(listings || []), { ex: IDEALISTA_TTL_SECONDS });
    console.log(`[QueryCache] Idealista SET ${key} (${listings?.length || 0} listings, TTL ${IDEALISTA_TTL_SECONDS}s)`);
  } catch (err) {
    console.warn(`[QueryCache] Idealista set failed for ${city}:`, err.message);
  }
}

/**
 * Wis cache (bv. handmatig voor debugging). Niet gebruikt in productie-flow.
 */
async function flush() {
  const r = getRedis();
  if (!r) return;
  try {
    const keys = await r.keys(KEY_PREFIX + '*');
    if (keys.length === 0) return 0;
    await r.del(...keys);
    return keys.length;
  } catch (err) {
    console.warn('[QueryCache] flush failed:', err.message);
    return 0;
  }
}

module.exports = {
  get,
  set,
  flush,
  computeKey,
  getWarmListings,
  setWarmListings,
  getIdealistaCity,
  setIdealistaCity,
  computeIdealistaKey,
};
