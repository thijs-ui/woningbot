-- Fase 5.1 — Hybrid search RPC functions
-- Run dit in de Supabase SQL editor (Woningbot project) NA migratie 001.
--
-- Twee RPC-functies, één per tabel. Beiden accepteren:
--   - query_embedding (vector(1536)) — optioneel; null = geen vector-rank, gewoon prijs ASC
--   - match_count (int) — hoeveel rijen retourneren
--   - hard filters — prijs, kamers, type, locaties, etc.
--
-- Returnt rij + similarity-score (0..1, 0 als geen embedding gegeven).

-- ─── Resales (resales_properties) ──────────────────────────────────────────

create or replace function search_resales_hybrid(
  query_embedding vector(1536) default null,
  match_count int default 30,
  filter_price_min numeric default null,
  filter_price_max numeric default null,
  filter_bedrooms_min int default null,
  filter_bathrooms_min int default null,
  filter_size_min int default null,
  filter_property_type text default null,
  filter_locations text[] default null,
  filter_pool boolean default null,
  filter_new_build boolean default null
)
returns table (
  ref text,
  url text,
  price numeric,
  currency text,
  property_type text,
  town text,
  province text,
  latitude numeric,
  longitude numeric,
  beds int,
  baths int,
  built_m2 numeric,
  plot_m2 numeric,
  pool boolean,
  new_build boolean,
  features jsonb,
  desc_nl text,
  desc_en text,
  images jsonb,
  similarity float
)
language plpgsql
stable
as $$
begin
  return query
  select
    p.ref,
    p.url,
    p.price,
    p.currency,
    p.property_type,
    p.town,
    p.province,
    p.latitude,
    p.longitude,
    p.beds,
    p.baths,
    p.built_m2,
    p.plot_m2,
    p.pool,
    p.new_build,
    p.features,
    p.desc_nl,
    p.desc_en,
    p.images,
    case
      when query_embedding is null or p.embedding is null then 0::float
      else (1 - (p.embedding <=> query_embedding))::float
    end as similarity
  from resales_properties p
  where
    p.price_freq = 'sale'
    and (filter_price_min is null or p.price >= filter_price_min)
    and (filter_price_max is null or p.price <= filter_price_max)
    and (filter_bedrooms_min is null or p.beds >= filter_bedrooms_min)
    and (filter_bathrooms_min is null or p.baths >= filter_bathrooms_min)
    and (filter_size_min is null or p.built_m2 >= filter_size_min)
    and (filter_property_type is null or p.property_type = filter_property_type)
    and (
      filter_locations is null
      or array_length(filter_locations, 1) is null
      or exists (
        select 1
        from unnest(filter_locations) as loc
        where p.town ilike '%' || loc || '%'
           or p.province ilike '%' || loc || '%'
      )
    )
    and (filter_pool is null or filter_pool = false or p.pool = true)
    and (filter_new_build is null or p.new_build = filter_new_build)
    -- Bij vector-zoeken: vereis embedding aanwezig (anders zou null naar voren komen)
    and (query_embedding is null or p.embedding is not null)
  order by
    case when query_embedding is null then null
         else (p.embedding <=> query_embedding)
    end asc nulls last,
    p.price asc
  limit match_count;
end;
$$;

-- ─── Nieuwbouw projecten (listings) ────────────────────────────────────────

create or replace function search_listings_hybrid(
  query_embedding vector(1536) default null,
  match_count int default 30,
  filter_price_min numeric default null,
  filter_price_max numeric default null,
  filter_bedrooms_min int default null,
  filter_bathrooms_min int default null,
  filter_size_min int default null,
  filter_locations text[] default null,
  filter_project_name text default null
)
returns table (
  id uuid,
  property_code text,
  url text,
  title text,
  description text,
  price numeric,
  price_per_m2 numeric,
  size_m2 numeric,
  rooms int,
  bathrooms int,
  province text,
  municipality text,
  district text,
  address text,
  latitude numeric,
  longitude numeric,
  property_type text,
  is_new_development boolean,
  has_lift boolean,
  has_parking boolean,
  has_swimming_pool boolean,
  has_terrace boolean,
  has_air_conditioning boolean,
  has_garden boolean,
  has_storage_room boolean,
  num_photos int,
  main_image_url text,
  agency_name text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  is_active boolean,
  similarity float
)
language plpgsql
stable
as $$
begin
  return query
  select
    l.id,
    l.property_code,
    l.url,
    l.title,
    l.description,
    l.price,
    l.price_per_m2,
    l.size_m2,
    l.rooms,
    l.bathrooms,
    l.province,
    l.municipality,
    l.district,
    l.address,
    l.latitude,
    l.longitude,
    l.property_type,
    l.is_new_development,
    l.has_lift,
    l.has_parking,
    l.has_swimming_pool,
    l.has_terrace,
    l.has_air_conditioning,
    l.has_garden,
    l.has_storage_room,
    l.num_photos,
    l.main_image_url,
    l.agency_name,
    l.first_seen_at,
    l.last_seen_at,
    l.is_active,
    case
      when query_embedding is null or l.embedding is null then 0::float
      else (1 - (l.embedding <=> query_embedding))::float
    end as similarity
  from listings l
  where
    l.is_active = true
    and (filter_price_min is null or l.price >= filter_price_min)
    and (filter_price_max is null or l.price <= filter_price_max)
    and (filter_bedrooms_min is null or l.rooms >= filter_bedrooms_min)
    and (filter_bathrooms_min is null or l.bathrooms >= filter_bathrooms_min)
    and (filter_size_min is null or l.size_m2 >= filter_size_min)
    and (
      filter_locations is null
      or array_length(filter_locations, 1) is null
      or exists (
        select 1
        from unnest(filter_locations) as loc
        where l.municipality ilike '%' || loc || '%'
           or l.province ilike '%' || loc || '%'
      )
    )
    and (
      filter_project_name is null
      or l.title ilike '%' || filter_project_name || '%'
      or l.description ilike '%' || filter_project_name || '%'
      or l.address ilike '%' || filter_project_name || '%'
    )
    and (query_embedding is null or l.embedding is not null)
  order by
    case when query_embedding is null then null
         else (l.embedding <=> query_embedding)
    end asc nulls last,
    l.price asc
  limit match_count;
end;
$$;

-- ─── Permissions ───────────────────────────────────────────────────────────
-- Geef de anon en authenticated rollen toegang tot beide RPCs (PostgREST
-- vereist execute-permissie om ze via REST aan te roepen).

grant execute on function search_resales_hybrid to anon, authenticated, service_role;
grant execute on function search_listings_hybrid to anon, authenticated, service_role;
