// ─── /klant handler ────────────────────────────────────────────────────────
// Gebruik: /klant Jan Janssen        — shortlist bekijken
//          /klant lijst              — alle klanten

const { getClientProperties, getAllClients } = require('../services/client-service');

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

  const block = {
    type: 'section',
    text: { type: 'mrkdwn', text: lines.join('\n') },
  };

  if (thumbnail) {
    block.accessory = {
      type: 'image',
      image_url: thumbnail,
      alt_text: prop.town || 'Property',
    };
  }

  return block;
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
      ...rows.map(formatProperty),
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

module.exports = { handleKlant };
