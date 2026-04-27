// ─── Alert Check Cron Job ──────────────────────────────────────────────────
// Runs daily to check all active alerts for new matching units
// Sends DM notifications to users when matches are found

const { getActiveAlerts, getNewUnitsForAlert, getNewResalesForAlert, updateLastChecked } = require('../services/alert-service');
const { getShortlistForPriceCheck, updateLastKnownPrice } = require('../services/client-service');

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
      const [newUnits, newResales] = await Promise.all([
        getNewUnitsForAlert(alert),
        getNewResalesForAlert(alert),
      ]);

      console.log(`[${ts}] [AlertCheck] Alert ${shortId} (${alert.location || 'any'}): ${newUnits.length} nieuwbouw, ${newResales.length} resales`);

      if (newUnits.length > 0) {
        totalMatches += newUnits.length;
        try {
          await sendNotification(app, alert, newUnits);
          totalNotified++;
          console.log(`[${ts}] [AlertCheck] Nieuwbouw notificatie verstuurd voor alert ${shortId}`);
        } catch (dmErr) {
          totalErrors++;
          console.error(`[${ts}] [AlertCheck] Failed to send DM for alert ${shortId}:`, dmErr.message);
        }
        await sleep(DM_DELAY_MS);
      }

      if (newResales.length > 0) {
        totalMatches += newResales.length;
        try {
          await sendResalesNotification(app, alert, newResales);
          totalNotified++;
          console.log(`[${ts}] [AlertCheck] Resales notificatie verstuurd voor alert ${shortId}`);
        } catch (dmErr) {
          totalErrors++;
          console.error(`[${ts}] [AlertCheck] Failed to send resales DM for alert ${shortId}:`, dmErr.message);
        }
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

  // Prijsdaling check voor shortlists
  await runPriceDropCheck(app);
}

/**
 * Controleer of shortlist-woningen in prijs gedaald zijn.
 */
