const { getThread, updateThread, addConversation } = require('../store/thread-memory');
const { refineSelection } = require('../services/claude-refiner');
const { searchIdealista } = require('../services/idealista');
const { deduplicateListings } = require('../services/dedup');
const { buildRefinedBlocks, splitBlocks, buildErrorBlocks } = require('../formatters/slack-blocks');

/**
 * Handle messages in threads where the bot has posted results.
 * Listens for consultant feedback and refines the selection.
 */
async function handleThreadReply({ event, client, context }) {
  // Only handle threaded messages (not the parent)
  if (!event.thread_ts || event.thread_ts === event.ts) return;

  // Ignore bot's own messages
  if (event.bot_id || event.subtype === 'bot_message') return;

  // Check if we have thread data for this thread
  const threadData = getThread(event.thread_ts);
  if (!threadData) return; // Not our thread

  const feedback = event.text?.trim();
  if (!feedback) return;

  const channelId = event.channel;
  const threadTs = event.thread_ts;
  const ts = new Date().toISOString();

  console.log(`[${ts}] [ThreadReply] Feedback in thread ${threadTs}: "${feedback}"`);

  // Send "thinking" message
  let thinkingMsg;
  try {
    thinkingMsg = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: '🔄 Ik pas de selectie aan op basis van je feedback...',
    });
  } catch (err) {
    console.error(`[${ts}] [ThreadReply] Failed to send thinking msg:`, err.message);
  }

  try {
    // Record the feedback
    addConversation(threadTs, 'consultant', feedback);

    // Call Claude refiner
    const refinement = await refineSelection(threadData, feedback);

    // Check if new scrape is needed
    if (refinement.needs_new_scrape && refinement.new_filters) {
      console.log(`[${ts}] [ThreadReply] New scrape needed with filters:`, JSON.stringify(refinement.new_filters));

      // Update thinking message
      if (thinkingMsg) {
        try {
          await client.chat.update({
            channel: channelId,
            ts: thinkingMsg.ts,
            text: '🔄 Criteria zijn aangepast, ik zoek opnieuw met de nieuwe filters...',
          });
        } catch (e) { /* ignore */ }
      }

      // Merge new filters with existing hard_filters
      const mergedFilters = { ...threadData.client_profile.hard_filters, ...refinement.new_filters };

      // Run new scrape
      try {
        const newListings = await searchIdealista(mergedFilters);
        const combined = [...threadData.all_properties, ...newListings];
        const deduped = deduplicateListings(combined);

        // Update thread data with new properties
        updateThread(threadTs, { all_properties: deduped });

        // Update client profile with new filters
        const updatedProfile = {
          ...threadData.client_profile,
          hard_filters: mergedFilters,
        };
        updateThread(threadTs, { client_profile: updatedProfile });

        // Re-run selection with updated data
        const { selectProperties } = require('../services/claude-selector');
        const reselection = await selectProperties(updatedProfile, deduped);

        const selections = reselection.selections || [];
        updateThread(threadTs, { current_selection: selections });
        addConversation(threadTs, 'bot', refinement.response_to_consultant || 'Selectie aangepast met nieuwe zoekresultaten.');

        // Build and send refined blocks
        const blocks = buildRefinedBlocks(
          selections,
          deduped,
          refinement.response_to_consultant
        );
        await sendBlocks(client, channelId, threadTs, thinkingMsg?.ts, blocks);

      } catch (scrapeErr) {
        console.error(`[${ts}] [ThreadReply] New scrape failed:`, scrapeErr.message);
        // Fall back to selection from existing pool
        const selections = refinement.selections || [];
        updateThread(threadTs, { current_selection: selections });
        addConversation(threadTs, 'bot', refinement.response_to_consultant || 'Selectie aangepast.');

        const blocks = buildRefinedBlocks(
          selections,
          threadData.all_properties,
          (refinement.response_to_consultant || '') + '\n\n⚠️ Nieuwe zoekresultaten konden niet worden opgehaald. Selectie is gemaakt uit de bestaande pool.'
        );
        await sendBlocks(client, channelId, threadTs, thinkingMsg?.ts, blocks);
      }

    } else {
      // No new scrape needed — just refined selection from existing pool
      const selections = refinement.selections || [];
      updateThread(threadTs, { current_selection: selections });
      addConversation(threadTs, 'bot', refinement.response_to_consultant || 'Selectie aangepast.');

      const blocks = buildRefinedBlocks(
        selections,
        threadData.all_properties,
        refinement.response_to_consultant
      );
      await sendBlocks(client, channelId, threadTs, thinkingMsg?.ts, blocks);
    }

    console.log(`[${ts}] [ThreadReply] Refinement complete.`);

  } catch (error) {
    console.error(`[${ts}] [ThreadReply] Error:`, error);
    try {
      if (thinkingMsg) {
        await client.chat.update({
          channel: channelId,
          ts: thinkingMsg.ts,
          blocks: buildErrorBlocks('Er ging iets mis bij het verfijnen. Probeer het opnieuw.'),
          text: '⚠️ Fout bij verfijnen',
        });
      } else {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          blocks: buildErrorBlocks('Er ging iets mis bij het verfijnen. Probeer het opnieuw.'),
          text: '⚠️ Fout bij verfijnen',
        });
      }
    } catch (sendErr) {
      console.error(`[${ts}] [ThreadReply] Failed to send error:`, sendErr.message);
    }
  }
}

async function sendBlocks(client, channelId, threadTs, thinkingTs, blocks) {
  const chunks = splitBlocks(blocks);

  for (let i = 0; i < chunks.length; i++) {
    if (i === 0 && thinkingTs) {
      try {
        await client.chat.update({
          channel: channelId,
          ts: thinkingTs,
          blocks: chunks[i],
          text: '🏠 Aangepaste selectie',
        });
        continue;
      } catch (e) { /* fall through */ }
    }
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      blocks: chunks[i],
      text: '🏠 Aangepaste selectie',
    });
  }
}

module.exports = { handleThreadReply };
