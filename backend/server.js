// OBSERVABILITY: must be required FIRST, before express/pg/ioredis/etc. are
// ever loaded anywhere in this process — see the comment at the top of
// observability/tracing.js for exactly why require-order matters here.
require('./observability/tracing');

require('dotenv').config();
const express = require('express');
const winston = require('winston');
const rateLimit = require('express-rate-limit');
const { DEFAULT_AWS_REGION } = require('./config/region');
const app = express();

// Logger
// OBSERVABILITY FIX: previously just winston.format.json() with no
// timestamp field at all — every log line looked like
// {"level":"info","message":"..."} with no indication of when it happened,
// relying entirely on the log collector's own ingestion time (fragile the
// moment anything buffers/batches). format.errors({ stack: true }) is added
// defensively too: winston's JSON formatter silently drops a raw Error
// object's message/stack (they're non-enumerable) unless this is present —
// server.js's own error handler already works around this by passing
// err.stack manually (see the trust-proxy/global error handler below), but
// other call sites (and future ones) shouldn't have to remember to.
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'tfgen-backend' },
  transports: [
    new winston.transports.Console(),
  ],
});

const isDev = (process.env.NODE_ENV || 'development') !== 'production';

// SECURITY FIX (M-01): neither the backend nor nginx set any HTTP security
// headers previously — no CSP, no X-Frame-Options/frame-ancestors, no HSTS,
// no Referrer-Policy. helmet() adds sane defaults for all of those; CSP is
// tuned below for what this app actually needs (Monaco Editor's tokenizer
// workers load via blob: URLs, and the CRA build injects the app's own
// inline runtime chunk hash — everything else stays locked to 'self').
// This is defense-in-depth alongside the equivalent nginx `add_header`
// directives (see frontend/nginx.conf) — the two are redundant on purpose:
// nginx protects static/SPA responses, helmet protects the API responses
// nginx proxies straight through.
const helmet = require('helmet');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      // Monaco's syntax highlighting/language workers are spun up from
      // blob: URLs generated at runtime by monaco-editor's AMD loader.
      workerSrc: ["'self'", 'blob:'],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // Monaco injects <style> tags for themes
      imgSrc: ["'self'", 'data:', 'https:'],   // OAuth avatar_url values (Google/GitHub CDNs)
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"], // clickjacking protection (belt-and-suspenders with X-Frame-Options)
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  // Backend is not the TLS terminator here (nginx/ALB is) — still safe to
  // send HSTS; browsers only honour it once they've seen it over HTTPS.
  hsts: { maxAge: 15552000, includeSubDomains: true },
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // API is called cross-origin by the frontend
}));

// CORS: use a strict whitelist. Set `CORS_ORIGIN` in `backend/.env` to a
// comma-separated list of allowed origins for your environment/deployment
// (e.g. your dev machine's LAN IP, or your production domain).
//
// SECURITY FIX (L-08): the dev fallback used to include a specific
// internal-looking IP address (10.244.24.67) baked directly into source —
// environment-specific and meaningless (or actively misleading/wrong) on
// anyone else's machine, plus the same class of issue as the public IP
// that used to be hardcoded in docker-compose.yml (see C-05). No
// environment-specific IPs ship in source defaults now — only localhost,
// which is the one origin that's actually valid on every machine. Anything
// else (a LAN IP for testing from another device, a real domain in
// production) must be set explicitly via CORS_ORIGIN.
const cors = require('cors');
const defaultDevOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000'];
const allowedOrigins = (process.env.CORS_ORIGIN || defaultDevOrigins.join(',')).split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // allow non-browser requests (curl, server-side) with no Origin
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id', 'X-Requested-With', 'Accept'],
  exposedHeaders: ['X-Correlation-Id'],
  credentials: true,
  maxAge: 86400,
}));

// Express trust proxy is required when your app is behind a reverse proxy
// (e.g., Nginx/ALB). express-rate-limit validates that X-Forwarded-For is
// only used when trust proxy is enabled.
// Use a safe default: only trust the first proxy hop.
//
// SECURITY FIX (C-10): TRUST_PROXY used to be read as
// `process.env.TRUST_PROXY || 1`, which — because `||` only falls through on
// falsy values — meant setting `TRUST_PROXY=false` in .env actually set
// Express's trust-proxy option to the STRING `"false"`, not the boolean
// `false` (a non-empty string is truthy). Express's trust-proxy setting
// treats an unrecognised string as a hostname/subnet to trust, which is not
// what anyone setting `TRUST_PROXY=false` intended. Parse it explicitly.
function parseTrustProxy(raw) {
  if (raw === undefined || raw === '') return 1; // safe default: trust exactly one hop
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  const n = Number(raw);
  return Number.isInteger(n) ? n : raw; // allow a hostname/subnet/CSV list to pass through as-is
}
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

// Rate limiting
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000), 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || (isDev ? '1000' : '100'), 10);

// SECURITY FIX (critical — C-10): TRUSTED_IPS used to be matched with
// `ip.includes(t)` — a SUBSTRING check, not equality. Any spoofed
// X-Forwarded-For value that merely CONTAINED a trusted fragment anywhere in
// it (e.g. an attacker-chosen string embedding "127.0.0.1") was exempted
// from rate limiting entirely, including the strict authLimiter meant to
// stop login brute-forcing — reproducible with
// `curl -H "X-Forwarded-For: 127.0.0.1" ...` on every request. Fixed by
// parsing each configured entry as an exact IP or CIDR range with ipaddr.js
// (already a dependency — see utils/ssrfGuard.js) and comparing structurally
// instead of by string containment. This closes the bypass on its own, but
// it's paired with two other required fixes: nginx now overwrites (rather
// than appends to) X-Forwarded-For at the true network edge, and the backend
// port is no longer published directly to the host — see nginx.conf and
// docker-compose.yml.
const ipaddr = require('ipaddr.js');

function parseTrustedEntry(raw) {
  try {
    if (raw.includes('/')) return ipaddr.parseCIDR(raw);
    return ipaddr.process(raw); // normalises IPv4-mapped IPv6 (::ffff:a.b.c.d) too
  } catch (_) {
    console.warn(`[rate-limit] ignoring malformed RATE_LIMIT_TRUSTED_IPS entry: ${raw}`);
    return null;
  }
}
const TRUSTED_ENTRIES = (process.env.RATE_LIMIT_TRUSTED_IPS || '127.0.0.1,::1')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(parseTrustedEntry).filter(Boolean);

