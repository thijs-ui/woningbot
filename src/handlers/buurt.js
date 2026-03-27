// ─── /buurt handler ─────────────────────────────────────────────────────────
// Gebruik: /buurt Jávea
//          /buurt 771846               (property → buurt auto-detect)
//          /buurt https://costaselect.com/...
//          /buurt Marbella koop

const Anthropic = require('@anthropic-ai/sdk');
const { claudeRetry } = require('../services/claude-retry');
const { getPricesForLocation, getPriceHistory, formatPriceDataForClaude } = require('../services/ev-prices');
const { scrapeCostaSelectPage } = require('../services/costaselect-scraper');
const { lookupIdealista } = require('../services/idealista-lookup');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';

async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * Haal inventory stats op uit resales_properties voor een locatie.
 */
async function getInventoryStats(town) {
  const encoded = encodeURIComponent(town);
  const rows = await sbFetch(
    `resales_properties?town=ilike.${encoded}&select=price,built_m2,property_type,pool,new_build,beds`
  );
  if (!rows?.length) return null;

  const withPrice = rows.filter(r => r.price > 0);
  if (!withPrice.length) return null;

  const prices    = withPrice.map(r => r.price);
  const perM2     = withPrice.filter(r => r.built_m2 > 0).map(r => r.price / r.built_m2);
  const minPrice  = Math.min(...prices);
  const maxPrice  = Math.max(...prices);
  const avgPrice  = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
  const avgPerM2  = perM2.length ? Math.round(perM2.reduce((a, b) => a + b, 0) / perM2.length) : null;

  // Type verdeling
  const typeCounts = {};
  for (const r of rows) {
    const t = r.property_type || 'Overig';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  const topTypes = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t, n]) => `${t} (${n})`);

  const poolCount     = rows.filter(r => r.pool).length;
  const newBuildCount = rows.filter(r => r.new_build).length;

  return {
    total:     rows.length,
    minPrice,
    maxPrice,
    avgPrice,
    avgPerM2,
    topTypes,
    poolPct:     Math.round((poolCount / rows.length) * 100),
    newBuildPct: Math.round((newBuildCount / rows.length) * 100),
  };
}

function formatInventory(stats, town) {
  if (!stats) return `Geen aanbod gevonden in Costa Select database voor ${town}.`;

  return [
    `=== COSTA SELECT AANBOD: ${town} ===`,
    `Aantal woningen: ${stats.total}`,
    `Prijsrange: €${stats.minPrice.toLocaleString('nl-NL')} – €${stats.maxPrice.toLocaleString('nl-NL')}`,
    `Gemiddelde prijs: €${stats.avgPrice.toLocaleString('nl-NL')}`,
    stats.avgPerM2 ? `Gemiddelde prijs/m² (aanbod): €${stats.avgPerM2.toLocaleString('nl-NL')}/m²` : '',
    `Meest voorkomende types: ${stats.topTypes.join(', ')}`,
    `Met zwembad: ${stats.poolPct}%`,
    `Nieuwbouw: ${stats.newBuildPct}%`,
  ].filter(Boolean).join('\n');
}

