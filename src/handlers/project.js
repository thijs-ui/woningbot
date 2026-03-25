/**
 * /project Slack command handler — Project information via Tavily web search.
 *
 * Usage:
 *   /project The View Marbella
 *   /project Residencial Albatros Estepona
 *   /project Sierra Blanca Tower Málaga
 *
 * Follow-up in thread:
 *   "Wat zijn de prijzen voor 3 slaapkamers?"
 *   "Wie is de ontwikkelaar?"
 */

const Anthropic = require('@anthropic-ai/sdk');
const { claudeRetry } = require('../services/claude-retry');
const { getProjectInfo } = require('../services/project-info');
const { setThread, addConversation } = require('../store/thread-memory');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

const PROJECT_THREAD_PROMPT = `Je bent de ProjectBot van Costa Select, een Nederlandse makelaar in Spanje.
Je hebt eerder informatie opgezocht over een specifiek nieuwbouwproject via het internet.

Je taak:
1. Beantwoord vervolgvragen over dit project op basis van de eerder gevonden informatie
2. Als de consultant naar iets vraagt dat niet in de bronnen staat, zeg dat eerlijk
3. Geef concrete, bruikbare antwoorden in het Nederlands
4. Verzin GEEN informatie — als je het niet weet, zeg dat

Formatteer je antwoord voor Slack:
- Gebruik *bold* voor nadruk
- Gebruik bullet points voor lijsten
- Vermeld bronnen met links waar relevant
- Houd antwoorden beknopt maar volledig`;

/**
 * Handle the /project slash command.
 */
async function handleProject({ command, ack, client }) {
  await ack();

  const query = (command.text || '').trim();
  const channelId = command.channel_id;
  const userId = command.user_id;
  const ts = new Date().toISOString();

  console.log(`[${ts}] [Project] Query from ${userId}: "${query}"`);

  if (!query) {
    await client.chat.postMessage({
      channel: channelId,
      text: ':mag: *ProjectBot — Gebruik:*\n\n' +
        '`/project The View Marbella` — Info over een specifiek project\n' +
        '`/project Residencial Albatros Estepona` — Zoek alles wat online staat\n\n' +
        'Na resultaten kun je in de thread vervolgvragen stellen.',
    });
    return;
  }

  // The query IS the project name — no intent detection needed
  const projectName = query;

  // Send initial status
  let statusMsg;
  try {
    statusMsg = await client.chat.postMessage({
      channel: channelId,
      text: `:mag: *ProjectBot — ${projectName}*\n\n` +
        `:globe_with_meridians: Internet doorzoeken (incl. Idealista)...`,
    });
  } catch (e) {
    console.error(`[${ts}] [Project] Failed to send status:`, e.message);
  }

  const threadTs = statusMsg?.ts;

  try {
    const result = await getProjectInfo(projectName, query);

    // Build final message
    const idealistaNote = result.idealista_count > 0
      ? ` (waarvan ${result.idealista_count} van Idealista)`
      : '';

    const finalText = `:mag: *ProjectBot — ${projectName}*\n` +
      `_${result.source_count} bronnen gevonden en geanalyseerd${idealistaNote}_\n\n` +
      `${result.summary}\n\n` +
      `_:speech_balloon: Stel vervolgvragen in deze thread._`;

    if (threadTs) {
      try {
        await client.chat.update({ channel: channelId, ts: threadTs, text: finalText });
      } catch (e) {
        await client.chat.postMessage({ channel: channelId, text: finalText });
      }
    } else {
      await client.chat.postMessage({ channel: channelId, text: finalText });
    }

    // Store thread data for follow-up questions
    if (threadTs) {
      setThread(threadTs, {
        type: 'project',
        project_name: projectName,
        sources: result.sources,
        raw_context: result.summary,
        source_count: result.source_count,
        conversation_history: [],
        channel_id: channelId,
        original_query: query,
        created_at: Date.now(),
      });
    }

    console.log(`[${ts}] [Project] Info delivered for "${projectName}" (${result.source_count} sources, ${result.idealista_count} from Idealista)`);

  } catch (error) {
    console.error(`[${ts}] [Project] Failed:`, error);

    const errorMsg = `:mag: *ProjectBot — ${projectName}*\n\n` +
      `:warning: Kon geen informatie ophalen: ${error.message}\n\n` +
      `_Tip: controleer of TAVILY_API_KEY is ingesteld in Railway Variables._`;

    if (threadTs) {
      try { await client.chat.update({ channel: channelId, ts: threadTs, text: errorMsg }); } catch (e) { /* ignore */ }
    } else {
      await client.chat.postMessage({ channel: channelId, text: errorMsg });
    }
  }
}

/**
 * Handle follow-up questions in /project threads.
 */
async function handleProjectThreadReply(threadData, feedback, client, channelId, threadTs) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [ProjectThread] Follow-up for "${threadData.project_name}": "${feedback}"`);

  let thinkingMsg;
  try {
    thinkingMsg = await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: ':arrows_counterclockwise: Even kijken...',
    });
  } catch (e) { /* ignore */ }

  try {
    addConversation(threadTs, 'consultant', feedback);

    const history = (threadData.conversation_history || []).map(msg => ({
      role: msg.role === 'consultant' ? 'user' : 'assistant',
      content: msg.content,
    }));

    const contextMessage = `Eerder opgezochte informatie over "${threadData.project_name}":\n\n${threadData.raw_context}\n\nBronnen: ${(threadData.sources || []).map(s => s.url).join(', ')}`;

    const messages = [
      { role: 'user', content: contextMessage },
      ...history,
      { role: 'user', content: feedback },
    ];

    const response = await claudeRetry(claude, {
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: PROJECT_THREAD_PROMPT,
      messages,
    }, { label: 'ProjectThread' });

    const answer = response.content[0].text.trim();

    addConversation(threadTs, 'bot', answer);

    if (thinkingMsg) {
      try {
        await client.chat.update({
          channel: channelId,
          ts: thinkingMsg.ts,
          text: `:mag: ${answer}`,
        });
      } catch (e) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `:mag: ${answer}`,
        });
      }
    } else {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `:mag: ${answer}`,
      });
    }

  } catch (error) {
    console.error(`[${ts}] [ProjectThread] Error:`, error);
    const errorMsg = `:warning: Er ging iets mis: ${error.message}`;
    if (thinkingMsg) {
      try { await client.chat.update({ channel: channelId, ts: thinkingMsg.ts, text: errorMsg }); } catch (e) { /* ignore */ }
    } else {
      try { await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: errorMsg }); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { handleProject, handleProjectThreadReply };