function isTrustedIp(rawIp) {
  if (!rawIp) return false;
  let addr;
  try {
    addr = ipaddr.process(rawIp);
  } catch (_) {
    return false;
  }
  return TRUSTED_ENTRIES.some((entry) => {
    try {
      if (Array.isArray(entry)) { // parsed CIDR: [rangeAddr, prefixBits]
        return addr.kind() === entry[0].kind() && addr.match(entry);
      }
      return addr.kind() === entry.kind() && addr.toString() === entry.toString();
    } catch (_) {
      return false;
    }
  });
}

const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  skip: (req) => {
    // BE-02 fix: removed the blanket /api/admin skip — admin routes are protected
    // by authMiddleware + requireRole('admin') and must still be rate-limited to
    // prevent DoS via stolen/compromised admin tokens.
    // Skip for trusted local/dev IPs
    const ip = req.ip || req.connection?.remoteAddress || '';
    if (isTrustedIp(ip)) return true;
    // In dev, be more permissive
    if (isDev) return false; // dev uses a higher RATE_LIMIT_MAX already
    return false;
  },
  handler: (req, res) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    logger.warn(`[rate-limit] 429 ${ip} ${req.method} ${req.originalUrl}`);
    // Provide Retry-After header (seconds)
    res.set('Retry-After', Math.ceil(RATE_LIMIT_WINDOW_MS / 1000));
    res.status(429).json({ error: 'Too many requests — slow down', retryAfter: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) });
  }
});
const { httpMetricsMiddleware } = require('./observability/metrics');
// Correlation IDs and access logging run FIRST, before rate limiting and body
// parsing, so every response (including 400 for malformed JSON and 429 from the
// limiter) carries the X-Correlation-Id a support report can quote.
const { requestLogger } = require('./middleware/requestLogger');
app.use(httpMetricsMiddleware);
app.use(requestLogger(logger));
app.use(limiter);

// BUG-006 fix: dedicated stricter rate limiter for auth endpoints to prevent
// brute-force and credential-stuffing attacks. 10 req/15 min per IP is far
// more appropriate than the global 100 req/15 min limit.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const ip = req.ip || req.connection?.remoteAddress || '';
    return isTrustedIp(ip);
  },
  handler: (req, res) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    logger.warn(`[auth-rate-limit] 429 ${ip} ${req.method} ${req.originalUrl}`);
    res.set('Retry-After', Math.ceil(15 * 60));
    res.status(429).json({ error: 'Too many authentication attempts — try again later', retryAfter: 15 * 60 });
  }
});
app.use('/api/auth/login',    authLimiter);
app.use('/api/auth/register', authLimiter);

// SECURITY FIX (defense-in-depth — C-10): authLimiter above is keyed by
// (trust-proxy-derived) IP, so it's only as strong as X-Forwarded-For
// handling — which the other C-10 fixes (nginx, backend port, trust-proxy
// parsing, exact-match TRUSTED_IPS) close, but a second, independent layer
// keyed by the ACCOUNT being targeted means a brute-force against one
// victim's account is still bounded even if some future proxy
// misconfiguration lets IP-based limiting be bypassed again. Deliberately
// does not consult TRUSTED_IPS/isTrustedIp at all — this is about
// protecting the target account, not about who's asking.
const loginPerAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = String(req.body?.email || '').toLowerCase().trim();
    return email ? `acct:${email}` : (req.ip || 'unknown');
  },
  handler: (req, res) => {
    logger.warn(`[login-account-rate-limit] 429 for account lookup on ${req.method} ${req.originalUrl}`);
    res.set('Retry-After', String(15 * 60));
    res.status(429).json({ error: 'Too many login attempts for this account — try again later', retryAfter: 15 * 60 });
  },
});
// NOTE: express.json() is mounted globally further below (after these
// limiters), but keyGenerator here needs req.body.email — so parse the body
// for this one route now. body-parser is idempotent (it no-ops if the body
// was already parsed), so this doesn't double-consume the request when the
// global parser runs again later.
app.use('/api/auth/login', express.json({ limit: '10mb' }), loginPerAccountLimiter);

// OBSERVABILITY: the dev-only request logger that used to live here
// ("help trace whether the browser's requests reach the backend" — exactly
// the kind of thing that would have caught the OAuth redirect bug sooner)
// is now superseded by middleware/requestLogger.js, mounted below — it does
// the same job but always-on (not just NODE_ENV=development), with a
// correlation ID, duration, status code, and trace ID when tracing is
// enabled. Removed here to avoid double-logging every request in dev.


app.use(express.json({ limit: '10mb' }));
// BUG-008 fix: parse cookies so auth routes can read the HttpOnly refreshToken cookie
const cookieParser = require('cookie-parser');
app.use(cookieParser());

// OBSERVABILITY: HTTP metrics + structured access log for EVERY request,
// mounted before any route so nothing is missed — including anonymous,
// read-only, and failed requests, which is exactly what the audit-log
// middleware (middleware/audit.js) does not cover. See
// observability/metrics.js and middleware/requestLogger.js for the full
// rationale (both were written to close a gap that made the OAuth redirect
// bug in routes/oauth.js invisible in production logs).

app.use('/api/auth',      require('./routes/auth'));
// Kept as a named reference (rather than an inline require like the routes
// around it) so autoMigrate() below can explicitly await
// projectsRouter.ensureResourceColumns()/ensureVersionColumns() once the
// base tables exist — see BUG-STARTUP-RACE fix there for why.
const projectsRouter = require('./routes/projects');
app.use('/api/projects',  projectsRouter);
app.use('/api/templates', require('./routes/templates'));
app.use('/api/terraform', require('./routes/terraform'));

// aws.js throws a synchronous Error at module load time if ENCRYPT_KEY is
// absent or set to the insecure default.  Wrap in try/catch so the process
// exits with a clear fatal message and code 1 rather than an unhandled
// exception with a cryptic stack trace (which causes unhelpful crashloops
// in Docker/Kubernetes).
try {
  app.use('/api/aws', require('./routes/aws'));
} catch (err) {
  console.error('\n[FATAL] Failed to load /routes/aws:', err.message);
  console.error('[FATAL] Set a strong ENCRYPT_KEY in backend/.env and restart.\n');
  process.exit(1);
}

app.use('/api/admin',     require('./routes/admin'));
app.use('/api/audit',     require('./routes/audit'));    // audit log viewer (admin-only)
app.use('/api/export',    require('./routes/export'));   // CI/CD pipeline + README generation
app.use('/api/learn',     require('./routes/learn'));   // HCL explain, labs, interview Q, patterns
app.use('/api/iam',       require('./routes/iam'));     // IAM policy generator
app.use('/api/state',     require('./routes/state'));   // Terraform state inspector
app.use('/api/registry',  require('./routes/registry')); // Module registry browser
app.use('/api/envconfig', require('./routes/envconfig')); // Multi-env tfvars + backend + terragrunt

