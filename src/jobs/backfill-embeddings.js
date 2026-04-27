/**
 * backfill-embeddings.js — Embed alle properties zonder embedding.
 *
 * Resumable: filtert op `embedding is null`, dus opnieuw runnen pakt op waar
 * de vorige run stopte. Tabel-keuze via CLI:
 *
 *   node src/jobs/backfill-embeddings.js              # beide tabellen
 *   node src/jobs/backfill-embeddings.js resales      # alleen resales_properties
 *   node src/jobs/backfill-embeddings.js listings     # alleen listings (nieuwbouw)
 *
 * Vereiste env:
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY  (voor write-permissies; valt anders terug op SUPABASE_KEY/ANON)
 *   - OPENAI_API_KEY
 */

require('dotenv').config();

const { embedBatch, isConfigured: isOpenAIConfigured } = require('../services/openai-embeddings');
const {
  buildResalesEmbeddingInput,
  buildListingEmbeddingInput,
} = require('../services/embedding-input');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  '';

const PAGE_SIZE = 100;

const TABLE_CONFIG = {
  resales: {
    table: 'resales_properties',
    pkCol: 'ref',
    selectCols:
      'ref,url,property_type,town,province,pool,new_build,features,desc_nl,desc_en',
    builder: buildResalesEmbeddingInput,
  },
  listings: {
    table: 'listings',
    pkCol: 'id',
    selectCols:
      'id,title,description,property_type,municipality,district,province,is_new_development,has_lift,has_parking,has_swimming_pool,has_terrace,has_air_conditioning,has_garden,has_storage_room,agency_name',
    builder: buildListingEmbeddingInput,
  },
};

// ─── Supabase REST helpers ─────────────────────────────────────────────────

function authHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function fetchPage(cfg) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${cfg.table}`);
  url.searchParams.set('select', cfg.selectCols);
  url.searchParams.set('embedding', 'is.null');
  url.searchParams.set('limit', String(PAGE_SIZE));
  url.searchParams.set('order', `${cfg.pkCol}.asc`);

  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase fetch ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function countRemaining(cfg) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${cfg.table}`);
  url.searchParams.set('select', cfg.pkCol);
  url.searchParams.set('embedding', 'is.null');
  url.searchParams.set('limit', '1');

  const res = await fetch(url, {
    headers: { ...authHeaders(), Prefer: 'count=exact' },
  });
  if (!res.ok) return null;
  const range = res.headers.get('content-range') || '';
  const m = range.match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function vectorToPgString(vec) {
  // pgvector accepteert text-formaat '[v1,v2,...]'
  return `[${vec.join(',')}]`;
}

async function patchRow(cfg, pkValue, embedding) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${cfg.table}`);
  url.searchParams.set(cfg.pkCol, `eq.${pkValue}`);

  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...authHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      embedding: vectorToPgString(embedding),
      embedded_at: new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH ${cfg.table} ${pkValue}: ${res.status} ${text.slice(0, 200)}`);
  }
}

// ─── Main loop per tabel ───────────────────────────────────────────────────

