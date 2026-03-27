// ─── /pitch handler ─────────────────────────────────────────────────────────
// Gebruik: /pitch 771846 Jan Janssen
//          /pitch 771846 Belgisch echtpaar, gepensioneerd, rust en tuin belangrijk
//          /pitch https://www.costaselect.com/... investeerder, verhuurpotentieel

const Anthropic = require('@anthropic-ai/sdk');
const { claudeRetry } = require('../services/claude-retry');
const { getClientProperties } = require('../services/client-service');
const { scrapeCostaSelectPage } = require('../services/costaselect-scraper');
const { lookupIdealista } = require('../services/idealista-lookup');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';

const FULL_SELECT = 'ref,url,price,property_type,town,province,beds,baths,built_m2,plot_m2,pool,new_build,features,desc_nl,desc_en';

async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function resolveProperty(input) {
  if (input.startsWith('http')) {
    if (input.includes('idealista.com')) return lookupIdealista(input);

    // Exacte URL match
    const rows = await sbFetch(
      `resales_properties?url=eq.${encodeURIComponent(input)}&select=${FULL_SELECT}&limit=1`
    );
    if (rows?.[0]) return rows[0];

    // Costa Select: probeer ref te extraheren en in Supabase op te zoeken
    if (input.includes('costaselect.com')) {
      try {
        const res = await fetch(input, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WoningBot/1.0)' },
        });
        const html = await res.text();
        const refMatch = html.match(/<small[^>]*>\s*(\d{5,7})\s*<\/small>/i);
        if (refMatch) {
          const rows2 = await sbFetch(
            `resales_properties?ref=eq.${encodeURIComponent(refMatch[1])}&select=${FULL_SELECT}&limit=1`
          );
          if (rows2?.[0]) return rows2[0];
        }
      } catch { /* ignore */ }
      // Fallback: scrape de pagina direct
      try {
        return await scrapeCostaSelectPage(input);
      } catch { /* ignore */ }
    }
    return null;
  }

  const rows = await sbFetch(
    `resales_properties?ref=eq.${encodeURIComponent(input)}&select=${FULL_SELECT}&limit=1`
  );
  return rows?.[0] || null;
}

/**
 * Haal shortlist op van een klant als die naam bestaat in de DB.
 * Geeft een korte samenvatting terug van wat de klant eerder heeft bekeken.
 */
async function getClientContext(clientName) {
  try {
    const rows = await getClientProperties(clientName);
    if (!rows?.length) return null;

    const props = rows
      .filter(r => r.property?.price)
      .slice(0, 5)
      .map(r => {
        const p = r.property;
        return `- ${p.property_type || 'property'} in ${p.town || '?'}, €${Number(p.price).toLocaleString('nl-NL')}, ${p.beds || '?'} slpk, ${p.built_m2 || '?'}m²${r.note ? ` (notitie: ${r.note})` : ''}`;
      });

    return props.length ? props.join('\n') : null;
  } catch {
    return null;
  }
}

function buildPropertyBlock(prop) {
  const desc = prop.desc_nl || prop.desc_en || '';
  const pricePerM2 = prop.price && prop.built_m2
    ? Math.round(prop.price / prop.built_m2)
    : null;

  const lines = [
    `Type: ${prop.property_type || '?'}`,
    `Locatie: ${prop.town || '?'}${prop.province ? `, ${prop.province}` : ''}`,
    `Prijs: €${Number(prop.price || 0).toLocaleString('nl-NL')}${pricePerM2 ? ` (€${pricePerM2.toLocaleString('nl-NL')}/m²)` : ''}`,
    `Slaapkamers: ${prop.beds ?? '?'}`,
    `Badkamers: ${prop.baths ?? '?'}`,
    `Bebouwde opp.: ${prop.built_m2 ?? '?'} m²`,
    `Perceeloppervlakte: ${prop.plot_m2 ?? '?'} m²`,
    `Zwembad: ${prop.pool === true ? 'Ja' : prop.pool === false ? 'Nee' : 'Onbekend'}`,
    `Nieuwbouw: ${prop.new_build === true ? 'Ja' : prop.new_build === false ? 'Nee' : 'Onbekend'}`,
  ];

  const features = (prop.features || []);
  if (features.length) lines.push(`Kenmerken: ${features.join(', ')}`);
  if (desc) lines.push(`Beschrijving: ${desc.substring(0, 800)}`);

  return lines.join('\n');
}

