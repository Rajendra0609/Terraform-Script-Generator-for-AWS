import axios from 'axios';

// REACT_APP_API_URL must be set in .env (or .env.local).
// For local dev: http://localhost:4000
// Never leave this undefined — it defaults to the same origin which won't
// reach a backend running on a different port.
const BASE_URL = process.env.REACT_APP_API_URL;

if (!BASE_URL) {
  console.error(
    '[client.js] REACT_APP_API_URL is not set!\n' +
    'Create frontend/.env with: REACT_APP_API_URL=http://localhost:4000\n' +
    'Then restart the dev server.'
  );
}

// Debug: print which API base URL the client was built with (development only)
if (process.env.NODE_ENV === 'development') {
  console.debug(`[API] BASE_URL = ${BASE_URL || 'null (will default to http://localhost:4000)'}`);
}

const API = axios.create({
  baseURL: BASE_URL || 'http://localhost:4000',
  timeout: 120000, // 120s for long terraform operations
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
        `[API] Cannot reach backend at ${BASE_URL}.\n` +
        `Make sure the backend is running: cd backend && npm start`
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
    await API.get('/api/health', { timeout: 5000, _skipRetry: true }); // skip retry for health — BUG-018 fix: explicit flag, not fragile _retryCount seed
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

export const projectsAPI = {
  list:          ()                => API.get('/api/projects'),
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
  // Version diff
  versionDiff:   (id, a, b)        => assertProjectId(id) ?? API.get(`/api/projects/${id}/versions/diff?a=${a}&b=${b}`),
};

export const templatesAPI = {
  list: ()        => API.get('/api/templates'),
  get:  (service) => API.get(`/api/templates/${service}`),
};

export const terraformAPI = {
  fmt:      (hcl, runner = 'auto') => API.post('/api/terraform/fmt',      { hcl, runner }),
  validate: (hcl, runner = 'auto') => API.post('/api/terraform/validate', { hcl, runner }),
  suggest:  (payload)              => API.post('/api/terraform/suggest',   payload),
  plan:     (hcl, runner = 'auto') => API.post('/api/terraform/plan',     { hcl, runner }),
  init:     (hcl, runner = 'auto') => API.post('/api/terraform/init',     { hcl, runner }),
  cost:     (hcl)                  => API.post('/api/terraform/cost',     { hcl }),
  scan:     (hcl)                  => API.post('/api/terraform/scan',     { hcl }),
};


/** WebSocket job stream — returns a WebSocket instance. */
export const jobsAPI = {
  connectWs(jobId) {
    const wsBase = (process.env.REACT_APP_API_URL || 'http://localhost:4000')
      .replace(/^http/, 'ws');
    return new WebSocket(`${wsBase}/ws/jobs?id=${encodeURIComponent(jobId)}`);
  },
};

export const terraformLspAPI = {
  connect() {
    const wsBase = (process.env.REACT_APP_API_URL_LS || 'http://localhost:4000')
      .replace(/^http/, 'ws');
    return new WebSocket(`${wsBase}/ws/terraform-lsp`);
  },
};

export const exportAPI = {
  githubActions: (body) => API.post('/api/export/pipeline/github-actions', body),
  gitlabCi:      (body) => API.post('/api/export/pipeline/gitlab-ci', body),
  readme:        (body) => API.post('/api/export/readme', body),
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


export default API;
