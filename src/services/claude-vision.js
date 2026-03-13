const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');
const http = require('http');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Je bent een vastgoedexpert die foto's van woningen beoordeelt. Je krijgt de hoofdfoto (thumbnail) van een woning, samen met de basisgegevens.

Geef een korte, eerlijke visuele beoordeling in het Nederlands. Focus op:
- Staat van onderhoud (modern/gerenoveerd/gedateerd/slecht)
- Stijl en sfeer (modern/klassiek/rustiek/luxe/basic)
- Licht en ruimtelijkheid
- Opvallende positieve of negatieve punten zichtbaar op de foto
- Eventuele rode vlaggen (slechte staat, donker, rommelig, misleidende foto)

Geef ALLEEN valid JSON terug:
{
  "visual_assessment": "2-3 zinnen in het Nederlands over wat je ziet",
  "condition_score": 1-5,
  "style_tags": ["max 3 tags, bijv: modern, licht, gerenoveerd"],
  "red_flags": ["eventuele waarschuwingen, of lege array"]
}

Condition scores:
1 = slecht/sterk gedateerd
2 = gedateerd maar bewoonbaar
3 = redelijk/gemiddeld
4 = goed onderhouden/modern
5 = uitstekend/luxe afwerking`;

/**
 * Download an image and convert to base64.
 * Returns { base64, mediaType } or null on failure.
 */
function downloadImageAsBase64(imageUrl, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const protocol = imageUrl.startsWith('https') ? https : http;

    const req = protocol.get(imageUrl, { timeout: timeoutMs }, (res) => {
      // Follow redirects (up to 3)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(downloadImageAsBase64(res.headers.location, timeoutMs));
        return;
      }

      if (res.statusCode !== 200) {
        resolve(null);
        return;
      }

      const contentType = res.headers['content-type'] || 'image/jpeg';
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length < 1000) { // Too small, probably an error page
          resolve(null);
          return;
        }
        resolve({
          base64: buffer.toString('base64'),
          mediaType: contentType.split(';')[0].trim(),
        });
      });
      res.on('error', () => resolve(null));
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Analyze the thumbnail of a single property using Claude Vision.
 * @param {object} property - A normalized property object
 * @returns {object|null} Visual assessment or null if no image available
 */
async function analyzePropertyPhoto(property) {
  const imageUrl = property.thumbnail || (property.images && property.images[0]);

  if (!imageUrl) {
    console.log(`[Vision] No image for property ${property.id}, skipping`);
    return null;
  }

  try {
    const imageData = await downloadImageAsBase64(imageUrl);
    if (!imageData) {
      console.log(`[Vision] Failed to download image for ${property.id}`);
      return null;
    }

    const context = `Woning: ${property.title || 'Onbekend'}
Prijs: ${property.price ? '€' + property.price.toLocaleString() : 'onbekend'}
Locatie: ${property.location || 'onbekend'}
Kamers: ${property.bedrooms || '?'} slpk, ${property.bathrooms || '?'} bdk
Oppervlakte: ${property.size_m2 || '?'} m²`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: imageData.mediaType,
              data: imageData.base64,
            },
          },
          {
            type: 'text',
            text: context,
          },
        ],
      }],
    });

    const text = response.content[0].text.trim();
    const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      visual_assessment: parsed.visual_assessment || '',
      condition_score: parsed.condition_score || 3,
      style_tags: parsed.style_tags || [],
      red_flags: parsed.red_flags || [],
    };
  } catch (error) {
    console.error(`[Vision] Error analyzing ${property.id}:`, error.message);
    return null;
  }
}

/**
 * Analyze photos for the top selected properties (light analysis: 1 photo per property).
 * @param {Array} selections - Claude's selections (with property_id)
 * @param {Array} allProperties - All scraped properties
 * @returns {Map} Map of property_id -> visual assessment
 */
async function analyzeSelectedPhotos(selections, allProperties) {
  const assessments = new Map();

  console.log(`[Vision] Analyzing photos for ${selections.length} selected properties...`);

  // Process in batches of 3 to avoid rate limits
  const batchSize = 3;
  for (let i = 0; i < selections.length; i += batchSize) {
    const batch = selections.slice(i, i + batchSize);

    const results = await Promise.allSettled(
      batch.map(async (sel) => {
        const prop = allProperties.find(p =>
          p.id === sel.property_id || String(p.id) === String(sel.property_id)
        );
        if (!prop) return { id: sel.property_id, assessment: null };

        const assessment = await analyzePropertyPhoto(prop);
        return { id: sel.property_id, assessment };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.assessment) {
        assessments.set(result.value.id, result.value.assessment);
      }
    }

    // Small delay between batches
    if (i + batchSize < selections.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`[Vision] Completed: ${assessments.size}/${selections.length} photos analyzed`);
  return assessments;
}

module.exports = { analyzePropertyPhoto, analyzeSelectedPhotos };
