/**
 * Slack Block Kit message builder for WoningBot V2.
 * Includes match scores, motivations, highlights, and photo analysis.
 * Each property shows one link to its source portal.
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

function conditionToEmoji(score) {
  if (score >= 5) return '🟢 Uitstekend';
  if (score >= 4) return '🟢 Goed';
  if (score >= 3) return '🟡 Redelijk';
  if (score >= 2) return '🟠 Gedateerd';
  return '🔴 Slecht';
}

function getSourceLabel(source) {
  switch (source) {
    case 'thinkspain': return 'ThinkSpain';
    default: return 'Idealista';
  }
}

/**
 * Build a single property block (shared between results and refined).
 */
function buildPropertyBlock(sel, prop, index, photoAssessments) {
  const emoji = NUMBER_EMOJIS[index] || `${index + 1}.`;
  const assessment = photoAssessments
    ? (photoAssessments instanceof Map
        ? photoAssessments.get(sel.property_id) || photoAssessments.get(String(sel.property_id))
        : photoAssessments[sel.property_id] || photoAssessments[String(sel.property_id)])
    : null;

  const title = prop?.title || 'Woning';
  const truncTitle = title.length > 70 ? title.substring(0, 67) + '...' : title;
  const price = prop?.price ? formatPrice(prop.price) : 'Prijs onbekend';

  const details = [];
  if (prop?.location) details.push(`📍 ${prop.location}`);
  if (prop?.bedrooms) details.push(`🛏 ${prop.bedrooms} slpk`);
  if (prop?.bathrooms) details.push(`🚿 ${prop.bathrooms} bdk`);
  if (prop?.size_m2) details.push(`📏 ${prop.size_m2} m²`);
  if (prop?.is_new_build) details.push('🆕 Nieuwbouw');

  const stars = scoreToStars(sel.match_score);
  const highlights = (sel.highlights || []).join(' • ');

  // Photo analysis
  let photoLine = '';
  if (assessment) {
    const condition = conditionToEmoji(assessment.condition_score);
    const styleTags = (assessment.style_tags || []).join(', ');
    photoLine = `\n   📸 *Foto-analyse:* ${condition}`;
    if (styleTags) photoLine += ` — ${styleTags}`;
    photoLine += `\n   ${assessment.visual_assessment || ''}`;
    if (assessment.red_flags && assessment.red_flags.length > 0) {
      photoLine += `\n   ⚠️ *Let op:* ${assessment.red_flags.join(', ')}`;
    }
  }

  // Single link to source portal
  let linkLine = '';
  if (prop?.url) {
    const domain = getSourceLabel(prop.source);
    linkLine = `🔗 <${prop.url}|Bekijk op ${domain}>`;
  }

  let text = `${emoji}  *${truncTitle}* — *${price}*\n`;
  if (details.length > 0) text += `   ${details.join('  •  ')}\n`;
  text += `   Match: ${stars} (${sel.match_score}/100)\n\n`;
  text += `   💬 *Waarom deze woning past:*\n   ${sel.motivation || ''}\n`;
  if (photoLine) text += photoLine + '\n';
  text += '\n';
  if (highlights) text += `   ✨ ${highlights}\n\n`;
  if (linkLine) text += `   ${linkLine}`;

  return {
    type: 'section',
    text: { type: 'mrkdwn', text: text.trim() },
  };
}

/**
 * Build the main results message blocks.
 */
function buildResultBlocks(selections, allProperties, clientProfile, stats, photoAssessments) {
  const blocks = [];

  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `🏠 WoningBot — ${selections.length} matches gevonden`,
      emoji: true,
    },
  });

  const summary = clientProfile.search_summary || 'Zoekopdracht';
  const sourcesParts = [];
  if (stats.idealistaCount > 0) sourcesParts.push(`Idealista (${stats.idealistaCount})`);
  if (stats.supabaseCount  > 0) sourcesParts.push(`Costa Select (${stats.supabaseCount})`);
  if (stats.thinkspainCount > 0) sourcesParts.push(`ThinkSpain (${stats.thinkspainCount})`);

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Zoekopdracht:* ${summary}\n*Bronnen:* ${sourcesParts.join(' • ') || 'Geen resultaten'} → ${stats.totalScraped} gescraped, ${selections.length} geselecteerd`,
    },
  });

  blocks.push({ type: 'divider' });

  for (let i = 0; i < selections.length; i++) {
    const sel = selections[i];
    const prop = findProperty(sel.property_id, allProperties);
    blocks.push(buildPropertyBlock(sel, prop, i, photoAssessments));
    if (i < selections.length - 1) blocks.push({ type: 'divider' });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '💡 Reageer in deze thread om de selectie te verfijnen. Bijv: "meer zoals nr 1", "nr 4 en 7 zijn te gedateerd, vervang die", of "budget omhoog naar 1.5M"',
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
function buildRefinedBlocks(selections, allProperties, responseText, photoAssessments) {
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
    blocks.push(buildPropertyBlock(sel, prop, i, photoAssessments));
    if (i < selections.length - 1) blocks.push({ type: 'divider' });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '💡 Reageer opnieuw in deze thread om verder te verfijnen.' }],
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
  return [{ type: 'section', text: { type: 'mrkdwn', text: '🔍 Ik ga zoeken op Idealista en ThinkSpain. Even geduld...' } }];
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
