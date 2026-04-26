/**
 * query-logger.js — Per-query observability voor de woningbot.
 *
 * Sprint 0 van de verbeterstrategie: voordat we iets fixen, eerst zien WAT
 * er stuk gaat. Dit module verzamelt per /api/chat call:
 *   - intent + parser timings/uitkomst
 *   - per-portal scrape timings/counts
 *   - dedup/filter/selector counts
 *   - eind-status (success / parse_error / scrape_error / selector_error /
 *     no_results / exception)
 *
 * Logs gaan fire-and-forget naar de dashboard endpoint. Falen mag —
 * kritieke pad mag nooit hangen op logging.
 */

const DASHBOARD_URL = process.env.DASHBOARD_LOG_URL || '';
const DASHBOARD_KEY = process.env.DASHBOARD_LOG_KEY || process.env.API_SECRET_KEY || '';

class QueryLogger {
  constructor({ userMessage, sessionId = null, userId = null, source = 'web' }) {
    this.start = Date.now();
    this.userMessage = userMessage;
    this.sessionId = sessionId;
    this.userId = userId;
    this.source = source;
    this.intent = null;
    this.steps = {};
    this.selectedCount = null;
    this.totalFound = null;
  }

  setIntent(intent) {
    this.intent = intent;
  }

  /**
   * Helper om een stap te timen. Geeft een end-functie terug die je
   * aanroept met optioneel { count, error } om het resultaat te markeren.
   *
   *   const endParser = log.startStep('parser');
   *   try {
   *     const result = await parse(...);
   *     endParser({ filters: result.hard_filters });
   *   } catch (err) {
   *     endParser({ error: err.message });
   *     throw err;
   *   }
   */
  startStep(name) {
    const stepStart = Date.now();
    return (extras = {}) => {
      this.steps[name] = {
        ms: Date.now() - stepStart,
        ...extras,
      };
    };
  }

  /**
   * Voor scrapers: geneste structuur per portal.
   */
  startScrapeStep(portal) {
    const stepStart = Date.now();
    if (!this.steps.scrape) this.steps.scrape = {};
    return ({ count = null, error = null } = {}) => {
      this.steps.scrape[portal] = {
        ms: Date.now() - stepStart,
        count,
        error,
      };
    };
  }

  setCounts({ totalFound, selectedCount }) {
    if (totalFound != null) this.totalFound = totalFound;
    if (selectedCount != null) this.selectedCount = selectedCount;
  }

  /**
   * Markeer eind-status en stuur log fire-and-forget.
   */
  finish({ status, errorMessage = null }) {
    const totalMs = Date.now() - this.start;
    const payload = {
      user_id: this.userId,
      session_id: this.sessionId,
      user_message: this.userMessage,
      intent: this.intent,
      status,
      error_message: errorMessage,
      total_ms: totalMs,
      steps: this.steps,
      selected_count: this.selectedCount,
      total_found: this.totalFound,
      source: this.source,
    };

    if (!DASHBOARD_URL || !DASHBOARD_KEY) {
      // Dev / niet-geconfigureerd: log naar stdout zodat we het wél zien
      console.log('[QueryLogger]', JSON.stringify(payload));
      return;
    }

    // Fire-and-forget — exception negeren zodat logging nooit het kritieke
    // pad raakt. AbortController met 5s timeout.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    fetch(DASHBOARD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': DASHBOARD_KEY,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .catch((err) => {
        console.warn('[QueryLogger] Failed to ship log:', err.message);
      })
      .finally(() => clearTimeout(timeout));
  }
}

module.exports = { QueryLogger };
