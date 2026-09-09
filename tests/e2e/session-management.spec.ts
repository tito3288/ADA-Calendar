import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createDemoState } from "../../src/lib/fixtures";
import { newWorkItem } from "../../src/lib/work";
import { planCommands } from "../../src/lib/scheduler";
import { localDateTime, minutesBetween } from "../../src/lib/time";
import type { AppState } from "../../src/lib/types";
import { asActor, origin, state } from "./helpers";

// Local browser-only fixture; command requests run the pure scheduler and are
// intercepted before storage. No provider, production workload, or sends.
for (const width of [1440, 390]) test(`redistributes three bookings into five days at ${width}px`, async ({ page }, info) => {
  await asActor(page.request, "bryan");
  const stored = await state(page.request);
  expect(stored.mode).toBe("demo");
  const now = "2026-09-08T13:00:00Z";
  let fixture: AppState = { ...createDemoState(now), workspaceId: stored.workspaceId, actor: stored.actor,
    clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }], items: [], sessions: [], blocks: [], events: [], requests: [], notifications: [], attachments: [], emailDrafts: [] };
  const item = newWorkItem(fixture.actor, "2026-09-14", { id: "cedar-build", clientId: "cedar", title: "Cedar website", estimatedMinutes: 600, remainingMinutes: 600, windowEnd: "2026-09-18", minimumSessionMinutes: 120 });
  fixture.items = [item];
  const at = (date: string, clock: string) => localDateTime(date, clock, fixture.settings.timeZone);
  fixture.sessions = [
    { id: "one", workItemId: item.id, start: at("2026-09-14","12:30"), end: at("2026-09-14","17:00"), status: "planned", protected: false, usesReserve: false },
    { id: "two", workItemId: item.id, start: at("2026-09-15","09:00"), end: at("2026-09-15","12:00"), status: "planned", protected: false, usesReserve: false },
    { id: "three", workItemId: item.id, start: at("2026-09-16","12:30"), end: at("2026-09-16","15:00"), status: "planned", protected: false, usesReserve: false },
  ];
  fixture.settings.reserveMinutes = 0;
  const actions: string[] = [];
  await page.route(`${origin}/api/state`, route => route.fulfill({ json: fixture }));
  await page.route(`${origin}/api/commands`, async route => {
    const body = route.request().postDataJSON(); actions.push(body.action);
    const proposal = planCommands(fixture, body.commands, fixture.actor, { now, operationId: body.operationId });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    if (body.action === "commit") fixture = { ...fixture, version: fixture.version + 1, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks };
    await route.fulfill({ json: { proposal: { ...proposal, reviewFingerprint: "a".repeat(64) }, state: fixture } });
  });
  await page.clock.setFixedTime(new Date(now));
  await page.setViewportSize({ width, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "agenda", exact: true }).click();
  await expect(page.getByRole("button", { name: "agenda", exact: true })).toHaveClass(/active/);
  await page.getByRole("button", { name: "month", exact: true }).click();
  await expect(page.getByRole("button", { name: "month", exact: true })).toHaveClass(/active/);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByTitle("Cedar Studio · Cedar website", { exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: item.title, exact: true });
  await dialog.getByRole("button", { name: "Manage sessions", exact: true }).click();
  for (let i = 1; i <= 3; i++) {
    await dialog.getByLabel(`Session ${i} start`, { exact: true }).fill("09:00");
    await dialog.getByLabel(`Session ${i} end`, { exact: true }).fill("11:00");
  }
  await dialog.getByRole("button", { name: "Preview session changes", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Reserve all 10 remaining hours");
  expect(actions).toEqual([]);
  await dialog.getByRole("button", { name: "Add session", exact: true }).click();
  await expect(dialog.getByLabel("Session 4 date", { exact: true })).toHaveValue("2026-09-17");
  await dialog.getByRole("button", { name: "Add session", exact: true }).click();
  await expect(dialog.getByLabel("Session 5 date", { exact: true })).toHaveValue("2026-09-18");
  await expect(dialog.locator(".session-manager-budget")).toContainText("10h in future sessions");
  await dialog.locator(".session-manager").screenshot({ path: info.outputPath(`session-manager-${width}.png`) });
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  await dialog.getByRole("button", { name: "Preview session changes", exact: true }).click();
  await expect(dialog.getByText("This fits your schedule", { exact: true })).toBeVisible();
  expect(actions).toEqual(["preview"]);
  await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Manage sessions", exact: true })).toBeVisible();
  expect(actions).toEqual(["preview", "commit"]);
  expect(fixture.sessions.map(s => minutesBetween(s.start,s.end))).toEqual([120,120,120,120,120]);
  expect(fixture.items[0].remainingMinutes).toBe(600);
  expect((await state(page.request)).items).toEqual(stored.items);
  expect((await state(page.request)).notifications).toEqual(stored.notifications);
});
