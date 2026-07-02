/**
 * tests/e2e/login.spec.js
 *
 * Playwright E2E tests for the Login / Register page.
 * Tests cover happy paths, validation, and basic security posture.
 */
'use strict';

const { test, expect } = require('@playwright/test');

const ts       = Date.now();
const EMAIL    = `e2e-${ts}@tfgen-test.local`;
const PASSWORD = 'E2eTest@1234!';

// ─── Register + Login ─────────────────────────────────────────────────────────
test.describe('Login Page', () => {
  test('page loads and shows login form', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /login|sign in/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });

  test('shows error for wrong credentials', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).fill('nobody@nowhere.com');
    await page.getByLabel(/password/i).fill('WrongPass!!1');
    await page.getByRole('button', { name: /login|sign in/i }).click();
    await expect(page.getByText(/invalid|incorrect|credentials/i)).toBeVisible({ timeout: 8000 });
  });

  test('shows validation error for empty email', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /login|sign in/i }).click();
    // Browser native validation or app-level error
    const emailField = page.getByLabel(/email/i);
    const valid = await emailField.evaluate(el => el.validity?.valid ?? true);
    if (valid) {
      await expect(page.getByText(/email|required/i)).toBeVisible({ timeout: 5000 });
    }
  });

  test('can navigate to the register tab/page', async ({ page }) => {
    await page.goto('/');
    const registerLink = page.getByRole('link', { name: /register|sign up|create account/i })
      .or(page.getByRole('button', { name: /register|sign up/i }));
    await registerLink.first().click();
    await expect(page.getByRole('heading', { name: /register|create|sign up/i })).toBeVisible({ timeout: 8000 });
  });
});

// ─── Registration flow ────────────────────────────────────────────────────────
test.describe('Registration Flow', () => {
  test('registers a new user and redirects to dashboard', async ({ page }) => {
    await page.goto('/');
    // Navigate to register
    const registerLink = page.getByRole('link', { name: /register|sign up|create account/i })
      .or(page.getByRole('button', { name: /register|sign up/i }));
    await registerLink.first().click();

    await page.getByLabel(/email/i).fill(EMAIL);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /register|create account|sign up/i }).click();

    // Should redirect to dashboard / builder after successful register
    await expect(page).toHaveURL(/dashboard|builder|studio/, { timeout: 15000 });
  });
});

// ─── Authenticated login ──────────────────────────────────────────────────────
test.describe('Successful Login', () => {
  test('logs in with valid credentials and lands on dashboard', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).fill(EMAIL);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /login|sign in/i }).click();
    await expect(page).toHaveURL(/dashboard|builder|studio/, { timeout: 15000 });
  });

  test('navbar is visible after login', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).fill(EMAIL);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /login|sign in/i }).click();
    await expect(page).toHaveURL(/dashboard|builder|studio/, { timeout: 15000 });
    // Navbar should contain user info or a logout button
    await expect(page.getByRole('navigation')).toBeVisible();
  });
});

// ─── Security checks ─────────────────────────────────────────────────────────
test.describe('Login Page Security', () => {
  test('password field is type=password (not visible)', async ({ page }) => {
    await page.goto('/');
    const passwordInput = page.getByLabel(/password/i);
    await expect(passwordInput).toHaveAttribute('type', 'password');
  });

  test('unauthenticated user cannot access /dashboard directly', async ({ page }) => {
    await page.goto('/dashboard');
    // Should redirect to login
    await expect(page).toHaveURL(/login|\/$/, { timeout: 8000 });
  });
});
