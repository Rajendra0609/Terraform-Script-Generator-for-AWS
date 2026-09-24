import axios from 'axios';

// ── Base URL ──────────────────────────────────────────────────────────────────
// When running behind the nginx proxy (docker-compose), REACT_APP_API_URL is
// intentionally empty. All /api/... calls are made relative to the same origin
// (e.g. http://localhost:3000/api/...) and nginx proxies them to the backend
// container via Docker internal DNS.
//
// Only non-empty when running the frontend directly against a remote backend
// (e.g. REACT_APP_API_URL=http://localhost:4000 for bare `npm start` dev).
const BASE_URL = process.env.REACT_APP_API_URL || '';

// Debug: print which API base URL the client was built with (development only)
if (process.env.NODE_ENV === 'development') {
  console.debug(`[API] BASE_URL = "${BASE_URL || '(empty — using relative paths via nginx proxy)'}" `);
}

const API = axios.create({
  baseURL: BASE_URL,   // '' = relative URLs, nginx handles the proxy
  timeout: 120000,     // 120s for long terraform operations
  headers: { 'Content-Type': 'application/json' },
  // BUG-008 fix: send cookies (including the HttpOnly refreshToken) cross-origin
  withCredentials: true,
});

// Log every request in development so you can see what's being called
if (process.env.NODE_ENV === 'development') {
  API.interceptors.request.use((config) => {
    console.debug(`[API] ${config.method?.toUpperCase()} ${config.baseURL}${config.url}`);
    return config;
  });
}

// Auto-refresh token on 401 (token rotation support)
// BUG-008 fix: the refresh token is in an HttpOnly cookie — no localStorage reads needed.
// The browser sends the cookie automatically on POST /api/auth/refresh.
let _isRefreshing = false;
let _refreshQueue = [];

function processRefreshQueue(err, token) {
  _refreshQueue.forEach(({ resolve, reject }) => (err ? reject(err) : resolve(token)));
  _refreshQueue = [];
}

API.interceptors.response.use(
  (res) => res,
  async (err) => {
    const original = err.config;
    if (err.response?.status === 401 && !original._retry && !original.url?.includes('/api/auth/refresh')) {
      original._retry = true;
      if (_isRefreshing) {
        return new Promise((resolve, reject) => {
          _refreshQueue.push({ resolve, reject });
        }).then(token => {
          original.headers['Authorization'] = `Bearer ${token}`;
          return API(original);
        });
      }
      _isRefreshing = true;
      try {
        // Cookie is sent automatically — no body or localStorage read needed
        const { data } = await API.post('/api/auth/refresh');
        const newAccessToken = data.token || data.accessToken;
        if (!newAccessToken) throw new Error('No access token in refresh response');
        // Keep new access token in-memory via axios default header only
        API.defaults.headers.common['Authorization'] = `Bearer ${newAccessToken}`;
        original.headers['Authorization'] = `Bearer ${newAccessToken}`;
        processRefreshQueue(null, newAccessToken);
        // BUG-014 fix: carry _retryCount forward to the refreshed config so the
        // retry interceptor treats the fresh request as a continuation of the same
        // attempt chain. Without this, a 503 after a successful 401-refresh could
        // loop up to MAX_RETRIES extra times because _retryCount reset to 0.
        original._retryCount = original._retryCount || 0;
        return API(original);
      } catch (refreshErr) {
        processRefreshQueue(refreshErr, null);
        window.dispatchEvent(new Event('tfgen:session-expired'));
        return Promise.reject(refreshErr);
      } finally {
        _isRefreshing = false;
      }
    }
    return Promise.reject(err);
  }
);

// Attach a short UUID correlation id to every request to help server telemetry
function shortUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}
API.interceptors.request.use((config) => {
  config.headers['X-Correlation-Id'] = shortUUID();
  return config;
});

// Retry logic for transient errors (network, 502, 503, 429)
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;

