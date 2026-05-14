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

const API = axios.create({
  baseURL: BASE_URL || 'http://localhost:4000',
  timeout: 60000,
  headers: { 'Content-Type': 'application/json' },
});

// Log every request in development so you can see what's being called
if (process.env.NODE_ENV === 'development') {
  API.interceptors.request.use((config) => {
    console.debug(`[API] ${config.method?.toUpperCase()} ${config.baseURL}${config.url}`);
    return config;
  });
}

// Attach response error details for better debugging
API.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.code === 'ERR_NETWORK' || err.code === 'ECONNREFUSED') {
      console.error(
        `[API] Cannot reach backend at ${BASE_URL}.\n` +
        `Make sure the backend is running: cd backend && npm start`
      );
    } else if (err.response) {
      console.error(`[API] ${err.response.status} – ${JSON.stringify(err.response.data)}`);
    }
    return Promise.reject(err);
  }
);

export const projectsAPI = {
  list:         ()           => API.get('/api/projects'),
  get:          (id)         => API.get(`/api/projects/${id}`),
  create:       (data)       => API.post('/api/projects', data),
  update:       (id, data)   => API.put(`/api/projects/${id}`, data),
  delete:       (id)         => API.delete(`/api/projects/${id}`),
  saveResources:(id, resources) => API.post(`/api/projects/${id}/resources`, { resources }),
  getVersions:  (id)         => API.get(`/api/projects/${id}/versions`),
  saveVersion:  (id, data)   => API.post(`/api/projects/${id}/versions`, data),
};

export const templatesAPI = {
  list: ()        => API.get('/api/templates'),
  get:  (service) => API.get(`/api/templates/${service}`),
};

export const terraformAPI = {
  fmt:      (hcl) => API.post('/api/terraform/fmt', { hcl }),
  validate: (hcl) => API.post('/api/terraform/validate', { hcl }),
};

export const awsAPI = {
  instanceTypes: (region) => API.get(`/api/aws/instance-types?region=${encodeURIComponent(region || '')}`),
  availabilityZones: (region) => API.get(`/api/aws/availability-zones?region=${encodeURIComponent(region || '')}`),
  amis: (region, q) => API.get(`/api/aws/amis?region=${encodeURIComponent(region || '')}&q=${encodeURIComponent(q || '')}`),
};

export default API;