async function backfillTable(key) {
  const cfg = TABLE_CONFIG[key];
  if (!cfg) throw new Error(`Unknown table key: ${key}`);

  console.log(`\n[Backfill:${key}] Start — tabel "${cfg.table}"`);

  const initialCount = await countRemaining(cfg);
  if (initialCount !== null) {
    console.log(`[Backfill:${key}] ${initialCount} rijen zonder embedding`);
  }

  let totalDone = 0;
  let totalFailed = 0;
  let pageNum = 0;

  while (true) {
    pageNum++;
    const rows = await fetchPage(cfg);

    if (rows.length === 0) {
      console.log(`[Backfill:${key}] Klaar — geen rijen meer zonder embedding`);
      break;
    }

    // Bouw inputs
    const inputs = rows.map(r => cfg.builder(r));
    const validIdx = inputs
      .map((txt, i) => (txt && txt.trim().length > 10 ? i : -1))
      .filter(i => i >= 0);

    if (validIdx.length === 0) {
      console.warn(
        `[Backfill:${key}] Page ${pageNum}: alle ${rows.length} rijen hebben lege/te korte embedding-input — overslaan`
      );
      // Markeer ze met een dummy embedded_at = nu? Nee — dat verbergt het probleem.
      // Stop hier zodat we anders in een infinite loop draaien.
      console.warn(`[Backfill:${key}] Stop — risico op infinite loop`);
      break;
    }

    const validInputs = validIdx.map(i => inputs[i]);
    const validRows = validIdx.map(i => rows[i]);

    let vectors;
    try {
      vectors = await embedBatch(validInputs);
    } catch (err) {
      console.error(`[Backfill:${key}] Page ${pageNum} embed-fout: ${err.message}`);
      totalFailed += validRows.length;
      // Probeer volgende page
      continue;
    }

    // Schrijf 1-voor-1 terug (Supabase REST PATCH heeft geen bulk per-row update)
    let pageDone = 0;
    let pageFailed = 0;

    // Lichte concurrency: 10 PATCH-calls parallel
    const CONCURRENCY = 10;
    for (let i = 0; i < validRows.length; i += CONCURRENCY) {
      const batch = validRows.slice(i, i + CONCURRENCY);
      const batchVecs = vectors.slice(i, i + CONCURRENCY);

      const results = await Promise.allSettled(
        batch.map((row, j) => patchRow(cfg, row[cfg.pkCol], batchVecs[j]))
      );

      for (const r of results) {
        if (r.status === 'fulfilled') pageDone++;
        else {
          pageFailed++;
          console.error(`[Backfill:${key}] PATCH-fout: ${r.reason?.message || r.reason}`);
        }
      }
    }

    totalDone += pageDone;
    totalFailed += pageFailed;

    const remaining = await countRemaining(cfg);
    console.log(
      `[Backfill:${key}] Page ${pageNum}: ${pageDone} ok, ${pageFailed} fout — totaal ${totalDone} klaar${
        remaining !== null ? `, ${remaining} resterend` : ''
      }`
    );

    // Veiligheidsklep: als deze hele page faalde, stop
    if (pageDone === 0) {
      console.error(`[Backfill:${key}] Hele page mislukt — stop`);
      break;
    }
  }

  console.log(`[Backfill:${key}] Eindresultaat: ${totalDone} ok, ${totalFailed} fout`);
  return { done: totalDone, failed: totalFailed };
}

// ─── Entry point ───────────────────────────────────────────────────────────

async function main() {
  if (!isOpenAIConfigured()) {
    console.error('OPENAI_API_KEY niet ingesteld — abort');
    process.exit(1);
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('SUPABASE_URL of SUPABASE_KEY niet ingesteld — abort');
    process.exit(1);
  }

  const arg = (process.argv[2] || 'all').toLowerCase();
  const targets =
    arg === 'all'
      ? ['resales', 'listings']
      : arg in TABLE_CONFIG
      ? [arg]
      : null;

  if (!targets) {
    console.error(`Onbekend argument "${arg}". Gebruik: resales | listings | all`);
    process.exit(1);
  }

  const results = {};
  for (const key of targets) {
    try {
      results[key] = await backfillTable(key);
    } catch (err) {
      console.error(`[Backfill:${key}] Fataal: ${err.message}`);
      results[key] = { done: 0, failed: -1, error: err.message };
    }
  }

  console.log('\n===== Samenvatting =====');
  for (const [key, r] of Object.entries(results)) {
    console.log(`  ${key}: ${r.done} klaar, ${r.failed} fout${r.error ? ` (${r.error})` : ''}`);
  }
}

main().catch(err => {
  console.error('Fataal:', err);
  process.exit(1);
});