// ── Phase 2-5 routes ─────────────────────────────────────────────────────────
app.use('/api/auth/oauth',       require('./routes/oauth'));         // Phase 3: Google/GitHub OAuth
app.use('/api/policies',        require('./routes/policies'));        // Phase 2: OPA governance
app.use('/api/change-requests', require('./routes/change-requests')); // Phase 2: PR-style review
app.use('/api/notifications',   require('./routes/notifications'));   // Phase 4: notification system
app.use('/api/search',          require('./routes/search'));          // Phase 4: global search
app.use('/api/hcl-explain',     require('./routes/hcl-explain'));     // Phase 4: AI HCL explainer
app.use('/api/hcl-assist',      require('./routes/hcl-assist'));      // AI HCL writer/editor for Studio
app.use('/api/diagram',         require('./routes/diagram'));         // AWS architecture diagram generator
app.use('/api/github',          require('./routes/github'));          // GitHub: connect, browse, review PRs, open PR from project
app.use('/api/modules',         require('./routes/modules'));         // Module analyzer, code review, autofix, docs (no GitHub needed)

// BE-09: return only { status: 'ok' } — no server clock, no fingerprinting surface.
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// 404 fallback
app.use((req, res) => res.status(404).json({ error: 'Route not found', correlationId: req.correlationId }));

// Global error handler
// BUG-021 fix: previously returned err.message directly, leaking DB table/column
// names, SQL fragments, and file paths to callers. In production we return a
// generic message; the full stack is logged server-side only.
app.use((err, req, res, next) => {
  // Caller errors are not server faults. Malformed JSON, an oversized body and
  // a disallowed CORS origin used to fall through to the 500 handler below,
  // which both mislabelled them and echoed parser internals back to the client.
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON in request body', correlationId: req.correlationId });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large', correlationId: req.correlationId });
  }
  if (err && err.message === 'Origin not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed', correlationId: req.correlationId });
  }
  // OBSERVABILITY: correlationId ties this exact log line back to the
  // requestLogger.js access-log entry for the same request (and to a trace
  // if OpenTelemetry is enabled), and is also returned to the caller so a
  // user/support ticket can quote one ID an engineer can grep for directly
  // instead of correlating on approximate timestamps.
  logger.error('unhandled_error', { correlationId: req.correlationId, path: req.path, method: req.method, stack: err.stack });
  const message = process.env.NODE_ENV !== 'production'
    ? (err.message || 'Internal server error')
    : 'Internal server error';
  res.status(500).json({ error: message, correlationId: req.correlationId });
});

// Troubleshooting note: "Cannot reach backend at http://<your-host-ip>:4000"
// If the backend process is running but the frontend (browser) still reports
// that it cannot reach the backend, common causes include:
// - Frontend still using an old environment/build: Create-react-app reads
//   `REACT_APP_*` variables at start/build time. After changing `frontend/.env`
//   you must restart the dev server (`npm start`) or rebuild (`npm run build`).
// - Browser cannot reach internal/container IPs (e.g., 10.244.x.x). When the
//   server listens on `0.0.0.0` the browser should use `http://localhost:4000`.
// - Backend bound to a specific interface: ensure `HOST=0.0.0.0` (or the host
//   you intend) in `backend/.env` and restart the backend so it picks up the
//   change.
// - OS firewall (Windows Defender / iptables) may block incoming connections
//   to port 4000 — temporarily allow the port or disable the firewall to test.
// - Docker/WSL networking: if the backend runs in a container, ensure port 4000
//   is published to the host (`-p 4000:4000` or proper docker-compose `ports`).
// - Reverse proxy or VPN: a proxy (nginx, corporate VPN) can change host/port
//   or block traffic — check proxy config or disable VPN for local testing.
// - CORS misconfiguration: if DevTools shows CORS errors, set `CORS_ORIGIN`
//   to the exact frontend origin (e.g. `http://localhost:3000`) and avoid `*`
//   when `credentials: true` is used.
// - Rate limiting / trusted IPs: requests may be skipped or blocked by the
//   rate-limiter if your IP is not in `RATE_LIMIT_TRUSTED_IPS`; check server
//   logs for `[rate-limit]` warnings.
// - WebSocket scheme mismatch: use `ws://` for HTTP or `wss://` for HTTPS.
// Quick checks (run on the machine where your browser is running and where
// the backend may be hosted):
// From Windows PowerShell / CMD:
//   curl -v http://localhost:4000/api/health
//   curl -v http://<your-host-ip>:4000/api/health
//   netstat -an | findstr :4000
//   Test-NetConnection -ComputerName localhost -Port 4000
// From WSL / Linux:
//   curl -v http://127.0.0.1:4000/api/health
//   ss -tlnp | grep 4000   # or: netstat -tlnp | grep 4000
// Check the browser DevTools Network tab for the actual Request URL and any
// console CORS/network errors. If you see `ERR_CONNECTION_REFUSED` the host is
// unreachable; if you see a CORS message, the server responded but with wrong
// CORS headers.
// Recommended quick fixes:
// - Restart backend: `cd backend && npm start` (stop existing process first).
// - Restart frontend dev server: `cd frontend && npm start` (or rebuild with
//   `npm run build` if serving a production build).
// - Use `REACT_APP_API_URL=http://localhost:4000` for browser-based frontend
//   when backend is on the same machine (WSL/docker caveats noted above).
// If this persists, gather the outputs of the above commands and a screenshot
// of the browser DevTools Network request/console and share them — I'll analyze
// and provide next steps.


const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';

// NOTE: If `ss -tlnp` / `netstat` shows the server listening on a specific
// IP (e.g. `<your-host-ip>:4000`) rather than `0.0.0.0:4000`, the Node process is
// bound to a single interface. In that case the browser on the host may not be
// able to reach that internal/container IP and you'll see the frontend error
// "Cannot reach backend at http://<your-host-ip>:4000" even though the server
// process is running. Common causes and quick remedies:
//  - The server was started before `.env` was changed; restart the backend so
//    it picks up `HOST=0.0.0.0`.
//  - The server was explicitly started with an env or flag binding to that IP.
//  - The process is running inside Docker/WSL and that IP is internal to the
//    VM; prefer `localhost` on the browser and bind the server to `0.0.0.0`.
// Quick commands (Linux):
//   ss -tlnp | grep 4000          # find PID and listening address
//   sudo kill <PID>               # stop old process
//   cd backend
//   HOST=0.0.0.0 npm start         # restart bound to all interfaces
// Windows PowerShell:
//   $env:HOST = '0.0.0.0'; npm start
// Afterwards verify from the host/browser machine:
//   curl -v http://localhost:4000/api/health
// If the server listens on `0.0.0.0:4000` the browser should be able to reach
// it via `http://localhost:4000`. If issues persist, check firewall, Docker
// port mappings, and browser DevTools (Network/Console) for CORS vs network errors.

