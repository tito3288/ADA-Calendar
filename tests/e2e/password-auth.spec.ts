import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

// These tests exercise real pages against intercepted auth responses. They do not
// authenticate against Supabase, send email, or enable a production bypass.
const syntheticEmail = "invited-user@example.test";
const syntheticPassword = " Fixture Only Password! 73 ";
const loginError = "We couldn’t sign you in. Check your email and password, then try again.";
const unexpectedAuthRequests = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const unexpected: string[] = [];
  unexpectedAuthRequests.set(page, unexpected);
  // Explicit endpoint mocks below take precedence over this fail-closed guard.
  await page.route("**/api/auth/**", async (route) => {
    unexpected.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await route.fulfill({ status: 501, json: { error: "Unexpected test authentication request." } });
  });
});

test.afterEach(async ({ page }) => {
  expect(unexpectedAuthRequests.get(page)).toEqual([]);
});

async function checkAccessibility(page: Page, testInfo: TestInfo, name: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  await testInfo.attach(`${name}-accessibility`, { body: JSON.stringify(results.violations, null, 2), contentType: "application/json" });
  expect(results.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

test("password login is accessible, keyboard usable, and has no public registration", async ({ page }, testInfo) => {
  await page.goto("/auth/login");
  const email = page.getByLabel("Work email", { exact: true });
  const password = page.getByLabel("Password", { exact: true });
  await expect(email).toHaveAttribute("type", "email");
  await expect(email).toHaveAttribute("autocomplete", "username");
  await expect(password).toHaveAttribute("type", "password");
  await expect(password).toHaveAttribute("autocomplete", "current-password");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Forgot password?", exact: true })).toHaveAttribute("href", "/auth/forgot-password");
  await expect(page.getByText("Private, invite-only access", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /sign up|create.*account|register/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /sign up|create.*account|register|email me a sign-in link/i })).toHaveCount(0);
  await email.focus();
  await page.keyboard.press("Tab");
  await expect(password).toBeFocused();
  await checkAccessibility(page, testInfo, "desktop-password-login");
});

test("password login preserves the password exactly, reports rejection, then navigates after success", async ({ page }) => {
  const submitted: unknown[] = [];
  await page.route("**/api/auth/login", async (route) => {
    expect(route.request().method()).toBe("POST");
    submitted.push(route.request().postDataJSON());
    await route.fulfill(submitted.length === 1
      ? { status: 401, json: { error: loginError } }
      : { status: 200, json: { ok: true } });
  });
  await page.goto("/auth/login");
  await page.getByLabel("Work email", { exact: true }).fill(syntheticEmail);
  await page.getByLabel("Password", { exact: true }).fill(syntheticPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(loginError);
  await expect(page).toHaveURL(/\/auth\/login$/);
  await expect(page.getByLabel("Work email", { exact: true })).toHaveValue(syntheticEmail);
  await page.getByLabel("Password", { exact: true }).fill(syntheticPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/");
  expect(submitted).toEqual([
    { email: syntheticEmail, password: syntheticPassword },
    { email: syntheticEmail, password: syntheticPassword },
  ]);
  // This is the isolated demo destination, not proof of hosted authentication.
  await expect(page.getByRole("heading", { name: "Your plate, at a glance." })).toBeVisible();
});

test("failed login does not expose arbitrary provider error details", async ({ page }) => {
  await page.route("**/api/auth/login", (route) => route.fulfill({
    status: 401,
    json: { error: "Private provider details: user does not exist; internal_id=fixture-123" },
  }));
  await page.goto("/auth/login");
  await page.getByLabel("Work email", { exact: true }).fill(syntheticEmail);
  await page.getByLabel("Password", { exact: true }).fill(syntheticPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(loginError);
  await expect(page.getByText(/Private provider details|internal_id=fixture-123/)).toHaveCount(0);
});

test("login recovery messages are fixed rather than reflected from the query string", async ({ page }) => {
  await page.goto("/auth/login?error=invalid_link");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("That link is invalid or has expired.");
  await page.goto("/auth/login?error=access_denied");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("This workspace is invite-only.");
  await page.goto("/auth/login?password=updated");
  await expect(page.getByRole("status")).toContainText("Your password is saved. Sign in with your email and new password.");
  await page.goto("/auth/login?error=Do%20not%20display%20this%20untrusted%20message&password=unexpected");
  await expect(page.getByText("Do not display this untrusted message", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("forgot password submits only the email and acknowledges without confirming an account exists", async ({ page }) => {
  const submitted: unknown[] = [];
  const acknowledgment = "If this email belongs to an invited account, you’ll receive a password reset link.";
  await page.route("**/api/auth/forgot-password", async (route) => {
    expect(route.request().method()).toBe("POST");
    submitted.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, json: { message: acknowledgment } });
  });
  await page.goto("/auth/login");
  await page.getByRole("link", { name: "Forgot password?", exact: true }).click();
  await expect(page).toHaveURL(/\/auth\/forgot-password$/);
  await page.getByLabel("Work email", { exact: true }).fill(syntheticEmail);
  await page.getByRole("button", { name: "Send reset link", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(/If .*invited account/i);
  expect(submitted).toEqual([{ email: syntheticEmail }]);
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /sign up|create.*account|register/i })).toHaveCount(0);
});

test("login and password recovery remain accessible without horizontal scrolling on mobile", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/auth/login");
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await checkAccessibility(page, testInfo, "mobile-password-login");
  await page.getByRole("link", { name: "Forgot password?", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send reset link", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await checkAccessibility(page, testInfo, "mobile-password-recovery");
});