API.interceptors.response.use(
  (res) => res,
  async (err) => {
    const config = err.config;
    if (!config) return Promise.reject(err);

    config._retryCount = config._retryCount || 0;

    const isRetryable =
      err.code === 'ERR_NETWORK' ||
      err.code === 'ECONNREFUSED' ||
      err.code === 'ECONNABORTED' ||
      (err.response && [429, 502, 503].includes(err.response.status));

    // BUG-018 fix: the health check previously skipped retries by pre-seeding
    // _retryCount: MAX_RETRIES — an off-by-one hack that silently broke whenever
    // MAX_RETRIES changed. Use an explicit _skipRetry flag instead so the intent
    // is unambiguous and immune to constant changes.
    if (config._skipRetry) return Promise.reject(err);

    if (isRetryable && config._retryCount < MAX_RETRIES) {
      config._retryCount++;
      const delay = RETRY_DELAY * Math.pow(2, config._retryCount - 1);
      console.warn(`[API] Retrying (${config._retryCount}/${MAX_RETRIES}) after ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      return API(config);
    }

    if (err.code === 'ERR_NETWORK' || err.code === 'ECONNREFUSED') {
      console.error(
        `[API] Cannot reach backend.\n` +
        `Make sure docker-compose is running: docker compose up -d`
      );
    } else if (err.response) {
      console.error(`[API] ${err.response.status} - ${JSON.stringify(err.response.data)}`);
    }
    return Promise.reject(err);
  }
);

// Periodic health check — detect backend disconnection early.
// Uses a module-scoped singleton guard so hot-reloads in development
// don't stack additional intervals on top of existing ones.
let _healthOk = true;
export function isBackendHealthy() { return _healthOk; }

const _HEALTH_INTERVAL_KEY = '__tfgen_healthIntervalId__';
if (window[_HEALTH_INTERVAL_KEY]) {
  // A previous module instance (e.g. after HMR) left an interval running — clear it first.
  clearInterval(window[_HEALTH_INTERVAL_KEY]);
}
window[_HEALTH_INTERVAL_KEY] = setInterval(async () => {
  try {
    await API.get('/api/health', { timeout: 5000, _skipRetry: true }); // BUG-018 fix: explicit flag
    _healthOk = true;
  } catch {
    _healthOk = false;
  }
}, 30000); // check every 30 seconds

// Guard: prevent API calls with a missing or clearly-invalid project ID.
// This catches the string "undefined" / "null" that can appear when JS
// coerces an undefined variable into a template literal.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertProjectId(id) {
  if (!id || id === 'undefined' || id === 'null' || !UUID_RE.test(id)) {
    const msg = `[client] Invalid project ID: "${id}". Select or create a project before calling this API.`;
    console.error(msg);
    return Promise.reject(new Error(msg));
  }
  return null;
}

// ── WebSocket base URL ────────────────────────────────────────────────────────
// Derive the WebSocket base from window.location so it always matches the page
// origin — this works correctly whether accessed via localhost, an IP, or a
// domain, without any hardcoded addresses.
// nginx proxies /ws/... to the backend container (see nginx.conf).
function getWsBase() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}`;
}

// SECURITY FIX (backend/server.js now requires auth on WS upgrade — see
// CHANGELOG_SECURITY_AUDIT_FIXES.md #4): browsers can't set custom headers
// during a WebSocket handshake, so the current in-memory access token is
// passed as a `?token=` query param instead. Read from the same axios
// default header that AuthContext/refresh-flow already keep up to date, so
// this can never drift out of sync with "am I currently logged in".
function getAccessToken() {
  const header = API.defaults.headers.common['Authorization'];
  return header ? String(header).replace(/^Bearer\s+/i, '') : '';
}

export const projectsAPI = {
  list:          (params = {})     => API.get('/api/projects', { params }),
  get:           (id)              => assertProjectId(id) ?? API.get(`/api/projects/${id}`),
  create:        (data)            => API.post('/api/projects', data),
  update:        (id, data)        => assertProjectId(id) ?? API.put(`/api/projects/${id}`, data),
  delete:        (id)              => assertProjectId(id) ?? API.delete(`/api/projects/${id}`),
  saveResources: (id, resources, full_hcl) => assertProjectId(id) ?? API.post(`/api/projects/${id}/resources`, { resources, full_hcl }), // BUG-005 fix: pass full_hcl so backend persists complete HCL
  getVersions:   (id)              => assertProjectId(id) ?? API.get(`/api/projects/${id}/versions`),
  saveVersion:   (id, data)        => assertProjectId(id) ?? API.post(`/api/projects/${id}/versions`, data),
  // Team members
  getMembers:    (id)              => assertProjectId(id) ?? API.get(`/api/projects/${id}/members`),
  inviteMember:  (id, body)        => assertProjectId(id) ?? API.post(`/api/projects/${id}/members`, body),
  removeMember:  (id, userId)      => assertProjectId(id) ?? API.delete(`/api/projects/${id}/members/${userId}`),
  acceptInvite:  (id, userId)      => assertProjectId(id) ?? API.put(`/api/projects/${id}/members/${userId}/accept`),
  declineInvite: (id, userId)      => assertProjectId(id) ?? API.delete(`/api/projects/${id}/members/${userId}`),
  myInvitations: ()                => API.get('/api/projects/invitations/pending'),
  // Version diff
  versionDiff:   (id, a, b)        => assertProjectId(id) ?? API.get(`/api/projects/${id}/versions/diff?a=${a}&b=${b}`),
};

export const templatesAPI = {
  list: ()        => API.get('/api/templates'),
  get:  (service) => API.get(`/api/templates/${service}`),
};

export const terraformAPI = {
  fmt:      (hcl, runner = 'auto')               => API.post('/api/terraform/fmt',      { hcl, runner }),
  validate: (hcl, runner = 'auto', projectId)    => API.post('/api/terraform/validate', { hcl, runner, project_id: projectId }),
  suggest:  (payload)                            => API.post('/api/terraform/suggest',   payload),
  plan:     (hcl, runner = 'auto', projectId, useRealCreds = false) =>
    API.post('/api/terraform/plan', { hcl, runner, project_id: projectId, use_real_credentials: useRealCreds }),
  init:     (hcl, runner = 'auto')               => API.post('/api/terraform/init',     { hcl, runner }),
  cost:     (hcl)                                => API.post('/api/terraform/cost',     { hcl }),
  scan:     (hcl)                                => API.post('/api/terraform/scan',     { hcl }),
  // ── Phase-1: Apply (new) ──────────────────────────────────────────────────
  // Always returns { jobId, status: 'queued', wsUrl } — never blocks. The
  // caller should open connectJobWs(jobId) to stream live logs and the final
  // outcome (success/failure + plan_summary + checkov_summary).
  apply: (hcl, projectId, runner = 'auto') =>
    API.post('/api/terraform/apply', { hcl, project_id: projectId, runner }),
};

/** WebSocket job stream — returns a WebSocket instance. */
export const jobsAPI = {
  connectWs(jobId) {
    return new WebSocket(`${getWsBase()}/ws/jobs?id=${encodeURIComponent(jobId)}&token=${encodeURIComponent(getAccessToken())}`);
  },
  // Polling fallback (for environments where WebSocket isn't available, or
  // when the frontend has reconnected and wants the final status of an
  // already-completed job).
  get:  (jobId) => assertProjectId(jobId) ?? API.get(`/api/terraform/jobs/${jobId}`),
  // List recent jobs — pass ?project_id= or ?type= to filter
  list: (params = {}) => API.get('/api/terraform/jobs', { params }),
};

export const terraformLspAPI = {
  connect() {
    // Use window.location so the WS goes through nginx (/ws/ proxy block).
    return new WebSocket(`${getWsBase()}/ws/terraform-lsp?token=${encodeURIComponent(getAccessToken())}`);
  },
};

export const exportAPI = {
  githubActions: (body) => API.post('/api/export/pipeline/github-actions', body),
  gitlabCi:      (body) => API.post('/api/export/pipeline/gitlab-ci', body),
  readme:        (body) => API.post('/api/export/readme', body),
};

export const diagramAPI = {
  generate: (body) => API.post('/api/diagram/generate', body),
};

export const authAPI = {
  login:    (body)  => API.post('/api/auth/login', body),
  register: (body)  => API.post('/api/auth/register', body),
  // BUG-002 fix: do not accept or forward a token in the request body.
  // After the BUG-008 fix, the backend reads the refresh token exclusively
  // from the HttpOnly cookie, which the browser sends automatically via
  // withCredentials: true. Passing a body token was misleading and broken.
  refresh:  () => API.post('/api/auth/refresh'),
  logout:   () => API.post('/api/auth/logout'),
  me:       ()      => API.get('/api/auth/me'),
};

export const awsAPI = {
  instanceTypes:     (region) => API.get(`/api/aws/instance-types?region=${encodeURIComponent(region || '')}`),
  availabilityZones: (region) => API.get(`/api/aws/availability-zones?region=${encodeURIComponent(region || '')}`),
  amis:              (region, q) => API.get(`/api/aws/amis?region=${encodeURIComponent(region || '')}&q=${encodeURIComponent(q || '')}`),
  // AWS Credential management (per-user, stored encrypted in DB)
  getCredentials:    ()                   => API.get('/api/aws/credentials'),
  saveCredentials:   (body)               => API.post('/api/aws/credentials', body),
  deleteCredentials: ()                   => API.delete('/api/aws/credentials'),
};

export const learnAPI = {
  explain:      (hcl)             => API.post('/api/learn/explain', { hcl }),
  questions:    (services = [])   => API.get(`/api/learn/questions?services=${services.join(',')}`),
  getLabs:      ()                => API.get('/api/learn/labs'),
  getLab:       (id)              => API.get(`/api/learn/labs/${id}`),
  getPatterns:  (category)        => API.get(`/api/learn/patterns${category ? `?category=${category}` : ''}`),
  getPattern:   (id)              => API.get(`/api/learn/patterns/${id}`),
  saveProgress: (labId, stepId, completed) => API.post('/api/learn/labs/progress', { lab_id: labId, step_id: stepId, completed }),
  getProgress:  ()                => API.get('/api/learn/labs/progress'),
};

// AI code assistant for Studio — describe a change in plain English, get
// back the full updated file content. Separate from learnAPI.explain (which
// only explains existing HCL, never writes/modifies it).
export const hclAssistAPI = {
  assist: ({ instruction, filename, currentCode, allFiles }) =>
    API.post('/api/hcl-assist', { instruction, filename, currentCode, allFiles }),
};

export const iamAPI = {
  generate:      (service_type)    => API.post('/api/iam/generate', { service_type }),
  generateBatch: (service_types)   => API.post('/api/iam/generate/batch', { service_types }),
};

export const stateAPI = {
  inspect: (state, config_resources) => API.post('/api/state/inspect', { state, config_resources }),
};

export const registryAPI = {
  search:   (q, provider, limit) => API.get(`/api/registry/search?q=${encodeURIComponent(q||'')}&provider=${provider||'aws'}&limit=${limit||20}`),
  module:   (ns, name, prov)     => API.get(`/api/registry/module/${ns}/${name}/${prov}`),
  versions: (ns, name, prov)     => API.get(`/api/registry/module/${ns}/${name}/${prov}/versions`),
  importModule: (body)           => API.post('/api/registry/import', body),
};

export const envconfigAPI = {
  tfvars:     (body) => API.post('/api/envconfig/tfvars', body),
  backend:    (body) => API.post('/api/envconfig/backend', body),
  terragrunt: (body) => API.post('/api/envconfig/terragrunt', body),
};



// ── Phase 2: OPA Policies ─────────────────────────────────────────────────────
export const policiesAPI = {
  list:           ()     => API.get('/api/policies'),
  create:         (body) => API.post('/api/policies', body),
  update:         (id, body) => API.put(`/api/policies/${id}`, body),
  delete:         (id)   => API.delete(`/api/policies/${id}`),
  toggle:         (id)   => API.post(`/api/policies/${id}/toggle`),
  seedTemplates:  ()     => API.post('/api/policies/seed-templates'),
  evaluate:       (body) => API.post('/api/policies/evaluate', body),
  summary:        ()     => API.get('/api/policies/summary'),
};

// ── Phase 2: Change Requests ──────────────────────────────────────────────────
export const changeRequestsAPI = {
  listAll:       (params = {}) => API.get('/api/change-requests', { params }),
  listForProject:(pid)   => API.get(`/api/change-requests/project/${pid}`),
  get:           (id)    => API.get(`/api/change-requests/${id}`),
  create:        (body)  => API.post('/api/change-requests', body),
  approve:       (id, body = {}) => API.post(`/api/change-requests/${id}/approve`, body),
  reject:        (id, body = {}) => API.post(`/api/change-requests/${id}/reject`, body),
  merge:         (id)    => API.post(`/api/change-requests/${id}/merge`),
  withdraw:      (id)    => API.delete(`/api/change-requests/${id}`),
  getComments:   (id)    => API.get(`/api/change-requests/${id}/comments`),
  postComment:   (id, body) => API.post(`/api/change-requests/${id}/comments`, body),
};

// ── Phase 3: Admin ────────────────────────────────────────────────────────────
export const adminAPI = {
  metrics:        ()            => API.get('/api/admin/metrics'),
  system:         ()            => API.get('/api/admin/system'),
  users:          (params = {}) => API.get('/api/admin/users', { params }),
  getUser:        (id)          => API.get(`/api/admin/users/${id}`),
  setUserRole:    (id, role)    => API.put(`/api/admin/users/${id}/role`, { role }),
  deleteUser:     (id)          => API.delete(`/api/admin/users/${id}`),
  projects:       (params = {}) => API.get('/api/admin/projects', { params }),
  sanitizeHcl:    ()            => API.post('/api/admin/sanitize-hcl'),
};

// ── Phase 4: Notifications ────────────────────────────────────────────────────
export const notificationsAPI = {
  list:         (params = {}) => API.get('/api/notifications', { params }),
  unreadCount:  ()            => API.get('/api/notifications/unread-count'),
  markRead:     (id)          => API.post(`/api/notifications/${id}/read`),
  markAllRead:  ()            => API.post('/api/notifications/read-all'),
  delete:       (id)          => API.delete(`/api/notifications/${id}`),
  preferences:  ()            => API.get('/api/notifications/preferences'),
  setPrefs:     (body)        => API.put('/api/notifications/preferences', body),
  testWebhook:  (url)         => API.post('/api/notifications/webhook-test', { url }),
};

// ── Phase 4: Global Search ────────────────────────────────────────────────────
export const searchAPI = {
  search: (q, opts = {}) => API.get('/api/search', { params: { q, ...opts } }),
};

export default API;
