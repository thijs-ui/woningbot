const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT = `Je bent een vastgoed-zoekparser voor Spanje. Je krijgt een zoekopdracht van een makelaar/consultant over wat hun klant zoekt.

Splits de opdracht in twee delen:

1. HARDE FILTERS — objectieve, meetbare criteria voor de zoek-API
2. ZACHTE CRITERIA — subjectieve wensen, stijlvoorkeuren, sfeer

Geef ALLEEN valid JSON terug. Geen tekst eromheen.

{
  "hard_filters": {
    "property_type": "apartment|villa|townhouse|finca|penthouse|studio|plot|country_house|duplex|bungalow|null",
    "is_new_build": true of false,
    "operation": "sale|rent",
    "locations": ["lijst van plaatsnamen — altijd een array, ook als het er maar 1 is"],
    "neighborhoods": ["wijknamen als de gebruiker specifieke wijken noemt, anders lege array"],
    "province": "Spaanse provincie of null als meerdere provincies",
    "price_min": nummer of null,
    "price_max": nummer of null,
    "bedrooms_min": nummer of null,
    "bedrooms_max": nummer of null,
    "bathrooms_min": nummer of null,
    "size_min_m2": nummer of null,
    "size_max_m2": nummer of null,
    "features": ["pool","garage","terrace","garden","elevator","air_conditioning","security","storage"],
    "project_name": "naam van een specifiek nieuwbouwproject als de gebruiker daarnaar vraagt, anders null"
  },
  "soft_criteria": {
    "style_preferences": "beschrijving van gewenste stijl/sfeer",
    "must_haves": ["specifieke eisen die niet in filters passen"],
    "dealbreakers": ["dingen die de klant absoluut niet wil"],
    "lifestyle_notes": "context over de klant en hun leefstijl"
  },
  "search_summary": "korte samenvatting van de zoekopdracht in 1 zin, in het Nederlands"
}

Regels:
- Standaard operation is "sale" tenzij huur/rent wordt genoemd.
- is_new_build = true als de klant expliciet nieuwbouw/obra nueva/new build/project zoekt, OF als ze naar een specifiek project vragen. Standaard false.
- locations is ALTIJD een array met STADSNAMEN (niet wijknamen). Voorbeelden:
  - "villa in Estepona" → locations: ["Estepona"]
  - "appartement in Estepona of Mijas" → locations: ["Estepona", "Mijas"]
  - "Costa del Sol" → locations: ["Estepona", "Marbella", "Fuengirola", "Mijas", "Benalmádena"]
  - "Costa Blanca South" → locations: ["Torrevieja", "Orihuela", "Guardamar del Segura", "Santa Pola"]
  - "Costa Blanca North" → locations: ["Jávea", "Dénia", "Moraira", "Calpe", "Altea", "Benidorm"]
- Als een regio wordt genoemd (Costa del Sol, Costa Blanca, etc.), vertaal naar de belangrijkste steden in die regio.

WIJKEN EN BUURTEN:
- Als de gebruiker een WIJK of BUURT noemt (bijv. El Cabanyal, El Grau, Ruzafa, El Carmen, Nueva Andalucía, Golden Mile, La Zagaleta, Arenal, Puerto Banús):
  - Zet de STAD in locations (bijv. El Cabanyal → locations: ["Valencia"])
  - Zet de WIJKNAAM in neighborhoods (bijv. neighborhoods: ["El Cabanyal"])
- Bekende wijk-naar-stad mappings:
  - El Cabanyal, El Grau, Ruzafa, El Carmen, Benimaclet, Patraix, Campanar → Valencia
  - Nueva Andalucía, Golden Mile, Puerto Banús, San Pedro de Alcántara, Los Monteros → Marbella
  - La Zagaleta → Benahavís
  - Arenal → Jávea
  - Arroyo de la Miel → Benalmádena
  - Villamartín, Las Colinas → Orihuela
  - La Zenia, Playa Flamenca → Orihuela

PROJECTNAMEN:
- Als de gebruiker naar een SPECIFIEK NIEUWBOUWPROJECT vraagt (bijv. "The View Marbella", "Residencial Albatros", "Ocean Suites"):
  - Zet project_name op de projectnaam (bijv. "The View Marbella")
  - Zet is_new_build op true
  - Zet de stad waar het project zich bevindt in locations. Als de stad onduidelijk is, leid het af uit de projectnaam (bijv. "The View Marbella" → locations: ["Marbella"])
  - Laat price_min/max/bedrooms etc. op null — we zoeken breed om het project te vinden

- Als prijsrange vaag is ("rond 500k"): price_min = -15%, price_max = +15%.
- "Geen urbanisatie" = dealbreaker ["urbanisatie/resort complex"]
- "Privacy" = soft_criteria must_have ["afgelegen/privacy"]
- "Moderne maar warme stijl" = style_preferences
- "Ingegraven zwembad" = must_have (niet hetzelfde als gewoon "pool" in harde filters)
- Als iets niet afleidbaar is, gebruik null of lege array.`;

/**
 * Parse a free-text search query into hard filters + soft criteria.
 * Retries once on failure.
 */
