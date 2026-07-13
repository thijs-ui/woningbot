/**
 * claude-retry.js — Shared retry wrapper for all Claude API calls.
 *
 * Handles:
 *   - HTTP 529 (overloaded) with exponential backoff
 *   - HTTP 500/502/503 (server errors) with retry
 *   - Fallback to a cheaper/more-available model after all retries fail
 *
 * Usage:
 *   const { claudeRetry } = require('./claude-retry');
 *   const response = await claudeRetry(claude, params);
 *
 * Where `claude` is an Anthropic client instance and `params` is the
 * object you'd normally pass to claude.messages.create().
 */

const FALLBACK_MODEL = process.env.CLAUDE_FALLBACK_MODEL || 'claude-haiku-4-5-20251001';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000; // 2s, 4s, 8s

/**
 * Call Claude with automatic retry on transient errors + fallback model.
 *
 * @param {object} claude - Anthropic client instance
 * @param {object} params - Parameters for claude.messages.create()
 * @param {object} opts - Optional: { maxRetries, fallback }
 *   - maxRetries: number of retries before giving up (default: 3)
 *   - fallback: whether to try fallback model after all retries (default: true)
 *   - label: log label for debugging (default: 'Claude')
 * @returns {object} - Claude API response
 */
async function claudeRetry(claude, params, opts = {}) {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const useFallback = opts.fallback !== false;
  const label = opts.label || 'Claude';
  const originalModel = params.model;

  let lastError;

  // Phase 1: Try with the original model
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await claude.messages.create(params);
    } catch (err) {
      lastError = err;
      const status = err.status || err.statusCode || 0;
      const isRetryable = status === 529 || status === 500 || status === 502 || status === 503;

      if (!isRetryable) {
        // Non-retryable error (400, 401, 403, 404, etc.) — throw immediately
        throw err;
      }

      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1); // 2s, 4s, 8s
      console.warn(`[${label}] Attempt ${attempt}/${maxRetries} failed (${status}). Retrying in ${delay}ms...`);

      if (attempt < maxRetries) {
        await sleep(delay);
      }
    }
  }

  // Phase 2: Try fallback model (if enabled and different from original)
  if (useFallback && FALLBACK_MODEL && FALLBACK_MODEL !== originalModel) {
    console.warn(`[${label}] All ${maxRetries} retries failed with ${originalModel}. Trying fallback model: ${FALLBACK_MODEL}`);

    try {
      const fallbackParams = { ...params, model: FALLBACK_MODEL };
      const response = await claude.messages.create(fallbackParams);
      console.log(`[${label}] Fallback model ${FALLBACK_MODEL} succeeded.`);
      return response;
    } catch (fallbackErr) {
      console.error(`[${label}] Fallback model ${FALLBACK_MODEL} also failed: ${fallbackErr.message}`);
      // Throw the original error, not the fallback error
    }
  }

  // All attempts exhausted
  throw lastError;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { claudeRetry };