async function runPriceDropCheck(app) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [PriceDrop] Starting shortlist price drop check...`);

  let entries;
  try {
    entries = await getShortlistForPriceCheck();
    if (!entries?.length) {
      console.log(`[${ts}] [PriceDrop] No shortlist entries with known price. Done.`);
      return;
    }
  } catch (err) {
    console.error(`[${ts}] [PriceDrop] Failed to fetch shortlist:`, err.message);
    return;
  }

  // Batch: haal actuele prijzen op voor alle unieke refs
  const refs = [...new Set(entries.map(e => e.ref))];
  let currentPrices = {};
  try {
    const refFilter = refs.map(r => encodeURIComponent(r)).join(',');
    const props = await sbFetch(
      `resales_properties?ref=in.(${refFilter})&select=ref,price,property_type,town,url`
    );
    for (const p of (props || [])) currentPrices[p.ref] = p;
  } catch (err) {
    console.error(`[${ts}] [PriceDrop] Failed to fetch current prices:`, err.message);
    return;
  }

  // Groepeer dalingen per gebruiker zodat we één DM sturen per persoon
  const dropsByUser = {};
  for (const entry of entries) {
    const current = currentPrices[entry.ref];
    if (!current?.price) continue;

    const oldPrice = Number(entry.last_known_price);
    const newPrice = Number(current.price);

    if (newPrice < oldPrice) {
      if (!dropsByUser[entry.slack_user_id]) dropsByUser[entry.slack_user_id] = [];
      dropsByUser[entry.slack_user_id].push({ entry, current, oldPrice, newPrice });
    }
  }

  const userIds = Object.keys(dropsByUser);
  console.log(`[${ts}] [PriceDrop] ${userIds.length} gebruikers met prijsdalingen gevonden`);

  for (const userId of userIds) {
    const drops = dropsByUser[userId];
    try {
      await sendPriceDropNotification(app, userId, drops);
      // Update last_known_price voor elk gedaald pand
      for (const { entry, newPrice } of drops) {
        await updateLastKnownPrice(entry.id, newPrice);
      }
      console.log(`[${ts}] [PriceDrop] Notificatie verstuurd naar ${userId} voor ${drops.length} pand(en)`);
    } catch (err) {
      console.error(`[${ts}] [PriceDrop] DM mislukt voor ${userId}:`, err.message);
    }
    await sleep(DM_DELAY_MS);
  }

  console.log(`[${ts}] [PriceDrop] Done.`);
}

/**
 * Stuur een DM met alle prijsdalingen voor één gebruiker.
 */
async function sendPriceDropNotification(app, userId, drops) {
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📉 *${drops.length} shortlist-woning${drops.length > 1 ? 'en zijn' : ' is'} in prijs gedaald*`,
      },
    },
    { type: 'divider' },
  ];

  for (const { entry, current, oldPrice, newPrice } of drops) {
    const saving   = oldPrice - newPrice;
    const pct      = Math.round(((oldPrice - newPrice) / oldPrice) * 100);
    const title    = `${current.property_type || 'Property'} in ${current.town || '?'}`;
    const propUrl  = current.url || null;

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          propUrl ? `*<${propUrl}|${title}>*` : `*${title}*`,
          `_Klant: ${entry.client_name}_`,
          `~~€${oldPrice.toLocaleString('nl-NL')}~~ → *€${newPrice.toLocaleString('nl-NL')}*`,
          `📉 €${saving.toLocaleString('nl-NL')} goedkoper (-${pct}%)`,
        ].join('\n'),
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '_Gebruik `/klant [naam]` om de shortlist te bekijken._',
    }],
  });

  await app.client.chat.postMessage({
    channel: userId,
    blocks,
    text: `📉 ${drops.length} shortlist-woning${drops.length > 1 ? 'en zijn' : ' is'} in prijs gedaald`,
  });
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

  const klantPrefix = alert.klant_naam ? `👤 *${alert.klant_naam}* — ` : '';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${klantPrefix}🔔 *${count} nieuwe nieuwbouw listing${count > 1 ? 's' : ''} gevonden*\n_Alert: ${filterText}_`,
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

/**
 * Send a DM notification for new Costa Select resales properties.
 */
async function sendResalesNotification(app, alert, properties) {
  const count = properties.length;
  const preview = properties.slice(0, 5);

  const filterParts = [];
  if (alert.location) filterParts.push(alert.location);
  if (alert.max_price) filterParts.push(`max €${Number(alert.max_price).toLocaleString('nl-NL')}`);
  if (alert.min_rooms) filterParts.push(`${alert.min_rooms}+ slpk`);
  const filterText = filterParts.length > 0 ? filterParts.join(', ') : 'alle criteria';

  const klantPrefix = alert.klant_naam ? `👤 *${alert.klant_naam}* — ` : '';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${klantPrefix}🔔 *${count} nieuwe Costa Select listing${count > 1 ? 's' : ''} gevonden*\n_Alert: ${filterText}_`,
      },
    },
    { type: 'divider' },
  ];

  for (const p of preview) {
    const images = (p.images || []).map(img => img?.url).filter(Boolean);
    const thumbnail = images[0] || null;
    const desc = (p.desc_nl || p.desc_en || '').substring(0, 120);

    const title = `${p.property_type || 'Property'} in ${p.town || p.province || '?'}`;
    const textLines = [
      p.url ? `*<${p.url}|${title}>*` : `*${title}*`,
      `📍 ${[p.town, p.province].filter(Boolean).join(', ')}`,
      `💶 €${Number(p.price || 0).toLocaleString('nl-NL')}  🛏 ${p.beds || '?'} slpk  📐 ${p.built_m2 || '?'}m²`,
      p.pool ? '🏊 Zwembad' : '',
      desc ? `_${desc}..._` : '',
    ].filter(Boolean);

    const sectionBlock = {
      type: 'section',
      text: { type: 'mrkdwn', text: textLines.join('\n') },
    };

    if (thumbnail) {
      sectionBlock.accessory = {
        type: 'image',
        image_url: thumbnail,
        alt_text: `${p.property_type || 'Property'} in ${p.town || '?'}`,
      };
    }

    blocks.push(sectionBlock);
  }

  if (count > 5) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `_... en nog ${count - 5} meer. Gebruik \`/zoekwoning\` voor een volledig overzicht._`,
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
    channel: alert.slack_user_id,
    blocks,
    text: `🔔 ${count} nieuwe Costa Select listing${count > 1 ? 's' : ''} matchen met jouw alert (${filterText})`,
  });
}

module.exports = { runAlertCheck };
