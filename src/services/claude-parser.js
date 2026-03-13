const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
    "locations": ["lijst van plaatsnamen in het Spaans — altijd een array, ook als het er maar 1 is"],
    "province": "Spaanse provincie of null als meerdere provincies",
    "price_min": nummer of null,
    "price_max": nummer of null,
    "bedrooms_min": nummer of null,
    "bedrooms_max": nummer of null,
    "bathrooms_min": nummer of null,
    "size_min_m2": nummer of null,
    "size_max_m2": nummer of null,
    "features": ["pool","garage","terrace","garden","elevator","air_conditioning","security","storage"]
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
- is_new_build = true als de klant expliciet nieuwbouw/obra nueva/new build/project zoekt. Standaard false.
- locations is ALTIJD een array. Voorbeelden:
  - "villa in Estepona" → locations: ["Estepona"]
  - "appartement in Estepona of Mijas" → locations: ["Estepona", "Mijas"]
  - "Costa del Sol" → locations: ["Estepona", "Marbella", "Fuengirola", "Mijas", "Benalmádena"]
  - "Costa Blanca South" → locations: ["Torrevieja", "Orihuela", "Guardamar del Segura", "Santa Pola"]
  - "Costa Blanca North" → locations: ["Jávea", "Dénia", "Moraira", "Calpe", "Altea", "Benidorm"]
- Als een regio wordt genoemd (Costa del Sol, Costa Blanca, etc.), vertaal naar de belangrijkste steden in die regio.
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
        model: 'claude-sonnet-4-20250514',
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

module.exports = { parseSearchQuery };
