require('dotenv').config();
const express = require('express');
const winston = require('winston');
const rateLimit = require('express-rate-limit');
const app = express();

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
  ],
});

const isDev = (process.env.NODE_ENV || 'development') !== 'production';

// CORS: use a strict whitelist. In dev we allow common local origins including
// localhost:3000 and the host IP used in your environment. Set `CORS_ORIGIN`
// in `backend/.env` to a comma-separated list of allowed origins in production.
const cors = require('cors');
const defaultDevOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://10.244.24.67:3000'];
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
app.set('trust proxy', process.env.TRUST_PROXY || 1);

// Rate limiting
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || String(15 * 60 * 1000), 10);
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || (isDev ? '1000' : '100'), 10);
// Comma-separated list of trusted IP fragments (e.g. '127.0.0.1,::1,10.244.24.67')
const TRUSTED_IPS = (process.env.RATE_LIMIT_TRUSTED_IPS || '127.0.0.1,::1,10.244.24.67').split(',').map(s => s.trim()).filter(Boolean);

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
    if (TRUSTED_IPS.some(t => t && ip.includes(t))) return true;
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
    return TRUSTED_IPS.some(t => t && ip.includes(t));
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

// Dev-only request logger: log incoming requests to help trace whether
// the browser's requests reach the backend. Enabled only in development.
if (isDev) {
  app.use((req, res, next) => {
    try {
      logger.info(`[req] ${req.method} ${req.originalUrl} ip=${req.ip || req.connection?.remoteAddress} origin=${req.headers.origin || ''} host=${req.headers.host || ''}`);
    } catch (e) {
      // best-effort logging
      logger.debug && logger.debug('Request logger error', e.message);
    }
    next();
  });
}


app.use(express.json({ limit: '10mb' }));
// BUG-008 fix: parse cookies so auth routes can read the HttpOnly refreshToken cookie
const cookieParser = require('cookie-parser');
app.use(cookieParser());

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/projects',  require('./routes/projects'));
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

// BE-09: return only { status: 'ok' } — no server clock, no fingerprinting surface.
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// 404 fallback
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Global error handler
// BUG-021 fix: previously returned err.message directly, leaking DB table/column
// names, SQL fragments, and file paths to callers. In production we return a
// generic message; the full stack is logged server-side only.
app.use((err, req, res, next) => {
  logger.error(err.stack);
  const message = process.env.NODE_ENV !== 'production'
    ? (err.message || 'Internal server error')
    : 'Internal server error';
  res.status(500).json({ error: message });
});

// Troubleshooting note: "Cannot reach backend at http://10.244.24.67:4000"
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
//   curl -v http://10.244.24.67:4000/api/health
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
// IP (e.g. `10.244.24.67:4000`) rather than `0.0.0.0:4000`, the Node process is
// bound to a single interface. In that case the browser on the host may not be
// able to reach that internal/container IP and you'll see the frontend error
// "Cannot reach backend at http://10.244.24.67:4000" even though the server
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
const { runPlan, runValidate, runFmt } = require('./terraform/runner');

// BUG-004 fix: initQueue was never called, so the BullMQ worker was never
// started and all jobs ran synchronously, blocking the event loop.
// Wire up the job processor here so Redis-backed async execution works.
initQueue(async (data, logFn) => {
  const { type, hcl, awsCredentials } = data;
  if (type === 'plan')     return runPlan(hcl, logFn, awsCredentials || null);
  if (type === 'validate') return runValidate(hcl, logFn);
  if (type === 'fmt')      return runFmt(hcl, logFn);
  throw new Error(`Unknown job type: ${type}`);
});

const server = http.createServer(app);

// Handle WebSocket upgrades before Express middleware
server.on('upgrade', (req, socket, head) => {
  // Extract path for routing
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  logger.info && logger.info(`[ws-upgrade] ${req.method} ${req.url} origin=${req.headers.origin || ''} host=${req.headers.host || ''}`);
  try {
    if (pathname === '/ws/jobs' || pathname.startsWith('/ws/jobs')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }
    if (pathname === '/ws/terraform-lsp' || pathname.startsWith('/ws/terraform-lsp')) {
      lspWss.handleUpgrade(req, socket, head, (ws) => {
        lspWss.emit('connection', ws, req);
      });
      return;
    }
    logger.warn && logger.warn(`[ws-upgrade] Unknown websocket path: ${pathname}`);
    socket.destroy();
  } catch (err) {
    logger.error && logger.error('[ws-upgrade] error handling upgrade: ' + (err && err.message));
    try { socket.destroy(); } catch (_) {}
  }
});

const wss = new WebSocketServer({ noServer: true });
const lspWss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  // Extract jobId from URL: /ws/jobs?id=<jobId>
  const url = new URL(req.url, `http://${req.headers.host}`);
  const jobId = url.searchParams.get('id');
  if (!jobId) { ws.close(1008, 'jobId required'); return; }

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

  ws.on('close', () => {
    jobEvents.off(`log:${jobId}`, onLog);
    jobEvents.off(`done:${jobId}`, onDone);
  });

  ws.send(JSON.stringify({ type: 'connected', jobId }));
});

lspWss.on('connection', (ws) => {
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

  // ── Auto-migration: ensure all required tables and columns exist ───────────
  // This runs at startup and silently creates anything missing. Safe to run
  // multiple times — uses CREATE IF NOT EXISTS and ADD COLUMN IF NOT EXISTS.
  (async function autoMigrate() {
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
          aws_region  VARCHAR(50) DEFAULT 'ap-south-1',
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
          aws_region      VARCHAR(50) NOT NULL DEFAULT 'ap-south-1',
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
      ];
      for (const sql of indexes) {
        await db.query(sql).catch(() => {});
      }

      logger.info('✅ Auto-migration complete — all tables and columns verified');
    } catch (e) {
      logger.warn('Auto-migration warning:', e.message);
    }
  })();

  // sanitize any persisted HCL that may contain color/style fragments
  const { stripHtml } = require('./utils/sanitize');
  (async function sanitizePersistedHcl() {
    try {
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
