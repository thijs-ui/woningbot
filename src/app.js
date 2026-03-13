require('dotenv').config();

const { App } = require('@slack/bolt');
const { handleZoekwoning } = require('./handlers/zoekwoning');
const { handleThreadReply } = require('./handlers/thread-reply');
const { handleNieuwbouw } = require('./handlers/nieuwbouw');
const { runNieuwbouwSync } = require('./jobs/nieuwbouw-sync');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Register slash commands
app.command('/zoekwoning', handleZoekwoning);
app.command('/nieuwbouw', handleNieuwbouw);

// Listen for ALL message events — filter in handler
app.event('message', async (args) => {
  const { event } = args;
  const ts = new Date().toISOString();

  if (event.thread_ts) {
    console.log(`[${ts}] [Event] Thread message received: thread_ts=${event.thread_ts}, user=${event.user || 'bot'}, subtype=${event.subtype || 'none'}, text="${(event.text || '').substring(0, 80)}"`);
  }

  try {
    await handleThreadReply(args);
  } catch (err) {
    console.error(`[${ts}] [Event] Error in handleThreadReply:`, err);
  }
});

// Global error handler
app.error(async (error) => {
  const ts = new Date().toISOString();
  console.error(`[${ts}] [WoningBot] Unhandled error:`, error);
});

/**
 * Schedule daily nieuwbouw sync.
 * Runs at 06:00 CET (05:00 UTC) every day.
 * Can be overridden with NIEUWBOUW_CRON_HOUR env var.
 */
function scheduleDailySync() {
  const cronHour = parseInt(process.env.NIEUWBOUW_CRON_HOUR || '5', 10); // UTC hour
  const cronEnabled = process.env.NIEUWBOUW_CRON_ENABLED !== 'false'; // enabled by default

  if (!cronEnabled) {
    console.log('[Cron] Daily nieuwbouw sync is DISABLED (set NIEUWBOUW_CRON_ENABLED=true to enable)');
    return;
  }

  // Check if Google Sheets is configured
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
    console.log('[Cron] Daily nieuwbouw sync is DISABLED (no Google Sheets credentials configured)');
    return;
  }

  if (!process.env.GOOGLE_SHEET_ID) {
    console.log('[Cron] Daily nieuwbouw sync is DISABLED (GOOGLE_SHEET_ID not set)');
    return;
  }

  console.log(`[Cron] Daily nieuwbouw sync scheduled at ${cronHour}:00 UTC`);

  // Simple interval-based scheduler: check every 10 minutes if it's time to run
  let lastRunDate = null;

  setInterval(async () => {
    const now = new Date();
    const currentHour = now.getUTCHours();
    const currentDate = now.toISOString().split('T')[0];

    // Run once per day at the specified hour
    if (currentHour === cronHour && lastRunDate !== currentDate) {
      lastRunDate = currentDate;
      console.log(`[Cron] Starting daily nieuwbouw sync at ${now.toISOString()}`);

      try {
        const results = await runNieuwbouwSync();
        console.log(`[Cron] Daily sync complete:`, JSON.stringify(results));

        // Optionally notify a Slack channel
        const notifyChannel = process.env.NIEUWBOUW_NOTIFY_CHANNEL;
        if (notifyChannel) {
          try {
            const summary = [
              `🏗️ *Dagelijkse NieuwbouwBot Sync voltooid*`,
              `• Gescraped: ${results.totalScraped}`,
              `• Nieuw: ${results.newProjects}`,
              `• Bijgewerkt: ${results.updatedProjects}`,
              `• Niet meer gezien: ${results.markedUnseen}`,
            ];
            if (results.errors.length > 0) {
              summary.push(`• ⚠️ Fouten: ${results.errors.length}`);
            }
            await app.client.chat.postMessage({
              channel: notifyChannel,
              text: summary.join('\n'),
            });
          } catch (e) {
            console.error('[Cron] Failed to send Slack notification:', e.message);
          }
        }
      } catch (error) {
        console.error('[Cron] Daily sync failed:', error);
      }
    }
  }, 10 * 60 * 1000); // Check every 10 minutes
}

(async () => {
  await app.start();
  console.log('⚡ WoningBot V2 is running in Socket Mode!');
  scheduleDailySync();
})();
