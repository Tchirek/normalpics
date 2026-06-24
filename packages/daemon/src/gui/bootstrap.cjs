const fs = require('node:fs');
const path = require('node:path');

const baseDir = process.resourcesPath || path.resolve(__dirname, '..', '..');
const logPath = path.join(baseDir, 'normalpics-bootstrap.log');

function log(message) {
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    // Startup logging must never block the app.
  }
}

log('bootstrap start');

import('./main.js').catch((err) => {
  log(`bootstrap failed ${err && err.stack ? err.stack : String(err)}`);
  process.exit(1);
});
