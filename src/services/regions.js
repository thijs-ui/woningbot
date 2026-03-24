/**
 * regions.js — Costa Select region/city mapping and project grouping utilities.
 *
 * Extracted from nieuwbouw-scraper.js to remove Apify dependency.
 * Used by: nieuwbouw.js, and any module needing region lookups.
 */

// ─── Region definitions ────────────────────────────────────────────────────

const COSTA_SELECT_REGIONS = {
  'Costa del Sol': [
    'Estepona', 'Marbella', 'Mijas', 'Fuengirola', 'Benalmadena',
    'Torremolinos', 'Malaga', 'Nerja', 'Manilva', 'Casares',
    'Benahavis', 'Rincon de la Victoria', 'Velez-Malaga', 'Torrox',
  ],
  'Costa Blanca South': [
    'Torrevieja', 'Orihuela', 'Guardamar del Segura', 'Rojales',
    'Pilar de la Horadada', 'Santa Pola', 'Alicante', 'Elche',
  ],
  'Costa Blanca North': [
    'Javea', 'Denia', 'Moraira', 'Calpe', 'Altea', 'Benidorm',
  ],
  'Valencia': [
    'Valencia', 'Gandia',
  ],
};

// ─── Municipality-to-region mapping ────────────────────────────────────────

const MUNICIPALITY_TO_REGION = {};
for (const [region, cities] of Object.entries(COSTA_SELECT_REGIONS)) {
  for (const city of cities) {
    MUNICIPALITY_TO_REGION[city.toLowerCase()] = region;
  }
}

// Alternate spellings
MUNICIPALITY_TO_REGION['málaga'] = 'Costa del Sol';
MUNICIPALITY_TO_REGION['benalmádena'] = 'Costa del Sol';
MUNICIPALITY_TO_REGION['benahavís'] = 'Costa del Sol';
MUNICIPALITY_TO_REGION['vélez-málaga'] = 'Costa del Sol';
MUNICIPALITY_TO_REGION['rincón de la victoria'] = 'Costa del Sol';
MUNICIPALITY_TO_REGION['jávea'] = 'Costa Blanca North';
MUNICIPALITY_TO_REGION['dénia'] = 'Costa Blanca North';
MUNICIPALITY_TO_REGION['gandía'] = 'Valencia';
MUNICIPALITY_TO_REGION['san pedro de alcántara'] = 'Costa del Sol';
MUNICIPALITY_TO_REGION['san pedro de alcantara'] = 'Costa del Sol';
MUNICIPALITY_TO_REGION['nueva andalucia'] = 'Costa del Sol';
MUNICIPALITY_TO_REGION['nueva andalucía'] = 'Costa del Sol';
MUNICIPALITY_TO_REGION['orihuela costa'] = 'Costa Blanca South';

// ─── Lookup functions ──────────────────────────────────────────────────────

function getAllCities() {
  return Object.values(COSTA_SELECT_REGIONS).flat();
}

function getRegionForCity(city) {
  if (!city) return 'Overig';
  const normalized = city.toLowerCase().trim();
  if (MUNICIPALITY_TO_REGION[normalized]) return MUNICIPALITY_TO_REGION[normalized];

  // Partial match
  for (const [key, region] of Object.entries(MUNICIPALITY_TO_REGION)) {
    if (normalized.includes(key) || key.includes(normalized)) return region;
  }

  // Province-based fallback
  if (normalized.includes('málaga') || normalized.includes('malaga')) return 'Costa del Sol';
  if (normalized.includes('alicante')) return 'Costa Blanca South';
  if (normalized.includes('valencia')) return 'Valencia';

  return 'Overig';
}

// ─── Project grouping (for nieuwbouw) ──────────────────────────────────────

/**
 * Extract project name from listing title/description.
 */
