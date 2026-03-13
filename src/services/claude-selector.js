const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Je bent een vastgoedconsultant-assistent. Je krijgt twee dingen:

1. Een KLANTPROFIEL met harde filters en zachte criteria
2. Een lijst van WONINGEN met hun beschrijvingen en kenmerken

Jouw taak: selecteer de woningen die het BEST passen bij deze specifieke klant. Beoordeel elke woning op:

- Match met harde filters (prijs, locatie, grootte, kamers)
- Match met zachte criteria (stijl, sfeer, must-haves)
- Afwezigheid van dealbreakers
- Algemene kwaliteit en aantrekkelijkheid van de listing

Geef ALLEEN valid JSON terug:
{
  "selections": [
    {
      "rank": 1,
      "property_id": "originele ID uit de listing data",
      "match_score": 0-100,
      "motivation": "2-3 zinnen in het Nederlands waarom deze woning bij de klant past. Wees specifiek: verwijs naar concrete details uit de beschrijving die matchen met de wensen. Noem ook eventuele minpunten.",
      "highlights": ["3-5 korte tags die de match beschrijven"]
    }
  ]
}

Regels:
- Selecteer MAXIMAAL 10 woningen. Als er minder dan 10 goed passen, selecteer er minder. Kwaliteit boven kwantiteit.
- match_score 90+ = uitstekende match
- match_score 70-89 = goede match met kleine compromissen
- match_score 50-69 = redelijke match, duidelijke afwijkingen
- Onder 50: niet selecteren.
- Wees eerlijk over minpunten in de motivatie. De consultant moet de klant goed kunnen adviseren.
- Als een woning een dealbreaker heeft: niet selecteren, ook niet als de rest perfect is.
- De motivatie moet in het NEDERLANDS zijn.
- Sorteer op match_score (hoogste eerst).`;

/**
 * Truncate a description to max N words, stripping HTML.
 */
function truncateDescription(desc, maxWords = 300) {
  if (!desc) return '';
  // Strip HTML tags
  const clean = desc.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const words = clean.split(' ');
  if (words.length <= maxWords) return clean;
  return words.slice(0, maxWords).join(' ') + '...';
}

/**
 * Prepare properties for Claude (limit tokens).
 */
function preparePropertiesForClaude(properties) {
  return properties.map((p, i) => ({
    id: p.id || p.url || `property_${i}`,
    title: p.title || 'Onbekend',
    price: p.price,
    location: p.location,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    size_m2: p.size_m2,
    description: truncateDescription(p.description),
    features: p.features || [],
    url: p.url,
    portal: p.source || 'idealista',
  }));
}

/**
 * Select the best matching properties using Claude AI.
 * @param {object} clientProfile - Output from claude-parser (hard_filters + soft_criteria)
 * @param {Array} properties - All scraped properties
 * @returns {object} Claude's selection response
 */
async function selectProperties(clientProfile, properties) {
  const preparedProps = preparePropertiesForClaude(properties);

  const userMessage = `KLANTPROFIEL:
${JSON.stringify(clientProfile, null, 2)}

WONINGEN (${preparedProps.length} gevonden):
${JSON.stringify(preparedProps, null, 2)}`;

  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });

      const text = response.content[0].text.trim();
      const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
      const parsed = JSON.parse(cleaned);

      console.log(`[Claude Selector] Selected ${parsed.selections?.length || 0} properties`);
      return parsed;
    } catch (error) {
      lastError = error;
      console.error(`[Claude Selector] Attempt ${attempt + 1} failed:`, error.message);
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error(`Claude selection failed after 2 attempts: ${lastError.message}`);
}

module.exports = { selectProperties, truncateDescription };