// ─── HTTP + WebSocket server ────────────────────────────────────────────────
const http = require('http');
const { WebSocketServer } = require('ws');
const { initQueue, enqueue, jobEvents } = require('./services/jobQueue');
const { attachTerraformLspSession } = require('./services/terraformLsp');
const { dispatchAndPersist } = require('./services/terraformJobs');
const { verifyAccessToken } = require('./middleware/auth');
const { hasJobAccess, UUID_RE } = require('./utils/projectAccess');

// BUG-004 fix: initQueue was never called, so the BullMQ worker was never
// started and all jobs ran synchronously, blocking the event loop.
// FIX (Phase 1 — async execution wiring): the processor now delegates to
// the shared terraformJobs.dispatchAndPersist(), which (a) applies checkov
// + the policy gate to queued jobs (previously silently skipped for
// anything actually enqueued — only the old synchronous route path had that
// logic), and (b) writes execution_jobs lifecycle transitions
// (queued → running → succeeded/failed) so job status survives a page
// reload and is visible via GET /api/terraform/jobs/:id. routes/terraform.js
// uses this exact same function for its no-Redis synchronous fallback, so
// behaviour is identical either way.
initQueue(dispatchAndPersist);

const server = http.createServer(app);

/**
 * Write a minimal HTTP response and close the socket, so a rejected upgrade
 * gets a real status code/reason instead of a bare connection reset.
 */
function rejectUpgrade(socket, statusCode, reason) {
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Length: 0\r\n\r\n'
    );
  } catch (_) { /* socket may already be gone */ }
  try { socket.destroy(); } catch (_) {}
}

// SECURITY FIX (critical): /ws/jobs and /ws/terraform-lsp previously had NO
// authentication at all.
//  - /ws/jobs?id=<jobId>: any client that supplied a jobId immediately
//    received that job's live terraform plan/apply output — no check that
//    the caller owned or was a member of the associated project. jobId is a
//    UUID, but it's returned in plain JSON from POST /plan|/apply, logged,
//    etc., so anything that leaked a jobId handed a stranger a live read of
//    that job's terraform output (resource ARNs, IPs, infra details).
//  - /ws/terraform-lsp: every connection unconditionally spawned a new
//    terraform-ls process + temp workspace with no auth and no concurrency
//    limit — an unauthenticated, unbounded resource-exhaustion vector.
//
// Fix, applied at the upgrade itself (before either WebSocketServer ever
// accepts the connection):
//  1. Validate Origin against the same allow-list used for HTTP CORS, to
//     close the cross-site WebSocket hijacking angle.
//  2. Require a short-lived access token as `?token=...` (browsers cannot
//     set custom headers — e.g. Authorization — during a WS handshake, so a
//     query-string token is the standard pattern) and verify it with the
//     exact same JWT check used by authMiddleware.
// Per-connection authorization (job ownership, LSP session caps) happens in
// the 'connection' handlers below, once we know who the caller is.
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  logger.info && logger.info(`[ws-upgrade] ${req.method} ${req.url} origin=${req.headers.origin || ''} host=${req.headers.host || ''}`);

  // Origin allow-list — mirrors the Express CORS origin check above. Missing
  // Origin is allowed (non-browser clients, e.g. server-to-server or CLI
  // tools); a present-but-disallowed Origin is rejected outright.
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) {
    logger.warn && logger.warn(`[ws-upgrade] rejected — origin not allowed: ${origin}`);
    return rejectUpgrade(socket, 403, 'Forbidden');
  }

  if (pathname !== '/ws/jobs' && pathname !== '/ws/terraform-lsp') {
    logger.warn && logger.warn(`[ws-upgrade] Unknown websocket path: ${pathname}`);
    return rejectUpgrade(socket, 404, 'Not Found');
  }

  const token = url.searchParams.get('token');
  if (!token) {
    logger.warn && logger.warn(`[ws-upgrade] rejected — no token provided for ${pathname}`);
    return rejectUpgrade(socket, 401, 'Unauthorized');
  }
  let user;
  try {
    user = verifyAccessToken(token);
  } catch (e) {
    logger.warn && logger.warn(`[ws-upgrade] rejected — invalid/expired token: ${e.message}`);
    return rejectUpgrade(socket, 401, 'Unauthorized');
  }
  req.tfgenUser = user;

  try {
    if (pathname === '/ws/jobs') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }
    // pathname === '/ws/terraform-lsp'
    lspWss.handleUpgrade(req, socket, head, (ws) => {
      lspWss.emit('connection', ws, req);
    });
  } catch (err) {
    logger.error && logger.error('[ws-upgrade] error handling upgrade: ' + (err && err.message));
    try { socket.destroy(); } catch (_) {}
  }
});

const wss = new WebSocketServer({ noServer: true });
const lspWss = new WebSocketServer({ noServer: true });

wss.on('connection', async (ws, req) => {
  const user = req.tfgenUser;
  if (!user) { ws.close(1008, 'Unauthorized'); return; } // defensive — upgrade handler already enforces this

  // Extract jobId from URL: /ws/jobs?id=<jobId>
  const url = new URL(req.url, `http://${req.headers.host}`);
  const jobId = url.searchParams.get('id');
  if (!jobId || !UUID_RE.test(jobId)) { ws.close(1008, 'Invalid or missing jobId'); return; }

  // SECURITY FIX: re-run the same ownership/membership check used by
  // GET /api/terraform/jobs/:jobId — do NOT wire up log/done listeners
  // (i.e. do not leak anything) until access is confirmed.
  let allowed = false;
  try {
    allowed = await hasJobAccess(jobId, user.id);
  } catch (e) {
    logger.error && logger.error('[ws-jobs] access check failed: ' + e.message);
  }
  if (!allowed) { ws.close(1008, 'Access denied'); return; }

  // Stream log lines to client
  const onLog = (data) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'log', ...data }));
  };
  const onDone = (result) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'done', result }));
    ws.close();
  };

  jobEvents.on(`log:${jobId}`, onLog);
  jobEvents.once(`done:${jobId}`, onDone);

  // OBSERVABILITY: see observability/metrics.js — websocket_active_connections{channel="jobs"}
  const { websocketConnections } = require('./observability/metrics');
  websocketConnections.inc({ channel: 'jobs' });

  ws.on('close', () => {
    jobEvents.off(`log:${jobId}`, onLog);
    jobEvents.off(`done:${jobId}`, onDone);
    websocketConnections.dec({ channel: 'jobs' });
  });

  ws.send(JSON.stringify({ type: 'connected', jobId }));
});

