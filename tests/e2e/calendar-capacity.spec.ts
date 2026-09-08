import { expect, test } from "@playwright/test";
import { createDemoState } from "../../src/lib/fixtures";
import { newWorkItem } from "../../src/lib/work";
import { localDateTime } from "../../src/lib/time";
import type { AppState, WorkSession } from "../../src/lib/types";
import { asActor, origin, state } from "./helpers";

// Fictional browser-only fixture. No calendar mutation or provider request.
function capacityFixture(): AppState {
  const fixture = createDemoState("2026-09-08T13:00:00Z");
  const item = newWorkItem(fixture.actor, "2026-09-08", { id: "cedar-work", clientId: "cedar", title: "Catalog refresh", windowEnd: "2026-09-30", estimatedMinutes: 1200, remainingMinutes: 1200 });
  const other = newWorkItem(fixture.actor, "2026-09-09", { id: "maple-work", clientId: "maple", title: "Layout review" });
  const session = (id: string, date: string, start: string, end: string, workItemId = item.id): WorkSession => ({
    id, workItemId, start: localDateTime(date, start, fixture.settings.timeZone), end: localDateTime(date, end, fixture.settings.timeZone),
    status: "planned", protected: false, usesReserve: false,
  });
  return { ...fixture, clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }, { id: "maple", name: "Maple Books", aliases: [] }],
    items: [item, other], sessions: [
      session("part-a", "2026-09-09", "09:00", "11:00"), session("part-b", "2026-09-09", "11:00", "12:00", other.id),
      session("full-a", "2026-09-10", "09:00", "12:00"), session("full-b", "2026-09-10", "12:30", "16:00"),
      session("low-a", "2026-09-11", "09:00", "12:00"), session("low-b", "2026-09-11", "12:30", "15:00"),
      session("meeting-day", "2026-09-14", "09:00", "11:00"),
    ], blocks: [{ id: "fictional-meeting", title: "Planning meeting", kind: "meeting", start: localDateTime("2026-09-14", "13:00", fixture.settings.timeZone), end: localDateTime("2026-09-14", "14:00", fixture.settings.timeZone) }],
    events: [], notifications: [], requests: [], emailDrafts: [], attachments: [],
  };
}

for (const width of [1440, 1100, 390]) {
  test(`remaining daily capacity stays readable at ${width}px without changing bookings`, async ({ page, baseURL }, testInfo) => {
    expect(baseURL).toBe(origin);
    await asActor(page.request, "bryan");
    const storedBefore = await state(page.request);
    expect(storedBefore.mode).toBe("demo");
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.setFixedTime(new Date("2026-09-08T13:00:00Z"));
    const fixture = capacityFixture();
    await page.route(`${origin}/api/state`, route => route.fulfill({ json: fixture }));
    await page.goto("/");
    await page.getByRole("button", { name: "month", exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const calendar = page.getByLabel("Month workload calendar", { exact: true });
    const cases = [
      ["Tuesday, September 8", "6.5h", "0h"], ["Wednesday, September 9", "3.5h", "3h"],
      ["Thursday, September 10", "0h", "6.5h"], ["Friday, September 11", "1h", "5.5h"],
      ["Monday, September 14", "3.5h", "2h"],
    ];
    for (const [date, available, planned] of cases) {
      const cell = calendar.getByRole("button", { name: `${date}, ${available} available, ${planned} planned`, exact: true });
      await expect(cell.locator(".day-capacity strong")).toHaveText(available);
      await expect(cell.getByText("left", { exact: true })).toBeVisible();
      await expect(cell.locator(".day-capacity-planned")).toHaveText(`${planned} planned`);
      const bounds = await cell.boundingBox();
      const badge = await cell.locator(".day-capacity-remaining").boundingBox();
      expect(bounds).not.toBeNull(); expect(badge).not.toBeNull();
      expect(badge!.x).toBeGreaterThanOrEqual(bounds!.x);
      expect(badge!.x + badge!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
      const textSize = await cell.locator("strong").evaluate(node => parseFloat(getComputedStyle(node).fontSize));
      expect(textSize).toBeGreaterThanOrEqual(width === 390 ? 11 : 12);
    }
    await expect(calendar.getByRole("button", { name: /^Thursday, September 10,/ }).locator(".capacity-full")).toBeVisible();
    await expect(calendar.getByRole("button", { name: /^Friday, September 11,/ }).locator(".capacity-low")).toBeVisible();
    await expect(calendar.getByRole("button", { name: "Saturday, September 12, Non-working day", exact: true }).locator(".day-capacity")).toHaveCount(0);
    const week = calendar.locator(".calendar-week").nth(1);
    const badgeBottoms = await week.locator(".day-capacity-remaining").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().bottom));
    const firstRibbon = await week.locator(".project-ribbon").first().boundingBox();
    expect(Math.max(...badgeBottoms)).toBeLessThan(firstRibbon!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (width === 1440) {
      await expect(calendar.getByRole("button", { name: /^Wednesday, September 9,/ }).locator(".day-capacity-planned")).toBeVisible();
      await page.getByRole("button", { name: "C Cedar Studio", exact: true }).click();
      await expect(calendar.getByRole("button", { name: "Wednesday, September 9, 3.5h available, 3h planned", exact: true })).toBeVisible();
    }
    await calendar.screenshot({ path: testInfo.outputPath(`daily-hours-left-${width}.png`) });
    expect(await state(page.request)).toEqual(storedBefore);
  });
}

test("turning off the reserve shows 7.5 available hours without changing existing work", async ({ page, baseURL }, testInfo) => {
  expect(baseURL).toBe(origin);
  await asActor(page.request, "bryan");
  const storedBefore = await state(page.request);
  expect(storedBefore.mode).toBe("demo");
  await page.clock.setFixedTime(new Date("2026-09-08T13:00:00Z"));
  const original = capacityFixture();
  let fixture = structuredClone(original);
  let saved = 0;
  await page.route(`${origin}/api/state`, route => route.fulfill({ json: fixture }));
  // Capture the settings request without writing to any live or demo workspace.
  await page.route(`${origin}/api/admin`, async route => {
    const payload = route.request().postDataJSON();
    expect(payload).toEqual({ type: "settings", settings: { ...original.settings, reserveMinutes: 0 } });
    fixture = { ...fixture, settings: payload.settings };
    saved++;
    await route.fulfill({ json: { state: fixture } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "month", exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const calendar = page.getByLabel("Month workload calendar", { exact: true });
  await expect(calendar.getByRole("button", { name: "Tuesday, September 8, 6.5h available, 0h planned", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^Reserve minutes/).fill("0");
  await dialog.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(dialog.getByText("Saved.", { exact: true })).toBeVisible();
  expect(saved).toBe(1);
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(calendar.getByRole("button", { name: "Tuesday, September 8, 7.5h available, 0h planned", exact: true }).locator("strong")).toHaveText("7.5h");
  await expect(calendar.getByRole("button", { name: "Wednesday, September 9, 4.5h available, 3h planned", exact: true })).toBeVisible();
  await expect(page.getByText("No automatic buffer", { exact: true })).toBeVisible();
  expect(fixture.items).toEqual(original.items);
  expect(fixture.sessions).toEqual(original.sessions);
  expect(fixture.blocks).toEqual(original.blocks);
  expect(fixture.notifications).toEqual(original.notifications);
  expect(await state(page.request)).toEqual(storedBefore);
  await calendar.screenshot({ path: testInfo.outputPath("daily-hours-left-no-reserve.png") });
});