function parsePitchInput(text) {
  // Extract URL indien aanwezig
  let remaining = text.trim();
  let propertyInput = null;

  const urlMatch = remaining.match(/https?:\/\/\S+/);
  if (urlMatch) {
    propertyInput = urlMatch[0];
    remaining = remaining.replace(propertyInput, '').trim();
  } else {
    // Eerste token = ref
    const parts = remaining.split(/\s+/);
    propertyInput = parts[0];
    remaining = parts.slice(1).join(' ').trim();
  }

  // Detecteer taal flag: nl / en / de aan het einde
  let lang = 'nl';
  const langMatch = remaining.match(/\b(nl|en|de|fr)\b$/i);
  if (langMatch) {
    lang = langMatch[1].toLowerCase();
    remaining = remaining.replace(langMatch[0], '').trim();
  }

  // Detecteer formaat flag: email / whatsapp / beschrijving
  let format = 'whatsapp';
  const fmtMatch = remaining.match(/\b(email|whatsapp|beschrijving|description)\b/i);
  if (fmtMatch) {
    format = fmtMatch[1].toLowerCase();
    remaining = remaining.replace(fmtMatch[0], '').trim();
  }

  const profile = remaining.trim() || null;

  return { propertyInput, profile, lang, format };
}

const LANG_LABELS = { nl: 'Nederlands', en: 'English', de: 'Deutsch', fr: 'Français' };
const FORMAT_LABELS = {
  whatsapp: 'WhatsApp bericht (kort, direct, persoonlijk, max 160 woorden)',
  email: 'e-mail (iets langer, met aanhef en afsluiting, max 250 woorden)',
  beschrijving: 'property beschrijving voor presentatie of website (objectief maar wervend, max 200 woorden)',
  description: 'property description for presentation or website (objective but compelling, max 200 words)',
};

function buildPrompt(prop, profile, clientContext, lang, format) {
  const langLabel = LANG_LABELS[lang] || 'Nederlands';
  const formatLabel = FORMAT_LABELS[format] || FORMAT_LABELS.whatsapp;
  const pricePerM2 = prop.price && prop.built_m2
    ? Math.round(prop.price / prop.built_m2)
    : null;

  const clientSection = clientContext
    ? `\n**Eerder bekeken door deze klant (context voor personalisatie):**\n${clientContext}`
    : '';

  const profileSection = profile
    ? `\n**Klantprofiel / doelgroep:**\n${profile}`
    : '\n**Klantprofiel:** onbekend — schrijf voor een algemeen hoogwaardig publiek';

  return `Je bent een topmakelaar in Spaans luxevastgoed met 20 jaar ervaring. Je schrijft pitches die voelen als een persoonlijk advies van een vertrouwde expert — nooit als een folder of advertentie.

**Vaste regels:**
- Geen clichés: verboden woorden zijn "droomwoning", "unieke kans", "adembenemend", "must-see", "parels", "perfect", "fantastisch"
- Gebruik concrete details: vierkante meters, oriëntatie, specifieke locatievoordelen
- De opening moet direct raken aan wat deze specifieke koper wil — niet generiek beginnen
- Verwerk één scherpe, onverwachte hoek die de koper zelf nog niet had bedacht (bijv. verhuurpotentieel, perceelwaarde, locatietrend, prijs/m² vs omgeving, uitbreidingsmogelijkheden)
- Eindig met een zachte urgentie — geen druk, wel een reden om nu te handelen
- Schrijf als een mens, niet als een systeem

**Formaat:** ${formatLabel}
**Taal:** ${langLabel}

**Property gegevens:**
${buildPropertyBlock(prop)}${pricePerM2 ? `\nPrijs per m² bebouwd: €${pricePerM2.toLocaleString('nl-NL')}` : ''}
${profileSection}${clientSection}

Geef je antwoord in dit exacte formaat:

---PITCH---
[de pitch tekst hier]
---EINDE PITCH---

---ANGLES---
• [Scherpe gesprekshaak 1 voor de consultant — concreet en verrassend]
• [Scherpe gesprekshaak 2]
• [Scherpe gesprekshaak 3]
---EINDE ANGLES---`;
}

