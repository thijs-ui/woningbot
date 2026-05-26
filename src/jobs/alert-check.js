// ─── Alert Check Cron Job ──────────────────────────────────────────────────
// Runs daily to check all active alerts for new matching units
// Sends DM notifications to users when matches are found

const { getActiveAlerts, updateLastChecked, updateIdealistaSeenCodes } = require('../services/alert-service');
const { findMatches } = require('../services/alert-matcher');

// Rate limit: wait between DMs to avoid Slack rate limits
const DM_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main alert check function. Called by cron scheduler in app.js.
 * @param {Object} slack - Slack WebClient instance (needed for chat.postMessage)
 */
async function runAlertCheck(slack) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [AlertCheck] Starting daily alert check...`);

  let alerts;
  try {
    alerts = await getActiveAlerts();
    console.log(`[${ts}] [AlertCheck] ${alerts.length} active alerts to check`);
  } catch (err) {
    console.error(`[${ts}] [AlertCheck] Failed to fetch alerts:`, err.message);
    return;
  }

  if (alerts.length === 0) {
    console.log(`[${ts}] [AlertCheck] No active alerts. Done.`);
    return;
  }

  let totalMatches = 0;
  let totalNotified = 0;
  let totalErrors = 0;

  for (const alert of alerts) {
    const shortId = alert.id.slice(0, 8);

    try {
      // Cutoff: 25u terug bij nieuwe alerts (ruim de cron-window), anders de
      // last_checked_at zodat we precies de nieuwe items sinds de vorige run zien.
      const cutoff = alert.last_checked_at
        ? new Date(alert.last_checked_at).toISOString()
        : new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

      const [newUnits, newCSResales, allIdealistaResales] = await Promise.all([
        findMatches(alert, { cutoff, sources: ['units'],             limit: 50 }),
        findMatches(alert, { cutoff, sources: ['resales'],           limit: 50 }),
        findMatches(alert, {         sources: ['idealista_resales'] }), // live; geen cutoff
      ]);

      // Idealista-dedup tegen seen-codes uit de alerts-rij. Alleen propertyCodes
      // die we nog NIET ge-DM'd hebben voor deze alert tellen als "nieuw".
      const seen = new Set(alert.idealista_seen_codes || []);
      const newIdealistaResales = allIdealistaResales.filter(m => m.code && !seen.has(m.code));

      console.log(`[${ts}] [AlertCheck] Alert ${shortId} (${alert.location || 'any'}): ${newUnits.length} nieuwbouw, ${newCSResales.length} CS-resales, ${newIdealistaResales.length}/${allIdealistaResales.length} idealista-resales (nieuw/totaal)`);

      const dmJobs = [
        { matches: newUnits,            kind: 'nieuwbouw',         label: 'Nieuwbouw' },
        { matches: newCSResales,        kind: 'resales',           label: 'Costa Select-resales' },
        { matches: newIdealistaResales, kind: 'idealista_resales', label: 'Idealista-resales' },
      ];

      for (const job of dmJobs) {
        if (job.matches.length === 0) continue;
        totalMatches += job.matches.length;
        try {
          await sendMatchesDM(slack, alert, job.matches, job.kind);
          totalNotified++;
          console.log(`[${ts}] [AlertCheck] ${job.label} notificatie verstuurd voor alert ${shortId}`);
        } catch (dmErr) {
          totalErrors++;
          console.error(`[${ts}] [AlertCheck] Failed to send ${job.label} DM for alert ${shortId}:`, dmErr.message);
        }
        await sleep(DM_DELAY_MS);
      }

      // Update seen-codes met de huidige Apify-respons (niet alleen new ones).
      // Zo blijven listings die nog op Idealista staan in de "seen"-set zitten,
      // en pas zodra ze van Idealista afvallen kunnen ze later opnieuw triggeren.
      if (allIdealistaResales.length > 0) {
        try {
          await updateIdealistaSeenCodes(alert.id, allIdealistaResales.map(m => m.code).filter(Boolean));
        } catch (err) {
          console.error(`[${ts}] [AlertCheck] seen-codes update faalde voor ${shortId}:`, err.message);
        }
      }

      // Always update last_checked_at, even if no matches
      await updateLastChecked(alert.id);

    } catch (err) {
      totalErrors++;
      console.error(`[${ts}] [AlertCheck] Error processing alert ${shortId}:`, err.message);
    }
  }

  console.log(`[${ts}] [AlertCheck] Done. ${alerts.length} alerts checked, ${totalMatches} matches, ${totalNotified} notifications sent, ${totalErrors} errors.`);
}

/**
 * Stuur een DM met matches. Source-agnostic: consumeert de normalized shape uit
 * alert-matcher.findMatches. `kind` bepaalt alleen header-tekst en de "meer"-link.
 */
async function sendMatchesDM(slack, alert, matches, kind) {
  const count = matches.length;
  const preview = matches.slice(0, 5);

  const filterParts = [];
  if (alert.location)  filterParts.push(alert.location);
  if (alert.max_price) filterParts.push(`max €${Number(alert.max_price).toLocaleString('nl-NL')}`);
  if (alert.min_rooms) filterParts.push(`${alert.min_rooms}+ slpk`);
  const filterText = filterParts.length > 0 ? filterParts.join(', ') : 'alle criteria';
  const klantPrefix = alert.klant_naam ? `👤 *${alert.klant_naam}* — ` : '';

  const headerLabel =
    kind === 'nieuwbouw'         ? `nieuwbouw listing${count > 1 ? 's' : ''}` :
    kind === 'idealista_resales' ? `Idealista resale${count > 1 ? 's' : ''}` :
                                   `Costa Select listing${count > 1 ? 's' : ''}`;

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${klantPrefix}🔔 *${count} nieuwe ${headerLabel} gevonden*\n_Alert: ${filterText}_`,
      },
    },
    { type: 'divider' },
    ...preview.map(buildMatchBlock),
  ];

  if (count > 5) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `_... en nog ${count - 5} meer. Bekijk de volledige resultaten in het Costa Select dashboard._`,
      }],
    });
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `_Alert ID: \`${alert.id.slice(0, 8)}\` · Beheer alerts in het dashboard._`,
    }],
  });

  await slack.chat.postMessage({
    channel: alert.slack_user_id,
    blocks,
    text: `🔔 ${count} nieuwe ${headerLabel} matchen met jouw alert (${filterText})`,
  });
}

/**
 * Bouwt één Slack section block voor een normalized match.
 */
function buildMatchBlock(m) {
  const titleLine = m.url ? `*<${m.url}|${m.title}>*` : `*${m.title}*`;
  const lines = [titleLine];
  if (m.location) lines.push(`📍 ${m.location}`);

  const stats = [`💶 €${m.price.toLocaleString('nl-NL')}`];
  if (m.beds)    stats.push(`🛏 ${m.beds} slpk`);
  if (m.size_m2) stats.push(`📐 ${m.size_m2}m²`);
  lines.push(stats.join('  '));

  if (m.type === 'unit' && m.features.floor) lines.push(`🏢 ${m.features.floor}`);

  const feats = [];
  if (m.features.terrace)  feats.push('terras');
  if (m.features.garden)   feats.push('tuin');
  if (m.features.pool)     feats.push('zwembad');
  if (m.features.exterior) feats.push('buitenzijde');
  if (feats.length > 0) lines.push(feats.join(' · '));

  if (m.features.description) lines.push(`_${m.features.description}..._`);

  const block = { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } };
  if (m.image) {
    block.accessory = { type: 'image', image_url: m.image, alt_text: m.title };
  }
  return block;
}

module.exports = { runAlertCheck };
