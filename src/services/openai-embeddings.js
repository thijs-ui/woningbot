/**
 * openai-embeddings.js — Wrapper voor OpenAI text-embedding-3-small.
 *
 * Wordt gebruikt voor:
 *   - Backfill (scripts/backfill-embeddings.js): batches van properties → vectors
 *   - Query-time (api.js handleNewSearch/handleNieuwbouw): soft-criteria → query vector
 *   - Scrape-integratie: nieuwe property direct embedden
 *
 * Output: array of 1536-dim floats per input. Eén batch-call kan tot 2048 inputs
 * en max 8191 tokens per input. Onze embedding-input is ~600 tokens dus ruim.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const OPENAI_EMBEDDING_URL = 'https://api.openai.com/v1/embeddings';

const MAX_RETRIES = 6;
const BASE_DELAY_MS = 1500;
const MAX_BATCH_SIZE = 30; // ~10K tokens per call op Tier-1 (40K TPM limiet)
const INTER_BATCH_SLEEP_MS = 16000; // ~16s tussen batches → max 4 batches/min × 10K = 40K TPM
const MAX_CHARS_PER_INPUT = 30000; // ~7500 tokens, ruim onder de 8191 limit

function isConfigured() {
  return Boolean(OPENAI_API_KEY);
}

function truncate(text) {
  if (!text) return '';
  return text.length > MAX_CHARS_PER_INPUT ? text.slice(0, MAX_CHARS_PER_INPUT) : text;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callOpenAI(inputs) {
  const res = await fetch(OPENAI_EMBEDDING_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_EMBEDDING_MODEL,
      input: inputs,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;

    // Parse retry-hint: header eerst, dan body-message ("Please try again in 25.659s")
    const retryAfterHeader = res.headers.get('retry-after');
    if (retryAfterHeader) {
      const secs = parseFloat(retryAfterHeader);
      if (!Number.isNaN(secs)) err.retryAfterMs = Math.ceil(secs * 1000);
    }
    if (!err.retryAfterMs) {
      const m = text.match(/try again in ([\d.]+)\s*s/i);
      if (m) err.retryAfterMs = Math.ceil(parseFloat(m[1]) * 1000);
    }

    throw err;
  }

  const json = await res.json();
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error(`OpenAI: malformed response (no data array)`);
  }

  // OpenAI garandeert volgorde via .index
  const sorted = [...json.data].sort((a, b) => a.index - b.index);
  return sorted.map(d => d.embedding);
}

async function withRetry(fn, label = 'OpenAI') {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = err.status || 0;
      const isRetryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 0;
      if (!isRetryable) throw err;

      // OpenAI's eigen wachttijd-hint heeft voorrang; anders exponential backoff
      const hinted = err.retryAfterMs || 0;
      const expo = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      const delay = Math.max(hinted, expo) + 500; // +500ms safety margin
      console.warn(`[${label}] Attempt ${attempt}/${MAX_RETRIES} failed (${status || err.message}). Retrying in ${delay}ms...`);
      if (attempt < MAX_RETRIES) await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Embed één tekst → één 1536-dim float array.
 */
async function embed(text) {
  if (!isConfigured()) throw new Error('OPENAI_API_KEY not set');
  if (!text || typeof text !== 'string') throw new Error('embed() requires a non-empty string');

  const input = truncate(text);
  const vectors = await withRetry(() => callOpenAI([input]), 'OpenAI:embed');
  return vectors[0];
}

/**
 * Embed een batch teksten → array van 1536-dim float arrays (zelfde volgorde).
 * Splitst automatisch in chunks van MAX_BATCH_SIZE.
 */
async function embedBatch(texts) {
  if (!isConfigured()) throw new Error('OPENAI_API_KEY not set');
  if (!Array.isArray(texts)) throw new Error('embedBatch() requires an array');
  if (texts.length === 0) return [];

  const inputs = texts.map(truncate);
  const out = [];

  for (let i = 0; i < inputs.length; i += MAX_BATCH_SIZE) {
    const chunk = inputs.slice(i, i + MAX_BATCH_SIZE);

    // Throttle tussen batches om TPM-limiet te respecteren (skip voor de eerste)
    if (i > 0) await sleep(INTER_BATCH_SLEEP_MS);

    const vectors = await withRetry(
      () => callOpenAI(chunk),
      `OpenAI:embedBatch[${i}-${i + chunk.length - 1}]`
    );
    out.push(...vectors);
  }

  return out;
}

/**
 * Cosine similarity tussen twee vectoren. OpenAI text-embedding-3-* output
 * is unit-normalized, dus dot product == cosine similarity. Geen normalisatie
 * nodig hier — scheelt twee Math.sqrt-calls.
 */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

module.exports = {
  isConfigured,
  embed,
  embedBatch,
  cosineSimilarity,
  MAX_BATCH_SIZE,
};
