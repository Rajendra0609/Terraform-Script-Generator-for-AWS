/**
 * tests/setup/testHelpers.js
 *
 * Shared helpers used across integration, API, and smoke test suites.
 */
'use strict';

const axios   = require('axios');
const jwt     = require('jsonwebtoken');

const BASE_URL = () => process.env.TEST_BASE_URL || 'http://localhost:4099';

// ─── Token helpers ─────────────────────────────────────────────────────────────

/**
 * Mint a signed JWT for testing without hitting the DB.
 * Only for unit/middleware tests — real integration tests should register+login.
 */
function mintTestToken(payload = {}, expiresIn = '1h') {
  const secret = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';
  return jwt.sign(
    { id: payload.id || 'test-user-id', email: payload.email || 'test@example.com', role: payload.role || 'user', ...payload },
    secret,
    { expiresIn }
  );
}

function mintAdminToken() {
  return mintTestToken({ role: 'admin', email: 'admin@example.com', id: 'admin-test-id' });
}

function mintExpiredToken() {
  return mintTestToken({}, '-1s');
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────────

function api(path) {
  return `${BASE_URL()}/api${path}`;
}

async function get(path, token) {
  return axios.get(api(path), {
    headers:          token ? { Authorization: `Bearer ${token}` } : {},
    validateStatus:   () => true,   // never throw on HTTP errors
  });
}

async function post(path, body, token) {
  return axios.post(api(path), body, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    validateStatus: () => true,
  });
}

async function put(path, body, token) {
  return axios.put(api(path), body, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    validateStatus: () => true,
  });
}

async function del(path, token) {
  return axios.delete(api(path), {
    headers:        token ? { Authorization: `Bearer ${token}` } : {},
    validateStatus: () => true,
  });
}

// ─── User factory ─────────────────────────────────────────────────────────────

let _userCounter = Date.now();

/**
 * Register a fresh test user and return { token, user }.
 * Each call generates a unique email so tests stay independent.
 */
async function registerUser(role = 'user') {
  const email    = `test-${_userCounter++}@tfgen-test.local`;
  const password = 'Test@12345!';
  const res      = await post('/auth/register', { email, password });
  if (res.status !== 201) {
    throw new Error(`registerUser failed: ${JSON.stringify(res.data)}`);
  }
  return { token: res.data.token, user: res.data.user, email, password };
}

module.exports = { mintTestToken, mintAdminToken, mintExpiredToken, api, get, post, put, del, registerUser };
