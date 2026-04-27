-- Klant-alerts vanuit dashboard — Fase A
-- Run dit in de Supabase SQL editor (Woningbot project: sqafsrknbfzhkbxqhqlu).
--
-- Voegt kolommen toe aan de bestaande `alerts` tabel zodat één alert aan
-- een dashboard-klant (shortlist) gekoppeld kan worden. shortlist_id is
-- géén foreign key — shortlists leven in een ander Supabase-project, dus
-- we slaan de UUID op als referentie + denormaliseren klant_naam voor de DM.

alter table alerts
  add column if not exists shortlist_id uuid,
  add column if not exists klant_naam text,
  add column if not exists query_text text,
  add column if not exists dashboard_user_email text;

-- Index voor snelle lookup per shortlist (bij management-pagina + dedup-check)
create index if not exists alerts_shortlist_id_idx on alerts(shortlist_id);