async function parseSearchQuery(queryText) {
  let lastError;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 800,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: queryText }],
      });

      const text = response.content[0].text.trim();
      const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      const parsed = JSON.parse(cleaned);

      // Backwards compatibility: if parser returns "location" (string), convert to "locations" (array)
      if (parsed.hard_filters) {
        if (parsed.hard_filters.location && !parsed.hard_filters.locations) {
          const loc = parsed.hard_filters.location;
          parsed.hard_filters.locations = loc.includes(',')
            ? loc.split(',').map(l => l.trim()).filter(Boolean)
            : [loc];
          delete parsed.hard_filters.location;
        }
        // Ensure locations is always an array
        if (!Array.isArray(parsed.hard_filters.locations)) {
          parsed.hard_filters.locations = parsed.hard_filters.locations
            ? [parsed.hard_filters.locations]
            : [];
        }
        // Ensure neighborhoods is always an array
        if (!Array.isArray(parsed.hard_filters.neighborhoods)) {
          parsed.hard_filters.neighborhoods = parsed.hard_filters.neighborhoods
            ? [parsed.hard_filters.neighborhoods]
            : [];
        }

        // Safety net: if locations are actually neighborhoods, resolve to cities
        parsed.hard_filters.locations = resolveNeighborhoodsToCities(
          parsed.hard_filters.locations,
          parsed.hard_filters.neighborhoods
        );
      }

      console.log('[Claude Parser] Parsed:', JSON.stringify(parsed, null, 2));
      return parsed;
    } catch (error) {
      lastError = error;
      console.error(`[Claude Parser] Attempt ${attempt + 1} failed:`, error.message);
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error(`Claude parsing failed after 2 attempts: ${lastError.message}`);
}

/**
 * Known neighborhood-to-city mappings.
 * If Claude puts a neighborhood in locations instead of the city, we fix it here.
 */
const NEIGHBORHOOD_TO_CITY = {
  // Valencia
  'el cabanyal': 'Valencia',
  'cabanyal': 'Valencia',
  'el cabañal': 'Valencia',
  'el grau': 'Valencia',
  'el grao': 'Valencia',
  'grau': 'Valencia',
  'ruzafa': 'Valencia',
  'russafa': 'Valencia',
  'el carmen': 'Valencia',
  'el carme': 'Valencia',
  'benimaclet': 'Valencia',
  'patraix': 'Valencia',
  'campanar': 'Valencia',
  'malvarrosa': 'Valencia',
  'la malvarrosa': 'Valencia',
  'ciutat vella': 'Valencia',
  'eixample': 'Valencia',
  'ensanche': 'Valencia',
  'extramurs': 'Valencia',
  'poblats marítims': 'Valencia',

  // Marbella
  'nueva andalucia': 'Marbella',
  'nueva andalucía': 'Marbella',
  'golden mile': 'Marbella',
  'milla de oro': 'Marbella',
  'puerto banus': 'Marbella',
  'puerto banús': 'Marbella',
  'los monteros': 'Marbella',
  'rio real': 'Marbella',
  'río real': 'Marbella',
  'elviria': 'Marbella',
  'bahia de marbella': 'Marbella',
  'bahía de marbella': 'Marbella',
  'nagüeles': 'Marbella',
  'nagueles': 'Marbella',
  'sierra blanca': 'Marbella',
  'san pedro de alcantara': 'Marbella',
  'san pedro de alcántara': 'Marbella',
  'san pedro': 'Marbella',

  // Benahavís
  'la zagaleta': 'Benahavís',

  // Jávea
  'arenal': 'Jávea',
  'el arenal': 'Jávea',
  'montgo': 'Jávea',
  'montgó': 'Jávea',

  // Benalmádena
  'arroyo de la miel': 'Benalmádena',

  // Orihuela
  'villamartin': 'Orihuela',
  'villamartín': 'Orihuela',
  'las colinas': 'Orihuela',
  'la zenia': 'Orihuela',
  'playa flamenca': 'Orihuela',
  'campoamor': 'Orihuela',
  'punta prima': 'Orihuela',
  'cabo roig': 'Orihuela',

  // Torrevieja
  'la mata': 'Torrevieja',
  'los balcones': 'Torrevieja',

  // Estepona
  'el paraiso': 'Estepona',
  'el paraíso': 'Estepona',
  'cancelada': 'Estepona',
  'new golden mile': 'Estepona',

  // Fuengirola
  'los boliches': 'Fuengirola',
  'torreblanca': 'Fuengirola',

  // Mijas
  'la cala de mijas': 'Mijas',
  'mijas pueblo': 'Mijas',
  'mijas costa': 'Mijas',
  'riviera del sol': 'Mijas',
  'calahonda': 'Mijas',
};

/**
 * Check if any locations are actually neighborhoods and resolve to cities.
 * Also moves them to the neighborhoods array.
 */
function resolveNeighborhoodsToCities(locations, neighborhoods) {
  const resolvedLocations = [];
  const addedCities = new Set();

  for (const loc of locations) {
    const lower = loc.toLowerCase().trim();
    const city = NEIGHBORHOOD_TO_CITY[lower];

    if (city) {
      // This is a neighborhood — add the city instead
      if (!addedCities.has(city.toLowerCase())) {
        resolvedLocations.push(city);
        addedCities.add(city.toLowerCase());
      }
      // Add to neighborhoods if not already there
      if (!neighborhoods.some(n => n.toLowerCase() === lower)) {
        neighborhoods.push(loc);
      }
      console.log(`[Claude Parser] Resolved neighborhood "${loc}" → city "${city}"`);
    } else {
      // Regular city
      if (!addedCities.has(lower)) {
        resolvedLocations.push(loc);
        addedCities.add(lower);
      }
    }
  }

  return resolvedLocations;
}

module.exports = { parseSearchQuery, NEIGHBORHOOD_TO_CITY };
