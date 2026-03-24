const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Je bent een vastgoedconsultant-assistent. Je hebt eerder een selectie gemaakt van woningen voor een klant. De consultant heeft nu feedback gegeven.

Je krijgt:
1. Het originele KLANTPROFIEL
2. De EERDERE SELECTIE met motivaties
3. ALLE beschikbare woningen (ook de niet-geselecteerde)
4. De FEEDBACK van de consultant

Pas je selectie aan op basis van de feedback. Misschien:
- Verschuiven de zachte criteria (rustiek i.p.v. modern)
- Veranderen de harde filters (hoger budget)
- Moeten bepaalde woningen behouden blijven ("nr 1 en 3")
- Moeten nieuwe woningen uit de pool naar voren komen

Als de feedback nieuwe harde filters impliceert die buiten de originele scrape-resultaten vallen (bijv. budget verhoogd boven originele maxPrice, of een andere locatie), geef dat aan met:
  "needs_new_scrape": true,
  "new_filters": { ... aangepaste harde filters ... }

Anders: "needs_new_scrape": false

Geef je response in JSON:
{
  "needs_new_scrape": false,
  "new_filters": null,
  "response_to_consultant": "een kort bericht in het Nederlands dat uitlegt wat je hebt aangepast en waarom.",
  "selections": [
    {
      "rank": 1,
      "property_id": "originele ID uit de listing data",
      "match_score": 0-100,
      "motivation": "2-3 zinnen in het Nederlands, aangepast aan de nieuwe criteria",
      "highlights": ["3-5 korte tags"]
    }
  ]
}

Regels:
- Maximaal 10 selecties, kwaliteit boven kwantiteit.
- match_score onder 50: niet selecteren.
- Wees eerlijk over minpunten.
- Motivatie en response_to_consultant in het NEDERLANDS.
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
 * Refine selection based on consultant feedback.
 */
async function refineSelection(threadData, feedback) {
  const preparedProps = threadData.all_properties.map((p, i) => ({
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

  const conversationContext = threadData.conversation_history
    .map((c) => `[${c.role}]: ${c.text}`)
    .join('\n');

  const userMessage = `KLANTPROFIEL:
${JSON.stringify(threadData.client_profile, null, 2)}

EERDERE SELECTIE:
${JSON.stringify(threadData.current_selection, null, 2)}

ALLE BESCHIKBARE WONINGEN (${preparedProps.length}):
${JSON.stringify(preparedProps, null, 2)}

GESPREKSHISTORIE:
${conversationContext}

NIEUWE FEEDBACK VAN CONSULTANT:
${feedback}`;

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

      console.log(`[Claude Refiner] Refined to ${parsed.selections?.length || 0} properties, needs_new_scrape: ${parsed.needs_new_scrape}`);
      return parsed;
    } catch (error) {
      lastError = error;
      console.error(`[Claude Refiner] Attempt ${attempt + 1} failed:`, error.message);
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error(`Claude refinement failed after 2 attempts: ${lastError.message}`);
}

module.exports = { refineSelection };
