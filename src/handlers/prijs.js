/**
 * /prijs handler — Answers price questions about Spanish real estate markets.
 *
 * Data source: Engel & Völkers market data stored in Supabase (ev_market_data table).
 * Scraped weekly, covers 976 locations across Andalusia and Valencian Community.
 *
 * Usage examples:
 *   /prijs Marbella
 *   /prijs huur Estepona
 *   /prijs vergelijk Marbella en Torrevieja
 *   /prijs Nueva Andalucia
 *   /prijs trend Benidorm
 */

const Anthropic = require('@anthropic-ai/sdk');
const { claudeRetry } = require('../services/claude-retry');
const {
  getPricesForLocation,
  getPriceHistory,
  comparePrices,
  formatPriceDataForClaude,
  isConfigured,
} = require('../services/ev-prices');
const { setThread } = require('../store/thread-memory');

const claude = new Anthropic();

// ─── Query parser ─────────────────────────────────────────────────────────

/**
 * Parse the user's price query to extract intent, locations, and filters.
 * Does NOT use Claude — pure regex/keyword parsing for speed.
 *
 * @param {string} query - Raw user input
 * @returns {Object} { intent, locations, marketingType, includeHistory, includeNeighborhoods }
 */
function parsePriceQuery(query) {
  const q = query.toLowerCase().trim();

  // Detect intent
  let intent = 'lookup'; // default: single location lookup
  if (/vergelijk|versus|vs\.?|tegenover|compared?\s+to/i.test(q)) {
    intent = 'compare';
  } else if (/trend|ontwikkeling|historie|historisch|verloop|stijging|daling|afgelopen/i.test(q)) {
    intent = 'trend';
  }

  // Detect marketing type
  let marketingType = null; // null = both
  if (/\b(huur|huren|verhuur|rental?)\b/i.test(q)) {
    marketingType = 'rent';
  } else if (/\b(koop|kopen|verkoop|sale|buy)\b/i.test(q)) {
    marketingType = 'sale';
  }

  // Extract location names
  // Remove known keywords to isolate location names
  let cleaned = q
    .replace(/\b(prijs|prijzen|huur|huren|verhuur|rental?|koop|kopen|verkoop|sale|buy)\b/gi, '')
    .replace(/\b(vergelijk|versus|vs\.?|tegenover|compared?\s+to)\b/gi, ',')
    .replace(/\b(trend|ontwikkeling|historie|historisch|verloop|stijging|daling|afgelopen)\b/gi, '')
    .replace(/\b(woning|woningen|huis|huizen|appartement|appartementen|villa|villas)\b/gi, '')
    .replace(/\b(gemiddelde?|per\s+m2|m²|vierkante?\s+meter)\b/gi, '')
    .replace(/\b(en|and|of|or|in|van|voor|de|het|een)\b/gi, ',')
    .trim();

  // Split on commas, 'en', 'and', etc.
  const locations = cleaned
    .split(/[,;]+/)
    .map(s => s.trim())
    .filter(s => s.length > 1)
    // Capitalize first letter of each word
    .map(s => s.replace(/\b\w/g, c => c.toUpperCase()));

  // If compare intent but only 1 location, switch to lookup
  if (intent === 'compare' && locations.length < 2) {
    intent = 'lookup';
  }

  // If multiple locations detected, switch to compare
  if (locations.length >= 2 && intent === 'lookup') {
    intent = 'compare';
  }

  return {
    intent,
    locations,
    marketingType,
    includeHistory: intent === 'trend' || locations.length === 1,
    includeNeighborhoods: true,
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────

async function handlePrijs({ command, ack, client }) {
  await ack();

  const ts = new Date().toISOString();
  const query = (command.text || '').trim();
  const channelId = command.channel_id;
  const userId = command.user_id;

  console.log(`[${ts}] [Prijs] Received: "${query}" from user ${userId}`);

  // Validate
  if (!query) {
    await client.chat.postMessage({
      channel: channelId,
      text: '❓ Geef een locatie op. Voorbeelden:\n• `/prijs Marbella`\n• `/prijs huur Estepona`\n• `/prijs vergelijk Marbella en Torrevieja`\n• `/prijs trend Benidorm`',
    });
    return;
  }

  if (!isConfigured()) {
    await client.chat.postMessage({
      channel: channelId,
      text: '⚠️ Prijsdata niet beschikbaar. Controleer of SUPABASE_ANON_KEY is ingesteld.',
    });
    return;
  }

  // Post initial status
  const statusMsg = await client.chat.postMessage({
    channel: channelId,
    text: `🔍 Prijsdata ophalen voor: _${query}_...`,
  });

  try {
    // Parse the query
    const parsed = parsePriceQuery(query);
    console.log(`[${ts}] [Prijs] Parsed:`, JSON.stringify(parsed));

    if (parsed.locations.length === 0) {
      await client.chat.update({
        channel: channelId,
        ts: statusMsg.ts,
        text: `⚠️ Kon geen locatie herkennen in "${query}". Probeer bijvoorbeeld: \`/prijs Marbella\` of \`/prijs vergelijk Estepona en Marbella\``,
      });
      return;
    }

    let context = '';
    let headerInfo = '';

    if (parsed.intent === 'compare') {
      // ─── Compare mode ───────────────────────────────────────────
      await client.chat.update({
        channel: channelId,
        ts: statusMsg.ts,
        text: `🔍 Prijzen vergelijken: ${parsed.locations.join(' vs ')}...`,
      });

      const results = await comparePrices(parsed.locations);
      const found = results.filter(r => r.found);

      if (found.length === 0) {
        await client.chat.update({
          channel: channelId,
          ts: statusMsg.ts,
          text: `⚠️ Geen prijsdata gevonden voor: ${parsed.locations.join(', ')}. Probeer een andere locatie.`,
        });
        return;
      }

      // Build context for each location
      for (const result of results) {
        if (result.found) {
          context += formatPriceDataForClaude(result) + '\n\n';
        } else {
          context += `=== ${result.location}: GEEN DATA GEVONDEN ===\n\n`;
        }
      }

      headerInfo = `Vergelijking: ${found.map(r => r.location).join(' vs ')} (${found.length} locaties)`;

    } else if (parsed.intent === 'trend') {
      // ─── Trend mode ─────────────────────────────────────────────
      const locationName = parsed.locations[0];

      await client.chat.update({
        channel: channelId,
        ts: statusMsg.ts,
        text: `📈 Prijstrend ophalen voor ${locationName}...`,
      });

      const [priceData, history] = await Promise.all([
        getPricesForLocation(locationName),
        getPriceHistory(locationName, parsed.marketingType),
      ]);

      if (!priceData.found && history.length === 0) {
        await client.chat.update({
          channel: channelId,
          ts: statusMsg.ts,
          text: `⚠️ Geen prijsdata gevonden voor "${locationName}". Probeer een andere locatie.`,
        });
        return;
      }

      context = formatPriceDataForClaude(priceData, history);
      headerInfo = `Prijstrend: ${priceData.location || locationName}`;

    } else {
      // ─── Lookup mode (default) ──────────────────────────────────
      const locationName = parsed.locations[0];

      await client.chat.update({
        channel: channelId,
        ts: statusMsg.ts,
        text: `🔍 Prijsdata ophalen voor ${locationName}...`,
      });

      const [priceData, history] = await Promise.all([
        getPricesForLocation(locationName),
        getPriceHistory(locationName, parsed.marketingType),
      ]);

      if (!priceData.found) {
        await client.chat.update({
          channel: channelId,
          ts: statusMsg.ts,
          text: `⚠️ Geen prijsdata gevonden voor "${locationName}". Probeer een andere locatie.\n\nTip: gebruik de officiële stadsnaam (bijv. "Marbella", niet "Marbs").`,
        });
        return;
      }

      context = formatPriceDataForClaude(priceData, history);
      headerInfo = `Prijsoverzicht: ${priceData.location || locationName}`;
    }

    // ─── Claude summarization ───────────────────────────────────────
    await client.chat.update({
      channel: channelId,
      ts: statusMsg.ts,
      text: `📊 ${headerInfo} — samenvatting maken...`,
    });

    const typeFilter = parsed.marketingType === 'rent' ? ' (alleen huur)' : parsed.marketingType === 'sale' ? ' (alleen koop)' : '';

    const summary = await claudeRetry(claude, {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: `Je bent een marktdata-analist voor een Nederlandse makelaardij die kopers begeleidt bij het kopen van vastgoed in Spanje. Je geeft heldere, professionele antwoorden in het Nederlands over vastgoedprijzen.

REGELS:
- Antwoord altijd in het Nederlands
- Gebruik Slack-formatting: *bold* voor nadruk, geen markdown headers
- Geef prijzen in €/m² en bereken ook een indicatieve totaalprijs voor een typisch appartement (80-100m²) en woning (150-200m²) als dat nuttig is
- Bij wijkdata: sorteer van duurste naar goedkoopste
- Bij vergelijkingen: wees concreet over de verschillen in percentage
- Bij trends: bereken de totale stijging/daling over de beschikbare periode
- Noem altijd de bron (Engel & Völkers) en dat het om gemiddelde m²-prijzen gaat
- Als data ontbreekt voor een locatie, zeg dat eerlijk
- Houd het antwoord compact maar informatief — maximaal 1500 tekens
- Gebruik GEEN emoji behalve 📊 als header-icoon`,
      messages: [{
        role: 'user',
        content: `Gebruikersvraag: "${query}"${typeFilter}

Beschikbare marktdata:
${context}

Geef een helder, professioneel antwoord op de vraag van de gebruiker.`,
      }],
    }, { label: '[PrijsSummary]' });

    const summaryText = summary.content[0].text;

    // ─── Post final result ──────────────────────────────────────────
    const finalMessage = `📊 *${headerInfo}*\n_Bron: Engel & Völkers marktdata_\n\n${summaryText}\n\n_Stel vervolgvragen in deze thread._`;

    const result = await client.chat.update({
      channel: channelId,
      ts: statusMsg.ts,
      text: finalMessage,
    });

    // Store thread data for follow-up questions
    try {
      await client.conversations.join({ channel: channelId }).catch(() => {});
    } catch (e) { /* ignore */ }

    setThread(result.ts, {
      type: 'prijs',
      query,
      context,
      location: parsed.locations.join(', '),
      channelId,
      conversation_history: [],
      created_at: Date.now(),
    });

    console.log(`[${ts}] [Prijs] Done. ${headerInfo}`);

  } catch (error) {
    console.error(`[${ts}] [Prijs] Error:`, error);

    const errorMsg = error.status === 529
      ? '⚠️ Claude is momenteel overbelast. Probeer het over een minuut opnieuw.'
      : `⚠️ Er ging iets mis: ${error.message}`;

    await client.chat.update({
      channel: channelId,
      ts: statusMsg.ts,
      text: errorMsg,
    }).catch(() => {});
  }
}

// ─── Thread reply handler for follow-up questions ─────────────────────────

async function handlePrijsThreadReply({ event, client, threadData }) {
  const ts = new Date().toISOString();
  const userMessage = event.text || '';

  console.log(`[${ts}] [Prijs] Thread reply: "${userMessage.substring(0, 80)}"`);

  try {
    const response = await claudeRetry(claude, {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: `Je bent een marktdata-analist voor een Nederlandse makelaardij. Je beantwoordt vervolgvragen over vastgoedprijzen in Spanje in het Nederlands.

Gebruik de eerder opgehaalde marktdata als context. Als de vraag buiten de beschikbare data valt, zeg dat eerlijk.

REGELS:
- Antwoord in het Nederlands
- Gebruik Slack-formatting
- Houd antwoorden compact (max 1500 tekens)
- Bron: Engel & Völkers marktdata`,
      messages: [{
        role: 'user',
        content: `Eerdere context (marktdata):
${threadData.context}

Vervolgvraag van de gebruiker: "${userMessage}"`,
      }],
    }, { label: '[PrijsThread]' });

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: response.content[0].text,
    });

  } catch (error) {
    console.error(`[${ts}] [Prijs] Thread reply error:`, error);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: '⚠️ Kon de vraag niet beantwoorden. Probeer het opnieuw.',
    }).catch(() => {});
  }
}

module.exports = { handlePrijs, handlePrijsThreadReply };
