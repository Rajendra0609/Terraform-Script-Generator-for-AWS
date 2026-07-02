# Audit + Fix Session — `tfgen_phases2_5_final`

Acting as senior dev, with the original issue list as the test plan. Every
item below was checked against the actual code (not just re-read from the
doc) before being marked done, partial, or fixed.

## TL;DR

Most of the 12 issues in the original doc were **already resolved** in this
build — the doc describes an earlier state of the product. I verified each
one against the code and found **6 real, concrete gaps**, which are now
fixed. Everything below is evidence-based: file names and line-level
behavior, not assumptions.

---

## Already working (verified, not touched)

| Issue | Verified by |
|---|---|
| No Terraform apply from UI | `ApplyStatusPanel.jsx` + WebSocket log streaming + confirm dialog, wired to `jobQueue.js`/`execution_jobs` via `dispatchAndPersist` |
| Synchronous terraform runs blocking requests | `/plan` and `/apply` in `terraform.js` enqueue through the async job queue, not inline |
| Policy-as-code UI absent | `AdminPanel.jsx` → Policies tab (full CRUD, Rego editor, seed templates) |
| Policy enforcement not wired | `terraformJobs.js::planJob` calls `evaluateAllPolicies`; a `blocks_plan` violation returns `blocked:true` and the plan never runs |
| Admin panel is a stub | `AdminPanel.jsx` has Metrics / Users (role mgmt) / Projects / Policies tabs — not a stub |
| No OAuth/SSO | `routes/oauth.js` (GitHub + Google, Passport strategies) + buttons in `Login.jsx` |
| HCL explainer is a static dictionary | `routes/hcl-explain.js` calls the Anthropic API for arbitrary HCL, dictionary is fallback-only |
| No global search | `routes/search.js` (Postgres `tsvector`/GIN) + `GlobalSearch.jsx` wired into `Navbar.jsx` |
| PR-style change request review | `ChangeRequestPanel.jsx`, wired into Builder, backed by `routes/change-requests.js` (diff, Checkov delta, approve/reject) |
| AWS credentials stored server-side | Real AES-256-GCM (`awsCrypto.js`), fails fast without a key — a legitimate pattern, not a bug (OIDC module exists as a scaffold but isn't wired as an alternative — noted below as a future item, not a defect) |
| Ad-hoc migrations | `migrate.js` is a real sequential runner with a `schema_migrations` table, transactional, idempotent |

## Real gaps found — now fixed

### 1. Team collaboration UI didn't exist at all
The backend (`invite`/`getMembers`/`removeMember` in `routes/projects.js`) was
fully built, but **no frontend component ever called it** — not even a
button. Worse: a pending invitee had no way to discover the invite existed
(their project didn't show in `GET /api/projects`, and `GET /:id/members`
403'd them because it required `accepted_at IS NOT NULL`).

**Fixed:**
- New `frontend/src/pages/Team.jsx` — pending invitations (accept/decline),
  member list, invite form (owner/admin), remove/leave.
- New `GET /api/projects/invitations/pending` — lets an invitee see invites
  addressed to them (previously impossible).
- `DELETE /:id/members/:userId` now allows self-removal without going
  through `authoriseProject` — needed so a pending invitee can decline, and
  any member can leave.
- Invite now creates an in-app notification (`member.invited`) — previously
  the invite row was inserted with **zero signal** to the invitee.
- Entry points added: Navbar link (badge shows pending-invite count),
  Dashboard project-card button, Builder toolbar item.

### 2. Region hardcoded to `ap-south-1` in ~15 more places than the earlier fix caught
`backend/config/region.js` already centralized a `DEFAULT_AWS_REGION`, but
it was only wired into 3 backend files. Six more frontend files and 3
backend generator functions still had their own local `'ap-south-1'`
literals:
- Backend: `routes/envconfig.js` (3 defaults), `routes/registry.js` (VPC
  module AZ scaffold).
- Frontend: `store/useStore.js`, `pages/Dashboard.jsx`, `pages/Studio.jsx`,
  `engine/templateEngine.js` (×3), `components/AwsCredentialsModal.jsx`,
  `components/MultiEnvPanel.jsx`, `components/ConfigPanel.jsx` (×3),
  `components/BackendGenerator.jsx`, `components/TerragruntPanel.jsx`,
  `components/MultiResourcePanel.jsx` (×2).
- **A real correctness bug**, not just cosmetic: `PresetsPanel.jsx`'s
  "VPC — public/private, 2 AZ" preset hardcoded
  `availability_zone: 'ap-south-1a'/'ap-south-1b'` into generated resources
  regardless of the project's actual region — applying that preset outside
  `ap-south-1` would emit an AZ that doesn't exist in the target region.
  Fixed in `Builder.jsx::handleApplyPreset`: the AZ suffix is now rewritten
  against the project's actual region.
- `backend/.env.example` itself set `DEFAULT_AWS_REGION=ap-south-1`, which
  would silently re-introduce the bias on any fresh deploy that copies the
  example file — changed to `us-east-1`.
- All of the above now import a single constant
  (`frontend/src/utils/awsRegions.js::DEFAULT_AWS_REGION`, sourced from
  `REACT_APP_DEFAULT_AWS_REGION`) mirroring the backend's `config/region.js`.

### 3. Dashboard project list had no real pagination
The backend `GET /api/projects` already supported `limit/offset/search/sort`
with a `total`/`has_more` response — but `Dashboard.jsx` called
`projectsAPI.list()` with **no params**, so it silently got only the
server's default 50 most-recent projects, with search filtering only
*within* that same 50. At 1000+ projects (the exact scale called out in the
original review) most projects were simply unreachable.

**Fixed:** Dashboard now sends `limit/offset/search` to the server, shows
accurate `total`, and has Prev/Next controls.

### 4. No audit log viewer anywhere in the UI
`GET /api/audit` (admin-only, filters + pagination) had no frontend caller
at all.

**Fixed:** New "Audit Log" tab in `AdminPanel.jsx` — action/date filters,
paginated table.

### 5. Notifications: email side was essentially empty
`services/mailer.js` only ever sent password-reset emails. The product doc
asked for email on Checkov critical findings and on change-request
submission — neither existed. In-app notifications for change requests did
already exist and work correctly (`change_request.created/approved/rejected`).

**Fixed:**
- `mailer.js`: added `sendCheckovCriticalAlert` and
  `sendChangeRequestSubmitted` (reuses the existing branded email template).
- New `services/notify.js`: extracted the project-wide notify fan-out (was a
  private copy inside `change-requests.js`) so any job type can reuse it
  with the same audited logic. In-app notification is always the source of
  truth; email is fire-and-forget and never blocks the caller.
- Wired: change-request creation now emails the team; a Checkov-critical
  block in `terraformJobs.js::planJob` now notifies + emails; **apply job
  completion** (success/fail) now notifies the team too — added this
  because apply can run 5–15 minutes, long enough that whoever's watching
  the live log may well have navigated away before it finishes.

### 6. Dead file
`frontend/src/components/ResourceG` — a 0-byte stray file (not
`ResourceGraph.jsx`, which is fine and unaffected) — removed.

---

## Not touched — flagged, not fixed (scope/judgment calls)

- **OIDC/federated IAM as an alternative to stored encrypted keys.** The
  roadmap doc frames this as "a better pattern," not a defect — the current
  AES-256-GCM storage is legitimate. There's already a Terraform module
  scaffold at `terraform/oidc_federation/`, but wiring it into the actual
  apply flow as a selectable auth mode is a genuinely separate feature
  (new credential type, UI, and job-runner changes), not a bug fix. Flagging
  for a follow-up pass if you want it.
- Region **selection lists** (dropdown *options*, e.g. in `BackendGenerator.jsx`)
  still list `ap-south-1` first in a couple of places — left as-is since
  it's a user-chosen option, not a silent default; only the *defaults* were
  in scope for this pass.

---

## Session 2 additions — AI code assistant in Studio + discoverability

### New: AI can now *write/update* code, not just explain it
The AI explainer (`/api/hcl-explain`) only ever explains existing HCL. There
was no way to ask AI to *generate or modify* code — the roadmap's
"AI-powered HCL generation" item was genuinely unbuilt, unlike most of the
other roadmap items which turned out to already exist.

- New `backend/routes/hcl-assist.js` (`POST /api/hcl-assist`): takes a
  plain-English instruction + the active file's content + the other open
  files as context, calls Claude, and returns the complete updated file
  content plus a short summary. No offline fallback (returns a clear 503
  without `ANTHROPIC_API_KEY` — a static dictionary can't generate arbitrary
  code the way it can explain known resource types).
- New **✨ AI Assistant** panel in Studio's activity bar (left icon strip,
  same place as Explorer/Outline/Module Explorer) and in the command palette
  (Cmd/Ctrl+Shift+P → "AI: Write / Update Code"). Type an instruction (e.g.
  *"add an S3 bucket with versioning and encryption enabled"*), the AI
  proposes a full replacement for the file you're editing, and you get an
  explicit **Apply to Editor** / **Discard** choice — nothing overwrites
  your code silently.

### Discoverability fixes
Both AI features existed but weren't obviously flagged as AI before you
opened them:
- Builder's **Learn** tab now shows a small "✨ AI" badge inline in the tab
  itself, so it's visible before you click in — not just once you're already
  looking at the panel.
- Studio's new AI Assistant icon has a `title` tooltip explaining what it
  does, and is also reachable via the command palette for keyboard users.
- `.env.example`'s `ANTHROPIC_API_KEY` comment now documents both features
  it powers instead of only the (older) HCL explainer.

## How to verify

```bash
# Backend
cd backend && node --check <any changed file>   # all pass
npm start  # needs Postgres + the usual .env — see backend/.env.example

# Frontend
cd frontend && npm start
```

Suggested manual test path: invite a second account to a project from
`/team/:projectId` → confirm the invitee sees it under Team → Pending
Invitations → accept → confirm both accounts see each other in the member
list. Then submit a change request and confirm the in-app bell fires (email
requires SMTP_* configured in `backend/.env`).
