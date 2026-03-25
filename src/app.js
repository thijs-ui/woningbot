require('dotenv').config();

const { App } = require('@slack/bolt');
const { handleZoekwoning } = require('./handlers/zoekwoning');
const { handleThreadReply } = require('./handlers/thread-reply');
const { handleNieuwbouw } = require('./handlers/nieuwbouw');
const { handleProject } = require('./handlers/project');
const { handlePrijs } = require('./handlers/prijs');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Register slash commands
app.command('/zoekwoning', handleZoekwoning);
app.command('/nieuwbouw', handleNieuwbouw);
app.command('/project', handleProject);
app.command('/prijs', handlePrijs);

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

(async () => {
  await app.start();
  console.log('⚡ WoningBot V2 is running in Socket Mode!');
  console.log('📌 Portals: Idealista (custom scraper) + Supabase (nieuwbouw DB + E&V prices)');
  console.log('📌 Commands: /zoekwoning, /nieuwbouw, /project, /prijs');
})();
