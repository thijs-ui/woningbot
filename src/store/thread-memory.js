const fs = require('fs');
const path = require('path');

/**
 * Thread memory with JSON file persistence.
 * Data survives Railway restarts.
 *
 * Key: thread_ts (string)
 * Value: {
 *   client_profile: object,
 *   all_properties: array,
 *   current_selection: array,
 *   photo_assessments: object,
 *   conversation_history: array,
 *   channel_id: string,
 *   original_query: string,
 *   created_at: number,
 * }
 */

const STORE_DIR = path.join(process.cwd(), '.thread-store');
const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours

// Ensure store directory exists
try {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
} catch (e) {
  console.warn('[ThreadMemory] Could not create store dir, falling back to memory-only:', e.message);
}

// In-memory cache
const threads = new Map();

/**
 * Sanitize thread_ts for use as filename.
 */
function tsToFilename(threadTs) {
  return threadTs.replace(/[^a-zA-Z0-9.-]/g, '_') + '.json';
}

/**
 * Persist a thread to disk (async, non-blocking).
 */
function persistToDisk(threadTs, data) {
  try {
    const filePath = path.join(STORE_DIR, tsToFilename(threadTs));
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
  } catch (e) {
    console.warn(`[ThreadMemory] Failed to persist thread ${threadTs}:`, e.message);
  }
}

/**
 * Load a thread from disk.
 */
function loadFromDisk(threadTs) {
  try {
    const filePath = path.join(STORE_DIR, tsToFilename(threadTs));
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn(`[ThreadMemory] Failed to load thread ${threadTs} from disk:`, e.message);
  }
  return null;
}

function getThread(threadTs) {
  // Check memory first
  if (threads.has(threadTs)) {
    return threads.get(threadTs);
  }
  // Try disk
  const fromDisk = loadFromDisk(threadTs);
  if (fromDisk) {
    threads.set(threadTs, fromDisk); // Cache in memory
    return fromDisk;
  }
  return null;
}

function setThread(threadTs, data) {
  threads.set(threadTs, data);
  persistToDisk(threadTs, data);
}

function updateThread(threadTs, updates) {
  const existing = getThread(threadTs);
  if (!existing) return false;
  const updated = { ...existing, ...updates };
  threads.set(threadTs, updated);
  persistToDisk(threadTs, updated);
  return true;
}

function addConversation(threadTs, role, text) {
  const existing = getThread(threadTs);
  if (!existing) return false;
  existing.conversation_history.push({ role, text, timestamp: new Date().toISOString() });
  persistToDisk(threadTs, existing);
  return true;
}

function deleteThread(threadTs) {
  threads.delete(threadTs);
  try {
    const filePath = path.join(STORE_DIR, tsToFilename(threadTs));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) { /* ignore */ }
}

// Clean up old threads every hour (both memory and disk)
setInterval(() => {
  const cutoff = Date.now() - MAX_AGE_MS;

  // Clean memory
  for (const [ts, data] of threads) {
    if ((data.created_at || 0) < cutoff) {
      threads.delete(ts);
    }
  }

  // Clean disk
  try {
    if (fs.existsSync(STORE_DIR)) {
      const files = fs.readdirSync(STORE_DIR);
      for (const file of files) {
        const filePath = path.join(STORE_DIR, file);
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const data = JSON.parse(raw);
          if ((data.created_at || 0) < cutoff) {
            fs.unlinkSync(filePath);
          }
        } catch (e) {
          // Corrupt file, remove it
          try { fs.unlinkSync(filePath); } catch (e2) { /* ignore */ }
        }
      }
    }
  } catch (e) { /* ignore */ }
}, 60 * 60 * 1000);

// Load existing threads from disk on startup
try {
  if (fs.existsSync(STORE_DIR)) {
    const files = fs.readdirSync(STORE_DIR);
    let loaded = 0;
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const file of files) {
      try {
        const filePath = path.join(STORE_DIR, file);
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        if ((data.created_at || 0) >= cutoff) {
          const threadTs = file.replace('.json', '').replace(/_/g, '.');
          threads.set(threadTs, data);
          loaded++;
        } else {
          fs.unlinkSync(path.join(STORE_DIR, file));
        }
      } catch (e) { /* skip corrupt files */ }
    }
    if (loaded > 0) console.log(`[ThreadMemory] Restored ${loaded} thread(s) from disk`);
  }
} catch (e) { /* ignore */ }

module.exports = { getThread, setThread, updateThread, addConversation, deleteThread };
