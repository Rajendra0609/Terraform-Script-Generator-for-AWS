/**
 * tests/unit/backend/metrics-port.test.js
 *
 * Regression: a busy METRICS_PORT used to raise an unhandled 'error' event and
 * terminate the whole API process. It must now log and keep running.
 */
'use strict';
const http = require('http');
const path = require('path');

describe('metrics server bind failure', () => {
  test('a port already in use is logged, not thrown', async () => {
    const blocker = http.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const busyPort = blocker.address().port;

    const prev = process.env.METRICS_PORT;
    process.env.METRICS_PORT = String(busyPort);
    jest.resetModules();
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { startMetricsServer, stopMetricsServer } = require(path.join(__dirname, '../../../backend/observability/metrics'));

    let unhandled = null;
    const onUnhandled = (err) => { unhandled = err; };
    process.once('uncaughtException', onUnhandled);
    try {
      startMetricsServer();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(unhandled).toBeNull();
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/cannot listen on :\d+ \(EADDRINUSE\)/);
    } finally {
      process.removeListener('uncaughtException', onUnhandled);
      errSpy.mockRestore();
      await stopMetricsServer().catch(() => {});
      await new Promise((resolve) => blocker.close(resolve));
      if (prev === undefined) delete process.env.METRICS_PORT; else process.env.METRICS_PORT = prev;
    }
  });
});
