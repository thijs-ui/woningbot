// ─── Alert Check Cron Job ──────────────────────────────────────────────────
// Runs daily to check all active alerts for new matching units
// Sends DM notifications to users when matches are found

const { getActiveAlerts, getNewUnitsForAlert, updateLastChecked } = require('../services/alert-service');

// Rate limit: wait between DMs to avoid Slack rate limits
const DM_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main alert check function. Called by cron scheduler in app.js.
 * @param {Object} app - Slack Bolt app instance (needed for chat.postMessage)
 */
async function runAlertCheck(app) {
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
      const newUnits = await getNewUnitsForAlert(alert);
      console.log(`[${ts}] [AlertCheck] Alert ${shortId} (${alert.location || 'any'}): ${newUnits.length} new matches`);

      if (newUnits.length > 0) {
        totalMatches += newUnits.length;

        try {
          await sendNotification(app, alert, newUnits);
          totalNotified++;
          console.log(`[${ts}] [AlertCheck] Notification sent for alert ${shortId}`);
        } catch (dmErr) {
          totalErrors++;
          // DM might fail if user has DMs disabled — log but don't crash
          console.error(`[${ts}] [AlertCheck] Failed to send DM for alert ${shortId}:`, dmErr.message);
        }

        // Rate limit between DMs
        await sleep(DM_DELAY_MS);
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
 * Send a DM notification to the user about new matching units.
 */
async function sendNotification(app, alert, units) {
  const count = units.length;
  const preview = units.slice(0, 5);

  // Build alert summary for context
  const filterParts = [];
  if (alert.location) filterParts.push(alert.location);
  if (alert.max_price) filterParts.push(`max €${Number(alert.max_price).toLocaleString('nl-NL')}`);
  if (alert.min_rooms) filterParts.push(`${alert.min_rooms}+ slpk`);
  const filterText = filterParts.length > 0 ? filterParts.join(', ') : 'alle criteria';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔔 *${count} nieuwe nieuwbouw listing${count > 1 ? 's' : ''} gevonden*\n_Alert: ${filterText}_`,
      },
    },
    { type: 'divider' },
  ];

  for (const unit of preview) {
    const listing = unit.listing || {};
    const features = [];
    if (unit.has_terrace || listing.has_terrace) features.push('terras');
    if (unit.has_garden  || listing.has_garden)  features.push('tuin');
    if (listing.has_swimming_pool)               features.push('zwembad');
    if (unit.is_exterior)                        features.push('buitenzijde');

    const location = [listing.municipality, listing.district].filter(Boolean).join(', ');

    const textLines = [
      `*${listing.title || 'Nieuwbouwproject'}*`,
      location ? `📍 ${location}` : '',
      `💶 €${Number(unit.price || 0).toLocaleString('nl-NL')}  🛏 ${unit.rooms || '?'} slpk  📐 ${unit.size_m2 || '?'}m²`,
      unit.floor ? `🏢 ${unit.floor}` : '',
      features.length > 0 ? features.join(' · ') : '',
      listing.url ? `<${listing.url}|Bekijk project →>` : '',
    ].filter(Boolean);

    const sectionBlock = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: textLines.join('\n'),
      },
    };

    // Add thumbnail if available
    if (listing.main_image_url) {
      sectionBlock.accessory = {
        type: 'image',
        image_url: listing.main_image_url,
        alt_text: listing.title || 'Project',
      };
    }

    blocks.push(sectionBlock);
  }

  if (count > 5) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `_... en nog ${count - 5} meer. Gebruik \`/nieuwbouw ${alert.location || ''}\` voor een volledig overzicht._`,
      }],
    });
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `_Alert ID: \`${alert.id.slice(0, 8)}\` · Stop met \`/alert stop ${alert.id.slice(0, 8)}\`_`,
    }],
  });

  await app.client.chat.postMessage({
    channel: alert.slack_user_id, // DM to user
    blocks,
    text: `🔔 ${count} nieuwe listing${count > 1 ? 's' : ''} matchen met jouw alert (${filterText})`,
  });
}

module.exports = { runAlertCheck };
