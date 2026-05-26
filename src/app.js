require('dotenv').config();

const { WebClient } = require('@slack/web-api');
const cron = require('node-cron');
const { runAlertCheck } = require('./jobs/alert-check');
const { runPrewarm } = require('./jobs/prewarm');
const { startApiServer } = require('./api');

// Slack WebClient voor cron DMs (dashboard-alerts). Bot heeft alleen
// chat:write + users:read.email scopes nodig — slash commands & socket
// mode zijn niet meer in gebruik.
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

(async () => {
  console.log('⚡ WoningBot is running');
  console.log('📌 Portals: Idealista (Apify) + Supabase (nieuwbouw DB + E&V prices)');
  console.log('📌 Interface: REST API voor Costa Select dashboard + dagelijkse alert-DMs via Slack');

  // Daily alert check at 07:00 UTC (08:00 CET / 09:00 CEST)
  cron.schedule('0 7 * * *', () => {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [Cron] Triggering daily alert check...`);
    runAlertCheck(slack).catch(err => console.error(`[${ts}] [Cron] Alert check error:`, err));
  });
  console.log('⏰ Alert check scheduled: daily at 07:00 UTC (08:00 CET)');

  // Daily prewarm at 04:00 UTC (05:00 CET / 06:00 CEST) — vóór ochtend-werkverkeer
  cron.schedule('0 4 * * *', () => {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [Cron] Triggering daily prewarm...`);
    runPrewarm().catch(err => console.error(`[${ts}] [Cron] Prewarm error:`, err));
  });
  console.log('⏰ Prewarm scheduled: daily at 04:00 UTC (05:00 CET)');

  // Start REST API server
  startApiServer();
})();
