// ─── /alert Handler ────────────────────────────────────────────────────────
// Create, list, and stop alerts for new nieuwbouw units matching criteria

const Anthropic = require('@anthropic-ai/sdk');
const { claudeRetry } = require('../services/claude-retry');
const { saveAlert, getAlertsForUser, deactivateAlert, MAX_ALERTS_PER_USER } = require('../services/alert-service');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

// ─── Claude prompt for parsing alert criteria ──────────────────────────────

const PARSE_PROMPT = `Je bent een assistent die zoekopdrachten voor Spaans vastgoed omzet naar gestructureerde JSON.

Geef ALTIJD een JSON object terug met exact deze velden (gebruik null als niet opgegeven):
{
  "location": string | null,
  "min_price": number | null,
  "max_price": number | null,
  "min_rooms": number | null,
  "min_bathrooms": number | null,
  "min_size_m2": number | null,
  "has_pool": boolean | null,
  "has_sea_view": boolean | null,
  "has_terrace": boolean | null,
  "has_garden": boolean | null,
  "is_new_development": boolean | null
}

Regels:
- "k" of "K" = duizend (400k = 400000)
- "slpk" of "slaapkamers" = min_rooms
- "zwembad" = has_pool: true
- "zeezicht" = has_sea_view: true
- "Costa del Sol", "Costa Blanca" etc. zijn geldige locaties
- Geef ALLEEN geldige JSON terug, geen uitleg.

Voorbeelden:
"Marbella, max 400k, 2 slaapkamers, zwembad" → {"location":"Marbella","min_price":null,"max_price":400000,"min_rooms":2,"min_bathrooms":null,"min_size_m2":null,"has_pool":true,"has_sea_view":null,"has_terrace":null,"has_garden":null,"is_new_development":null}
"costa del sol onder 600k met zeezicht" → {"location":"Costa del Sol","min_price":null,"max_price":600000,"min_rooms":null,"min_bathrooms":null,"min_size_m2":null,"has_pool":null,"has_sea_view":true,"has_terrace":null,"has_garden":null,"is_new_development":null}`;

// ─── Parse alert query with Claude ─────────────────────────────────────────

async function parseAlertQuery(text) {
  const response = await claudeRetry(() =>
    claude.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 300,
      system: PARSE_PROMPT,
      messages: [{ role: 'user', content: text }],
    }),
    'AlertParser'
  );
  const raw = response.content[0].text.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Geen JSON in Claude response');
  return JSON.parse(match[0]);
}

// ─── Format alert summary for display ──────────────────────────────────────

function formatAlertSummary(a) {
  const parts = [];
  if (a.location)       parts.push(`📍 ${a.location}`);
  if (a.min_price && a.max_price) {
    parts.push(`💶 €${Number(a.min_price).toLocaleString('nl-NL')} – €${Number(a.max_price).toLocaleString('nl-NL')}`);
  } else if (a.max_price) {
    parts.push(`💶 max €${Number(a.max_price).toLocaleString('nl-NL')}`);
  } else if (a.min_price) {
    parts.push(`💶 min €${Number(a.min_price).toLocaleString('nl-NL')}`);
  }
  if (a.min_rooms)      parts.push(`🛏 ${a.min_rooms}+ slaapkamers`);
  if (a.min_bathrooms)  parts.push(`🚿 ${a.min_bathrooms}+ badkamers`);
  if (a.min_size_m2)    parts.push(`📐 ${a.min_size_m2}m²+`);
  if (a.has_pool)       parts.push(`🏊 zwembad`);
  if (a.has_sea_view)   parts.push(`🌊 zeezicht`);
  if (a.has_terrace)    parts.push(`🌿 terras`);
  if (a.has_garden)     parts.push(`🌳 tuin`);
  return parts.length > 0 ? parts.join('  ') : '_Geen filters_';
}

// ─── Main handler ──────────────────────────────────────────────────────────