function parseResponse(text) {
  const pitchMatch = text.match(/---PITCH---([\s\S]*?)---EINDE PITCH---/);
  const anglesMatch = text.match(/---ANGLES---([\s\S]*?)---EINDE ANGLES---/);

  const pitch = pitchMatch?.[1]?.trim() || text.trim();
  const angles = anglesMatch?.[1]?.trim() || null;

  return { pitch, angles };
}

function buildSlackBlocks(prop, pitch, angles) {
  const title = `${prop.property_type || 'Property'} in ${prop.town || '?'} — €${Number(prop.price || 0).toLocaleString('nl-NL')}`;
  const propUrl = prop.url || null;

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Pitch* — ${propUrl ? `<${propUrl}|${title}>` : title}`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: pitch },
    },
  ];

  if (angles) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Consultant talking points*\n${angles}`,
        },
      }
    );
  }

  return blocks;
}

async function handlePitch({ command, ack, respond, client }) {
  await ack();

  const text = command.text?.trim();
  if (!text) {
    await respond({
      response_type: 'ephemeral',
      text: 'Gebruik: `/pitch [ref of URL] [klantprofiel]`\nVoorbeelden:\n• `/pitch 771846 Jan Janssen`\n• `/pitch 771846 Belgisch echtpaar, gepensioneerd, tuin belangrijk`\n• `/pitch https://www.costaselect.com/... investeerder, verhuur`',
    });
    return;
  }

  const { propertyInput, profile, lang, format } = parsePitchInput(text);

  if (!propertyInput) {
    await respond({ response_type: 'ephemeral', text: 'Geef een ref-nummer of URL op.' });
    return;
  }

  // Stuur bezig-bericht
  let statusMsg;
  try {
    statusMsg = await client.chat.postMessage({
      channel: command.channel_id,
      text: '✍️ Pitch genereren...',
    });
  } catch {
    await respond({ response_type: 'in_channel', text: '✍️ Pitch genereren...' });
  }

  const updateStatus = async (msg) => {
    if (!statusMsg?.ts) return;
    try {
      await client.chat.update({ channel: command.channel_id, ts: statusMsg.ts, text: msg });
    } catch { /* ignore */ }
  };

  try {
    await updateStatus('🔍 Property ophalen...');
    const prop = await resolveProperty(propertyInput);

    if (!prop) {
      await updateStatus(`❌ Property niet gevonden: \`${propertyInput}\``);
      return;
    }

    // Probeer klantcontext op te halen als het een naam lijkt (geen komma, geen trefwoorden)
    let clientContext = null;
    if (profile && !profile.includes(',') && profile.split(' ').length <= 3) {
      await updateStatus('🔍 Klantprofiel ophalen...');
      clientContext = await getClientContext(profile);
    }

    await updateStatus('✍️ Pitch schrijven...');

    const prompt = buildPrompt(prop, profile, clientContext, lang, format);

    const response = await claudeRetry(claude, {
      model: CLAUDE_MODEL,
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    }, { label: 'Pitch' });

    const { pitch, angles } = parseResponse(response.content[0].text);
    const blocks = buildSlackBlocks(prop, pitch, angles);

    await client.chat.update({
      channel: command.channel_id,
      ts: statusMsg.ts,
      blocks,
      text: `Pitch: ${prop.town || propertyInput}`,
    });

  } catch (err) {
    console.error('[Pitch] Fout:', err.message);
    await updateStatus(`❌ Fout: ${err.message}`);
  }
}

module.exports = { handlePitch };
