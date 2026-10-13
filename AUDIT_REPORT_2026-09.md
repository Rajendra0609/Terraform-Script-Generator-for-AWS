# Terraform Script Generator for AWS — Audit Report

**Scope:** full-application review (backend, frontend, infra config), OAuth/SSO investigation, observability implementation, and UI/UX assessment.
**Method:** static reading of the full codebase plus live testing — the backend was actually run against a real PostgreSQL + Redis instance (including against a freshly created, empty database), hit with `curl` to observe real behavior, and the frontend was actually built with `npm run build` (both in normal mode and in strict `CI=true` mode) to catch things a read-through alone would miss. Findings below are marked accordingly; nothing is reported as fixed without having been re-verified after the fix.
**Note on the codebase's starting state:** this app already carries the marks of several serious security-hardening passes (see the many `SECURITY FIX`, `BUG-NNN`, `C-NN`/`M-NN`/`L-NN` comments throughout). That work holds up — see [What Was Already Solid](#what-was-already-solid-verified-not-just-read) — and this report does not re-litigate it. It focuses on what those passes missed and on the specific problems you flagged.

---

## Table of contents
1. [The OAuth "blocked redirect" bug — root cause, fix, and setup guide](#1-the-oauth-blocked-redirect-bug)
2. [Other bugs found and fixed](#2-other-bugs-found-and-fixed)
3. [Observability: metrics, logs, tracing](#3-observability-metrics-logs-tracing)
4. [UI/UX: findings and fixes](#4-uiux-findings-and-fixes)
5. [What was already solid (verified, not just read)](#5-what-was-already-solid-verified-not-just-read)
6. [Enhancement roadmap](#6-enhancement-roadmap)
7. [How to apply these changes](#7-how-to-apply-these-changes)
8. [Full list of changed/added files](#8-full-list-of-changedadded-files)

---

## 1. The OAuth "blocked redirect" bug

### Root cause
Two compounding gaps, both in configuration rather than in the OAuth logic itself:

**Gap A — the wrong URL is used as the OAuth callback base in the shipped Docker deployment.**
`backend/routes/oauth.js` builds the callback URL Google/GitHub redirect back to as:
```js
const GOOGLE_REDIRECT_URI = `${OAUTH_REDIRECT_BASE}/api/auth/oauth/google/callback`;
```
`OAUTH_REDIRECT_BASE` defaulted to `http://localhost:4000` — the backend's own address. That's correct **only** if the browser can reach the backend directly. But `docker-compose.yml` deliberately does **not** publish the backend's port 4000 to the host (a prior security fix — only nginx's port is published, and nginx proxies `/api/*` through internally). So in the shipped Docker topology, Google/GitHub would redirect the user's browser straight at a port nothing on the host machine is listening on — indistinguishable from a hang or a block.

**Gap B — the variables were never templated where Docker Compose actually reads them.**
`docker-compose.yml`'s backend service loads its environment from the **repo-root** `.env` (`env_file: - .env`), not from `backend/.env`. But `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `OAUTH_REDIRECT_BASE` only existed in `backend/.env.example` — the root `.env.example` never mentioned them. Anyone deploying via Docker Compose had no way to discover these variables existed at all.

### How this was confirmed (not guessed)
The backend was started for real against a live Postgres/Redis, and the actual HTTP response was inspected:
```
$ curl -sD - -o /dev/null http://localhost:4000/api/auth/oauth/google
Location: https://accounts.google.com/o/oauth2/v2/auth?...&redirect_uri=http%3A%2F%2Flocalhost%3A4000%2Fapi%2Fauth%2Foauth%2Fgoogle%2Fcallback&...
```
Confirmed the default produces a callback pointed at the unreachable port. After setting `OAUTH_REDIRECT_BASE=http://localhost:3000` (nginx's published port), the same request correctly produced `redirect_uri=http://localhost:3000/...`. CSP and CORS were also checked and ruled out as contributing causes — neither applies to a top-level browser redirect (they govern `fetch`/`XHR`, not full-page navigation).

### What was fixed
- **`backend/routes/oauth.js`** now logs the exact computed callback URL for each provider at startup, and prints an explicit warning when `OAUTH_REDIRECT_BASE`'s port doesn't match `FRONTEND_URL`'s port while running behind a proxy — so this fails loudly at boot instead of silently at sign-in time.
- **`.env.example` (root)** now documents `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`, and `OAUTH_REDIRECT_BASE`, with the exact callback URLs to paste into each provider's console.
- **`docker-compose.yml`** now passes these through explicitly, with `OAUTH_REDIRECT_BASE` defaulting to `http://localhost:${FRONTEND_PORT:-3000}` — correct out of the box, and self-correcting even against a `.env` file that predates this fix.
- **`backend/.env.example`**'s comment on `OAUTH_REDIRECT_BASE` was actively misleading ("where THIS backend lives") for anyone using Docker Compose — corrected to spell out both topologies.

### Provider console setup (do this next)
**Google Cloud Console** → [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials) → your OAuth 2.0 Client ID:
| Field | Value (local Docker Compose) | Value (real domain) |
|---|---|---|
| Authorized JavaScript origin | `http://localhost:3000` | `https://your-domain.com` |
| Authorized redirect URI | `http://localhost:3000/api/auth/oauth/google/callback` | `https://your-domain.com/api/auth/oauth/google/callback` |

**GitHub** → Settings → Developer settings → [OAuth Apps](https://github.com/settings/developers):
| Field | Value (local Docker Compose) | Value (real domain) |
|---|---|---|
| Homepage URL | `http://localhost:3000` | `https://your-domain.com` |
| Authorization callback URL | `http://localhost:3000/api/auth/oauth/github/callback` | `https://your-domain.com/api/auth/oauth/github/callback` |

Then set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` in your root `.env`. Deploying on a real domain? Update `FRONTEND_URL`, `CORS_ORIGIN`, and `OAUTH_REDIRECT_BASE` together, plus both provider consoles, to the same origin — all of these must match exactly (scheme, host, and port) or you'll get either the same blocked-redirect symptom (mismatch against what's actually published) or a provider-side `redirect_uri_mismatch` error (mismatch against the provider console).

---

## 2. Other bugs found and fixed

All of these were found by actually running the app, not only by reading it.

### 2.1 Fresh-database startup race condition
On a **completely fresh database** (dropped and recreated live to test this), the backend printed, on every clean boot:
```
[projects] ensureResourceColumns error: relation "resources" does not exist
[projects] ensureVersionColumns error: relation "project_versions" does not exist
```
`routes/projects.js` runs its own column-migration check at module-load time — which happens *before* `server.js`'s own table-creation migration (`autoMigrate()`) has run, since that only kicks off once the HTTP server starts listening. A third place, `sanitizePersistedHcl()` in `server.js`, had the identical race against the same tables.

This is self-healing in practice (the same functions retry on the first real request, and a real client is almost always slower to arrive than migration is to finish), which is presumably why it shipped unnoticed — but it's a genuine race, not guaranteed, and it printed a false-positive error on every single clean install.

**Fix:** `autoMigrate()`'s completion is now an explicit promise that both dependents (`ensureResourceColumns`/`ensureVersionColumns`, and `sanitizePersistedHcl`) await, plus a quiet `to_regclass` existence check so an expected "too early" condition no longer logs as an error. **Re-verified against a freshly dropped-and-recreated database** — the errors are gone.

### 2.2 A missed instance of an already-fixed anti-pattern
Every other per-request `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `routes/projects.js` had already been fixed (see the file's own `BUG-019`/`M-03` comments) to run once at startup instead of on every request, because it takes an `ACCESS EXCLUSIVE` lock that blocks concurrent reads/writes to the whole table — except one: `last_hcl`, which was still running inside the transaction on **every single** `POST /:id/resources` call (i.e., every save). Moved to the same startup migration as everything else.

### 2.3 `GlobalSearch.jsx` — duplicate object key
Caught by running `npm run build` (which flags this as `no-dupe-keys`): the "Esc" button's inline style set `border` twice — `border: 'none'` and, a few properties later, `border: '1px solid #E5E7EB'`. In JavaScript the second silently wins, so the first was dead code. Removed the dead one; the rendered button is unchanged (it already had a visible border, since that was the value that was actually taking effect).

### 2.4 OAuth buttons briefly untabbable during every login submission
`pages/Login.jsx`'s Google/GitHub buttons set `href={undefined}` while `disabled` — which is `true` for the whole duration of *every* email/password login submission, not a rare edge case. An `<a>` with no `href` drops out of the tab order and isn't announced as a link, so a keyboard or screen-reader user tabbing through the page mid-submit would lose track of these controls. Fixed to follow the standard WAI-ARIA pattern for a disabled link: keep a real `href`, add `aria-disabled`, remove it from the tab order with `tabIndex={-1}`, and swallow the click — rather than removing `href` outright. Confirmed via `npm run build` that this was flagged as a real `jsx-a11y` violation and is now clean.

### 2.5 (Checked and ruled out) `Studio.jsx`'s "template string in a regular string" warnings
`npm run build` also flags eight lines in `Studio.jsx` for `no-template-curly-in-string` (a `${...}` inside a non-backtick string). Investigated each: these are Terraform HCL snippets (e.g. `'  name = "${var.project_name}-sg"'`) deliberately stored as plain JS strings so the literal `${var.project_name}` text is preserved for the user's generated Terraform code — not a mistake. **This is not a bug**; flagging it here mainly so it isn't rediscovered and "fixed" into an actual bug later. One instance already carries an `eslint-disable-next-line` comment; for hygiene, consider adding the same to the other seven so a genuinely accidental future occurrence doesn't get lost in matching noise.

### 2.6 Dangling documentation reference
Several `.env.example` comments point to `CHANGELOG_SECURITY_AUDIT_FIXES.md` (e.g. for the WebSocket LSP session caps). That file doesn't exist anywhere in the repo. Either it was dropped at some point or never committed — worth restoring or removing the references.

---

## 3. Observability: metrics, logs, tracing

Before this change, the only logging in the app was unstructured, timestamp-less `console`-style output via `winston`, and the only "metrics" were `routes/admin.js`'s signup/project counts read from Postgres for the in-app admin dashboard — a product-analytics view, not ops observability. There was no tracing and no per-request correlation of any kind. This also happens to be exactly why the OAuth bug above was invisible in production logs: `GET /api/auth/oauth/google` is anonymous and non-mutating, so nothing about it was ever logged outside of dev mode. This section closes a gap already named (but not implemented) in `docs/PRODUCT_ROADMAP.md`'s own Non-Functional Requirements table.

### Logs
- `winston`'s format now includes `timestamp()` and `errors({ stack: true })` (previously neither existed — every line looked like `{"level":"info","message":"..."}` with no indication of when it happened).
- **New:** `backend/middleware/requestLogger.js` — a structured, always-on access log for *every* request (not just authenticated/mutating ones, which is all the existing audit log covers). Each line carries a correlation ID, method, full path (query strings are deliberately excluded — several routes, like password reset, accept tokens as query params, and those must never end up in logs), status code, duration, and the caller's user ID when authenticated. The correlation ID honors an incoming `X-Correlation-Id`/`X-Request-Id` header and is echoed back on the response and in error/404 JSON bodies, so a user or support ticket can quote one ID that an engineer can grep for directly.
- The global error handler and 404 handler now include `correlationId` in both the log line and the JSON response.

### Metrics
**New:** `backend/observability/metrics.js`, via `prom-client`. Default Node.js process metrics (CPU, memory, event-loop lag, GC), plus:
- `http_request_duration_seconds` / `http_requests_total` — labeled by method, **route pattern** (e.g. `/api/projects/:id`, not the raw URL — using the raw URL would create one time series per distinct ID ever requested, the classic way to blow up a Prometheus server's memory), and status code.
- `terraform_job_duration_seconds` / `terraform_jobs_total` — wired into `services/terraformJobs.js`'s single dispatch choke-point, so fmt/validate/plan/apply are covered automatically across both the BullMQ-worker path and the no-Redis synchronous fallback.
- `websocket_active_connections` — wired into both the `/ws/jobs` and `/ws/lsp` handlers.

Served on its **own internal-only port** (`METRICS_PORT`, default `9464`) rather than as a route on the main app. `nginx.conf` proxies everything under `/api/` through to the backend, and nginx's port is the only thing published to the host — a metrics route on the main app would be reachable by anyone on the public internet with no auth in front of it. The dedicated port is not published by `docker-compose.yml` and not proxied by nginx; only other containers on the same compose network (e.g. the optional Prometheus service below) can reach it.

### Distributed tracing
**New:** `backend/observability/tracing.js`, via OpenTelemetry — auto-instrumentation for `http`, `express`, `pg`, and `ioredis`. **Opt-in** (`OTEL_ENABLED=true`) since no collector ships by default. Required as the literal first line of `server.js`, before anything else — OpenTelemetry's auto-instrumentation works by patching modules the first time they're `require()`'d, so it has to run before `express`/`pg`/`ioredis` are loaded anywhere in the process.

**Verified this fails gracefully:** booted the app with `OTEL_ENABLED=true` pointed at a collector address with nothing listening, and confirmed the app served requests normally with no crash and no uncaught exception (OpenTelemetry's exporter drops spans and logs a warning in this situation by design; it doesn't throw into application code).

### Optional local stack
**New:** `docker-compose.observability.yml` — Prometheus + Jaeger (single-container "all-in-one," suitable for dev/demo; a real production Jaeger deployment uses separate collector/query/storage components) + Grafana, with Prometheus auto-provisioned as a Grafana datasource. Entirely opt-in; the base `docker-compose.yml` is unaffected. To use it:
```
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```
Then set `OTEL_ENABLED=true` in `.env` and restart the backend. UIs: Prometheus `http://localhost:9090`, Jaeger `http://localhost:16686`, Grafana `http://localhost:3001`.

**Note:** `prom-client` (used above) prints its own deprecation notice pointing at a successor package, `@prometheus-io/client`. That package is still pre-1.0 as of this writing, with no API stability guarantee yet, whereas `prom-client` is the long-established, extremely widely deployed implementation. Shipping a brand-new 0.x package for the very first production observability pass would trade a cosmetic warning for real stability risk — used `prom-client` for now; worth revisiting once the successor reaches a stable 1.x.

---

## 4. UI/UX: findings and fixes

### What was fixed
- **Responsive navigation.** Confirmed via grep that, out of 44 frontend components, exactly one (`Login.jsx`) had any responsive/mobile handling at all — `index.css` sets `overflow: hidden` on the whole app shell with no fallback, so on a narrow viewport, clipped content was simply unreachable. `components/Navbar.jsx` now collapses into a hamburger menu below 860px, consolidating the nav links, AWS connection status, registry link, and account actions into one panel. Implemented as a fully separate render branch (rather than threading conditionals through the existing desktop JSX) specifically so the working desktop layout has no way to regress. Verified with `eslint` (zero new errors/warnings) and a full `npm run build`.

### Found, but deliberately not attempted in this pass — with reasoning
These are real, verified findings, but fixing them properly is a substantially larger effort than a scoped audit-and-fix pass should absorb without dedicated review, so they're documented rather than rushed:

- **Dark mode is a non-functional placeholder.** `contexts/ThemeContext.jsx` hardcodes light mode — `toggle` is a no-op and `isDark` is always `false` — and there is no `[data-theme="dark"]` block anywhere in `index.css`. Building this out isn't just a CSS flip: a scan of `Builder.jsx` alone turned up extensive hardcoded hex colors in inline styles (`'#111827'`, `'#6B7280'`, etc.) that bypass the existing CSS custom-property system entirely, across 17,000+ lines of frontend code. Properly supporting dark mode means auditing and migrating all of that to theme tokens — a project in its own right, not a safe same-session patch alongside everything else here.
- **`Builder.jsx`'s core layout is fixed-width and desktop-only.** A hardcoded `width: 360, minWidth: 360` sidebar plus a `minWidth: 260, maxWidth: 560` center panel mean the single most important screen in the product cannot fit a phone-width viewport at all (360px alone approaches the full width of a typical phone screen) — and again, there's no scroll fallback given the app-wide `overflow: hidden`. Recommend either a dedicated compact/stacked layout for narrow viewports, or an explicit "this view works best on a larger screen" state, scoped and tested on its own.
- **Accessibility coverage is thin.** Only 5 of 44 components use any `aria-*` attribute at all. The two concrete a11y bugs this pass actually found (§2.4 and the anchor issue) are fixed; a fuller pass (focus management in modals/dropdowns, keyboard navigation in `ResourceGraph.jsx`'s canvas-like interactions, color contrast) would need dedicated time.

---

## 5. What was already solid (verified, not just read)

So effort isn't wasted re-litigating what already works: this codebase has clearly been through multiple genuine security-hardening rounds, and a representative sample was actually exercised rather than trusted at face value:
- `utils/ssrfGuard.js`'s DNS-pinning SSRF protection is applied consistently in **both** the webhook "test" endpoint and the real webhook-delivery path (`utils/webhookDelivery.js`), including re-validating on every retry attempt — closing the DNS-rebinding gap that a one-time check would leave open.
- Router-level auth (`authMiddleware`, `requireRole('admin')`) was checked across every route file, not assumed from a sample — all correctly wired.
- Credential handling (`routes/aws.js`) never returns a secret access key, correctly masks the access key ID, and secrets never enter BullMQ job payloads or Redis.
- The Terraform execution pipeline (`routes/terraform.js`, `terraform/runner.js`) has extensive, correctly-applied sandboxing already in place (see that file's own security-fix history).
- The full production frontend build (`npm run build`, matching what `frontend/Dockerfile` actually runs) succeeds cleanly, both before and after this pass's changes.

---

## 6. Enhancement roadmap

`docs/PRODUCT_ROADMAP.md` already tracks a substantial, well-organized set of planned work — this isn't duplicated here. Two items already listed there as "Quick Wins" were checked and confirmed still open, worth calling out since they're already scoped and estimated: **QW-05** (a Monaco diff view in `History.jsx` — currently no diff UI exists between versions) and **QW-09** (invoking `terraform-docs` on export). New recommendations that emerged specifically from this pass:

- **Surface the new correlation ID in the UI.** When the global error handler returns `correlationId`, a small "Error ID: xxxx — include this if you contact support" affordance in the frontend's error states would let support map a user's report straight to a log line/trace, with zero guesswork.
- **Grafana dashboards.** The observability add-on wires the datasource but ships no pre-built dashboards — a first "golden signals" dashboard (request rate/latency/error rate, terraform job outcomes, queue depth) over the new metrics would make the stack immediately useful rather than requiring hand-built panels.
- **A `/healthz`-style readiness check that reflects migration state**, now that `autoMigrate()` has an explicit completion promise (§2.1) — an orchestrator could hold traffic until it resolves, rather than relying on the self-healing retry.
- **Revisit `prom-client` → `@prometheus-io/client`** once the latter reaches a stable 1.x (see §3).

---

## 7. How to apply these changes

1. Unzip the delivered archive over your working copy (or diff it against your current tree — every changed file is listed in §8 below).
2. Copy `.env.example` → `.env` at the repo root, and fill in `GOOGLE_CLIENT_ID`/`SECRET`, `GITHUB_CLIENT_ID`/`SECRET` per §1. If you already have a root `.env`, diff it against the new `.env.example` — it now documents variables (OAuth + observability) that a pre-existing `.env` won't have.
3. `docker compose up --build` as usual. Watch the backend's boot log for the new `[oauth] ... callback URL ...` lines and confirm they match what you registered with each provider.
4. Optional: bring up `docker-compose.observability.yml` alongside it (§3) if you want metrics/tracing dashboards running locally.
5. No database migration steps are needed beyond restarting the backend — `last_hcl` (§2.2) is picked up automatically by the existing auto-migration on next boot.

---

## 8. Full list of changed/added files

**Modified:**
- `.env.example` — OAuth vars, `ADMIN_BOOTSTRAP_TOKEN`, observability vars
- `backend/.env.example` — corrected `OAUTH_REDIRECT_BASE` guidance, observability vars
- `docker-compose.yml` — OAuth/observability env passthrough with corrected defaults
- `backend/server.js` — logger format, tracing bootstrap, metrics/request-logger middleware, startup-race fix, `last_hcl` migration, graceful shutdown, WebSocket connection gauges
- `backend/routes/oauth.js` — documentation + startup diagnostic logging
- `backend/routes/projects.js` — startup-race fix, removed per-request `last_hcl` migration
- `backend/services/terraformJobs.js` — job metrics
- `backend/package.json` / `package-lock.json` — new observability dependencies
- `frontend/src/components/Navbar.jsx` — responsive mobile menu
- `frontend/src/components/GlobalSearch.jsx` — duplicate-key fix
- `frontend/src/pages/Login.jsx` — OAuth button accessibility fix

**New:**
- `backend/observability/tracing.js`
- `backend/observability/metrics.js`
- `backend/middleware/requestLogger.js`
- `docker-compose.observability.yml`
- `observability/prometheus.yml`
- `observability/grafana-datasource.yml`
- This report (`AUDIT_REPORT_2026-09.md`)
