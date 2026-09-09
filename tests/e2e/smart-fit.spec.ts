import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createDemoState } from "../../src/lib/fixtures";
import { newWorkItem } from "../../src/lib/work";
import { planCommands } from "../../src/lib/scheduler";
import { localDate, localDateTime, minutesBetween } from "../../src/lib/time";
import type { AppState } from "../../src/lib/types";
import { asActor, commit, futureDate, makeItem, origin, preview, state } from "./helpers";

// Browser-local fixture only. Intercepts writes before storage; no production
// workload, external providers, or real email delivery.
async function setup(page: Page, width: number) {
  await asActor(page.request, "bryan");
  const stored = await state(page.request);
  expect(stored.mode).toBe("demo");
  const now = "2026-09-09T13:00:00Z";
  let fixture: AppState = { ...createDemoState(now), workspaceId: stored.workspaceId, actor: stored.actor,
    clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }], items: [], sessions: [], blocks: [], events: [], requests: [], notifications: [], attachments: [], emailDrafts: [] };
  fixture.settings.reserveMinutes = 0;
  const ongoing = newWorkItem(fixture.actor, "2026-09-08", { id: "cedar-survey", clientId: "cedar", title: "Cedar survey", category: "software", webKind: null,
    status: "waiting", estimatedMinutes: null, remainingMinutes: null, windowEnd: "2026-10-31", minimumSessionMinutes: 120, blockedReason: "Waiting for client details" });
  const other = newWorkItem(fixture.actor, "2026-09-09", { id: "existing-work", clientId: "cedar", title: "Existing protected work", estimatedMinutes: 60, remainingMinutes: 60 });
  fixture.items = [ongoing, other];
  const at = (day: string, time: string) => localDateTime(day, time, fixture.settings.timeZone);
  fixture.sessions = [{ id: "protected-booking", workItemId: other.id, start: at("2026-09-09", "09:00"), end: at("2026-09-09", "10:00"), protected: true, status: "planned", usesReserve: false }];
  fixture.blocks = [{ id: "tomorrow-full", title: "Time off", kind: "time_off", start: at("2026-09-10", "09:00"), end: at("2026-09-10", "17:00") }];
  const before = structuredClone(fixture);
  const actions: string[] = [];
  await page.route(`${origin}/api/state`, route => route.fulfill({ json: fixture }));
  await page.route(`${origin}/api/commands`, async route => {
    const body = route.request().postDataJSON(); actions.push(body.action);
    const proposal = planCommands(fixture, body.commands, fixture.actor, { now, operationId: body.operationId });
    if (body.action === "commit") {
      expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
      fixture = { ...fixture, version: fixture.version + 1, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks };
    }
    await route.fulfill({ json: { proposal: { ...proposal, reviewFingerprint: "a".repeat(64) }, state: fixture } });
  });
  await page.clock.setFixedTime(new Date(now));
  await page.setViewportSize({ width, height: 1000 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your plate, at a glance." })).toBeVisible();
  // A real interaction waits for hydration before firing the refresh listener.
  await page.getByRole("button", { name: "agenda", exact: true }).click();
  await expect(page.getByRole("button", { name: "agenda", exact: true })).toHaveClass(/active/);
  const loaded = page.waitForResponse(response => response.url() === `${origin}/api/state`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await loaded;
  await expect(page.getByText("Cedar Studio", { exact: true }).first()).toBeAttached();
  return { before, actions, fixture: () => fixture };
}

for (const width of [1440, 390]) test(`finds two hours today on an existing unknown-total project at ${width}px`, async ({ page }, info) => {
  const context = await setup(page, width);
  const menu = page.getByRole("button", { name: "Open navigation", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: "All work", exact: true }).click();
  await page.getByLabel("Search work").fill("Cedar survey");
  await page.getByRole("button", { name: /Cedar survey Cedar Studio/ }).click();
  const dialog = page.getByRole("dialog", { name: "Cedar survey", exact: true });
  await dialog.getByRole("button", { name: "Find a time for me", exact: true }).click();
  await expect(dialog.getByLabel("Hours to book", { exact: true })).toHaveValue("2");
  await dialog.getByLabel("Resume this waiting project", { exact: false }).check();
  await dialog.getByRole("button", { name: "Tomorrow", exact: true }).click();
  await dialog.getByRole("button", { name: "Find available times", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "This needs a decision" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Confirm changes", exact: true })).toHaveCount(0);
  expect(context.fixture()).toEqual(context.before);
  await dialog.getByRole("button", { name: "Today", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "This needs a decision" })).toHaveCount(0);
  await dialog.getByLabel("Work day", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`smart-fit-controls-${width}.png`) });
  await dialog.getByRole("button", { name: "Find available times", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "This fits your schedule" })).toBeVisible();
  await expect(dialog.locator(".proposal-sessions")).toContainText("10:00 AM–12:00 PM");
  await expect(dialog.locator(".proposal-sessions")).not.toContainText("Existing protected work");
  expect(context.fixture()).toEqual(context.before);
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  await dialog.locator(".session-manager").screenshot({ path: info.outputPath(`smart-fit-${width}.png`) });
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Manage sessions", exact: true })).toBeVisible();
  const saved = context.fixture();
  expect(saved.sessions.find(s => s.id === "protected-booking")).toEqual(context.before.sessions[0]);
  expect(saved.items.find(i => i.id === "cedar-survey")).toMatchObject({ status: "planned", estimatedMinutes: null, remainingMinutes: null, windowStart: "2026-09-08", windowEnd: "2026-10-31" });
  expect(saved.sessions.filter(s => s.workItemId === "cedar-survey").map(s => minutesBetween(s.start, s.end))).toEqual([120]);
  expect(context.actions).toEqual(["preview", "preview", "commit"]);
});

