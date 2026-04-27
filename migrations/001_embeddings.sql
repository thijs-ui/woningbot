-- Fase 5.1 — Embedding-based hybrid search
-- Run dit in de Supabase SQL editor (Woningbot project: sqafsrknbfzhkbxqhqlu).
--
-- Voorwaarde: pgvector extension al enabled.
--   create extension if not exists vector;
--
-- Voegt embedding-kolommen toe aan beide property-tabellen.
-- Index aanmaken kan ook ná de backfill — sneller. Maar voor < 10K rijen is het verschil verwaarloosbaar.

-- ─── Resales (resales_properties) ──────────────────────────────────────────

alter table resales_properties
  add column if not exists embedding vector(1536),
  add column if not exists embedded_at timestamptz;

create index if not exists resales_properties_embedding_idx
  on resales_properties
  using hnsw (embedding vector_cosine_ops);

-- ─── Nieuwbouw projecten (listings) ────────────────────────────────────────

alter table listings
  add column if not exists embedding vector(1536),
  add column if not exists embedded_at timestamptz;

create index if not exists listings_embedding_idx
  on listings
  using hnsw (embedding vector_cosine_ops);
