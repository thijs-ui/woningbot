/**
 * In-memory storage per Slack thread.
 * Key: thread_ts (string)
 * Value: {
 *   client_profile: object,     // Claude parser output (hard_filters + soft_criteria)
 *   all_properties: array,      // All scraped properties (~30)
 *   current_selection: array,   // Current top selections from Claude
 *   conversation_history: array, // [{role: 'consultant'|'bot', text: string}]
 *   channel_id: string,
 *   original_query: string,
 * }
 *
 * Memory is lost on restart. That's fine for V1.
 */

const threads = new Map();

function getThread(threadTs) {
  return threads.get(threadTs) || null;
}

function setThread(threadTs, data) {
  threads.set(threadTs, data);
}

function updateThread(threadTs, updates) {
  const existing = threads.get(threadTs);
  if (!existing) return false;
  threads.set(threadTs, { ...existing, ...updates });
  return true;
}

function addConversation(threadTs, role, text) {
  const existing = threads.get(threadTs);
  if (!existing) return false;
  existing.conversation_history.push({ role, text, timestamp: new Date().toISOString() });
  return true;
}

function deleteThread(threadTs) {
  threads.delete(threadTs);
}

// Clean up old threads (older than 24 hours) every hour
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [ts, data] of threads) {
    const created = data.created_at || 0;
    if (created < cutoff) {
      threads.delete(ts);
    }
  }
}, 60 * 60 * 1000);

module.exports = { getThread, setThread, updateThread, addConversation, deleteThread };
