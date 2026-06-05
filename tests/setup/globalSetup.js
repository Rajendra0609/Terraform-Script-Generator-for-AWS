/**
 * tests/setup/globalSetup.js
 *
 * Runs ONCE before all test suites that require a live server + database.
 * Sets up:
 *   1. A test Postgres DB (or reuses TEST_DATABASE_URL if provided)
 *   2. The Express app on a random free port
 *   3. Exports TEST_BASE_URL and TEST_PORT via process.env for all test files
 */
'use strict';

const { execSync, spawn } = require('child_process');
const path   = require('path');
const http   = require('http');
require('dotenv').config({ path: path.join(__dirname, '../../backend/.env') });

// ─── Env overrides for test isolation ─────────────────────────────────────────
// Use a separate DB so tests never pollute production data
const TEST_DB_URL = process.env.TEST_DATABASE_URL
  || 'postgresql://tfgen:tfgen123@localhost:5432/tfgen_test';

process.env.DATABASE_URL  = TEST_DB_URL;
process.env.NODE_ENV      = 'test';
process.env.JWT_SECRET    = 'test-jwt-secret-do-not-use-in-prod';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-do-not-use-in-prod';
process.env.ENCRYPT_KEY   = 'test-encrypt-key-exactly-32-char';
process.env.REDIS_URL     = process.env.TEST_REDIS_URL || 'redis://localhost:6379';
// Disable Docker-dependent services in unit/api tests
process.env.SKIP_STS_VERIFY = 'true';
process.env.SKIP_DOCKER     = 'true';

let server;
let serverProcess;

async function waitForPort(port, retries = 20, delay = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${port}/api/health`, (res) => {
          if (res.statusCode === 200) resolve();
          else reject(new Error(`Status ${res.statusCode}`));
        });
        req.on('error', reject);
        req.setTimeout(400, () => reject(new Error('timeout')));
      });
      return; // success
    } catch (_) {
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`Server on port ${port} did not become ready in time`);
}

module.exports = async function globalSetup() {
  const port = process.env.TEST_PORT || 4099;
  process.env.TEST_PORT     = port;
  process.env.TEST_BASE_URL = `http://localhost:${port}`;
  process.env.PORT          = port;

  // Skip if the server is already running (e.g. CI pre-started it)
  if (process.env.TEST_SKIP_SERVER_START === 'true') {
    console.log('[setup] Using externally started server at', process.env.TEST_BASE_URL);
    return;
  }

  console.log(`[setup] Starting test server on port ${port}...`);
  serverProcess = spawn('node', [path.join(__dirname, '../../backend/server.js')], {
    env:   { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

  // Store PID so teardown can kill it
  global.__TEST_SERVER_PID__ = serverProcess.pid;

  await waitForPort(port);
  console.log(`[setup] Server ready at http://localhost:${port}`);
};
