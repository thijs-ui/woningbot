const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');
const http = require('http');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Fix #16: Configurable model
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

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
function downloadImageAsBase64(imageUrl, timeoutMs = 10000, redirectCount = 0) {
  if (redirectCount > 3) return Promise.resolve(null);

  return new Promise((resolve) => {
    const protocol = imageUrl.startsWith('https') ? https : http;

    const req = protocol.get(imageUrl, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(downloadImageAsBase64(res.headers.location, timeoutMs, redirectCount + 1));
        return;
      }

      if (res.statusCode !== 200) {
        resolve(null);
        return;
      }

      const rawContentType = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length < 1000) {
          resolve(null);
          return;
        }

        // Claude Vision only accepts: image/jpeg, image/png, image/gif, image/webp
        const ALLOWED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        let mediaType = rawContentType;

        // Normalize common variants
        if (mediaType === 'image/jpg') mediaType = 'image/jpeg';
        if (mediaType === 'image/svg+xml') { resolve(null); return; } // SVG not supported

        // If content-type is missing or not in allowed list, detect from buffer magic bytes
        if (!ALLOWED.includes(mediaType)) {
          if (buffer[0] === 0xFF && buffer[1] === 0xD8) mediaType = 'image/jpeg';
          else if (buffer[0] === 0x89 && buffer[1] === 0x50) mediaType = 'image/png';
          else if (buffer[0] === 0x47 && buffer[1] === 0x49) mediaType = 'image/gif';
          else if (buffer[0] === 0x52 && buffer[1] === 0x49) mediaType = 'image/webp';
          else mediaType = 'image/jpeg'; // Last resort fallback
        }

        resolve({
          base64: buffer.toString('base64'),
          mediaType,
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
 * Includes retry with backoff for rate limits.
 */
async function analyzePropertyPhoto(property, retries = 2) {
  const imageUrl = property.thumbnail || (property.images && property.images[0]);

  if (!imageUrl) {
    console.log(`[Vision] No image for property ${property.id}, skipping`);
    return null;
  }

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

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.messages.create({
        model: CLAUDE_MODEL,
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
      const isRateLimit = error.status === 429 || error.message?.includes('rate_limit');

      if (isRateLimit && attempt < retries) {
        const waitSec = 30 * (attempt + 1); // 30s, then 60s
        console.log(`[Vision] Rate limit for ${property.id}, waiting ${waitSec}s (attempt ${attempt + 1}/${retries + 1})`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
      } else {
        console.error(`[Vision] Error analyzing ${property.id} (attempt ${attempt + 1}):`, error.message);
        return null;
      }
    }
  }

  return null;
}

/**
 * Analyze photos for the top selected properties.
 * Processes SEQUENTIALLY with delays to avoid rate limits.
 * @param {Array} selections - Claude's selections (with property_id)
 * @param {Array} allProperties - All scraped properties
 * @returns {Map} Map of property_id -> visual assessment
 */
async function analyzeSelectedPhotos(selections, allProperties) {
  const assessments = new Map();

  console.log(`[Vision] Analyzing photos for ${selections.length} selected properties (sequential)...`);

  for (let i = 0; i < selections.length; i++) {
    const sel = selections[i];
    const prop = allProperties.find(p =>
      p.id === sel.property_id || String(p.id) === String(sel.property_id)
    );

    if (!prop) {
      console.log(`[Vision] Property ${sel.property_id} not found, skipping`);
      continue;
    }

    console.log(`[Vision] Analyzing ${i + 1}/${selections.length}: ${prop.id}`);

    const assessment = await analyzePropertyPhoto(prop);
    if (assessment) {
      assessments.set(sel.property_id, assessment);
    }

    // Wait 5 seconds between photos (Fix #8: reduced from 15s)
    // Anthropic rate limits are per-minute; 5s gap = ~12 photos/min
    if (i < selections.length - 1) {
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log(`[Vision] Completed: ${assessments.size}/${selections.length} photos analyzed`);
  return assessments;
}

module.exports = { analyzePropertyPhoto, analyzeSelectedPhotos };
