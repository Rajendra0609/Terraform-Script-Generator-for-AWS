# TFGen 0.0.4 — implementation plan and status

This document maps each requirement from the enhancement brief to what was built, what was verified, and what is still open. Statuses are deliberately conservative:

- **Done** — implemented and covered by automated tests, or verified against a running backend.
- **Partial** — the backend or configuration exists, but part of the requirement is open (usually the UI).
- **Not started** — not implemented in this release.

## Summary

| # | Requirement | Status | What exists now | Still open |
|---|---|---|---|---|
| 1 | Advanced, production-ready application features | Partial | Static security rules rewritten; module analyzer; code review with safe autofix; GitHub integration API; opt-in apply approval gate | Most new capabilities have no UI yet |
| 2 | Prometheus, Grafana, ELK, distributed tracing | Partial | Golden-signals dashboard (14 panels); six alert rules (promtool-valid); ELK compose stack and Logstash pipeline; OTLP tracing (existing) | ELK never run here (no Docker); Tempo documented but not wired |
| 3 | GitHub integration and automated code review | Partial | Encrypted token store; repo and PR listing; PR review (dry run by default, inline comments on diff lines); open a PR from a project | No UI; live PR creation and review posting not exercised against a real repository |
| 4 | Terraform module management | Partial | Inventory (inputs, outputs, resources, module calls, providers); dependency graph; Markdown docs and Mermaid output; existing registry browser | Creating, importing, versioning and scaffolding modules not built |
| 5 | Advanced Terraform analysis | Partial | Undeclared references; dependency cycles; unused inputs and locals; secrets in defaults; output leaks; unpinned providers and module sources; 5 auto-fix rules | Visual module explorer; cross-module resolution |
| 6 | Flow diagram improvements | Done | Four diagrams regenerated from the code (architecture, Terraform job flow, GitHub flow, observability); labels verified against the source | Interactive in-app explorer not built (SVG tooltips only) |
| 7 | Real-time infrastructure assistance | Partial | Static rules and module analysis run on demand through the API | Not wired into the Builder's live editing loop |
| 8 | Learning and educational features | Not started | Existing labs, interview practice and HCL explainer unchanged | No new content or exercises |
| 9 | Production readiness and security | Partial | Opt-in apply approval gate; error responses for caller mistakes; correlation IDs on every response; two dependency upgrades that close advisories; GitHub token encrypted at rest | Approval gate is off by default; runner default still prefers a host binary |
| 10 | Testing and bug fixing | Done | 200 unit tests, 35 API tests, 41 integration tests, all passing; see the fixes list below | Smoke, end-to-end (Playwright) and load suites not run in this release |
| 11 | CI/CD and automation | Partial | GitHub Actions workflow: backend tests on Postgres and Redis, frontend build with `CI=true`, Terraform fmt and validate, TFGen review gate, npm audit, Checkov, diagram and config validation | Workflow written and validated but not executed on GitHub; no deployment workflow |
| 12 | User experience and documentation | Partial | Builder panel tabs can be dragged to reorder (handlers attached; not yet tested in a browser); architecture and flow documents; this plan | No dark mode yet; module and GitHub panels not built |

## Bugs fixed in this release

Each item was reproduced before it was fixed.

**Build and test infrastructure**

- The unit suite crashed before running any test. Three causes: a standalone script (`templateEngine.test.js`) that called `process.exit`, a hoisted `jest.mock` that referenced `path` before initialisation, and ES-module sources Jest could not parse. All three are fixed; Jest now transforms the frontend modules through `tests/babel.config.js`.
- Three API tests and three integration tests were stale: they called routes that do not exist (`/terraform/checkov`, `/terraform/infracost`, `/projects/:id/hcl`), sent unauthenticated requests to endpoints that require authentication, or expected a bare array where the API returns a paginated envelope. They now match the real contract.
- The frontend production build failed under `CI=true` because of unused code and template-literal warnings. Dead code was removed, and the Terraform-text strings in `Studio.jsx` are documented as intentional.
- `frontend/package-lock.json` was out of sync with `package.json` (`npm ci` refused to run). Regenerated.

**Application**

