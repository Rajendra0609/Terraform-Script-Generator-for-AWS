'use strict';
/**
 * OpenTelemetry distributed tracing bootstrap.
 *
 * OBSERVABILITY FIX: this app previously had no tracing, no metrics, and no
 * per-request correlation at all — only ad-hoc winston console logs (see the
 * logger format fix in server.js) and a DB-backed audit log that only fires
 * for authenticated, mutating requests. A slow or failing request (Terraform
 * plan/apply, a Postgres query, an outbound call to AWS/Checkov/Infracost)
 * had no way to be traced end-to-end. This closes that gap for the "tracing"
 * pillar; see observability/metrics.js for "metrics" and
 * middleware/requestLogger.js for structured per-request "logs". This also
 * fulfils the Observability row already written into
 * docs/PRODUCT_ROADMAP.md's Non-Functional Requirements table, which asked
 * for exactly this (OpenTelemetry traces + a Prometheus metrics endpoint)
 * but had never been implemented.
 *
 * ── CRITICAL: require-order ──────────────────────────────────────────────
 * This file MUST be the very first thing server.js requires — before
 * express, pg, ioredis, http, etc. OpenTelemetry's auto-instrumentation
 * works by monkey-patching modules the first time they are `require()`'d;
 * if express/pg/ioredis are already loaded into Node's module cache before
 * this file runs, their patched versions are never installed and no spans
 * are produced for them. See the top of server.js.
 *
 * ── Opt-in by design ──────────────────────────────────────────────────────
 * No collector ships with this app by default, so tracing is OFF unless
 * OTEL_ENABLED=true is set. When enabled with no reachable collector, the
 * OTLP exporter fails silently in the background (OpenTelemetry's own
 * design — a batch processor drops spans and logs a diagnostic warning, it
 * never throws into application code), so turning this on never risks
 * crashing or slowing down the app even if OTEL_EXPORTER_OTLP_ENDPOINT is
 * wrong or unreachable. See docker-compose.observability.yml for a ready-to
 * -run Jaeger collector, and .env.example for the two lines needed to point
 * this at it.
 */

require('dotenv').config(); // safe/idempotent if server.js also calls this

const OTEL_ENABLED = /^true$/i.test(process.env.OTEL_ENABLED || '');

// A no-op shape so requestLogger.js and anything else can safely call
// getTraceContext() whether or not tracing actually initialised.
const NOOP_CONTEXT = { traceId: undefined, spanId: undefined };

let getTraceContext = () => NOOP_CONTEXT;
let shutdownTracing = async () => {};

if (!OTEL_ENABLED) {
  console.log('[tracing] OTEL_ENABLED is not set — distributed tracing disabled (metrics and logs are unaffected). See .env.example to enable.');
} else {
  try {
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const { resourceFromAttributes } = require('@opentelemetry/resources');
    const semconv = require('@opentelemetry/semantic-conventions');
    const { trace, context } = require('@opentelemetry/api');
    const { TraceIdRatioBasedSampler, ParentBasedSampler } = require('@opentelemetry/sdk-trace-base');

    const ATTR_SERVICE_NAME    = semconv.ATTR_SERVICE_NAME    || 'service.name';
    const ATTR_SERVICE_VERSION = semconv.ATTR_SERVICE_VERSION || 'service.version';
    const ATTR_DEPLOYMENT_ENV  = semconv.ATTR_DEPLOYMENT_ENVIRONMENT || 'deployment.environment';

    let pkgVersion = '0.0.0';
    try { pkgVersion = require('../package.json').version || pkgVersion; } catch (_) { /* non-fatal */ }

    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
    // OTLPTraceExporter (HTTP) wants the full signal path; accept either a
    // bare collector origin (append /v1/traces) or an already-complete URL.
    const tracesUrl = /\/v1\/traces\/?$/.test(otlpEndpoint)
      ? otlpEndpoint
      : `${otlpEndpoint.replace(/\/$/, '')}/v1/traces`;

    const sampleRatio = Number(process.env.OTEL_TRACES_SAMPLER_RATIO ?? '1');

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]:    process.env.OTEL_SERVICE_NAME || 'tfgen-backend',
        [ATTR_SERVICE_VERSION]: pkgVersion,
        [ATTR_DEPLOYMENT_ENV]:  process.env.NODE_ENV || 'development',
      }),
      traceExporter: new OTLPTraceExporter({ url: tracesUrl }),
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(Number.isFinite(sampleRatio) ? sampleRatio : 1) }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Fires a span per fs call — extremely noisy for an app that
          // shells out to write/read Terraform workspaces constantly, and
          // adds little tracing value over the explicit spans the
          // terraform job pipeline already produces around those steps.
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-http': {
            // Don't trace Prometheus scraping itself or this endpoint —
            // see observability/metrics.js, served on its own port/server
            // so it isn't even routed through this HTTP instrumentation,
            // but ignoreIncomingRequestHook is kept as defence-in-depth in
            // case metrics are ever mounted on the main app in the future.
            ignoreIncomingRequestHook: (req) => req.url === '/metrics' || req.url === '/api/metrics',
          },
        }),
      ],
    });

    sdk.start();
    console.log(`[tracing] OpenTelemetry initialised — exporting traces to ${tracesUrl} (sampling ratio ${sampleRatio}). See docker-compose.observability.yml for a local collector.`);

    getTraceContext = () => {
      const span = trace.getSpan(context.active());
      if (!span) return NOOP_CONTEXT;
      const ctx = span.spanContext();
      return { traceId: ctx.traceId, spanId: ctx.spanId };
    };

    shutdownTracing = async () => {
      try { await sdk.shutdown(); } catch (_) { /* best-effort flush on shutdown */ }
    };
  } catch (err) {
    // Never let a missing/misconfigured OTel package take the app down —
    // tracing is additive observability, not a hard dependency.
    console.warn('[tracing] Failed to initialise OpenTelemetry — continuing without tracing:', err.message);
  }
}

module.exports = { getTraceContext, shutdownTracing, OTEL_ENABLED };
