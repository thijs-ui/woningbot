// ─── /save handler ─────────────────────────────────────────────────────────
// Gebruik: /save Jan Janssen 771846
//          /save Jan Janssen https://www.idealista.com/inmueble/12345/
//          /save Jan Janssen 771846 interessante locatie, groot terras
//          /save 771846 voor Jan Janssen

const { saveProperty, lookupProperty } = require('../services/client-service');

/**
 * Parse de /save input.
 * Detecteert automatisch of het een ref (cijfers) of URL (http/https) is.
 * Geeft { clientName, ref, url, note } terug.
 */
function parseSaveInput(text) {
  let remaining = text.trim();

  // Extraheer URL als aanwezig
  let url = null;
  const urlMatch = remaining.match(/https?:\/\/\S+/);
  if (urlMatch) {
    url = urlMatch[0];
    remaining = remaining.replace(url, '').trim();
  }

  // Extraheer ref (5-7 cijfers) als aanwezig
  let ref = null;
  const refMatch = remaining.match(/\b(\d{5,7})\b/);
  if (refMatch) {
    ref = refMatch[1];
    remaining = remaining.replace(refMatch[0], '').trim();
  }

  // Verwijder "voor" als connector
  remaining = remaining.replace(/\bvoor\b/gi, '').trim();

  // Splits op komma: eerste deel = clientnaam, rest = notitie
  const parts = remaining.split(/,(.+)/);
  const clientName = parts[0].trim();
  const note       = parts[1]?.trim() || null;

  return { clientName, ref, url, note };
}

async function handleSave({ command, ack, respond }) {
  await ack();

  const text = command.text?.trim();
  if (!text) {
    await respond({
      response_type: 'ephemeral',
      text: 'Gebruik: `/save Jan Janssen 771846` of `/save Jan Janssen https://...`',
    });
    return;
  }

  const { clientName, ref, url, note } = parseSaveInput(text);

  if (!clientName) {
    await respond({ response_type: 'ephemeral', text: 'Geef een klantnaam op.' });
    return;
  }

  if (!ref && !url) {
    await respond({
      response_type: 'ephemeral',
      text: 'Geef een ref-nummer of URL op.\nVoorbeelden:\n`/save Jan Janssen 771846`\n`/save Jan Janssen https://www.idealista.com/inmueble/12345/`',
    });
    return;
  }

  try {
    // Haal propertydetails op voor bevestiging én last_known_price
    let details = '';
    let lastKnownPrice = null;
    if (ref) {
      const prop = await lookupProperty(ref);
      if (prop) {
        details = ` — ${prop.property_type || 'Property'} in ${prop.town || '?'}, €${Number(prop.price || 0).toLocaleString('nl-NL')}`;
        lastKnownPrice = prop.price || null;
      }
    } else if (url) {
      details = ` — ${url}`;
    }

    await saveProperty({ clientName, slackUserId: command.user_id, ref, url, note, lastKnownPrice });

    await respond({
      response_type: 'ephemeral',
      text: `✅ Opgeslagen voor *${clientName}*${details}${note ? `\n📝 ${note}` : ''}`,
    });
  } catch (err) {
    console.error('[Save] Fout:', err.message);
    await respond({ response_type: 'ephemeral', text: `❌ Opslaan mislukt: ${err.message}` });
  }
}

module.exports = { handleSave };
