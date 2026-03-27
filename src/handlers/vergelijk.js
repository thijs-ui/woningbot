// ─── /vergelijk handler ────────────────────────────────────────────────────
// Gebruik: /vergelijk 771846 771760
//          /vergelijk https://www.costaselect.com/... https://www.costaselect.com/...

const Anthropic = require('@anthropic-ai/sdk');
const { claudeRetry } = require('../services/claude-retry');
const { lookupProperty } = require('../services/client-service');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';

async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function lookupByUrl(url) {
  // Extraheer ref uit costaselect.com URL of zoek op url kolom
  const rows = await sbFetch(
    `resales_properties?url=eq.${encodeURIComponent(url)}&select=ref,url,price,property_type,town,province,beds,baths,built_m2,plot_m2,pool,new_build,features,desc_nl,desc_en&limit=1`
  );
  return rows?.[0] || null;
}

async function resolveProperty(input) {
  if (input.startsWith('http')) {
    return lookupByUrl(input);
  }
  // Behandel als ref
  return lookupProperty(input);
}

function formatForClaude(prop, label) {
  const desc = prop.desc_nl || prop.desc_en || '';
  return `
**${label}**
- Type: ${prop.property_type || '?'}
- Locatie: ${prop.town || '?'}${prop.province ? `, ${prop.province}` : ''}
- Prijs: €${Number(prop.price || 0).toLocaleString('nl-NL')}
- Slaapkamers: ${prop.beds || '?'}
- Badkamers: ${prop.baths || '?'}
- Bebouwde opp.: ${prop.built_m2 || '?'} m²
- Perceeloppervlakte: ${prop.plot_m2 || '?'} m²
- Zwembad: ${prop.pool ? 'Ja' : 'Nee'}
- Nieuwbouw: ${prop.new_build ? 'Ja' : 'Nee'}
- Kenmerken: ${(prop.features || []).join(', ') || '—'}
- Beschrijving: ${desc.substring(0, 400)}
`.trim();
}

function buildSlackBlocks(prop1, prop2, analysis) {
  const url1 = prop1.url || null;
  const url2 = prop2.url || null;

  const title1 = `${prop1.property_type || 'Property'} in ${prop1.town || '?'} — €${Number(prop1.price || 0).toLocaleString('nl-NL')}`;
  const title2 = `${prop2.property_type || 'Property'} in ${prop2.town || '?'} — €${Number(prop2.price || 0).toLocaleString('nl-NL')}`;

  const priceDiff = prop1.price && prop2.price
    ? Math.abs(prop1.price - prop2.price)
    : null;

  const sizeDiff = prop1.built_m2 && prop2.built_m2
    ? Math.abs(prop1.built_m2 - prop2.built_m2)
    : null;

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Vergelijking*\n${url1 ? `<${url1}|${title1}>` : title1}  vs  ${url2 ? `<${url2}|${title2}>` : title2}`,
      },
    },
    { type: 'divider' },
    // Cijfers naast elkaar
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Prijs*\n€${Number(prop1.price || 0).toLocaleString('nl-NL')}` },
        { type: 'mrkdwn', text: `*Prijs*\n€${Number(prop2.price || 0).toLocaleString('nl-NL')}` },
        { type: 'mrkdwn', text: `*m² bebouwd*\n${prop1.built_m2 || '?'} m²` },
        { type: 'mrkdwn', text: `*m² bebouwd*\n${prop2.built_m2 || '?'} m²` },
        { type: 'mrkdwn', text: `*Slaapkamers*\n${prop1.beds || '?'}` },
        { type: 'mrkdwn', text: `*Slaapkamers*\n${prop2.beds || '?'}` },
        { type: 'mrkdwn', text: `*Locatie*\n${prop1.town || '?'}` },
        { type: 'mrkdwn', text: `*Locatie*\n${prop2.town || '?'}` },
      ],
    },
    ...(priceDiff || sizeDiff ? [{
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: [
          priceDiff ? `Prijsverschil: *€${priceDiff.toLocaleString('nl-NL')}*` : '',
          sizeDiff  ? `Oppervlakteverschil: *${sizeDiff} m²*` : '',
        ].filter(Boolean).join('  ·  '),
      }],
    }] : []),
    { type: 'divider' },
    // Claude analyse
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*AI Analyse*\n${analysis}` },
    },
  ];
}

async function handleVergelijk({ command, ack, respond, client }) {
  await ack();

  const text = command.text?.trim();
  if (!text) {
    await respond({
      response_type: 'ephemeral',
      text: 'Gebruik: `/vergelijk [ref1] [ref2]`\nVoorbeeld: `/vergelijk 771846 771760`',
    });
    return;
  }

  // Parse twee inputs (refs of URLs)
  const parts = text.match(/https?:\/\/\S+|\S+/g) || [];
  if (parts.length < 2) {
    await respond({
      response_type: 'ephemeral',
      text: 'Geef twee refs of URLs op. Voorbeeld: `/vergelijk 771846 771760`',
    });
    return;
  }

  // Stuur bezig-bericht
  let statusMsg;
  try {
    statusMsg = await client.chat.postMessage({
      channel: command.channel_id,
      text: '🔍 Properties ophalen en vergelijken...',
    });
  } catch {
    await respond({ response_type: 'in_channel', text: '🔍 Vergelijking bezig...' });
  }

  const updateStatus = async (text) => {
    if (!statusMsg?.ts) return;
    try {
      await client.chat.update({ channel: command.channel_id, ts: statusMsg.ts, text });
    } catch { /* ignore */ }
  };

  try {
    await updateStatus('🔍 Properties ophalen...');

    const [prop1, prop2] = await Promise.all([
      resolveProperty(parts[0]),
      resolveProperty(parts[1]),
    ]);

    if (!prop1) {
      await updateStatus(`❌ Property niet gevonden: \`${parts[0]}\``);
      return;
    }
    if (!prop2) {
      await updateStatus(`❌ Property niet gevonden: \`${parts[1]}\``);
      return;
    }

    await updateStatus('🤖 AI vergelijking maken...');

    const prompt = `Je bent een Nederlandse vastgoedexpert. Vergelijk deze twee properties voor een potentiële koper en geef een eerlijk advies. Wees concreet en benoem duidelijke voor- en nadelen van beide. Sluit af met een aanbeveling. Maximaal 200 woorden. Antwoord in het Nederlands.

${formatForClaude(prop1, 'Property 1')}

${formatForClaude(prop2, 'Property 2')}`;

    const response = await claudeRetry(claude, {
      model: CLAUDE_MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    }, { label: 'Vergelijk' });

    const analysis = response.content[0].text.trim();
    const blocks   = buildSlackBlocks(prop1, prop2, analysis);

    await client.chat.update({
      channel: command.channel_id,
      ts: statusMsg.ts,
      blocks,
      text: `Vergelijking: ${prop1.town} vs ${prop2.town}`,
    });

  } catch (err) {
    console.error('[Vergelijk] Fout:', err.message);
    await updateStatus(`❌ Fout: ${err.message}`);
  }
}

module.exports = { handleVergelijk };
