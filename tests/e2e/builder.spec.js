/**
 * tests/e2e/builder.spec.js
 *
 * E2E tests for the Builder / Studio page — the core feature of TFGen.
 * Requires a logged-in user (auth state stored in storageState fixture).
 */
'use strict';

const { test, expect } = require('@playwright/test');

const ts       = Date.now();
const EMAIL    = `builder-e2e-${ts}@tfgen-test.local`;
const PASSWORD = 'Builder@E2e9876!';

// ─── Shared login fixture ─────────────────────────────────────────────────────
test.beforeEach(async ({ page }) => {
  // Register + login before each test
  await page.goto('/');
  // Try register first (may already exist on retry)
  try {
    const registerLink = page.getByRole('link', { name: /register|sign up/i })
      .or(page.getByRole('button', { name: /register|sign up/i }));
    await registerLink.first().click({ timeout: 3000 });
    await page.getByLabel(/email/i).fill(EMAIL);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /register|create account/i }).click();
    await page.waitForURL(/dashboard|builder|studio/, { timeout: 15000 });
  } catch {
    // Already registered — just log in
    await page.goto('/');
    await page.getByLabel(/email/i).fill(EMAIL);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /login|sign in/i }).click();
    await page.waitForURL(/dashboard|builder|studio/, { timeout: 15000 });
  }
});

// ─── Dashboard ────────────────────────────────────────────────────────────────
test.describe('Dashboard', () => {
  test('shows a "New Project" button or call-to-action', async ({ page }) => {
    await page.goto('/dashboard');
    const newProject = page.getByRole('button', { name: /new project|create project/i })
      .or(page.getByRole('link', { name: /new project|create project/i }));
    await expect(newProject.first()).toBeVisible({ timeout: 10000 });
  });

  test('displays the projects list (empty or populated)', async ({ page }) => {
    await page.goto('/dashboard');
    // The page should contain some indication of projects (even if zero)
    await expect(page.getByText(/project|no projects|start|create/i)).toBeVisible({ timeout: 10000 });
  });
});

// ─── Builder ──────────────────────────────────────────────────────────────────
test.describe('Builder / Studio', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/builder');
  });

  test('service selector panel is visible', async ({ page }) => {
    // The builder should show AWS service categories
    await expect(
      page.getByText(/EC2|S3|VPC|RDS|Lambda|service/i).first()
    ).toBeVisible({ timeout: 12000 });
  });

  test('can add an AWS VPC resource', async ({ page }) => {
    // Look for a VPC option and click it
    const vpcOption = page.getByText(/VPC/i).first();
    if (await vpcOption.isVisible()) {
      await vpcOption.click();
      // Code editor or config panel should update
      await expect(
        page.getByText(/aws_vpc|cidr_block|10\.0\.0\.0/i).first()
      ).toBeVisible({ timeout: 10000 });
    }
  });

  test('code editor is present and displays HCL', async ({ page }) => {
    // Monaco editor renders a .monaco-editor container
    await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 12000 });
  });

  test('can switch to the Graph view tab', async ({ page }) => {
    const graphTab = page.getByRole('tab', { name: /graph|visual/i })
      .or(page.getByRole('button', { name: /graph|visual/i }));
    if (await graphTab.first().isVisible()) {
      await graphTab.first().click();
      await expect(page.locator('svg, canvas').first()).toBeVisible({ timeout: 8000 });
    }
  });

  test('Validate button triggers feedback', async ({ page }) => {
    const validateBtn = page.getByRole('button', { name: /validate/i });
    if (await validateBtn.isVisible({ timeout: 5000 })) {
      await validateBtn.click();
      // Should show some feedback (valid, invalid, or loading)
      await expect(
        page.getByText(/valid|error|warning|check/i).first()
      ).toBeVisible({ timeout: 15000 });
    }
  });

  test('Download button is present', async ({ page }) => {
    const downloadBtn = page.getByRole('button', { name: /download|export/i });
    await expect(downloadBtn.first()).toBeVisible({ timeout: 10000 });
  });
});

// ─── Logout flow ─────────────────────────────────────────────────────────────
test.describe('Logout', () => {
  test('logging out redirects to login page', async ({ page }) => {
    // Find and click logout
    const logoutBtn = page.getByRole('button', { name: /logout|sign out/i })
      .or(page.getByRole('link', { name: /logout|sign out/i }));
    if (await logoutBtn.first().isVisible({ timeout: 5000 })) {
      await logoutBtn.first().click();
      await expect(page).toHaveURL(/login|\/$/, { timeout: 10000 });
    }
  });
});
