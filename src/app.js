require('dotenv').config();

const { App } = require('@slack/bolt');
const { handleZoekwoning } = require('./handlers/zoekwoning');
const { handleThreadReply } = require('./handlers/thread-reply');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Register the /zoekwoning slash command
app.command('/zoekwoning', handleZoekwoning);

// Listen for messages in threads where the bot has posted
app.event('message', handleThreadReply);

// Global error handler
app.error(async (error) => {
  const ts = new Date().toISOString();
  console.error(`[${ts}] [WoningBot] Unhandled error:`, error);
});

(async () => {
  await app.start();
  console.log('⚡ WoningBot V2 is running in Socket Mode!');
})();