- Static security rules reported a negative `passed` count (−47 in one probe). They also flagged compliant S3 buckets split into companion resources, reported port 8080 as HTTP port 80, and flagged SSH rules because of unrelated security groups. The rule engine is rewritten on a block-aware scanner.
- The backend depended on `uuid@14`, an ES-module-only package. It was replaced with `crypto.randomUUID()`, which removes the dependency.
- A busy `METRICS_PORT` crashed the whole API with an unhandled `error` event. It now logs and keeps serving.
- Malformed JSON and oversized bodies returned HTTP 500 with parser internals in the message. They now return 400 and 413. A disallowed CORS origin returns 403 instead of 500.
- Request correlation IDs were missing from responses that failed before the request logger ran (malformed JSON, rate-limit responses). The logger now runs first.
- Whitespace-only passwords were accepted. Email addresses longer than 254 characters were accepted.
- The Builder's tab drag-to-reorder handlers existed but were never attached to the tabs. They are now wired.

**Security dependencies**

- `proxy-addr` (critical): IP spoofing through IPv4-mapped IPv6 trust subnets. This matters because rate limits are keyed on the client IP. Fixed by upgrading to 2.0.8 (in-range).
- `nodemailer` (high): a bypass of `disableFileAccess` and an IDN allow-list bypass. Fixed by upgrading to 10.1.0, a major version. The app uses only `createTransport` and `sendMail`; the API suite passes after the change, but the mail path itself has no automated test.
- `express`, `body-parser` and `qs` received in-range patch upgrades.

## Recommended next features

These follow from the findings above. They are ordered by how much they reduce risk for a team adopting TFGen.

1. **Make the approval gate the default for production profiles.** The gate exists and is tested, but it is off by default. A production compose profile should set `APPLY_REQUIRES_APPROVAL=true` and the Builder should send `change_request_id`.
2. **Make the Docker sandbox the default runner in containers.** Today `auto` prefers a host Terraform binary, and the backend image ships one, so plan and apply run inside the backend container.
3. **Mount `NotificationCenter` and `GlobalSearch`.** Both components exist but nothing renders them. The Navbar imports were removed to satisfy lint; the components still need a home.
4. **Build the module and GitHub panels in the Builder.** The API is ready: analyze, review, autofix, PR review, and open-PR-from-project.
5. **Exercise the GitHub write path against a sandbox repository.** Create a branch, commit, open a PR and post a review, then add an integration test that records the flow.
6. **Add IAM wildcard and privilege-escalation rules.** The static rules do not yet check `Action = "*"` or `Resource = "*"` in IAM documents. The repository's own OIDC module passes the review because those patterns are not checked.
7. **Add a deployment workflow.** The CI workflow validates; it does not deploy. A tagged release could build and push the backend and frontend images.
8. **Add Tempo as a wired option** alongside Jaeger, if your team standardises on Grafana.

## What was verified and how

| Check | Result |
|---|---|
| Unit suite (`tests/`, Jest) | 14 suites, 200 tests passing |
| API suite (`tests/api`, against a live server, Postgres 16 and Redis 7) | 4 suites, 35 tests passing |
| Integration suite (`tests/integration`) | 4 suites, 41 tests passing |
| Live backend | Boots against Postgres and Redis; new routes mounted and enforcing auth; GitHub call reached `api.github.com` |
| Apply gate, live | Missing, unknown and malformed change requests refused with 403 before any credential is read. Self-approval and HCL-mismatch refusals are covered by unit tests only |
| Prometheus | `promtool check config` and `promtool check rules` pass; every metric name the dashboard and alerts use is exported by the running backend |
| Grafana dashboard | JSON parses; references the fixed datasource uid `prometheus` |
| Frontend production build (`CI=true npm run build`) | Passes after the lint fixes listed above |
| Diagrams | All four render with Graphviz; labels checked against the source |
| GitHub Actions workflow | YAML parses; every step is `uses:` or `run:`; not executed on GitHub |
| ELK stack | YAML parses; cross-file port matches; not executed (no Docker in the verification environment) |
| npm audit (production dependencies) | Zero vulnerabilities after the upgrades above |

Not run in this release: the Playwright end-to-end suite, the Jest smoke suite, the k6 load tests, the `terraform` binary (so `fmt` and `validate` in CI are unverified), and the Checkov action.
