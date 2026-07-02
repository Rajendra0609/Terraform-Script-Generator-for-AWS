/**
 * tests/performance/k6-load.js
 *
 * k6 load test for the TFGen API.
 * Scenarios:
 *   1. Baseline smoke  — 1 VU, 30 s
 *   2. Average load    — ramp to 20 VUs, hold 2 min, ramp down
 *   3. Spike test      — sudden burst to 50 VUs for 30 s
 *
 * Run:
 *   k6 run tests/performance/k6-load.js \
 *       -e BASE_URL=http://localhost:4000 \
 *       -e TEST_USER=perf@test.local \
 *       -e TEST_PASS=Perf@12345!
 *
 * Output JUnit XML for Jenkins:
 *   k6 run ... --out json=tests/reports/k6-results.json
 */

import http   from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ─── Configuration ─────────────────────────────────────────────────────────────
const BASE_URL  = __ENV.BASE_URL  || 'http://localhost:4000';
const TEST_USER = __ENV.TEST_USER || 'perf@tfgen-test.local';
const TEST_PASS = __ENV.TEST_PASS || 'PerfTest@12345!';

// ─── Custom metrics ────────────────────────────────────────────────────────────
const errorRate     = new Rate('error_rate');
const loginDuration = new Trend('login_duration_ms');
const hclDuration   = new Trend('hcl_format_duration_ms');
const authErrors    = new Counter('auth_errors');

// ─── Thresholds (SLO) ─────────────────────────────────────────────────────────
export const options = {
  scenarios: {
    smoke: {
      executor:        'constant-vus',
      vus:             1,
      duration:        '30s',
      tags:            { scenario: 'smoke' },
    },
    average_load: {
      executor:        'ramping-vus',
      startVUs:        0,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '2m',  target: 20 },
        { duration: '30s', target: 0  },
      ],
      startTime: '40s',  // starts after smoke finishes
      tags:      { scenario: 'average_load' },
    },
    spike: {
      executor:  'ramping-vus',
      startVUs:  0,
      stages: [
        { duration: '10s', target: 50 },
        { duration: '30s', target: 50 },
        { duration: '10s', target: 0  },
      ],
      startTime: '4m',   // starts after average_load finishes
      tags:      { scenario: 'spike' },
    },
  },
  thresholds: {
    // 95th percentile response times
    http_req_duration: ['p(95)<2000'],        // 2 s  — all endpoints
    login_duration_ms: ['p(95)<1500'],        // 1.5 s for auth
    hcl_format_duration_ms: ['p(95)<3000'],   // 3 s  for fmt (Docker may be cold)
    error_rate:        ['rate<0.05'],         // < 5 % errors overall
    http_req_failed:   ['rate<0.05'],
  },
};

// ─── Shared HCL payload ───────────────────────────────────────────────────────
const SAMPLE_HCL = `
terraform {
  required_providers { aws = { source = "hashicorp/aws" version = "~> 5.0" } }
}
provider "aws" { region = "us-east-1" }
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags       = { Name = "perf-vpc" }
}
`;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ─── Virtual User script ───────────────────────────────────────────────────────
export default function () {
  let accessToken;

  // 1. Health check
  group('health', () => {
    const res = http.get(`${BASE_URL}/api/health`);
    check(res, { 'health 200': r => r.status === 200 });
    errorRate.add(res.status !== 200);
  });

  sleep(0.5);

  // 2. Login
  group('login', () => {
    const start = Date.now();
    const res = http.post(
      `${BASE_URL}/api/auth/login`,
      JSON.stringify({ email: TEST_USER, password: TEST_PASS }),
      { headers: JSON_HEADERS }
    );
    loginDuration.add(Date.now() - start);

    const ok = check(res, {
      'login 200':    r => r.status === 200,
      'has token':    r => { try { return !!JSON.parse(r.body).token; } catch { return false; } },
    });
    if (!ok) { authErrors.add(1); errorRate.add(1); return; }
    errorRate.add(0);

    try { accessToken = JSON.parse(res.body).token; } catch (_) {}
  });

  if (!accessToken) { sleep(1); return; }

  const authHeaders = { ...JSON_HEADERS, Authorization: `Bearer ${accessToken}` };

  sleep(0.3);

  // 3. List projects
  group('projects_list', () => {
    const res = http.get(`${BASE_URL}/api/projects`, { headers: authHeaders });
    check(res, { 'projects 200': r => r.status === 200 });
    errorRate.add(res.status !== 200);
  });

  sleep(0.3);

  // 4. HCL format
  group('terraform_fmt', () => {
    const start = Date.now();
    const res = http.post(
      `${BASE_URL}/api/terraform/fmt`,
      JSON.stringify({ hcl: SAMPLE_HCL }),
      { headers: authHeaders }
    );
    hclDuration.add(Date.now() - start);
    check(res, { 'fmt 200': r => [200, 201].includes(r.status) });
    errorRate.add(![200, 201].includes(res.status));
  });

  sleep(0.5);

  // 5. HCL validate
  group('terraform_validate', () => {
    const res = http.post(
      `${BASE_URL}/api/terraform/validate`,
      JSON.stringify({ hcl: SAMPLE_HCL }),
      { headers: authHeaders }
    );
    check(res, { 'validate !500': r => r.status < 500 });
    errorRate.add(res.status >= 500);
  });

  sleep(1);
}
