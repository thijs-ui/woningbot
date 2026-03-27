// ─── /buurt handler ─────────────────────────────────────────────────────────
// Gebruik: /buurt Jávea
//          /buurt Nueva Andalucia
//          /buurt Marbella koop

const Anthropic = require('@anthropic-ai/sdk');
const { claudeRetry } = require('../services/claude-retry');
const { getPricesForLocation, getPriceHistory, formatPriceDataForClaude } = require('../services/ev-prices');

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

async function handleBuurt({ command, ack, client }) {
  await ack();

  const text = (command.text || '').trim();
  if (!text) {
    await client.chat.postMessage({
      channel: command.channel_id,
      text: 'Gebruik: `/buurt [locatie]`\nVoorbeelden:\n• `/buurt Jávea`\n• `/buurt Nueva Andalucia`\n• `/buurt Marbella koop`',
    });
    return;
  }

  // Parse marketing type filter
  let marketingType = null;
  let location = text;
  if (/\bhuur\b/i.test(text)) { marketingType = 'rent'; location = text.replace(/\bhuur\b/i, '').trim(); }
  if (/\bkoop\b/i.test(text)) { marketingType = 'sale'; location = text.replace(/\bkoop\b/i, '').trim(); }

  const statusMsg = await client.chat.postMessage({
    channel: command.channel_id,
    text: `🏘️ Buurtanalyse ophalen voor _${location}_...`,
  });

  const update = async (msg) => {
    try { await client.chat.update({ channel: command.channel_id, ts: statusMsg.ts, text: msg }); } catch { /* ignore */ }
  };

  try {
    await update(`🔍 Marktdata + aanbod ophalen voor ${location}...`);

    const [evData, history, inventory] = await Promise.all([
      getPricesForLocation(location),
      getPriceHistory(location, marketingType),
      getInventoryStats(location),
    ]);

    if (!evData.found && !inventory) {
      await update(`❌ Geen data gevonden voor "${location}". Probeer de officiële plaatsnaam.`);
      return;
    }

    await update(`🤖 Analyse schrijven voor ${location}...`);

    const evContext = evData.found ? formatPriceDataForClaude(evData, history) : `Geen E&V marktdata beschikbaar voor ${location}.`;
    const invContext = formatInventory(inventory, location);

    const prompt = `Je bent een vastgoedmarktanalist gespecialiseerd in Spaans onroerend goed. Schrijf een buurtanalyse van ${location} voor een Nederlandse vastgoedconsultant die dit gebruikt in klantgesprekken.

Structuur (gebruik deze kopjes exact):
*Marktpositie*
Hoe staat ${location} in de markt? Hot, stabiel of afkoelend? Vergelijk prijs/m² met het regionale gemiddelde als mogelijk.

*Investeerdersprofiel*
Wat trekt kopers hier naartoe? Welk type koper past bij deze markt (pensionado, investeerder, gezin, digitale nomade)? Waarom nu?

*Rendementsanalyse*
Bereken een indicatieve bruto huuryield als je zowel koop- als huurprijs/m² hebt. Wat is de prijstrend van de afgelopen jaren?

*Risico's & aandachtspunten*
Eerlijk en concreet — wat moet een koper weten?

*Consultant talking points*
• [Concreet argument 1 voor de consultant]
• [Concreet argument 2]
• [Concreet argument 3]

Regels:
- Schrijf in het Nederlands
- Gebruik Slack mrkdwn: *bold*, geen #headers
- Wees concreet: gebruik de exacte cijfers uit de data
- Max 600 woorden

${evContext}

${invContext}`;

    const response = await claudeRetry(claude, {
      model: CLAUDE_MODEL,
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    }, { label: 'Buurt' });

    const analysis = response.content[0].text.trim();
    const statsBlocks = buildStatsBlocks(location, evData.found ? evData : { location, prices: [] }, inventory, marketingType);

    const analysisBlock = {
      type: 'section',
      text: { type: 'mrkdwn', text: analysis },
    };

    await client.chat.update({
      channel: command.channel_id,
      ts: statusMsg.ts,
      blocks: [...statsBlocks, { type: 'divider' }, analysisBlock],
      text: `Buurtanalyse: ${location}`,
    });

  } catch (err) {
    console.error('[Buurt] Fout:', err.message);
    await update(`❌ Fout: ${err.message}`);
  }
}

module.exports = { handleBuurt };