test("new work clearly distinguishes total hours and hours each day", async ({ page }, info) => {
  const context = await setup(page, 390);
  await page.getByRole("button", { name: "Add work", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("What needs doing?").fill("Cedar school website");
  await dialog.getByRole("combobox", { name: "Work category", exact: true }).selectOption("web-build");
  await expect(dialog.getByRole("button", { name: /Find a time for me Choose days/ })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByLabel("Choose multiple days", { exact: true }).check();
  await dialog.getByLabel("First day", { exact: true }).fill("2026-09-14");
  await dialog.getByLabel("Last day", { exact: true }).fill("2026-09-18");
  await dialog.getByLabel("Hours to book", { exact: true }).fill("2");
  await expect(dialog.locator(".smart-fit-summary")).toContainText("2h to book total across these days");
  await dialog.getByRole("combobox", { name: "Spread the hours", exact: true }).selectOption("per_day");
  await expect(dialog.locator(".smart-fit-summary")).toContainText("10h to book");
  await dialog.getByLabel("First day", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("smart-fit-new-controls-mobile.png") });
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route(`${origin}/api/commands`, async route => { await hold; await route.fallback(); });
  await dialog.getByRole("button", { name: "Check schedule", exact: true }).click();
  await expect(dialog.getByLabel("What needs doing?")).toBeDisabled();
  await expect(dialog.getByLabel("Hours each working day", { exact: true })).toBeDisabled();
  release();
  await expect(dialog.getByRole("heading", { name: "This fits your schedule" })).toBeVisible();
  await expect(dialog.locator(".proposal-sessions > div")).toHaveCount(5);
  await dialog.locator(".work-form").screenshot({ path: info.outputPath("smart-fit-new-mobile.png") });
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
  const saved = context.fixture();
  const item = saved.items.find(i => i.title === "Cedar school website")!;
  expect(item.remainingMinutes).toBe(600);
  const sessions = saved.sessions.filter(s => s.workItemId === item.id);
  expect(sessions.map(s => localDate(s.start, saved.settings.timeZone))).toEqual(["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"]);
  expect(sessions.map(s => minutesBetween(s.start, s.end))).toEqual([120, 120, 120, 120, 120]);
});

test("editing a project offers the same find-time shortcut without saving metadata", async ({ page }) => {
  const context = await setup(page, 1440);
  await page.getByRole("button", { name: "All work", exact: true }).click();
  await page.getByLabel("Search work").fill("Cedar survey");
  await page.getByRole("button", { name: /Cedar survey Cedar Studio/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Edit work", exact: true }).click();
  await page.getByRole("dialog", { name: "Edit work", exact: true }).getByRole("button", { name: "Find a time for me", exact: true }).click();
  const fit = page.getByRole("dialog", { name: "Find time · Cedar survey", exact: true });
  await expect(fit.getByLabel("Hours to book", { exact: true })).toHaveValue("2");
  await fit.getByRole("button", { name: /^Choose exact times/ }).click();
  await expect(fit.getByRole("button", { name: "Add session", exact: true })).toBeVisible();
  await fit.getByRole("button", { name: /^Find a time for me/ }).click();
  await expect(fit.getByLabel("Hours to book", { exact: true })).toHaveValue("2");
  await fit.getByRole("button", { name: "Cancel edits", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Cedar survey", exact: true })).toBeVisible();
  expect(context.actions).toEqual([]);
  expect(context.fixture()).toEqual(context.before);
});

test("Ask ADA fits hours on an existing project after a short capacity follow-up", async ({ page }) => {
  await asActor(page.request, "bryan");
  const initial = await state(page.request);
  expect(initial.mode).toBe("demo");
  const date = futureDate(initial, 175);
  const item = makeItem(initial, "E2E ongoing smart survey", { windowStart: date, windowEnd: date, targetDate: null, status: "waiting", estimatedMinutes: null, remainingMinutes: null, minimumSessionMinutes: 120 });
  await commit(page.request, await preview(page.request, [{ type: "create", item }]));
  const before = await state(page.request);
  await page.goto("/");
  await page.getByRole("button", { name: "Ask ADA", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.getByLabel("Instruction for ADA", { exact: true });
  const send = dialog.getByRole("button", { name: "Send instruction", exact: true });
  await input.fill(`Find time for 8 hours on ${date} for ${item.title}.`);
  await send.click();
  await expect(dialog.getByText("Your reply will continue the pending instruction above.", { exact: true })).toBeVisible();
  const rejected = await state(page.request);
  expect(rejected.version).toBe(before.version);
  expect(rejected.sessions).toEqual(before.sessions);
  await input.fill("2 hours instead");
  await send.click();
  await expect(dialog.getByText("Your reply will continue the pending instruction above.", { exact: true })).toHaveCount(0);
  await expect(input).toHaveValue("");
  const saved = await state(page.request);
  expect(saved.version).toBe(before.version + 1);
  expect(saved.items.find(candidate => candidate.id === item.id)).toMatchObject({ estimatedMinutes: null, remainingMinutes: null, status: "planned" });
  expect(saved.sessions.filter(s => s.workItemId !== item.id)).toEqual(before.sessions);
  const booked = saved.sessions.filter(s => s.workItemId === item.id && s.status === "planned");
  expect(booked.reduce((sum, s) => sum + minutesBetween(s.start, s.end), 0)).toBe(120);
  expect(booked.every(s => localDate(s.start, saved.settings.timeZone) === date)).toBe(true);
  expect(saved.notifications.filter(n => !before.notifications.some(old => old.id === n.id)).every(n => n.status === "captured")).toBe(true);
});
