/**
 * tests/integration/projects.integration.test.js
 *
 * CRUD integration tests for /api/projects.
 * Each suite registers its own user so tests are fully isolated.
 */
'use strict';

const { registerUser, get, post, put, del } = require('../setup/testHelpers');

let token;
let projectId;

beforeAll(async () => {
  ({ token } = await registerUser());
});

describe('Projects Integration — /api/projects', () => {
  // ─── Create ──────────────────────────────────────────────────────────────────
  describe('POST /projects', () => {
    test('201 creates a project with name + description', async () => {
      const res = await post('/projects', { name: 'Integ-VPC-Test', description: 'Test project' }, token);
      expect(res.status).toBe(201);
      expect(res.data.id).toBeDefined();
      expect(res.data.name).toBe('Integ-VPC-Test');
      projectId = res.data.id;
    });

    test('400 when name is missing', async () => {
      const res = await post('/projects', { description: 'No name here' }, token);
      expect(res.status).toBe(400);
    });

    test('401 when no auth token provided', async () => {
      const res = await post('/projects', { name: 'No-Auth-Project' });
      expect(res.status).toBe(401);
    });
  });

  // ─── List ─────────────────────────────────────────────────────────────────────
  describe('GET /projects', () => {
    test('200 returns an array including the created project', async () => {
      const res = await get('/projects', token);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data.projects)).toBe(true);
      expect(res.data.total).toBeGreaterThanOrEqual(1);
      expect(res.data.projects.some(p => p.id === projectId)).toBe(true);
    });

    test('401 when unauthenticated', async () => {
      const res = await get('/projects');
      expect(res.status).toBe(401);
    });
  });

  // ─── Read single ─────────────────────────────────────────────────────────────
  describe('GET /projects/:id', () => {
    test('200 returns the project by id', async () => {
      const res = await get(`/projects/${projectId}`, token);
      expect(res.status).toBe(200);
      expect(res.data.id).toBe(projectId);
    });

    test('404 for a non-existent project id', async () => {
      const res = await get('/projects/00000000-0000-0000-0000-000000000000', token);
      expect(res.status).toBe(404);
    });
  });

  // ─── Update ──────────────────────────────────────────────────────────────────
  describe('PUT /projects/:id', () => {
    test('200 updates project name', async () => {
      const res = await put(`/projects/${projectId}`, { name: 'Updated-VPC-Name' }, token);
      expect(res.status).toBe(200);
      expect(res.data.name).toBe('Updated-VPC-Name');
    });

    test('403 when a different user tries to update', async () => {
      const { token: otherToken } = await registerUser();
      const res = await put(`/projects/${projectId}`, { name: 'Stolen' }, otherToken);
      expect([403, 404]).toContain(res.status);
    });
  });

  // ─── Resources sub-route ──────────────────────────────────────────────────────
  describe('POST /projects/:id/resources', () => {
    test('creates a resource block inside the project', async () => {
      const hcl = 'resource "aws_s3_bucket" "test_bucket" {\n  bucket = "my-test-bucket-xyz"\n}\n';
      const res = await post(`/projects/${projectId}/resources`, {
        resources: [{
          service_type: 's3',
          label:        'test_bucket',
          config:       { bucket: 'my-test-bucket-xyz', tags: { Env: 'test' } },
          hcl_output:   hcl,
        }],
        full_hcl: hcl,
      }, token);
      expect([200, 201]).toContain(res.status);
    });
  });

  // ─── HCL generation ───────────────────────────────────────────────────────────
  describe('GET /projects/:id (saved HCL)', () => {
    test('returns the HCL that was saved with the resources', async () => {
      const res = await get(`/projects/${projectId}`, token);
      expect(res.status).toBe(200);
      expect(res.data.last_hcl).toMatch(/resource "aws_s3_bucket" "test_bucket"/);
      expect(Array.isArray(res.data.resources)).toBe(true);
    });
  });

  // ─── Delete ──────────────────────────────────────────────────────────────────
  describe('DELETE /projects/:id', () => {
    test('200 or 204 deletes the project', async () => {
      const res = await del(`/projects/${projectId}`, token);
      expect([200, 204]).toContain(res.status);
    });

    test('project is gone after deletion', async () => {
      const res = await get(`/projects/${projectId}`, token);
      expect([403, 404]).toContain(res.status);
    });

    test('403 when a different user tries to delete', async () => {
      const { token: ownerToken }  = await registerUser();
      const createRes = await post('/projects', { name: 'To-Be-Guarded' }, ownerToken);
      const pid = createRes.data.id;
      const { token: attackerToken } = await registerUser();
      const res = await del(`/projects/${pid}`, attackerToken);
      expect([403, 404]).toContain(res.status);
    });
  });
});
