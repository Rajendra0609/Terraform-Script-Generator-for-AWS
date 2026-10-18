/**
 * tests/api/errors.api.test.js
 * Caller mistakes get 4xx responses without parser internals.
 */
'use strict';
const axios = require('axios');

const base = process.env.TEST_BASE_URL || 'http://localhost:4099';

describe('Error responses for caller mistakes', () => {
  test('malformed JSON is a 400 with a correlationId and no parser detail', async () => {
    const res = await axios.post(`${base}/api/projects`, '{"name": "x", ',
      { headers: { 'Content-Type': 'application/json' }, validateStatus: () => true });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/Malformed JSON/);
    expect(res.data.correlationId).toBeDefined();
    expect(JSON.stringify(res.data)).not.toMatch(/Unexpected|position|line \d/);
  });

  test('a disallowed CORS origin is refused with 403, not 500', async () => {
    const res = await axios.get(`${base}/api/health`,
      { headers: { Origin: 'https://attacker.example' }, validateStatus: () => true });
    expect(res.status).toBe(403);
    expect(res.data.error).toBe('Origin not allowed');
  });
});
