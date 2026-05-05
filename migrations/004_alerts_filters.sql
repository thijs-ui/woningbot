-- Klant-alerts: Tier 1+2 filter-uitbreiding.
-- Run in de Supabase SQL editor (Woningbot project: sqafsrknbfzhkbxqhqlu).
--
-- Voegt alle parser-velden toe die de matcher tot nu toe negeerde:
-- property_type, is_new_build, operation (sale/rent), bedrooms_max,
-- size_max_m2, bathrooms_min, neighborhoods, province, en extra features
-- (garage, elevator, air-conditioning, storage). Plus: location (single)
-- promoten naar locations[] zodat regio-zoekopdrachten als "Costa del Sol"
-- (5 steden) niet meer naar 1 stad gekapt worden.

alter table alerts
  -- Tier 1
  add column if not exists property_type        text,
  add column if not exists is_new_build         boolean,
  add column if not exists operation            text,
  add column if not exists max_rooms            int,
  add column if not exists max_size_m2          int,
  add column if not exists locations            text[],
  -- Tier 2
  add column if not exists min_bathrooms        int,
  add column if not exists neighborhoods        text[],
  add column if not exists province             text,
  add column if not exists has_garage           boolean,
  add column if not exists has_elevator         boolean,
  add column if not exists has_air_conditioning boolean,
  add column if not exists has_storage          boolean;

-- Bestaande single-location alerts: kopieer naar de array zodat de matcher
-- consistent locations[] kan lezen. De oude `location` kolom blijft staan
-- voor backward compat en zekerheid bij rollback.
update alerts
  set locations = array[location]
  where location is not null
    and (locations is null or cardinality(locations) = 0);

-- operation default 'sale' voor bestaande rijen zodat matcher niets
-- onverwacht filtert (parser default is sale).
update alerts
  set operation = 'sale'
  where operation is null;
