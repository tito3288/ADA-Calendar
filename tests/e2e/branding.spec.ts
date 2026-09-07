import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

// The Playwright server is an isolated demo with provider credentials cleared.
// These visual checks never submit auth, calendar, email, or assistant requests.
const unexpectedAuthRequests = new WeakMap<Page, string[]>();
const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
] as const;

test.beforeEach(async ({ page }) => {
  const unexpected: string[] = [];
  unexpectedAuthRequests.set(page, unexpected);
  await page.route("**/api/auth/**", async (route) => {
    unexpected.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await route.fulfill({ status: 501, json: { error: "Unexpected authentication request in branding test." } });
  });
});

test.afterEach(async ({ page }) => {
  expect(unexpectedAuthRequests.get(page)).toEqual([]);
});

async function expectLoadedLogo(logo: Locator) {
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute("src", /alpha-dog-mint\.svg/);
  await expect.poll(() => logo.evaluate((element: HTMLImageElement) => (
    element.complete && element.naturalWidth > 0 && element.naturalHeight > 0
  ))).toBe(true);
  const dimensions = await logo.evaluate((element: HTMLImageElement) => ({
    naturalRatio: element.naturalWidth / element.naturalHeight,
    renderedRatio: element.getBoundingClientRect().width / element.getBoundingClientRect().height,
  }));
  expect(dimensions.naturalRatio).toBeCloseTo(2550 / 1052, 1);
  expect(dimensions.renderedRatio).toBeCloseTo(dimensions.naturalRatio, 1);
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth <= window.innerWidth
  ))).toBe(true);
}

for (const viewport of viewports) {
  test(`login and recovery show the agency logo without overflow on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const screen of [
      { name: "login", url: "/auth/login", action: "Sign in" },
      { name: "forgot-password", url: "/auth/forgot-password", action: "Send reset link" },
    ]) {
      await page.goto(screen.url);
      await expectLoadedLogo(page.getByRole("img", { name: "Alpha Dog Agency", exact: true }));
      await expect(page.getByText("ADA CALENDAR", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: screen.action, exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-${screen.name}-branding.png`), fullPage: true });
    }
  });

  test(`protected set-password links retain branded sign-in on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    // Password setup deliberately requires a real invited session. Demo identity
    // must not bypass it; test the branded rejection without weakening auth.
    for (const mode of ["invite", "recovery"]) {
      await page.goto(`/auth/password?mode=${mode}`);
      await expect(page).toHaveURL(/\/auth\/login\?error=invalid_link$/);
      await expectLoadedLogo(page.getByRole("img", { name: "Alpha Dog Agency", exact: true }));
      await expect(page.getByRole("main").getByRole("alert")).toContainText("That link is invalid or has expired.");
      await expect(page.getByLabel("Confirm password", { exact: true })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
    }
    await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-protected-password-branding.png`), fullPage: true });
  });

  test(`sidebar keeps the agency logo and ADA Calendar home link on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Your plate, at a glance.", exact: true })).toBeVisible();
    if (viewport.name === "mobile") {
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await expect.poll(() => page.locator(".sidebar.nav-open").evaluate((element) => element.getBoundingClientRect().x)).toBe(0);
    }
    const home = page.getByRole("link", { name: "ADA Calendar home", exact: true });
    await expect(home).toBeVisible();
    await expect(home).toHaveAttribute("href", "/");
    await expect(home.getByText("ADA CALENDAR", { exact: true })).toBeVisible();
    await expectLoadedLogo(home.getByRole("img", { name: "Alpha Dog Agency", exact: true }));
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-sidebar-branding.png`), fullPage: true, animations: "disabled" });
    if (viewport.name === "mobile") {
      // The scrim fills the screen behind the drawer; its center is covered.
      await page.getByRole("button", { name: "Close navigation", exact: true }).click({ position: { x: viewport.width - 16, y: 24 } });
      await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });
}

test("page metadata serves the replacement favicon and dog app icons", async ({ page, request }) => {
  await page.goto("/auth/login");
  const icons = await page.locator('link[rel="icon"], link[rel="apple-touch-icon"]').evaluateAll((links) => (
    links.map((link) => ({ rel: link.getAttribute("rel"), href: (link as HTMLLinkElement).href }))
  ));
  for (const expected of [
    { rel: "icon", pathname: /^\/favicon\.ico$/, filename: "favicon.ico" },
    { rel: "icon", pathname: /^\/icon(?:\.png)?$/, filename: "icon.png" },
    { rel: "apple-touch-icon", pathname: /^\/apple-icon(?:\.png)?$/, filename: "apple-icon.png" },
  ]) {
    const matches = icons.filter((icon) => icon.rel === expected.rel && expected.pathname.test(new URL(icon.href).pathname));
    expect(matches, `Metadata should expose ${expected.filename}`).toHaveLength(1);
    const href = matches[0].href;
    expect(new URL(href).origin).toBe(new URL(page.url()).origin);
    const response = await request.get(href);
    expect(response.ok(), `Icon should load: ${href}`).toBe(true);
    expect(response.headers()["content-type"]).toMatch(/^image\//);
    expect(await response.body()).toEqual(await readFile(path.join(process.cwd(), "src", "app", expected.filename)));
    expect(await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      return image.naturalWidth > 0 && image.naturalHeight > 0;
    }, href)).toBe(true);
  }
});
