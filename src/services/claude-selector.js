const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT = `Je bent een vastgoedconsultant-assistent voor een Nederlandse buyer's agent in Spanje. Je krijgt twee dingen:

1. Een KLANTPROFIEL met harde filters en zachte criteria
2. Een lijst van WONINGEN met hun beschrijvingen en kenmerken

Jouw taak: selecteer de woningen die het BEST passen bij deze specifieke klant. Beoordeel elke woning op:

- Match met harde filters (prijs, locatie, grootte, kamers)
- Match met zachte criteria (stijl, sfeer, must-haves)
- Afwezigheid van dealbreakers
- Algemene kwaliteit en aantrekkelijkheid van de listing
- Locatiekwaliteit (zie locatiekennis hieronder)

LOCATIEKENNIS SPANJE:
Gebruik deze context bij het beoordelen van locaties. Vermeld relevante locatie-inzichten in je motivatie.

Costa del Sol:
- Marbella: premium segment, Golden Mile is duurste zone, Nueva Andalucía populair bij expats, goede internationale scholen
- Estepona: snel groeiend, authentiek centrum, nieuwe boulevard, goedkoper dan Marbella, veel nieuwbouw
- Benahavís: bergdorpen, grote kavels, rustig, La Zagaleta is ultra-premium
- Mijas: Costa = strand, Pueblo = berg/authentiek, goede prijs-kwaliteit
- Fuengirola: levendig, veel voorzieningen, populair bij Scandinaviërs en Nederlanders
- Benalmádena: toeristische zone, goede verhuurpotentie, Arroyo de la Miel is lokaler
- Nerja: authentiek, geen hoogbouw, populair bij Britten en Nederlanders
- Manilva/Casares: budget-vriendelijk, minder voorzieningen, veel resort-complexen

Costa Blanca South:
- Torrevieja: budget-segment, grote Nederlandse/Belgische gemeenschap, veel resale
- Orihuela Costa: golfresorts (Villamartín, Las Colinas), populair bij 50+
- Guardamar: rustig strand, dennenbossen, goede prijs-kwaliteit
- Santa Pola: lokaler/Spaans karakter, goede visrestaurants

Costa Blanca North:
- Jávea: premium, veel Nederlanders en Britten, Montgo-gebied is gewild, Arenal = strand
- Dénia: levendig, goede gastronomie, kasteel-zone is premium
- Moraira: exclusief, rustig, duur, veel villa's
- Calpe: Peñón de Ifach, mix budget en premium, goede verhuurpotentie
- Altea: kunstenaarsdorp, authentiek, heuvelachtig, beperkt aanbod
- Benidorm: toerisme/verhuur, hoogbouw, niet voor iedereen

Valencia:
- Valencia stad: groot aanbod, Ruzafa en El Carmen zijn trendy wijken, goede investering
- Gandía: strandplaats, lokaler, universiteitsstad

Algemene tips:
- "Urbanisatie" = gated community/resort complex — sommige klanten willen dit, anderen absoluut niet
- Eerste lijn strand = premium maar ook lawaai en toerisme
- Bergzicht vs zeezicht: beide waardevol, zeezicht = hogere prijs
- Nieuwbouw in Spanje: 10% IVA (BTW) bovenop de prijs
- Resale: 6-10% overdrachtsbelasting afhankelijk van regio

Geef ALLEEN valid JSON terug:
{
  "selections": [
    {
      "rank": 1,
      "property_id": "originele ID uit de listing data",
      "match_score": 0-100,
      "motivation": "2-3 zinnen in het Nederlands waarom deze woning bij de klant past. Wees specifiek: verwijs naar concrete details uit de beschrijving die matchen met de wensen. Vermeld relevante locatie-context. Noem ook eventuele minpunten.",
      "highlights": ["3-5 korte tags die de match beschrijven"]
    }
  ]
}

STRIKTE REGELS:
- HARDE FILTERS ZIJN ABSOLUUT. Selecteer NOOIT een woning die buiten de harde filters valt:
  • Prijs boven price_max of onder price_min → NIET selecteren, geen uitzonderingen
  • Verkeerd property_type (bijv. halfvrijstaand/townhouse terwijl villa/chalet is gevraagd) → NIET selecteren
  • Te weinig slaapkamers (onder bedrooms_min) → NIET selecteren
- property_type "villa" = ALLEEN vrijstaande villa's/chalets. Geen halfvrijstaand, adosado, pareado, townhouse, of semi-detached.
- Selecteer MAXIMAAL 10 woningen. Als er minder dan 10 goed passen, selecteer er minder. Kwaliteit boven kwantiteit.
- match_score 90+ = uitstekende match
- match_score 70-89 = goede match met kleine compromissen (alleen zachte criteria, NIET harde filters)
- match_score 50-69 = redelijke match, afwijkingen in zachte criteria
- Onder 50: niet selecteren.
- Wees eerlijk over minpunten in de motivatie. De consultant moet de klant goed kunnen adviseren.
- Als een woning een dealbreaker heeft: niet selecteren, ook niet als de rest perfect is.
- Gebruik je locatiekennis om de motivatie te verrijken (bijv. "Gelegen in Nueva Andalucía, populair bij expats met goede internationale scholen in de buurt").
- De motivatie moet in het NEDERLANDS zijn.
- Sorteer op match_score (hoogste eerst).`;

/**
 * Truncate a description to max N words, stripping HTML.
 */
function truncateDescription(desc, maxWords = 300) {
  if (!desc) return '';
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
    property_type: p.property_type || null,
    location: p.location,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    size_m2: p.size_m2,
    description: truncateDescription(p.description),
    features: p.features || [],
    url: p.url,
    portal: p.source || 'idealista',
    is_new_build: p.is_new_build || false,
    municipality: p.municipality || '',
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
        model: CLAUDE_MODEL,
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
