/**
 * /nieuwbouw Slack command handler.
 *
 * Supports:
 * - /nieuwbouw [locatie(s)]        → lijst alle actieve projecten in die locatie(s)
 * - /nieuwbouw [vraag]             → Claude beantwoordt vragen over de projecten-database
 * - /nieuwbouw sync                → handmatig een sync triggeren (admin)
 * - /nieuwbouw stats               → statistieken over de database
 */

const Anthropic = require('@anthropic-ai/sdk');
const { readAllProjects } = require('../services/google-sheets');
const { runNieuwbouwSync } = require('../jobs/nieuwbouw-sync');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Je bent de NieuwbouwBot van Costa Select, een Nederlandse makelaar in Spanje. Je hebt toegang tot een database van alle nieuwbouwprojecten die momenteel te koop zijn in Spanje (Costa del Sol, Costa Blanca North, Costa Blanca South, Valencia).

Je taak:
1. Beantwoord vragen over nieuwbouwprojecten in het Nederlands
2. Filter en presenteer projecten op basis van de vraag van de consultant
3. Verwijs altijd naar de projectnaam, locatie, prijsrange en URL
4. Wees eerlijk als er geen projecten zijn die matchen
5. Geef concrete, bruikbare antwoorden — geen vage samenvattingen

Formatteer je antwoord voor Slack (gebruik *bold* voor nadruk, geen markdown headers).
Gebruik bullet points voor lijsten van projecten.
Vermeld altijd de bron (Idealista/Fotocasa/Kyero) en de link.

Als de vraag over een specifieke locatie gaat, filter dan alleen projecten in die locatie(s).
Als de vraag over budget gaat, filter op prijs.
Als de vraag algemeen is, geef een overzicht.`;

/**
 * Handle the /nieuwbouw slash command.
 */
async function handleNieuwbouw({ command, ack, client }) {
  await ack();

  const query = (command.text || '').trim();
  const channelId = command.channel_id;
  const userId = command.user_id;
  const ts = new Date().toISOString();

  console.log(`[${ts}] [Nieuwbouw] Query from ${userId}: "${query}"`);

  if (!query) {
    await client.chat.postMessage({
      channel: channelId,
      text: '🏗️ *NieuwbouwBot — Gebruik:*\n\n• `/nieuwbouw Estepona, Marbella` — Toon alle projecten in die steden\n• `/nieuwbouw welke projecten onder 300k met 2 slaapkamers?` — Stel een vraag\n• `/nieuwbouw sync` — Handmatig database updaten\n• `/nieuwbouw stats` — Database statistieken',
    });
    return;
  }

  // Handle special commands
  if (query.toLowerCase() === 'sync') {
    await handleSync(client, channelId, ts);
    return;
  }

  if (query.toLowerCase() === 'stats') {
    await handleStats(client, channelId);
    return;
  }

  // Regular query — read Sheet and answer with Claude
  let statusMsg;
  try {
    statusMsg = await client.chat.postMessage({
      channel: channelId,
      text: '🔍 Database raadplegen...',
    });
  } catch (e) {
    console.error(`[${ts}] [Nieuwbouw] Failed to send status:`, e.message);
  }

  try {
    // Read all projects from Sheet
    const projects = await readAllProjects();
    const activeProjects = projects.filter(p => p.status === 'Actief');

    if (activeProjects.length === 0) {
      const msg = '⚠️ De projecten-database is leeg. Voer eerst `/nieuwbouw sync` uit om de database te vullen.';
      if (statusMsg) {
        await client.chat.update({ channel: channelId, ts: statusMsg.ts, text: msg });
      } else {
        await client.chat.postMessage({ channel: channelId, text: msg });
      }
      return;
    }

    // Build context for Claude — compact format to stay within token limits
    const projectContext = activeProjects.map((p, i) => {
      const parts = [
        `[${i + 1}] ${p.project_name}`,
        p.developer ? `Ontwikkelaar: ${p.developer}` : '',
        p.region ? `Regio: ${p.region}` : '',
        p.location ? `Locatie: ${p.location}` : '',
        p.property_type ? `Type: ${p.property_type}` : '',
        p.price_from ? `Prijs vanaf: €${Number(p.price_from).toLocaleString('nl-NL')}` : '',
        p.price_to ? `Prijs tot: €${Number(p.price_to).toLocaleString('nl-NL')}` : '',
        p.bedrooms ? `Slaapkamers: ${p.bedrooms}` : '',
        p.size_m2 ? `m²: ${p.size_m2}` : '',
        p.features ? `Features: ${p.features}` : '',
        p.url ? `URL: ${p.url.split('\n')[0]}` : '', // First URL only for context
        p.source ? `Bron: ${p.source}` : '',
        p.first_seen ? `Eerst gezien: ${p.first_seen}` : '',
      ].filter(Boolean);
      return parts.join(' | ');
    }).join('\n');

    // Truncate if too long (stay under ~100k tokens)
    const maxContextLength = 80000;
    const truncatedContext = projectContext.length > maxContextLength
      ? projectContext.substring(0, maxContextLength) + '\n... (meer projecten beschikbaar, stel een specifiekere vraag)'
      : projectContext;

    // Ask Claude
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Database bevat ${activeProjects.length} actieve nieuwbouwprojecten:\n\n${truncatedContext}\n\nVraag van de consultant: "${query}"`,
      }],
    });

    const answer = response.content[0].text.trim();

    // Send answer
    if (statusMsg) {
      await client.chat.update({
        channel: channelId,
        ts: statusMsg.ts,
        text: `🏗️ *NieuwbouwBot*\n\n${answer}`,
      });
    } else {
      await client.chat.postMessage({
        channel: channelId,
        text: `🏗️ *NieuwbouwBot*\n\n${answer}`,
      });
    }

    console.log(`[${ts}] [Nieuwbouw] Answer sent (${answer.length} chars)`);

  } catch (error) {
    console.error(`[${ts}] [Nieuwbouw] Error:`, error);
    const errorMsg = `⚠️ Er ging iets mis: ${error.message}`;
    if (statusMsg) {
      await client.chat.update({ channel: channelId, ts: statusMsg.ts, text: errorMsg });
    } else {
      await client.chat.postMessage({ channel: channelId, text: errorMsg });
    }
  }
}

