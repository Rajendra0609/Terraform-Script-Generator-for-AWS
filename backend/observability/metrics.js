'use strict';
/**
 * Prometheus-format metrics via prom-client.
 *
 * OBSERVABILITY FIX: no metrics of any kind previously existed — see the
 * comment at the top of observability/tracing.js for the full context.
 * routes/admin.js's GET /metrics is a *product/business* metrics endpoint
 * (signup counts, project counts — read from Postgres, admin-only, JSON);
 * it is not infrastructure/ops metrics and doesn't overlap with this file.
 *
 * ── Why a SEPARATE port instead of GET /api/metrics on the main app ──────
 * frontend/nginx.conf proxies everything under /api/ straight through to
 * the backend, and nginx's port is the only thing docker-compose.yml
 * publishes to the host (see the C-10 fix there) — so a metrics route
 * mounted on the main app would be reachable by anyone on the public
 * internet who can reach this deployment at all, with no auth in front of
 * it (Prometheus endpoints aren't typically designed to sit behind
 * user-facing auth). That's a real information-disclosure surface (route
 * names, error rates, timing) for zero benefit, since the only intended
 * scraper is a Prometheus server on the same private network. Instead this
 * starts its own tiny HTTP server on METRICS_PORT (default 9464, the
 * OpenTelemetry/Prometheus convention), which docker-compose.yml —
 * consistent with the backend's main port — does NOT publish to the host.
 * Only other containers on the same compose network (e.g. the optional
 * Prometheus service in docker-compose.observability.yml, which reaches it
 * at backend:9464) can scrape it.
 */

const http = require('http');
// prom-client's own package now prints a deprecation notice pointing at
// @prometheus-io/client (its intended successor under a new scope) — but
// that package is still 0.x as of this writing (pre-1.0, no stability
// guarantee yet), whereas prom-client is the long-established, extremely
// widely deployed implementation with a stable, well-documented API. Using
// a brand-new 0.x package for the very first production observability pass
// here would trade a cosmetic warning for real API-stability risk. Revisit
// this once @prometheus-io/client reaches a stable 1.x release.
const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register }); // process CPU/memory/event-loop-lag/GC, Node version, etc.

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const terraformJobDuration = new client.Histogram({
  name: 'terraform_job_duration_seconds',
  help: 'Duration of terraform/checkov/infracost execution jobs in seconds',
  labelNames: ['job_type', 'status'],
  buckets: [1, 2, 5, 10, 20, 30, 60, 120, 300, 600],
  registers: [register],
});

const terraformJobsTotal = new client.Counter({
  name: 'terraform_jobs_total',
  help: 'Total number of terraform/checkov/infracost execution jobs',
  labelNames: ['job_type', 'status'],
  registers: [register],
});

const jobQueueDepth = new client.Gauge({
  name: 'job_queue_depth',
  help: 'Current BullMQ job counts by state',
  labelNames: ['state'],
  registers: [register],
});

const websocketConnections = new client.Gauge({
  name: 'websocket_active_connections',
  help: 'Currently open WebSocket connections by channel',
  labelNames: ['channel'],
  registers: [register],
});

/**
 * Express middleware: times every request and records it against the
 * ROUTE PATTERN (e.g. "/api/projects/:id"), not the raw URL — using the
 * raw URL would create one time series per distinct project/resource ID
 * ever requested, which is the single most common way to accidentally
 * blow up a Prometheus server's memory ("cardinality explosion").
 * req.route is only populated once Express finishes matching a route, so
 * this reads it from the 'finish' listener rather than up front.
 */
function httpMetricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route ? `${req.baseUrl}${req.route.path}` : (req.baseUrl || req.path || 'unmatched');
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    httpRequestDuration.observe(labels, durationSeconds);
    httpRequestsTotal.inc(labels);
  });
  next();
}

let _metricsServer = null;
function startMetricsServer() {
  if (_metricsServer) return _metricsServer;
  const port = Number(process.env.METRICS_PORT || 9464);
  _metricsServer = http.createServer(async (req, res) => {
    if (req.url === '/metrics' && req.method === 'GET') {
      try {
        res.writeHead(200, { 'Content-Type': register.contentType });
        res.end(await register.metrics());
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`metrics collection failed: ${err.message}`);
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found — metrics are served at /metrics');
  });
  // A busy METRICS_PORT must not take the API down with it. Without this
  // listener Node turns the bind failure into an uncaught 'error' event and the
  // whole process exits. The API keeps serving; only metrics are unavailable.
  _metricsServer.on('error', (err) => {
    console.error(`[metrics] cannot listen on :${port} (${err.code || err.message}). ` +
      'Prometheus metrics are disabled for this process. Set METRICS_PORT to a free port. ' +
      'The API continues to serve requests.');
  });
  _metricsServer.listen(port, () => {
    console.log(`[metrics] Prometheus metrics listening on :${port}/metrics (internal only — not published to the host by docker-compose.yml, and not proxied by nginx)`);
  });
  return _metricsServer;
}

async function stopMetricsServer() {
  if (!_metricsServer) return;
  await new Promise((resolve) => _metricsServer.close(resolve));
  _metricsServer = null;
}

module.exports = {
  register,
  httpMetricsMiddleware,
  startMetricsServer,
  stopMetricsServer,
  terraformJobDuration,
  terraformJobsTotal,
  jobQueueDepth,
  websocketConnections,
};
