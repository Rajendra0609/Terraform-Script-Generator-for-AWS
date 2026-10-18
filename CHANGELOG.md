# Changelog

## 0.0.4

### Added

- **Module analyzer** (`backend/services/moduleAnalyzer.js`, `POST /api/modules/analyze`, `/docs`): inventory of inputs, outputs, locals, resources, data sources, module calls and providers; dependency graph with cycle detection; issues for undeclared references, unused inputs, secrets in defaults, output leaks, unpinned providers and module sources; Markdown reference and Mermaid output.
- **Automated code review** (`backend/services/codeReview.js`, `POST /api/modules/review`, `/autofix`): combines static security rules and module analysis into a verdict (`request_changes`, `comment` or `approve`); applies safe, deterministic auto-fixes for five rules and skips any fix that would overwrite an expression.
- **GitHub integration** (`backend/services/githubClient.js`, `githubStore.js`, `backend/routes/github.js`): connect with a personal access token (stored encrypted); list repositories and pull requests; review a pull request (dry run by default, inline comments on diff lines, `post: true` to submit); open a pull request from a project's HCL, with the review included in the PR body.
- **Apply approval gate** (`backend/services/applyApproval.js`), opt-in with `APPLY_REQUIRES_APPROVAL=true`.
- **Tab drag-to-reorder** in the Builder's panel tabs (the handlers existed; they are now attached).
- **Observability**: Grafana golden-signals dashboard (14 panels) with a fixed datasource uid; Prometheus alert rules (6); optional ELK stack (`docker-compose.elk.yml`, Filebeat and Logstash configuration).
- **CI** (`.github/workflows/ci.yml`): backend tests against Postgres and Redis, frontend production build, Terraform format and validate, TFGen review gate, npm audit, Checkov, diagram and configuration validation.
- **Command-line review** (`scripts/terraform-review.js`) for local use and CI, with `--fail-on` and `--markdown` options.
- **Documentation**: `docs/IMPLEMENTATION_PLAN.md`, `docs/ARCHITECTURE.md`, four Graphviz diagram sources with rendered images.

### Changed

- **Static security rules** are rewritten on a block-aware HCL scanner (`hclScan.js`, `staticSecurityRules.js`). `passed` can no longer go negative. S3 checks accept the companion resources that current AWS provider documentation recommends. ALB port matching is exact, and a port-80 listener that only redirects to HTTPS is compliant. Security-group rules are evaluated per rule.
- **Request logging** runs before rate limiting and body parsing, so every response carries a correlation ID.
- **Caller errors** return 400 (malformed JSON), 413 (oversized body) and 403 (disallowed origin) instead of 500.
- **Grafana datasource** has a fixed uid (`prometheus`) so dashboards can reference it.

### Fixed

- Unit suite crashed before running any test (`process.exit` in a standalone script; a hoisted `jest.mock` referencing an uninitialised variable; ES-module sources that Jest could not parse).
- Static security rules reported impossible `passed` counts, flagged compliant S3 configurations, matched port 8080 as port 80, and produced cross-resource false positives in security groups.
- The backend depended on the ES-module-only `uuid` package; replaced with `crypto.randomUUID()`.
- A busy `METRICS_PORT` crashed the API process.
- Whitespace-only passwords were accepted; email addresses over 254 characters were accepted.
- Stale tests for routes and response shapes that no longer exist (API and integration suites).
- `frontend/package-lock.json` was out of sync with `package.json`; `npm ci` failed.
- The frontend build failed under `CI=true` because of unused code and template-literal lint warnings.

### Security

- `proxy-addr` upgraded to 2.0.8: closes a critical IP-spoofing advisory that affected IP-keyed rate limits.
- `nodemailer` upgraded to 10.1.0: closes a high-severity advisory (file-access and domain allow-list bypasses). This is a major version; the app uses only `createTransport` and `sendMail`.
- `express`, `body-parser` and `qs` patch-level upgrades.

### Known issues

- **Approval gate is off by default** and the Builder does not yet send `change_request_id`.
- **Runner default** (`auto`) prefers a host Terraform binary, which the backend image includes.
- **`NotificationCenter` and `GlobalSearch`** exist but are not mounted anywhere in the UI.
- **Module and GitHub panels** are not in the UI; the API is complete.
- **Not verified in this release:** the ELK stack, the GitHub Actions workflow on GitHub, the Playwright end-to-end suite, the smoke and load suites, and Terraform `fmt`/`validate` in CI.
- **IAM wildcard rules** (`Action = "*"`, `Resource = "*"`) are not yet checked.

## 0.0.3

Baseline for this release (the branch `dev_v0.0.3` as uploaded).
