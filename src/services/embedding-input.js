/**
 * embedding-input.js — Bouwt gestructureerde tekst voor embedding-input.
 *
 * Twee builders, één per tabel:
 *   - buildResalesEmbeddingInput(row)   → resales_properties
 *   - buildListingEmbeddingInput(row)   → listings (nieuwbouw)
 *
 * We embedden bewust géén harde filters (prijs, kamers, oppervlakte). Die zijn
 * al exact-match in de SQL. We embedden semantische signalen: type, locatie,
 * sfeer, kenmerken, beschrijving. De LLM-embedding pakt synoniemen en nuance
 * vanzelf op (wijngaard ↔ viñedo ↔ vineyard).
 */

const MAX_DESC_CHARS = 3000; // ~750 tokens — ruim genoeg, voorkomt marketingruis

// ─── Helpers ───────────────────────────────────────────────────────────────

function cleanText(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/<[^>]+>/g, ' ')           // strip HTML tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')               // collapse whitespace
    .trim();
}

function truncateDescription(text) {
  const cleaned = cleanText(text);
  return cleaned.length > MAX_DESC_CHARS ? cleaned.slice(0, MAX_DESC_CHARS) : cleaned;
}

function joinNonEmpty(parts, sep = ', ') {
  return parts.filter(p => p && String(p).trim().length > 0).join(sep);
}

// ─── Resales builder ───────────────────────────────────────────────────────

function buildResalesEmbeddingInput(row) {
  const type = row.property_type || 'woning';

  const locatie = joinNonEmpty([row.town, row.province]);

  const kenmerken = [];
  if (row.pool) kenmerken.push('zwembad');
  if (row.new_build) kenmerken.push('nieuwbouw');
  if (Array.isArray(row.features)) {
    for (const f of row.features) {
      if (f && typeof f === 'string') kenmerken.push(f.toLowerCase());
    }
  }

  const beschrijving = truncateDescription(row.desc_nl || row.desc_en || '');

  const lines = [
    `Type: ${type}`,
    locatie ? `Locatie: ${locatie}` : null,
    kenmerken.length > 0 ? `Kenmerken: ${joinNonEmpty(kenmerken)}` : null,
    beschrijving ? `Beschrijving: ${beschrijving}` : null,
  ].filter(Boolean);

  return lines.join('\n');
}

// ─── Nieuwbouw (listings) builder ──────────────────────────────────────────

function buildListingEmbeddingInput(row) {
  const type = row.property_type || (row.is_new_development ? 'nieuwbouwproject' : 'woning');

  const locatie = joinNonEmpty([row.municipality, row.district, row.province]);

  const kenmerken = [];
  if (row.has_swimming_pool) kenmerken.push('zwembad');
  if (row.has_terrace) kenmerken.push('terras');
  if (row.has_garden) kenmerken.push('tuin');
  if (row.has_parking) kenmerken.push('parking');
  if (row.has_lift) kenmerken.push('lift');
  if (row.has_air_conditioning) kenmerken.push('airco');
  if (row.has_storage_room) kenmerken.push('berging');
  if (row.is_new_development) kenmerken.push('nieuwbouw');

  const beschrijving = truncateDescription(row.description || '');

  const titel = cleanText(row.title || '');

  const lines = [
    `Type: ${type}`,
    titel ? `Titel: ${titel}` : null,
    locatie ? `Locatie: ${locatie}` : null,
    kenmerken.length > 0 ? `Kenmerken: ${joinNonEmpty(kenmerken)}` : null,
    row.agency_name ? `Ontwikkelaar: ${row.agency_name}` : null,
    beschrijving ? `Beschrijving: ${beschrijving}` : null,
  ].filter(Boolean);

  return lines.join('\n');
}

// ─── Post-mapped listing builder (Idealista, etc.) ─────────────────────────

/**
 * Bouwt embedding-input uit een listing in het interne unified format
 * (output van Idealista mapper of supabase-search.mapRow). Wordt gebruikt
 * voor on-the-fly embedding van live-scrape resultaten zodat de selector
 * ook semantic_match krijgt op niet-DB-rijen.
 */
function buildListingPostMappedInput(listing) {
  if (!listing || typeof listing !== 'object') return null;

  const type = listing.property_type || 'woning';
  const locatie = joinNonEmpty([
    listing.municipality || listing.location,
    listing.district,
    listing.province,
  ]);

  const kenmerken = [];
  if (Array.isArray(listing.features)) {
    for (const f of listing.features) {
      if (f && typeof f === 'string') kenmerken.push(f.toLowerCase());
    }
  }
  if (listing.is_new_build) kenmerken.push('nieuwbouw');

  const beschrijving = truncateDescription(listing.description || '');
  const titel = cleanText(listing.title || '');

  const lines = [
    `Type: ${type}`,
    titel ? `Titel: ${titel}` : null,
    locatie ? `Locatie: ${locatie}` : null,
    kenmerken.length > 0 ? `Kenmerken: ${joinNonEmpty(kenmerken)}` : null,
    beschrijving ? `Beschrijving: ${beschrijving}` : null,
  ].filter(Boolean);

  if (lines.length === 0) return null;
  return lines.join('\n');
}

// ─── Soft-criteria query builder ───────────────────────────────────────────

/**
 * Bouwt embed-input uit `soft_criteria` van de Claude-parser. Zelfde structuur
 * als de property-embeddings zodat semantiek aligned: "Stijl: X — Must haves:
 * Y — Levensstijl: Z" matcht "Type: villa — Locatie: ... — Kenmerken: ...".
 *
 * Returnt null als er niets zinnigs te embedden is — caller skipt dan vector-search.
 */
function buildSoftQueryInput(softCriteria) {
  if (!softCriteria || typeof softCriteria !== 'object') return null;

  const lines = [];

  if (softCriteria.style_preferences && String(softCriteria.style_preferences).trim()) {
    lines.push(`Stijl: ${cleanText(softCriteria.style_preferences)}`);
  }

  const mustHaves = Array.isArray(softCriteria.must_haves)
    ? softCriteria.must_haves.filter(Boolean)
    : [];
  if (mustHaves.length > 0) {
    lines.push(`Must haves: ${mustHaves.map(cleanText).join(', ')}`);
  }

  if (softCriteria.lifestyle_notes && String(softCriteria.lifestyle_notes).trim()) {
    lines.push(`Levensstijl: ${cleanText(softCriteria.lifestyle_notes)}`);
  }

  // Dealbreakers bewust niet in embedding — die werken via exclusie, niet ranking
  // (een listing met "wel buren" zou anders dichtbij "geen buren" liggen).

  if (lines.length === 0) return null;
  const joined = lines.join('\n');
  return joined.trim().length >= 10 ? joined : null;
}

module.exports = {
  buildResalesEmbeddingInput,
  buildListingEmbeddingInput,
  buildListingPostMappedInput,
  buildSoftQueryInput,
};
