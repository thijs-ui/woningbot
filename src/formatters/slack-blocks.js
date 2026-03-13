/**
 * Slack Block Kit message builder for WoningBot V2.
 * Includes match scores, motivations, and highlights.
 */

const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function formatPrice(price) {
  if (!price) return 'Prijs onbekend';
  return '€' + price.toLocaleString('nl-NL');
}

function scoreToStars(score) {
  if (score >= 90) return '⭐⭐⭐⭐⭐';
  if (score >= 80) return '⭐⭐⭐⭐';
  if (score >= 70) return '⭐⭐⭐';
  if (score >= 60) return '⭐⭐';
  return '⭐';
}

/**
 * Build the main results message blocks.
 * @param {Array} selections - Claude's selections (with rank, match_score, motivation, highlights)
 * @param {Array} allProperties - All scraped properties (to look up details)
 * @param {object} clientProfile - The parsed client profile
 * @param {object} stats - { totalScraped, idealistaCount, fotocasaCount }
 */
function buildResultBlocks(selections, allProperties, clientProfile, stats) {
  const blocks = [];

  // Header
  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `🏠 WoningBot — ${selections.length} matches gevonden`,
      emoji: true,
    },
  });

  // Search summary + stats
  const summary = clientProfile.search_summary || 'Zoekopdracht';
  const sourcesParts = [];
  if (stats.idealistaCount > 0) sourcesParts.push(`Idealista (${stats.idealistaCount})`);
  if (stats.fotocasaCount > 0) sourcesParts.push(`Fotocasa (${stats.fotocasaCount})`);

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Zoekopdracht:* ${summary}\n*Bronnen:* ${sourcesParts.join(' • ') || 'Idealista'} → ${stats.totalScraped} gescraped, ${selections.length} geselecteerd`,
    },
  });

  blocks.push({ type: 'divider' });

  // Each selected property
  for (let i = 0; i < selections.length; i++) {
    const sel = selections[i];
    const prop = findProperty(sel.property_id, allProperties);
    const emoji = NUMBER_EMOJIS[i] || `${i + 1}.`;

    // Title + price
    const title = prop?.title || 'Woning';
    const truncTitle = title.length > 70 ? title.substring(0, 67) + '...' : title;
    const price = prop?.price ? formatPrice(prop.price) : 'Prijs onbekend';

    // Details line
    const details = [];
    if (prop?.location) details.push(`📍 ${prop.location}`);
    if (prop?.bedrooms) details.push(`🛏 ${prop.bedrooms} slpk`);
    if (prop?.bathrooms) details.push(`🚿 ${prop.bathrooms} bdk`);
    if (prop?.size_m2) details.push(`📏 ${prop.size_m2} m²`);

    // Match score
    const stars = scoreToStars(sel.match_score);
    const matchLine = `Match: ${stars} (${sel.match_score}/100)`;

    // Motivation
    const motivation = sel.motivation || '';

    // Highlights
    const highlights = (sel.highlights || []).join(' • ');

    // Links
    const links = [];
    if (prop?.url) {
      const domain = prop.source === 'fotocasa' ? 'Fotocasa' : 'Idealista';
      links.push(`<${prop.url}|Bekijk op ${domain}>`);
    }
    if (prop?.alternateUrls) {
      for (const alt of prop.alternateUrls) {
        const d = alt.source === 'fotocasa' ? 'Fotocasa' : 'Idealista';
        links.push(`<${alt.url}|Ook op ${d}>`);
      }
    }

    // Build text block
    let text = `${emoji}  *${truncTitle}* — *${price}*\n`;
    if (details.length > 0) text += `   ${details.join('  •  ')}\n`;
    text += `   ${matchLine}\n\n`;
    text += `   💬 *Waarom deze woning past:*\n   ${motivation}\n\n`;
    if (highlights) text += `   ✨ ${highlights}\n\n`;
    if (links.length > 0) text += `   🔗 ${links.join('  |  ')}`;

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: text.trim() },
    });

    if (i < selections.length - 1) {
      blocks.push({ type: 'divider' });
    }
  }

  // Footer
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '💡 Reageer in deze thread om de selectie te verfijnen. Bijv: "meer zoals nr 1" of "budget omhoog naar 1.5M"',
    }],
  });

  return blocks;
}

/**
 * Find a property by ID in the allProperties array.
 */
function findProperty(propertyId, allProperties) {
  if (!propertyId || !allProperties) return null;
  return allProperties.find((p) =>
    p.id === propertyId || p.url === propertyId || String(p.id) === String(propertyId)
  ) || null;
}

/**
 * Build blocks for a refined selection (thread reply).
 */
function buildRefinedBlocks(selections, allProperties, responseText) {
  const blocks = [];

  if (responseText) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `💬 ${responseText}` },
    });
    blocks.push({ type: 'divider' });
  }

  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `🏠 Aangepaste selectie — ${selections.length} matches`,
      emoji: true,
    },
  });

  blocks.push({ type: 'divider' });

  for (let i = 0; i < selections.length; i++) {
    const sel = selections[i];
    const prop = findProperty(sel.property_id, allProperties);
    const emoji = NUMBER_EMOJIS[i] || `${i + 1}.`;

    const title = prop?.title || 'Woning';
    const truncTitle = title.length > 70 ? title.substring(0, 67) + '...' : title;
    const price = prop?.price ? formatPrice(prop.price) : 'Prijs onbekend';

    const details = [];
    if (prop?.location) details.push(`📍 ${prop.location}`);
    if (prop?.bedrooms) details.push(`🛏 ${prop.bedrooms} slpk`);
    if (prop?.bathrooms) details.push(`🚿 ${prop.bathrooms} bdk`);
    if (prop?.size_m2) details.push(`📏 ${prop.size_m2} m²`);

    const stars = scoreToStars(sel.match_score);
    const highlights = (sel.highlights || []).join(' • ');

    const links = [];
    if (prop?.url) {
      const domain = prop.source === 'fotocasa' ? 'Fotocasa' : 'Idealista';
      links.push(`<${prop.url}|Bekijk op ${domain}>`);
    }

    let text = `${emoji}  *${truncTitle}* — *${price}*\n`;
    if (details.length > 0) text += `   ${details.join('  •  ')}\n`;
    text += `   Match: ${stars} (${sel.match_score}/100)\n\n`;
    text += `   💬 ${sel.motivation || ''}\n\n`;
    if (highlights) text += `   ✨ ${highlights}\n\n`;
    if (links.length > 0) text += `   🔗 ${links.join('  |  ')}`;

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: text.trim() },
    });

    if (i < selections.length - 1) blocks.push({ type: 'divider' });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '💡 Reageer opnieuw in deze thread om verder te verfijnen.',
    }],
  });

  return blocks;
}

/**
 * Split blocks into chunks for Slack's 50-block limit.
 */
function splitBlocks(blocks, max = 45) {
  const chunks = [];
  let current = [];
  for (const block of blocks) {
    current.push(block);
    if (current.length >= max) {
      chunks.push([...current]);
      current = [];
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function buildConfirmationBlocks() {
  return [{ type: 'section', text: { type: 'mrkdwn', text: '🔍 Ik ga zoeken op Idealista. Even geduld...' } }];
}

function buildErrorBlocks(msg) {
  return [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ ${msg}` } }];
}

function buildNoResultsBlocks() {
  return [{ type: 'section', text: { type: 'mrkdwn', text: 'Geen woningen gevonden met deze criteria. Probeer je zoekopdracht te verbreden (hoger budget, meer locaties, minder eisen).' } }];
}

function buildNoMatchBlocks(bestThree) {
  const blocks = [{
    type: 'section',
    text: { type: 'mrkdwn', text: '⚠️ Geen woningen scoren hoog genoeg op de wensen van je klant. Hieronder de 3 beste opties met uitleg waarom ze niet ideaal zijn:' },
  }, { type: 'divider' }];

  for (let i = 0; i < bestThree.length; i++) {
    const sel = bestThree[i];
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${NUMBER_EMOJIS[i]}  Score: ${sel.match_score}/100\n${sel.motivation}` },
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '💡 Reageer in deze thread om criteria aan te passen.' }],
  });

  return blocks;
}

module.exports = {
  buildResultBlocks,
  buildRefinedBlocks,
  splitBlocks,
  buildConfirmationBlocks,
  buildErrorBlocks,
  buildNoResultsBlocks,
  buildNoMatchBlocks,
  findProperty,
};
