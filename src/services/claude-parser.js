const Anthropic = require('@anthropic-ai/sdk');
const { claudeRetry } = require('./claude-retry');
const { normalizeQuery } = require('./query-normalizer');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Sprint 2: Haiku voor parser (lichte routing-taak), Sonnet via fallback.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL_PARSER
  || process.env.CLAUDE_MODEL
  || 'claude-haiku-4-5-20251001';

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
    "plot_min_m2": nummer of null,
    "plot_max_m2": nummer of null,
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
  - "Costa Brava" → locations: ["Tossa de Mar", "Lloret de Mar", "Blanes", "Platja d'Aro", "Begur", "Palafrugell", "Pals", "Roses", "Cadaqués", "Sant Feliu de Guíxols"]
  - "Costa Dorada" of "Costa Daurada" → locations: ["Sitges", "Vilanova i la Geltrú", "Calafell", "Salou", "Cambrils", "La Pineda", "Tarragona"]
- Als een regio wordt genoemd (Costa del Sol, Costa Blanca, Costa Brava, Costa Dorada, etc.), vertaal naar de belangrijkste steden in die regio.
- Veel Costa Blanca / Costa Brava / Costa Dorada steden hebben TWEE officiële namen (Spaans + Valenciaans/Catalaans). Voorbeelden: Jávea = Xàbia, Alicante = Alacant, Calpe = Calp, Gerona = Girona, Sant Feliu de Guíxols = San Feliu de Guíxols, Platja d'Aro = Playa de Aro. De post-processing voegt automatisch alle varianten toe — jij hoeft maar één naam te outputten.

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
- Als iets niet afleidbaar is, gebruik null of lege array.

OPPERVLAKTE — perceel vs woonoppervlak:
- "perceel", "grond", "land", "tuin van X m²", "plot" → plot_min_m2 / plot_max_m2
- "woonoppervlak", "woonopp", "m² woon", "indoor", "leefoppervlak", "bebouwd" → size_min_m2 / size_max_m2
- "X m²" zonder context → size_min_m2 (woonoppervlak is de standaard-interpretatie)
- "perceel 2000m²+" → plot_min_m2: 2000, plot_max_m2: null
- "tuin minimaal 1000m²" → plot_min_m2: 1000`;

/**
 * Validate the structure of Claude's parsed output.
 * Returns array of error messages (empty = valid).
 */
function validateClientProfile(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return ['Response is geen JSON object'];
  }
  if (!parsed.hard_filters || typeof parsed.hard_filters !== 'object') {
    return ['hard_filters ontbreekt of is geen object'];
  }

  const hf = parsed.hard_filters;
  const errors = [];

  if (hf.locations !== undefined && hf.locations !== null && !Array.isArray(hf.locations)) {
    errors.push('hard_filters.locations moet een array zijn (kan leeg zijn)');
  }
  if (hf.neighborhoods !== undefined && hf.neighborhoods !== null && !Array.isArray(hf.neighborhoods)) {
    errors.push('hard_filters.neighborhoods moet een array zijn (kan leeg zijn)');
  }
  for (const key of ['price_min', 'price_max', 'bedrooms_min', 'bedrooms_max', 'bathrooms_min', 'size_min_m2', 'size_max_m2', 'plot_min_m2', 'plot_max_m2']) {
    if (hf[key] != null && typeof hf[key] !== 'number') {
      errors.push(`hard_filters.${key} moet number of null zijn (is nu ${typeof hf[key]})`);
    }
  }
  if (hf.is_new_build !== undefined && hf.is_new_build !== null && typeof hf.is_new_build !== 'boolean') {
    errors.push('hard_filters.is_new_build moet boolean of null zijn');
  }

  return errors;
}

function tryParseJson(text) {
  const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch (err) {
    return { ok: false, error: err.message, raw: cleaned };
  }
}

/**
 * Parse a free-text search query into hard filters + soft criteria.
 * Sprint 1 update: normaliseert input deterministisch eerst (€/M/K),
 * valideert Claude's output tegen schema, en retry'd 1x bij fouten met
 * expliciete feedback richting Claude.
 */
async function parseSearchQuery(queryText) {
  // Pre-process: deterministische normalisatie (€/M/K naar cijfers)
  const norm = normalizeQuery(queryText);
  if (norm.changed) {
    console.log(`[Claude Parser] Normalized: "${queryText}" → "${norm.normalized}"`);
  }
  const inputForClaude = norm.normalized;

  const conversation = [{ role: 'user', content: inputForClaude }];
  let lastParseError = null;
  let lastSchemaErrors = null;
  let lastResponseText = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await claudeRetry(client, {
      model: CLAUDE_MODEL,
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: conversation,
    }, { label: `ClaudeParser:attempt${attempt}` });

    lastResponseText = response.content[0].text.trim();
    const parseResult = tryParseJson(lastResponseText);

    if (!parseResult.ok) {
      lastParseError = parseResult.error;
      console.warn(`[Claude Parser] Attempt ${attempt} JSON-parse failed: ${parseResult.error}`);
      if (attempt < 2) {
        conversation.push(
          { role: 'assistant', content: lastResponseText },
          { role: 'user', content: `Je vorige antwoord was geen geldige JSON (parser-fout: "${parseResult.error}"). Geef ALLEEN een geldig JSON object terug volgens het schema, geen tekst eromheen, geen markdown fences.` }
        );
        continue;
      }
      throw new Error(`Parser failed: invalid JSON after retry (${lastParseError})`);
    }

    const parsed = parseResult.value;
    const schemaErrors = validateClientProfile(parsed);

    if (schemaErrors.length > 0) {
      lastSchemaErrors = schemaErrors;
      console.warn(`[Claude Parser] Attempt ${attempt} schema validation failed:`, schemaErrors);
      if (attempt < 2) {
        conversation.push(
          { role: 'assistant', content: lastResponseText },
          { role: 'user', content: `Je vorige output had deze schema-fouten: ${schemaErrors.join('; ')}. Geef opnieuw een geldige JSON.` }
        );
        continue;
      }
      throw new Error(`Parser schema-validation failed after retry: ${lastSchemaErrors.join('; ')}`);
    }

    // Backwards compatibility: if parser returns "location" (string), convert to "locations" (array)
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

    console.log('[Claude Parser] Parsed:', JSON.stringify(parsed, null, 2));
    return parsed;
  }

  // Should be unreachable
  throw new Error('Parser exhausted attempts');
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
