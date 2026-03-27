// ─── /vergelijk handler ────────────────────────────────────────────────────
// Gebruik: /vergelijk 771846 771760
//          /vergelijk https://www.costaselect.com/... https://www.costaselect.com/...

const Anthropic = require('@anthropic-ai/sdk');
const { ApifyClient } = require('apify-client');
const { claudeRetry } = require('../services/claude-retry');
const { lookupProperty } = require('../services/client-service');

const APIFY_TOKEN = process.env.APIFY_API_TOKEN || process.env.APIFY_TOKEN || '';
const IDEALISTA_ACTOR_ID = 'igolaizola/idealista-scraper';
const apifyClient = APIFY_TOKEN ? new ApifyClient({ token: APIFY_TOKEN }) : null;

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

const FULL_SELECT = 'ref,url,price,property_type,town,province,beds,baths,built_m2,plot_m2,pool,new_build,features,desc_nl,desc_en';

async function lookupPropertyFull(ref) {
  const rows = await sbFetch(
    `resales_properties?ref=eq.${encodeURIComponent(ref)}&select=${FULL_SELECT}&limit=1`
  );
  return rows?.[0] || null;
}

async function lookupByUrl(url) {
  // 1. Probeer exacte URL match
  const rows = await sbFetch(
    `resales_properties?url=eq.${encodeURIComponent(url)}&select=${FULL_SELECT}&limit=1`
  );
  if (rows?.[0]) return rows[0];

  // 2. Voor costaselect.com: haal pagina op en extraheer ref uit <small> tag
  if (url.includes('costaselect.com')) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WoningBot/1.0)' },
      });
      const html = await res.text();
      const refMatch = html.match(/<small[^>]*>\s*(\d{5,7})\s*<\/small>/i);
      if (refMatch) {
        const prop = await lookupPropertyFull(refMatch[1]);
        if (prop) return prop;
      }
    } catch {
      // Pagina ophalen mislukt, verder met null
    }
  }

  return null;
}

async function lookupIdealista(url) {
  if (!apifyClient) throw new Error('Apify client niet geconfigureerd (APIFY_API_TOKEN ontbreekt)');

  const codeMatch = url.match(/\/inmueble\/(\d+)/);
  if (!codeMatch) throw new Error(`Geen propertyCode gevonden in URL: ${url}`);
  const propertyCode = codeMatch[1];

  console.log(`[Vergelijk] Idealista lookup: propertyCode=${propertyCode}`);

  const run = await apifyClient.actor(IDEALISTA_ACTOR_ID).call({
    operation: 'sale',
    propertyType: 'homes',
    country: 'es',
    location: '0-EU-ES-28-07-001-079', // Madrid — required but ignored when propertyCodes is set
    propertyCodes: [propertyCode],
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
  }, { timeout: 300, memory: 1024 });

  console.log(`[Vergelijk] Idealista run finished: datasetId=${run?.defaultDatasetId}`);

  if (!run?.defaultDatasetId) return null;

  const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
  console.log(`[Vergelijk] Idealista dataset items: ${items?.length ?? 0}`);
  const item = items?.[0];
  if (!item) return null;

  const get = (dotKey) => {
    if (item[dotKey] !== undefined) return item[dotKey];
    const parts = dotKey.split('.');
    let val = item;
    for (const p of parts) { if (val == null) return null; val = val[p]; }
    return val ?? null;
  };

  const features = [];
  if (get('features.hasSwimmingPool')) features.push('pool');
  if (get('features.hasGarden')) features.push('garden');
  if (get('features.hasTerrace')) features.push('terrace');
  if (get('features.hasAirConditioning')) features.push('air_conditioning');
  if (item.hasLift) features.push('elevator');
  if (get('parkingSpace.hasParkingSpace')) features.push('garage');
  const desc = (item.description || '').toLowerCase();
  if (!features.includes('pool') && (desc.includes('piscina') || desc.includes('pool'))) features.push('pool');

  return {
    ref:           propertyCode,
    url:           item.url || url,
    price:         item.price || get('priceInfo.price.amount') || null,
    property_type: item.propertyType || null,
    town:          item.municipality || null,
    province:      item.province || null,
    beds:          item.rooms || null,
    baths:         item.bathrooms || null,
    built_m2:      item.size || null,
    plot_m2:       item.plotSize || null,
    pool:          features.includes('pool') || null,
    new_build:     item.newDevelopment || null,
    features,
    desc_en:       item.description || null,
    desc_nl:       null,
  };
}

async function resolveProperty(input) {
  if (input.startsWith('http')) {
    if (input.includes('idealista.com')) {
      try {
        return await lookupIdealista(input);
      } catch (err) {
        console.error(`[Vergelijk] Idealista lookup fout: ${err.message}`);
        throw err;
      }
    }
    return lookupByUrl(input);
  }
  return lookupPropertyFull(input);
}

function formatForClaude(prop, label) {
  const desc = prop.desc_nl || prop.desc_en || '';
  const hasPoolInFeatures = (prop.features || []).some(f => /pool|zwembad/i.test(f));
  const poolVal = (prop.pool === true || hasPoolInFeatures) ? 'Ja' : prop.pool === false && !hasPoolInFeatures ? 'Nee' : 'Onbekend';
  const newBuildVal = prop.new_build === true ? 'Ja' : prop.new_build === false ? 'Nee' : 'Onbekend';
  return `
**${label}**
- Type: ${prop.property_type || '?'}
- Locatie: ${prop.town || '?'}${prop.province ? `, ${prop.province}` : ''}
- Prijs: €${Number(prop.price || 0).toLocaleString('nl-NL')}
- Slaapkamers: ${prop.beds ?? '?'}
- Badkamers: ${prop.baths ?? '?'}
- Bebouwde opp.: ${prop.built_m2 ?? '?'} m²
- Perceeloppervlakte: ${prop.plot_m2 ?? '?'} m²
- Zwembad: ${poolVal}
- Nieuwbouw: ${newBuildVal}
- Kenmerken: ${(prop.features || []).join(', ') || '—'}
- Beschrijving: ${desc.substring(0, 600)}
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

    const prompt = `Je bent een ervaren Nederlandse vastgoedmakelaar gespecialiseerd in Spaans onroerend goed. Analyseer onderstaande twee properties zorgvuldig en geef een vergelijking voor een potentiële koper.

Gebruik de volgende structuur:
1. **Korte samenvatting** – wat maakt elke woning uniek?
2. **Voordelen & nadelen** – per woning, concreet en eerlijk
3. **Prijs-kwaliteit** – wie biedt meer voor het geld?
4. **Aanbeveling** – voor welk type koper is welke woning het meest geschikt?

Baseer je analyse uitsluitend op de verstrekte gegevens. Als iets onbekend is, zeg dat dan. Antwoord in het Nederlands.

${formatForClaude(prop1, 'Property 1')}

${formatForClaude(prop2, 'Property 2')}`;

    const response = await claudeRetry(claude, {
      model: CLAUDE_MODEL,
      max_tokens: 900,
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
