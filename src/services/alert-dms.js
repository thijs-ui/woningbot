// Schakelaar voor de alert-DM's naar Slack (dagelijkse cron + de eenmalige
// test-batch na het aanmaken van een alert). Staat UIT tenzij
// ALERT_SLACK_DMS_ENABLED=true in de Railway-env staat. Bewust zonder
// default-aan: een ontbrekende of verkeerd gespelde var stuurt niets.
function alertSlackDmsEnabled() {
  return process.env.ALERT_SLACK_DMS_ENABLED === 'true';
}

module.exports = { alertSlackDmsEnabled };