async function handleAlert({ command, ack, respond }) {
  await ack();

  const text = (command.text || '').trim();
  const userId = command.user_id;
  const channelId = command.channel_id;
  const ts = new Date().toISOString();

  // ── No text: show help ──
  if (!text) {
    await respond({
      response_type: 'ephemeral',
      text: [
        '*📢 Alert — Gebruik:*',
        '',
        '• `/alert Marbella, max 400k, 2 slaapkamers, zwembad` — nieuwe alert aanmaken',
        '• `/alert list` — jouw actieve alerts bekijken',
        '• `/alert stop <id>` — alert stoppen',
        '',
        `_Je kunt maximaal ${MAX_ALERTS_PER_USER} alerts tegelijk actief hebben._`,
      ].join('\n'),
    });
    return;
  }

  // ── List alerts ──
  if (text.toLowerCase() === 'list' || text.toLowerCase() === 'lijst') {
    try {
      const alerts = await getAlertsForUser(userId);
      if (!alerts.length) {
        await respond({
          response_type: 'ephemeral',
          text: 'Je hebt nog geen actieve alerts. Maak er een aan met `/alert [zoekopdracht]`.',
        });
        return;
      }

      const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: `*Jouw actieve alerts (${alerts.length}/${MAX_ALERTS_PER_USER}):*` } },
        { type: 'divider' },
      ];

      for (const alert of alerts) {
        const shortId = alert.id.slice(0, 8);
        const created = new Date(alert.created_at).toLocaleDateString('nl-NL');
        const lastChecked = alert.last_checked_at
          ? new Date(alert.last_checked_at).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
          : 'nog niet';

        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${formatAlertSummary(alert)}\n_ID: \`${shortId}\` · aangemaakt ${created} · laatst gecheckt: ${lastChecked}_`,
          },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: '🛑 Stoppen' },
            style: 'danger',
            value: alert.id,
            action_id: 'stop_alert',
          },
        });
      }

      await respond({ response_type: 'ephemeral', blocks });
    } catch (err) {
      console.error(`[${ts}] [Alert] Error listing alerts:`, err.message);
      await respond({ response_type: 'ephemeral', text: `Fout bij ophalen alerts: ${err.message}` });
    }
    return;
  }

  // ── Stop alert ──
  if (text.toLowerCase().startsWith('stop')) {
    const alertId = text.split(/\s+/)[1]?.trim();
    if (!alertId) {
      await respond({
        response_type: 'ephemeral',
        text: 'Gebruik: `/alert stop <id>` — zie `/alert list` voor jouw alert IDs.',
      });
      return;
    }
    try {
      await deactivateAlert(alertId, userId);
      await respond({ response_type: 'ephemeral', text: `✅ Alert \`${alertId}\` gestopt.` });
    } catch (err) {
      await respond({ response_type: 'ephemeral', text: `Kon alert niet stoppen: ${err.message}` });
    }
    return;
  }

  // ── Create new alert ──
  await respond({ response_type: 'ephemeral', text: '⏳ Alert aanmaken...' });

  let filters;
  try {
    filters = await parseAlertQuery(text);
    console.log(`[${ts}] [Alert] Parsed filters:`, JSON.stringify(filters));
  } catch (err) {
    console.error(`[${ts}] [Alert] Parse error:`, err.message);
    await respond({ response_type: 'ephemeral', text: `Kon zoekopdracht niet verwerken: ${err.message}` });
    return;
  }

  try {
    const saved = await saveAlert({
      slack_user_id: userId,
      slack_channel_id: channelId,
      ...filters,
    });

    await respond({
      response_type: 'ephemeral',
      blocks: [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            '✅ *Alert aangemaakt!*',
            '',
            formatAlertSummary(filters),
            '',
            '_Je ontvangt een DM zodra er nieuwe nieuwbouwunits zijn die matchen._',
            `_Bekijk je alerts met \`/alert list\`. ID: \`${saved.id.slice(0, 8)}\`_`,
          ].join('\n'),
        },
      }],
    });
  } catch (err) {
    console.error(`[${ts}] [Alert] Save error:`, err.message);
    await respond({ response_type: 'ephemeral', text: `Fout bij opslaan alert: ${err.message}` });
  }
}

// ─── Slack action handler for the "Stoppen" button ─────────────────────────

async function handleStopAlertAction({ action, ack, respond, body }) {
  await ack();
  const alertId = action.value;
  const userId = body.user.id;
  const ts = new Date().toISOString();

  try {
    await deactivateAlert(alertId, userId);
    await respond({
      response_type: 'ephemeral',
      replace_original: false,
      text: `✅ Alert \`${alertId.slice(0, 8)}\` gestopt.`,
    });
    console.log(`[${ts}] [Alert] Alert ${alertId.slice(0, 8)} stopped via button by ${userId}`);
  } catch (err) {
    console.error(`[${ts}] [Alert] Button stop error:`, err.message);
    await respond({
      response_type: 'ephemeral',
      replace_original: false,
      text: `Kon alert niet stoppen: ${err.message}`,
    });
  }
}

module.exports = { handleAlert, handleStopAlertAction };
