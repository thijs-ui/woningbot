-- Sprint plot-filter — perceeloppervlak als hard filter op resales-search.
-- Run in de Supabase SQL editor (Woningbot project) NA migratie 002.
--
-- Aanleiding: prompts als "Finca Mijas, perceel 2000m²+" eindigden in
-- no_results omdat de parser geen plot-veld kende en "perceel 2000m²+" als
-- size_min_m2 (= woonoppervlak) interpreteerde. Met deze filter kan de
-- parser plot_min_m2 als apart veld doorgeven en filtert de RPC native op
-- plot_m2 ipv built_m2.
--
-- Alleen resales — listings (nieuwbouw-units) hebben geen plot-veld.

-- Stap 1: drop de oude overload (11 parameters, zonder filter_plot_min).
-- CREATE OR REPLACE matcht alleen op exact dezelfde signature; het
-- toevoegen van een parameter zou anders een tweede overload aanmaken
-- waardoor PostgREST de RPC niet meer eenduidig kan resolven.
drop function if exists search_resales_hybrid(
  vector(1536),
  int,
  numeric,
  numeric,
  int,
  int,
  int,
  text,
  text[],
  boolean,
  boolean
);

-- Stap 2: create de nieuwe versie met filter_plot_min als 12e parameter.
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
  filter_new_build boolean default null,
  filter_plot_min int default null
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
    and (filter_plot_min is null or p.plot_m2 >= filter_plot_min)
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
    and (query_embedding is null or p.embedding is not null)
  order by
    case when query_embedding is null then null
         else (p.embedding <=> query_embedding)
    end asc nulls last,
    p.price asc
  limit match_count;
end;
$$;

grant execute on function search_resales_hybrid to anon, authenticated, service_role;