/**
 * Handle /nieuwbouw sync — trigger a manual sync.
 */
async function handleSync(client, channelId, ts) {
  let statusMsg;
  try {
    statusMsg = await client.chat.postMessage({
      channel: channelId,
      text: '🔄 *NieuwbouwBot Sync gestart...*\nDit kan 5-10 minuten duren. Ik geef updates.',
    });
  } catch (e) {
    console.error(`[${ts}] [Nieuwbouw] Failed to send sync status:`, e.message);
  }

  try {
    const results = await runNieuwbouwSync(async (msg) => {
      // Send progress updates to Slack
      try {
        if (statusMsg) {
          await client.chat.update({
            channel: channelId,
            ts: statusMsg.ts,
            text: `🔄 *NieuwbouwBot Sync*\n${msg}`,
          });
        }
      } catch (e) { /* ignore update errors */ }
    });

    const summary = [
      `✅ *NieuwbouwBot Sync voltooid*`,
      ``,
      `• Gescraped: ${results.totalScraped} listings`,
      `• Nieuwe projecten: ${results.newProjects}`,
      `• Bijgewerkt: ${results.updatedProjects}`,
      `• Niet meer gezien: ${results.markedUnseen}`,
    ];

    if (results.errors.length > 0) {
      summary.push(``, `⚠️ Fouten: ${results.errors.join(', ')}`);
    }

    if (statusMsg) {
      await client.chat.update({
        channel: channelId,
        ts: statusMsg.ts,
        text: summary.join('\n'),
      });
    } else {
      await client.chat.postMessage({
        channel: channelId,
        text: summary.join('\n'),
      });
    }
  } catch (error) {
    console.error(`[${ts}] [Nieuwbouw] Sync error:`, error);
    const errorMsg = `⚠️ Sync mislukt: ${error.message}`;
    if (statusMsg) {
      await client.chat.update({ channel: channelId, ts: statusMsg.ts, text: errorMsg });
    } else {
      await client.chat.postMessage({ channel: channelId, text: errorMsg });
    }
  }
}

/**
 * Handle /nieuwbouw stats — show database statistics.
 */
async function handleStats(client, channelId) {
  try {
    const projects = await readAllProjects();
    const active = projects.filter(p => p.status === 'Actief');
    const unseen = projects.filter(p => p.status === 'Niet meer gezien');

    // Count by region
    const byRegion = {};
    for (const p of active) {
      const region = p.region || 'Overig';
      byRegion[region] = (byRegion[region] || 0) + 1;
    }

    // Count by source
    const bySource = {};
    for (const p of active) {
      const sources = (p.source || 'onbekend').split(',').map(s => s.trim());
      for (const s of sources) {
        bySource[s] = (bySource[s] || 0) + 1;
      }
    }

    // Price range
    const prices = active.map(p => p.price_from).filter(Boolean);
    const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
    const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;

    const stats = [
      `📊 *NieuwbouwBot Database Statistieken*`,
      ``,
      `*Totaal:* ${projects.length} projecten (${active.length} actief, ${unseen.length} niet meer gezien)`,
      ``,
      `*Per regio:*`,
      ...Object.entries(byRegion).sort((a, b) => b[1] - a[1]).map(([r, c]) => `  • ${r}: ${c}`),
      ``,
      `*Per bron:*`,
      ...Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([s, c]) => `  • ${s}: ${c}`),
      ``,
      `*Prijsrange:* €${minPrice.toLocaleString('nl-NL')} — €${maxPrice.toLocaleString('nl-NL')}`,
    ];

    await client.chat.postMessage({
      channel: channelId,
      text: stats.join('\n'),
    });
  } catch (error) {
    console.error('[Nieuwbouw] Stats error:', error);
    await client.chat.postMessage({
      channel: channelId,
      text: `⚠️ Kon statistieken niet laden: ${error.message}`,
    });
  }
}

module.exports = { handleNieuwbouw };