// SECURITY FIX: per-user + global concurrent session caps for terraform-ls.
// Previously unbounded — any (unauthenticated) client could spawn unlimited
// terraform-ls processes. Now every session is authenticated (see upgrade
// handler above) AND capped. This is in-memory/per-process; a multi-replica
// deployment would need a shared store (e.g. Redis) for a global cap that
// holds across instances — noted here as a scaling follow-up, not required
// at this app's current single-instance scale.
const MAX_LSP_SESSIONS_PER_USER = parseInt(process.env.MAX_LSP_SESSIONS_PER_USER || '2', 10);
const MAX_LSP_SESSIONS_GLOBAL   = parseInt(process.env.MAX_LSP_SESSIONS_GLOBAL   || '50', 10);
const lspSessionCountByUser = new Map();
let lspSessionCountTotal = 0;

lspWss.on('connection', (ws, req) => {
  const user = req.tfgenUser;
  if (!user) { ws.close(1008, 'Unauthorized'); return; } // defensive — upgrade handler already enforces this

  if (lspSessionCountTotal >= MAX_LSP_SESSIONS_GLOBAL) {
    logger.warn && logger.warn(`[ws-lsp] rejected — global session cap (${MAX_LSP_SESSIONS_GLOBAL}) reached`);
    ws.close(1013, 'Server busy — try again shortly');
    return;
  }
  const userCount = lspSessionCountByUser.get(user.id) || 0;
  if (userCount >= MAX_LSP_SESSIONS_PER_USER) {
    logger.warn && logger.warn(`[ws-lsp] rejected — user ${user.id} at session cap (${MAX_LSP_SESSIONS_PER_USER})`);
    ws.close(1008, 'Too many concurrent editor sessions — close another tab and retry');
    return;
  }

  lspSessionCountByUser.set(user.id, userCount + 1);
  lspSessionCountTotal += 1;
  // OBSERVABILITY: see observability/metrics.js — websocket_active_connections{channel="lsp"}
  require('./observability/metrics').websocketConnections.inc({ channel: 'lsp' });
  ws.once('close', () => {
    lspSessionCountTotal = Math.max(0, lspSessionCountTotal - 1);
    require('./observability/metrics').websocketConnections.dec({ channel: 'lsp' });
    const remaining = (lspSessionCountByUser.get(user.id) || 1) - 1;
    if (remaining <= 0) lspSessionCountByUser.delete(user.id);
    else lspSessionCountByUser.set(user.id, remaining);
  });

  attachTerraformLspSession(ws, logger);
});

