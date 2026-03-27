// ─── /klant handler ────────────────────────────────────────────────────────
// Gebruik: /klant Jan Janssen        — shortlist bekijken
//          /klant lijst              — alle klanten

const { getClientProperties, getAllClients, removeProperty } = require('../services/client-service');

function formatProperty(row) {
  const prop = row.property || {};
  const images = (prop.images || []).map(img => img?.url).filter(Boolean);
  const thumbnail = images[0] || null;

  // Bepaal weergave URL: property URL > opgeslagen URL
  const displayUrl = prop.url || row.url || null;

  const lines = [];

  if (prop.price) {
    const details = [
      prop.property_type || '',
      prop.town ? `${prop.town}${prop.province ? `, ${prop.province}` : ''}` : '',
      `€${Number(prop.price).toLocaleString('nl-NL')}`,
      prop.beds ? `${prop.beds} slpk` : '',
      prop.built_m2 ? `${prop.built_m2}m²` : '',
      prop.pool ? '🏊' : '',
    ].filter(Boolean).join('  ·  ');

    lines.push(displayUrl ? `*<${displayUrl}|${details}>*` : `*${details}*`);
  } else if (row.url) {
    // Externe link zonder ref
    lines.push(displayUrl ? `*<${displayUrl}|${displayUrl}>*` : `*${row.url}*`);
  }

  if (row.note) lines.push(`📝 _${row.note}_`);

  const savedBy = `opgeslagen door <@${row.slack_user_id}>`;
  const savedAt = new Date(row.saved_at).toLocaleDateString('nl-NL');
  lines.push(`_${savedAt} · ${savedBy}_`);

  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') },
      ...(thumbnail ? {
        accessory: {
          type: 'image',
          image_url: thumbnail,
          alt_text: prop.town || 'Property',
        },
      } : {}),
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🗑 Verwijderen', emoji: true },
          style: 'danger',
          confirm: {
            title: { type: 'plain_text', text: 'Verwijderen?' },
            text: { type: 'plain_text', text: 'Wil je deze property uit de shortlist verwijderen?' },
            confirm: { type: 'plain_text', text: 'Ja, verwijder' },
            deny: { type: 'plain_text', text: 'Annuleer' },
          },
          action_id: 'remove_client_property',
          value: JSON.stringify({ id: row.id, slack_user_id: row.slack_user_id }),
        },
      ],
    },
  ];

  return blocks;
}

async function handleKlant({ command, ack, respond }) {
  await ack();

  const text = command.text?.trim();

  if (!text || text === 'lijst') {
    // Toon alle klanten
    try {
      const clients = await getAllClients();
      if (!clients.length) {
        await respond({ response_type: 'ephemeral', text: 'Nog geen klanten opgeslagen. Gebruik `/save [naam] [ref of URL]`.' });
        return;
      }

      const lines = clients.map(c => `• *${c.client_name}* — ${c.count} propert${c.count === 1 ? 'y' : 'ies'}`);
      await respond({
        response_type: 'ephemeral',
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Alle klanten (${clients.length})*\n${lines.join('\n')}\n\nGebruik \`/klant [naam]\` voor de shortlist.` },
          },
        ],
        text: `${clients.length} klanten`,
      });
    } catch (err) {
      await respond({ response_type: 'ephemeral', text: `❌ Fout: ${err.message}` });
    }
    return;
  }

  // Toon shortlist voor specifieke klant
  try {
    const rows = await getClientProperties(text);

    if (!rows || rows.length === 0) {
      await respond({
        response_type: 'ephemeral',
        text: `Geen properties gevonden voor *${text}*. Gebruik \`/save ${text} [ref of URL]\` om iets op te slaan.`,
      });
      return;
    }

    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Shortlist voor ${text}* — ${rows.length} propert${rows.length === 1 ? 'y' : 'ies'}` },
      },
      { type: 'divider' },
      ...rows.flatMap(formatProperty),
    ];

    await respond({
      response_type: 'ephemeral',
      blocks,
      text: `Shortlist voor ${text}`,
    });
  } catch (err) {
    console.error('[Klant] Fout:', err.message);
    await respond({ response_type: 'ephemeral', text: `❌ Fout: ${err.message}` });
  }
}

async function handleRemoveClientProperty({ ack, body, respond }) {
  await ack();

  try {
    const { id, slack_user_id } = JSON.parse(body.actions[0].value);
    await removeProperty(id, body.user.id);
    await respond({ response_type: 'ephemeral', replace_original: false, text: '✅ Property verwijderd uit shortlist.' });
  } catch (err) {
    console.error('[Klant] Verwijder fout:', err.message);
    await respond({ response_type: 'ephemeral', replace_original: false, text: `❌ Verwijderen mislukt: ${err.message}` });
  }
}

module.exports = { handleKlant, handleRemoveClientProperty };
