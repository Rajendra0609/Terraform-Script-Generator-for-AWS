/**
 * tests/setup/globalTeardown.js
 * Kills the test server process started in globalSetup.
 */
'use strict';

module.exports = async function globalTeardown() {
  if (process.env.TEST_SKIP_SERVER_START === 'true') return;

  const pid = global.__TEST_SERVER_PID__;
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[teardown] Stopped test server (PID ${pid})`);
    } catch (e) {
      // Already dead — that's fine
    }
  }
};