function extractProjectName(title, desc) {
  if (!title) return 'Onbekend project';

  // Pattern 1: "in [Project Name]"
  const inMatch = title.match(/\bin\s+([A-ZÀ-Ú][A-Za-zÀ-ÿ\s\-'&]{2,50}?)(?:\s*,|\s*$)/);
  if (inMatch) {
    const name = inMatch[1].trim();
    if (!isGenericLocation(name)) return name;
  }

  // Pattern 2: Known project keywords in description
  const combined = `${title} ${desc || ''}`;
  const descPatterns = [
    /(?:residencial|residencia|urbanización|urbanizacion|complejo|promoción|promocion|proyecto|project|resort|residence|gardens|village|park)\s+([A-ZÀ-Ú][A-Za-zÀ-ÿ\s\-'&]{2,40})/i,
    /(?:fase|phase)\s+\d+\s+(?:of|de)\s+([A-ZÀ-Ú][A-Za-zÀ-ÿ\s\-'&]{2,40})/i,
  ];
  for (const pattern of descPatterns) {
    const match = combined.match(pattern);
    if (match) return match[1].trim();
  }

  // Pattern 3: Title after property type prefix
  const typePrefix = /^(?:flat|house|apartment|penthouse|duplex|villa|chalet|semi-detached house|terraced house|detached house|studio|bungalow|ground floor)\s+/i;
  const afterType = title.replace(typePrefix, '').trim();
  if (afterType.length > 3 && afterType.length < 60 && afterType !== title) {
    const afterIn = afterType.match(/^in\s+(.+)/i);
    if (afterIn) {
      const candidate = afterIn[1].split(',')[0].trim();
      if (!isGenericLocation(candidate)) return candidate;
    }
  }

  // Fallback: truncated title
  return title.substring(0, 60).trim() || 'Onbekend project';
}

function isGenericLocation(name) {
  const lower = name.toLowerCase();
  return !!MUNICIPALITY_TO_REGION[lower] || GENERIC_LOCATION_WORDS.includes(lower);
}

const GENERIC_LOCATION_WORDS = [
  'spain', 'españa', 'costa del sol', 'costa blanca', 'costa',
  'andalucia', 'andalucía', 'comunidad valenciana',
];

/**
 * Group individual listings into projects.
 * Multiple units from the same development become one project row.
 */
function groupIntoProjects(listings) {
  const projects = new Map();

  for (const listing of listings) {
    const key = buildProjectKey(listing);

    if (projects.has(key)) {
      const existing = projects.get(key);
      if (listing.price) {
        if (!existing.price_from || listing.price < existing.price_from) existing.price_from = listing.price;
        if (!existing.price_to || listing.price > existing.price_to) existing.price_to = listing.price;
      }
      if (listing.bedrooms && !existing.bedroom_types.includes(listing.bedrooms)) {
        existing.bedroom_types.push(listing.bedrooms);
      }
      if (listing.property_type && !existing.unit_types.includes(listing.property_type)) {
        existing.unit_types.push(listing.property_type);
      }
      if (listing.description && listing.description.length > (existing.description || '').length) {
        existing.description = listing.description;
      }
      for (const f of (listing.features || [])) {
        if (!existing.features.includes(f)) existing.features.push(f);
      }
      existing.unit_count++;
      if (!existing.url && listing.url) existing.url = listing.url;
      // Merge sources
      if (listing.source && !existing.sources.includes(listing.source)) {
        existing.sources.push(listing.source);
      }
    } else {
      projects.set(key, {
        project_name: listing.project_name,
        developer: listing.developer || 'Onbekend',
        region: listing.region,
        location: listing.location,
        municipality: listing.municipality,
        price_from: listing.price,
        price_to: listing.price,
        bedroom_types: listing.bedrooms ? [listing.bedrooms] : [],
        unit_types: listing.property_type ? [listing.property_type] : [],
        size_m2: listing.size_m2,
        description: listing.description,
        url: listing.url,
        sources: [listing.source || 'idealista'],
        thumbnail: listing.thumbnail,
        features: [...(listing.features || [])],
        unit_count: 1,
      });
    }
  }

  return Array.from(projects.values());
}

function buildProjectKey(listing) {
  const dev = (listing.developer || 'unknown').toLowerCase().trim();
  const name = (listing.project_name || '').toLowerCase().trim()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '');
  const muni = (listing.municipality || '').toLowerCase().trim();

  const genericNames = ['flat', 'house', 'apartment', 'penthouse', 'duplex', 'villa', 'chalet',
    'semi-detached house', 'terraced house', 'detached house', 'studio', 'bungalow',
    'ground floor', 'onbekend project'];
  const isGeneric = genericNames.includes(name) || name.length < 3;

  if (isGeneric) {
    return `${dev}|${muni}|generic`;
  }
  return `${name}|${muni}`;
}

/**
 * Convert a grouped project into a display row.
 */
function projectToDisplayRow(project) {
  const bedroomStr = project.bedroom_types.length > 0
    ? project.bedroom_types.sort((a, b) => a - b).join(', ')
    : '';
  const typeStr = project.unit_types.length > 0
    ? [...new Set(project.unit_types)].join(', ')
    : '';

  return {
    project_name: project.project_name || 'Onbekend project',
    developer: project.developer || 'Onbekend',
    region: project.region || 'Overig',
    location: project.location || '',
    property_type: typeStr,
    price_from: project.price_from || null,
    price_to: project.price_to || null,
    bedrooms: bedroomStr,
    size_m2: project.size_m2 || null,
    description: (project.description || '').substring(0, 300),
    url: project.url || '',
    source: (project.sources || ['idealista']).join(', '),
    thumbnail: project.thumbnail || '',
    features: project.features.join(', '),
    unit_count: project.unit_count || 1,
  };
}

module.exports = {
  COSTA_SELECT_REGIONS,
  MUNICIPALITY_TO_REGION,
  getAllCities,
  getRegionForCity,
  extractProjectName,
  groupIntoProjects,
  projectToDisplayRow,
};