function buildStatsBlocks(town, evData, inventory, marketingType) {
  const salePrice = evData.prices.find(p => p.marketing_type === 'sale' && p.object_type === 'house')
    || evData.prices.find(p => p.marketing_type === 'sale');
  const rentPrice = evData.prices.find(p => p.marketing_type === 'rent' && p.object_type === 'apartment')
    || evData.prices.find(p => p.marketing_type === 'rent');

  const fields = [];

  if (salePrice?.price_per_sqm) {
    const yoy = salePrice.yoy_change_pct ? ` (${salePrice.yoy_change_pct > 0 ? '+' : ''}${salePrice.yoy_change_pct}% j-o-j)` : '';
    fields.push({ type: 'mrkdwn', text: `*Koop prijs/m²*\n€${Number(salePrice.price_per_sqm).toLocaleString('nl-NL')}${yoy}` });
  }

  if (rentPrice?.price_per_sqm) {
    const yoy = rentPrice.yoy_change_pct ? ` (${rentPrice.yoy_change_pct > 0 ? '+' : ''}${rentPrice.yoy_change_pct}% j-o-j)` : '';
    fields.push({ type: 'mrkdwn', text: `*Huur prijs/m²*\n€${Number(rentPrice.price_per_sqm).toLocaleString('nl-NL')}${yoy}` });
  }

  if (inventory) {
    fields.push({ type: 'mrkdwn', text: `*Aanbod (Costa Select)*\n${inventory.total} woningen` });
    fields.push({ type: 'mrkdwn', text: `*Prijsrange*\n€${Math.round(inventory.minPrice / 1000)}K – €${Math.round(inventory.maxPrice / 1000)}K` });
    if (inventory.avgPerM2) {
      fields.push({ type: 'mrkdwn', text: `*Gem. prijs/m² (aanbod)*\n€${inventory.avgPerM2.toLocaleString('nl-NL')}` });
    }
    fields.push({ type: 'mrkdwn', text: `*Met zwembad*\n${inventory.poolPct}%` });
  }

  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Buurtanalyse: ${evData.location || town}*\n_E&V marktdata + Costa Select aanbod_` },
    },
    { type: 'divider' },
  ];

  if (fields.length) {
    // Slack fields max 10 items, 2 per row
    blocks.push({ type: 'section', fields: fields.slice(0, 10) });
  }

  return blocks;
}

const FULL_SELECT = 'ref,url,price,property_type,town,province,beds,baths,built_m2,plot_m2,pool,new_build,features,desc_nl,desc_en';

async function resolveProperty(input) {
  if (input.startsWith('http')) {
    if (input.includes('idealista.com')) return lookupIdealista(input);
    // Exacte URL match
    const rows = await sbFetch(
      `resales_properties?url=eq.${encodeURIComponent(input)}&select=${FULL_SELECT}&limit=1`
    );
    if (rows?.[0]) return rows[0];
    if (input.includes('costaselect.com')) {
      try {
        const res = await fetch(input, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await res.text();
        const m = html.match(/<small[^>]*>\s*(\d{5,7})\s*<\/small>/i);
        if (m) {
          const r2 = await sbFetch(`resales_properties?ref=eq.${encodeURIComponent(m[1])}&select=${FULL_SELECT}&limit=1`);
          if (r2?.[0]) return r2[0];
        }
      } catch { /* ignore */ }
      try { return await scrapeCostaSelectPage(input); } catch { /* ignore */ }
    }
    return null;
  }
  // Ref (5-7 cijfers)
  const rows = await sbFetch(
    `resales_properties?ref=eq.${encodeURIComponent(input)}&select=${FULL_SELECT}&limit=1`
  );
  return rows?.[0] || null;
}

function isPropertyInput(text) {
  return /^https?:\/\//.test(text) || /^\d{5,7}$/.test(text.split(/\s+/)[0]);
}

function formatPropertyBlock(prop) {
  const pricePerM2 = prop.price && prop.built_m2 ? Math.round(prop.price / prop.built_m2) : null;
  return [
    `=== WONING ===`,
    `Type: ${prop.property_type || '?'} in ${prop.town || '?'}${prop.province ? `, ${prop.province}` : ''}`,
    `Prijs: €${Number(prop.price || 0).toLocaleString('nl-NL')}`,
    pricePerM2 ? `Prijs/m² (woning): €${pricePerM2.toLocaleString('nl-NL')}` : '',
    `Bebouwde opp.: ${prop.built_m2 || '?'} m²`,
    `Perceeloppervlakte: ${prop.plot_m2 || '?'} m²`,
    `Slaapkamers: ${prop.beds ?? '?'} | Badkamers: ${prop.baths ?? '?'}`,
    `Zwembad: ${prop.pool === true ? 'Ja' : prop.pool === false ? 'Nee' : 'Onbekend'}`,
    prop.features?.length ? `Kenmerken: ${prop.features.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

async function handleBuurt({ command, ack, client }) {
  await ack();

  const text = (command.text || '').trim();
  if (!text) {
    await client.chat.postMessage({
      channel: command.channel_id,
      text: 'Gebruik: `/buurt [locatie of ref/URL]`\nVoorbeelden:\n• `/buurt Jávea`\n• `/buurt 771846`\n• `/buurt https://www.costaselect.com/...`',
    });
    return;
  }

  // Parse marketing type filter
  let marketingType = null;
  let input = text;
  if (/\bhuur\b/i.test(text)) { marketingType = 'rent'; input = text.replace(/\bhuur\b/i, '').trim(); }
  if (/\bkoop\b/i.test(text)) { marketingType = 'sale'; input = text.replace(/\bkoop\b/i, '').trim(); }

  const statusMsg = await client.chat.postMessage({
    channel: command.channel_id,
    text: `🏘️ Buurtanalyse ophalen...`,
  });

  const update = async (msg) => {
    try { await client.chat.update({ channel: command.channel_id, ts: statusMsg.ts, text: msg }); } catch { /* ignore */ }
  };

  try {
    let prop = null;
    let location = input;

    // Auto-detect: is de input een property ref of URL?
    if (isPropertyInput(input)) {
      await update(`🔍 Property ophalen...`);
      prop = await resolveProperty(input.split(/\s+/)[0]);
      if (!prop) {
        await update(`❌ Property niet gevonden: \`${input}\``);
        return;
      }
      location = prop.town || location;
    }

    await update(`🔍 Marktdata + aanbod ophalen voor ${location}...`);

    const [evData, history, inventory] = await Promise.all([
      getPricesForLocation(location),
      getPriceHistory(location, marketingType),
      getInventoryStats(location),
    ]);

    if (!evData.found && !inventory) {
      await update(`❌ Geen marktdata gevonden voor "${location}". Probeer de officiële plaatsnaam.`);
      return;
    }

    await update(`🤖 Analyse schrijven voor ${location}...`);

    const evContext  = evData.found ? formatPriceDataForClaude(evData, history) : `Geen E&V marktdata beschikbaar voor ${location}.`;
    const invContext = formatInventory(inventory, location);
    const propContext = prop ? formatPropertyBlock(prop) : null;

    // Bereken marktpositie van de woning t.o.v. markt
    let positioningNote = '';
    if (prop?.price && prop?.built_m2) {
      const propPerM2 = Math.round(prop.price / prop.built_m2);
      const saleRecord = evData.prices?.find(p => p.marketing_type === 'sale');
      if (saleRecord?.price_per_sqm) {
        const mktPerM2 = Number(saleRecord.price_per_sqm);
        const diff = Math.round(((propPerM2 - mktPerM2) / mktPerM2) * 100);
        positioningNote = `\nMarktpositie woning: €${propPerM2.toLocaleString('nl-NL')}/m² vs marktgemiddelde €${Math.round(mktPerM2).toLocaleString('nl-NL')}/m² = ${diff > 0 ? '+' : ''}${diff}% t.o.v. markt.`;
      }
    }

    const propSection = propContext ? `\n${propContext}${positioningNote}\n` : '';

    const prompt = `Je bent een vastgoedmarktanalist gespecialiseerd in Spaans onroerend goed. ${prop ? `Analyseer de onderstaande woning in de context van de ${location} markt.` : `Schrijf een buurtanalyse van ${location}.`} Dit is voor een Nederlandse vastgoedconsultant die dit gebruikt in klantgesprekken.

Structuur (gebruik deze kopjes exact):
${prop ? `*Marktpositie van deze woning*\nStaat de woning boven of onder het marktgemiddelde? Is het een koopje of betaalt de koper een premium? Wees concreet in %.` : `*Marktpositie*\nHoe staat ${location} in de markt? Hot, stabiel of afkoelend?`}

*Investeerdersprofiel*
Welk type koper past bij ${prop ? 'deze woning en' : ''} deze markt? Waarom nu?

*Rendementsanalyse*
${prop ? `Bereken indicatieve bruto huuryield voor deze woning op basis van de huurprijs/m² in ${location}.` : `Bereken indicatieve bruto huuryield als je zowel koop- als huurprijs/m² hebt.`} Wat is de prijstrend?

*Risico's & aandachtspunten*
Eerlijk en concreet.

*Consultant talking points*
• [Concreet argument 1]
• [Concreet argument 2]
• [Concreet argument 3]

Regels:
- Schrijf in het Nederlands
- Gebruik Slack mrkdwn: *bold*, geen #headers
- Wees concreet: gebruik de exacte cijfers uit de data
- Max 600 woorden
${propSection}
${evContext}

${invContext}`;

    const response = await claudeRetry(claude, {
      model: CLAUDE_MODEL,
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    }, { label: 'Buurt' });

    const analysis  = response.content[0].text.trim();
    const statsBlocks = buildStatsBlocks(location, evData.found ? evData : { location, prices: [] }, inventory, marketingType);

    // Voeg property header toe als er een woning is
    if (prop) {
      const propTitle = `${prop.property_type || 'Property'} in ${prop.town || '?'} — €${Number(prop.price || 0).toLocaleString('nl-NL')}`;
      const propUrl   = prop.url || null;
      statsBlocks.unshift({
        type: 'section',
        text: { type: 'mrkdwn', text: `*Woning:* ${propUrl ? `<${propUrl}|${propTitle}>` : propTitle}` },
      });
    }

    await client.chat.update({
      channel: command.channel_id,
      ts: statusMsg.ts,
      blocks: [...statsBlocks, { type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: analysis } }],
      text: `Buurtanalyse: ${location}`,
    });

  } catch (err) {
    console.error('[Buurt] Fout:', err.message);
    await update(`❌ Fout: ${err.message}`);
  }
}

module.exports = { handleBuurt };