server.listen(PORT, HOST, () => {
  logger.info(`✅ Backend running on http://${HOST}:${PORT}`);
  logger.debug && logger.debug(`   CORS allowed origins: ${allowedOrigins.join(',')}`);
  logger.info(`   DB: ${process.env.DATABASE_URL ? '✓ configured' : '✗ DATABASE_URL missing!'}`);
  logger.info(`   TF_LSP_PATH: ${process.env.TF_LSP_PATH || '(unset)'}`);
  if (!process.env.TF_LSP_PATH) {
    logger.warn('TF_LSP_PATH is not set in the loaded environment. Please ensure backend/.env is loaded by this process.');
  }

  // OBSERVABILITY: Prometheus metrics on their own internal-only port —
  // see observability/metrics.js for why this isn't just a route on `app`.
  require('./observability/metrics').startMetricsServer();

  // ── Verify the pinned Terraform Docker image digest (L-06 fix) ─────────────
  // Only meaningful if Docker is actually available — if it isn't, the
  // 'local' binary path is what's in play and this pin is irrelevant. Never
  // blocks startup: this is a loud warning, not a crash, since the app is
  // still fully usable via the local-binary path even if the Docker image
  // pin is stale. See runner.js's TF_DOCKER_IMAGE comment and
  // scripts/verify-docker-images.sh for the CI-side half of this fix.
  (async function verifyTerraformDockerImage() {
    try {
      const { isDockerAvailable, verifyDockerImage } = require('./utils/dockerAvailable');
      if (!(await isDockerAvailable())) return;
      const { TF_DOCKER_IMAGE, TF_DOCKER_IMAGE_TAG_HINT } = require('./terraform/runner');
      const result = await verifyDockerImage(TF_DOCKER_IMAGE);
      if (result.ok) {
        logger.info(`✅ Terraform Docker image verified: ${TF_DOCKER_IMAGE} (tag: ${TF_DOCKER_IMAGE_TAG_HINT})`);
      } else {
        logger.warn(`⚠️  TF_DOCKER_IMAGE does not resolve against its registry: ${TF_DOCKER_IMAGE}`);
        logger.warn('   Docker-fallback terraform/checkov/infracost operations will fail until this is fixed.');
        logger.warn(`   Detail: ${result.error}`);
      }
    } catch (_) {
      // Best-effort — never let this check block or crash startup.
    }
  })();

  // ── Auto-migration: ensure all required tables and columns exist ───────────
  // This runs at startup and silently creates anything missing. Safe to run
  // multiple times — uses CREATE IF NOT EXISTS and ADD COLUMN IF NOT EXISTS.
  //
  // BUG-STARTUP-RACE fix: this used to be a bare fire-and-forget IIFE with no
  // way for anything else to know when it finished. Three OTHER pieces of
  // startup code each independently queried tables this function creates,
  // with no ordering guarantee against it finishing first:
  //   1. routes/projects.js's ensureResourceColumns()/ensureVersionColumns()
  //      run at `require()` time — i.e. when the line above mounting
  //      '/api/projects' executes — which happens before server.listen() is
  //      even called, let alone before this callback runs.
  //   2. sanitizePersistedHcl() just below queries the same two tables.
  // On a completely fresh database (first-ever startup, e.g. a new
  // `docker compose up` or a fresh CI run) this is a genuine race: reproduced
  // live during this audit as
  //   [projects] ensureResourceColumns error: relation "resources" does not exist
  //   [projects] ensureVersionColumns error: relation "project_versions" does not exist
  // printed at ERROR level on an otherwise-clean boot, before "Auto-migration
  // complete" even logs. It is harmless in practice ONLY because
  // ensureResourceColumns/ensureVersionColumns lazily retry on the first real
  // request (see routes/projects.js) and a real client is virtually always
  // slower to arrive than autoMigrate() is to finish — but it is not
  // guaranteed (a fast readiness probe or CI smoke test hitting the API
  // immediately could lose the race for real), and it prints a false-positive
  // error on every single clean install regardless. The promise below lets
  // both dependents explicitly wait instead of racing.
  const autoMigrateReady = (async function autoMigrate() {
    const db = require('./db/connection');
    try {
      // Enable pgcrypto extension
      await db.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"').catch(() => {});

      // Core tables
      await db.query(`
        CREATE TABLE IF NOT EXISTS users (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email      VARCHAR(255) UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role       VARCHAR(50) DEFAULT 'user',
          created_at TIMESTAMP DEFAULT NOW()
        )
      `).catch(() => {});

      await db.query(`
        CREATE TABLE IF NOT EXISTS projects (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name        VARCHAR(255) NOT NULL,
          description TEXT,
          aws_region  VARCHAR(50) DEFAULT '${DEFAULT_AWS_REGION}',
          environment VARCHAR(50) DEFAULT 'dev',
          backend_config JSONB DEFAULT '{}',
          created_at  TIMESTAMP DEFAULT NOW(),
          updated_at  TIMESTAMP DEFAULT NOW(),
          user_id     UUID REFERENCES users(id) ON DELETE CASCADE
        )
      `).catch(() => {});

      await db.query(`
        CREATE TABLE IF NOT EXISTS resources (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id    UUID REFERENCES projects(id) ON DELETE CASCADE,
          service_type  VARCHAR(100),
          resource_name VARCHAR(255),
          config        JSONB,
          variables     JSONB DEFAULT '{}',
          outputs       JSONB DEFAULT '{}',
          is_module     BOOLEAN DEFAULT false,
          module_source VARCHAR(500),
          hcl_output    TEXT,
          position      INT DEFAULT 0,
          lifecycle_config JSONB DEFAULT '{}',
          position_x    NUMERIC DEFAULT 0,
          position_y    NUMERIC DEFAULT 0,
          annotations   TEXT DEFAULT '',
          security_findings JSONB DEFAULT '[]',
          created_at    TIMESTAMP DEFAULT NOW()
        )
      `).catch(() => {});

      await db.query(`
        CREATE TABLE IF NOT EXISTS templates (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          service_type  VARCHAR(100) UNIQUE,
          cloud_provider VARCHAR(20) DEFAULT 'aws',
          label         VARCHAR(255),
          category      VARCHAR(100),
          icon          VARCHAR(50),
          is_module     BOOLEAN DEFAULT false,
          schema_def    JSONB,
          template_body TEXT,
          module_body   TEXT,
          data_sources  JSONB DEFAULT '[]',
          updated_at    TIMESTAMP DEFAULT NOW()
        )
      `).catch(() => {});

      await db.query(`
        CREATE TABLE IF NOT EXISTS project_versions (
          id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id     UUID REFERENCES projects(id) ON DELETE CASCADE,
          version_number INT,
          full_hcl       TEXT,
          variables_hcl  TEXT,
          outputs_hcl    TEXT,
          resource_count INT DEFAULT 0,
          cost_estimate_usd NUMERIC(12,4),
          checkov_passed INT DEFAULT 0,
          checkov_failed INT DEFAULT 0,
          change_summary TEXT DEFAULT '',
          saved_by       UUID,
          saved_at       TIMESTAMP DEFAULT NOW()
        )
      `).catch(() => {});

      await db.query(`
        CREATE TABLE IF NOT EXISTS validation_logs (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
          is_valid   BOOLEAN,
          diagnostics JSONB,
          ran_at     TIMESTAMP DEFAULT NOW()
        )
      `).catch(() => {});

      // BUG-022 fix: index on validation_logs to avoid full sequential scans
      // when filtering by project for validation history features.
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_validation_logs_project
          ON validation_logs(project_id, ran_at DESC)
      `).catch(() => {});

      await db.query(`
        CREATE TABLE IF NOT EXISTS refresh_tokens (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL,
          expires_at TIMESTAMP NOT NULL,
          revoked    BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `).catch(() => {});

      await db.query(`
        CREATE TABLE IF NOT EXISTS user_aws_credentials (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id         UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
          aws_region      VARCHAR(50) NOT NULL DEFAULT '${DEFAULT_AWS_REGION}',
          access_key_id   TEXT NOT NULL,
          secret_key_enc  TEXT NOT NULL,
          label           VARCHAR(255) DEFAULT 'My AWS Account',
          verified_at     TIMESTAMP,
          created_at      TIMESTAMP DEFAULT NOW(),
          updated_at      TIMESTAMP DEFAULT NOW()
        )
      `).catch(() => {});

      await db.query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
          action      VARCHAR(100) NOT NULL,
          method      VARCHAR(10),
          path        TEXT,
          ip          VARCHAR(45),
          meta        JSONB DEFAULT '{}',
          status_code INT,
          created_at  TIMESTAMP DEFAULT NOW()
        )
      `).catch(() => {});

      await db.query(`
        CREATE TABLE IF NOT EXISTS project_members (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
          user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
          role        VARCHAR(50) DEFAULT 'editor',
          invited_by  UUID REFERENCES users(id),
          invited_at  TIMESTAMP DEFAULT NOW(),
          accepted_at TIMESTAMP,
          UNIQUE (project_id, user_id)
        )
      `).catch(() => {});

      await db.query(`
        CREATE TABLE IF NOT EXISTS execution_jobs (
          id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id   UUID REFERENCES projects(id) ON DELETE SET NULL,
          user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
          type         VARCHAR(50) NOT NULL,
          status       VARCHAR(50) DEFAULT 'queued',
          hcl_hash     VARCHAR(64),
          plan_summary JSONB DEFAULT '{}',
          cost_delta   NUMERIC(12,4),
          checkov_summary JSONB DEFAULT '{}',
          log_key      TEXT,
          error        TEXT,
          queued_at    TIMESTAMP DEFAULT NOW(),
          started_at   TIMESTAMP,
          finished_at  TIMESTAMP
        )
      `).catch(() => {});

      await db.query(`
        CREATE TABLE IF NOT EXISTS lab_progress (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
          lab_id     VARCHAR(50) NOT NULL,
          step_id    INT NOT NULL,
          completed  BOOLEAN DEFAULT true,
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_id, lab_id, step_id)
        )
      `).catch(() => {});

      // Ensure all columns exist on existing tables (safe ALTER)
      const alterStatements = [
        'ALTER TABLE projects ADD COLUMN IF NOT EXISTS environment VARCHAR(50) DEFAULT \'dev\'',
        'ALTER TABLE projects ADD COLUMN IF NOT EXISTS backend_config JSONB DEFAULT \'{}\'',
        'ALTER TABLE projects ADD COLUMN IF NOT EXISTS user_id UUID',
        // BUG-LASTHCL fix: this used to run as its own `ALTER TABLE ... ADD
        // COLUMN IF NOT EXISTS last_hcl` inside routes/projects.js's POST
        // /:id/resources handler, on EVERY request, taking the same
        // ACCESS EXCLUSIVE lock that BUG-019/M-03 (see routes/projects.js)
        // already fixed for every other column below — this one was just
        // missed. Asserted here once at startup like the rest instead.
        'ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_hcl TEXT DEFAULT \'\'',
        'ALTER TABLE resources ADD COLUMN IF NOT EXISTS variables JSONB DEFAULT \'{}\'',
        'ALTER TABLE resources ADD COLUMN IF NOT EXISTS outputs JSONB DEFAULT \'{}\'',
        'ALTER TABLE resources ADD COLUMN IF NOT EXISTS is_module BOOLEAN DEFAULT false',
        'ALTER TABLE resources ADD COLUMN IF NOT EXISTS module_source VARCHAR(500)',
        'ALTER TABLE resources ADD COLUMN IF NOT EXISTS lifecycle_config JSONB DEFAULT \'{}\'',
        'ALTER TABLE resources ADD COLUMN IF NOT EXISTS position_x NUMERIC DEFAULT 0',
        'ALTER TABLE resources ADD COLUMN IF NOT EXISTS position_y NUMERIC DEFAULT 0',
        'ALTER TABLE resources ADD COLUMN IF NOT EXISTS annotations TEXT DEFAULT \'\'',
        'ALTER TABLE resources ADD COLUMN IF NOT EXISTS security_findings JSONB DEFAULT \'[]\'',
        'ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS variables_hcl TEXT',
        'ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS outputs_hcl TEXT',
        'ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS cost_estimate_usd NUMERIC(12,4)',
        'ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS checkov_passed INT DEFAULT 0',
        'ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS checkov_failed INT DEFAULT 0',
        'ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS change_summary TEXT DEFAULT \'\'',
        'ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS saved_by UUID',
        'ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS resource_count INT DEFAULT 0',
        'ALTER TABLE templates ADD COLUMN IF NOT EXISTS data_sources JSONB DEFAULT \'[]\'',
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT \'user\'',
        // FIX: password-reset columns missing from auto-migration; without these
        // the UPDATE in POST /api/auth/forgot-password silently touches 0 rows.
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT',
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMP',
        // SECURITY FIX (C-13): oauth_provider/oauth_subject/display_name/
        // avatar_url/last_login_at were previously defined ONLY in migration
        // 011, which never actually ran against the shipped Postgres image
        // (see database/Dockerfile + CHANGELOG). Every "Sign in with Google/
        // GitHub" attempt failed with a masked "column does not exist" error.
        // Re-asserting them here means the backend self-heals this on every
        // restart, independent of which migration mechanism the operator
        // actually runs — see also database/012_security_hardening_c11_c13.sql
        // and database/Dockerfile for the belt-and-suspenders fixes.
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_provider VARCHAR(50)',
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_subject TEXT',
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(255)',
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT',
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP',
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP',
        // SECURITY FIX (C-12): email verification gate — see backend/routes/auth.js
        // (POST /register, GET /verify-email) and backend/routes/oauth.js
        // (upsertOAuthUser only auto-links by email when email_verified=true).
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false',
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token TEXT',
        'ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token_expires_at TIMESTAMP',
      ];
      for (const sql of alterStatements) {
        await db.query(sql).catch(() => {});
      }

      // Indexes
      const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id)',
        'CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash)',
        'CREATE INDEX IF NOT EXISTS idx_aws_creds_user ON user_aws_credentials(user_id)',
        'CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id)',
        'CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)',
        'CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id)',
        'CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id)',
        'CREATE INDEX IF NOT EXISTS idx_exec_jobs_project ON execution_jobs(project_id)',
        'CREATE INDEX IF NOT EXISTS idx_exec_jobs_status ON execution_jobs(status)',
        'CREATE INDEX IF NOT EXISTS idx_lab_progress_user ON lab_progress(user_id, lab_id)',
        // BUG-006 fix: indexes on most-queried tables missing from auto-migration
        'CREATE INDEX IF NOT EXISTS idx_resources_project        ON resources(project_id)',
        'CREATE INDEX IF NOT EXISTS idx_project_versions_project ON project_versions(project_id)',
        // FIX: partial index for reset-token lookups (sparse column, WHERE avoids indexing NULLs)
        'CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token) WHERE reset_token IS NOT NULL',
        // SECURITY FIX (C-13 / C-12): supporting indexes for the OAuth and
        // email-verification columns added above.
        'CREATE INDEX IF NOT EXISTS idx_users_oauth ON users(oauth_provider, oauth_subject) WHERE oauth_provider IS NOT NULL',
        'CREATE INDEX IF NOT EXISTS idx_users_email_verify_token ON users(email_verify_token) WHERE email_verify_token IS NOT NULL',
      ];
      for (const sql of indexes) {
        await db.query(sql).catch(() => {});
      }

      // SECURITY FIX (C-13): one user per (oauth_provider, oauth_subject) —
      // without this, upsertOAuthUser()'s "check by subject" fast path can
      // race under concurrent first-time OAuth logins from the same provider
      // account and create duplicate rows.
      await db.query(
        'ALTER TABLE users ADD CONSTRAINT uq_oauth_provider_subject UNIQUE (oauth_provider, oauth_subject)'
      ).catch(() => {}); // no-op if it already exists

      // SECURITY FIX (C-12): grandfather every account that existed BEFORE
      // email-verification was enforced, so upgrading an existing deployment
      // doesn't silently lock current users out of OAuth auto-linking
      // (upsertOAuthUser requires email_verified=true to link-by-email — see
      // routes/oauth.js). This must run ONLY ONCE — not on every restart, or
      // it would grandfather (and thus silently un-gate) every brand-new
      // unverified registration too, defeating the point of C-12 on every
      // subsequent deploy. Guarded by a row in schema_migrations (the same
      // table migrate.js uses) so it is safe to leave in autoMigrate()
      // permanently without re-running.
      await db.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version    VARCHAR(255) PRIMARY KEY,
          filename   TEXT NOT NULL,
          applied_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `).catch(() => {});
      const backfillMarker = 'auto_012_email_verified_backfill';
      const alreadyBackfilled = await db.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1', [backfillMarker]
      ).catch(() => ({ rows: [] }));
      if (!alreadyBackfilled.rows.length) {
        await db.query('UPDATE users SET email_verified = true WHERE email_verified = false')
          .catch((e) => logger.warn('C-12 one-time email_verified backfill failed:', e.message));
        await db.query(
          'INSERT INTO schema_migrations (version, filename) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [backfillMarker, '(autoMigrate one-time backfill, not a file)']
        ).catch(() => {});
      }

      // ── Phase 2-5 table auto-creation ──────────────────────────────────────
      const phase25Tables = [
        `CREATE TABLE IF NOT EXISTS policy_rules (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name        VARCHAR(255) NOT NULL,
          description TEXT,
          rego_source TEXT NOT NULL,
          severity    VARCHAR(20) DEFAULT 'HIGH',
          enabled     BOOLEAN DEFAULT true,
          blocks_plan BOOLEAN DEFAULT false,
          created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at  TIMESTAMP DEFAULT NOW(),
          updated_at  TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS change_requests (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
          version_id  UUID REFERENCES project_versions(id) ON DELETE CASCADE,
          author_id   UUID REFERENCES users(id) ON DELETE SET NULL,
          title       VARCHAR(255),
          description TEXT,
          status      VARCHAR(50) DEFAULT 'open',
          approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
          approved_at TIMESTAMP,
          rejected_by UUID REFERENCES users(id) ON DELETE SET NULL,
          rejected_at TIMESTAMP,
          reject_reason TEXT,
          merged_at   TIMESTAMP,
          created_at  TIMESTAMP DEFAULT NOW(),
          updated_at  TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS change_request_comments (
          id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          change_request_id UUID REFERENCES change_requests(id) ON DELETE CASCADE,
          author_id         UUID REFERENCES users(id) ON DELETE SET NULL,
          body              TEXT NOT NULL,
          created_at        TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS notifications (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type       VARCHAR(100) NOT NULL,
          title      VARCHAR(255) NOT NULL,
          body       TEXT,
          link       TEXT,
          actor_id   UUID REFERENCES users(id) ON DELETE SET NULL,
          read_at    TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS user_preferences (
          user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          notify_email         BOOLEAN DEFAULT true,
          notify_inapp         BOOLEAN DEFAULT true,
          webhook_url          TEXT,
          webhook_secret       TEXT,
          notify_plan_done     BOOLEAN DEFAULT true,
          notify_apply_done    BOOLEAN DEFAULT true,
          notify_cr_review     BOOLEAN DEFAULT true,
          notify_policy_fail   BOOLEAN DEFAULT true,
          updated_at           TIMESTAMP DEFAULT NOW()
        )`,
      ];
      for (const sql of phase25Tables) {
        await db.query(sql).catch(() => {});
      }

      // Phase 2-5 indexes
      const phase25Indexes = [
        'CREATE INDEX IF NOT EXISTS idx_cr_project ON change_requests(project_id, created_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_cr_author  ON change_requests(author_id)',
        'CREATE INDEX IF NOT EXISTS idx_cr_status  ON change_requests(status)',
        'CREATE INDEX IF NOT EXISTS idx_cr_comments ON change_request_comments(change_request_id, created_at)',
        'CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, created_at DESC) WHERE read_at IS NULL',
      ];
      for (const sql of phase25Indexes) {
        await db.query(sql).catch(() => {});
      }

      logger.info('✅ Auto-migration complete — all tables and columns verified');
    } catch (e) {
      logger.warn('Auto-migration warning:', e.message);
    }
  })();

  // BUG-STARTUP-RACE fix: block on autoMigrate() finishing before touching
  // any table it creates/alters. This call site is the third of the three
  // dependents described in the comment above — see there for the
  // reproduced fresh-database failure this prevents (this one showed up as
  // "Sanitize persisted HCL failed: relation ... does not exist").
  autoMigrateReady.then(async () => {
    try {
      await projectsRouter.ensureResourceColumns();
      await projectsRouter.ensureVersionColumns();
    } catch (e) {
      logger.warn('Post-migration column readiness check failed:', e.message);
    }
  });

  // sanitize any persisted HCL that may contain color/style fragments
  const { stripHtml } = require('./utils/sanitize');
  (async function sanitizePersistedHcl() {
    try {
      await autoMigrateReady; // BUG-STARTUP-RACE fix: wait for tables to exist first
      const db = require('./db/connection');
      // resources.hcl_output
      const r = await db.query("SELECT id, hcl_output FROM resources WHERE hcl_output IS NOT NULL AND (hcl_output LIKE '%<%' OR hcl_output LIKE '%color:%')");
      for (const row of r.rows) {
        try {
          const cleaned = stripHtml(row.hcl_output);
          if (cleaned !== row.hcl_output) {
            await db.query('UPDATE resources SET hcl_output = $1 WHERE id = $2', [cleaned, row.id]);
          }
        } catch (e) { logger.warn('Failed to sanitize resource', row.id, e.message); }
      }

      // project_versions.full_hcl
      const v = await db.query("SELECT id, full_hcl FROM project_versions WHERE full_hcl IS NOT NULL AND (full_hcl LIKE '%<%' OR full_hcl LIKE '%color:%')");
      for (const row of v.rows) {
        try {
          const cleaned = stripHtml(row.full_hcl);
          if (cleaned !== row.full_hcl) {
            await db.query('UPDATE project_versions SET full_hcl = $1 WHERE id = $2', [cleaned, row.id]);
          }
        } catch (e) { logger.warn('Failed to sanitize project_version', row.id, e.message); }
      }

      logger.info('✅ Sanitized persisted HCL fields (if any)');
    } catch (e) {
      logger.warn('Sanitize persisted HCL failed:', e.message);
    }
  })();
});

// OBSERVABILITY: flush pending trace spans and close the metrics server
// cleanly on shutdown. Containers are normally stopped with SIGTERM; an
// OpenTelemetry BatchSpanProcessor buffers spans in memory rather than
// sending them one at a time, so exiting abruptly can silently drop
// whatever hadn't been flushed yet — this ensures the last batch goes out.
async function gracefulShutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);
  try { await require('./observability/metrics').stopMetricsServer(); } catch (_) { /* best-effort */ }
  try { await require('./observability/tracing').shutdownTracing(); } catch (_) { /* best-effort */ }
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  // Force-exit if close() hangs (e.g. a stuck keep-alive/WebSocket connection)
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
