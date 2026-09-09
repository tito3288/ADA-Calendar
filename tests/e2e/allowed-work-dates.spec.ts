import { expect, test, type Page } from "@playwright/test";
import { createDemoState } from "../../src/lib/fixtures";
import { planCommands } from "../../src/lib/scheduler";
import { localDate, localDateTime, minutesBetween } from "../../src/lib/time";
import type { AppState, WorkCommand } from "../../src/lib/types";
import { newWorkItem } from "../../src/lib/work";
import { asActor, origin, state } from "./helpers";

// Fictional browser-local work only. Every preview and commit uses the shared
// scheduler with a fixed clock; intercepted writes never reach storage or mail.
const now = "2026-09-09T13:00:00Z";
const sourceDate = "2026-09-10";
const targetDate = "2026-09-11";
const title = "Fictional first wave of website edits";
const itemId = "allowed-dates-website-edits";

async function setup(page: Page, width = 1440, actor: "bryan" | "kyle" = "bryan", waiting = false) {
  await asActor(page.request, actor);
  const stored = await state(page.request);
  expect(stored.mode).toBe("demo");
  let fixture: AppState = {
    ...createDemoState(now), workspaceId: stored.workspaceId, actor: stored.actor,
    clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }],
    items: [], sessions: [], blocks: [], events: [], requests: [],
    notifications: [], attachments: [], emailDrafts: [],
  };
  fixture.settings.reserveMinutes = 0;
  const item = newWorkItem(fixture.actor, sourceDate, {
    id: itemId, clientId: "cedar", title, category: "web", webKind: "edit",
    windowEnd: sourceDate, allowedDates: [sourceDate], estimatedMinutes: 120,
    remainingMinutes: 120, minimumSessionMinutes: 60, targetDate: null, deadline: null,
    ...(waiting ? { status: "waiting", estimatedMinutes: null, remainingMinutes: null } : {}),
  });
  const neighbor = newWorkItem(fixture.actor, targetDate, {
    id: "allowed-dates-neighbor", clientId: "cedar", title: "Fictional protected neighbor",
    estimatedMinutes: 60, remainingMinutes: 60,
  });
  const at = (date: string, time: string) => localDateTime(date, time, fixture.settings.timeZone);
  fixture.items = [item, neighbor];
  fixture.sessions = [
    { id: "allowed-dates-booking", workItemId: item.id, start: at(sourceDate, "10:00"), end: at(sourceDate, "12:00"), protected: false, status: "planned", usesReserve: false },
    { id: "allowed-dates-protected-neighbor", workItemId: neighbor.id, start: at(targetDate, "09:00"), end: at(targetDate, "10:00"), protected: true, status: "planned", usesReserve: false },
  ];
  if (waiting) fixture.sessions = fixture.sessions.filter(session => session.workItemId !== itemId);
  const before = structuredClone(fixture);
  const requests: { action: string; commands: WorkCommand[] }[] = [];
  await page.route(`${origin}/api/state`, route => route.fulfill({ json: fixture }));
  for (const name of ["assistant", "workspace-chat", "transcribe"]) {
    await page.route(`${origin}/api/${name}`, () => {
      throw new Error(`Editing allowed work dates must not call /api/${name}.`);
    });
  }
  await page.route(`${origin}/api/commands`, async route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const proposal = planCommands(fixture, body.commands, fixture.actor, { now, operationId: body.operationId });
    if (body.action === "commit") {
      expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
      expect(body.baseVersion).toBe(fixture.version);
      fixture = { ...fixture, version: fixture.version + 1, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks };
    }
    await route.fulfill({ json: { proposal: { ...proposal, reviewFingerprint: "a".repeat(64) }, state: fixture } });
  });
  await page.clock.setFixedTime(new Date(now));
  await page.setViewportSize({ width, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "agenda", exact: true }).click();
  await expect(page.getByRole("button", { name: "agenda", exact: true })).toHaveClass(/active/);
  const refreshed = page.waitForResponse(`${origin}/api/state`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await refreshed;
  await expect(page.getByTitle("Cedar Studio", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "month", exact: true }).click();
  return { before, requests, fixture: () => fixture };
}

const calendar = (page: Page) => page.getByLabel("Month workload calendar", { exact: true });
const details = (page: Page) => page.getByRole("dialog", { name: title, exact: true });
const editor = (page: Page) => page.getByRole("dialog", { name: "Edit work", exact: true });
const moveDialog = (page: Page) => page.getByRole("dialog", { name: "Move booked hours", exact: true });
const moveHandle = (page: Page) => calendar(page).getByRole("button", { name: `Move Cedar Studio · ${title} on Sep 10`, exact: true });

async function openDetails(page: Page) {
  // The separate move handle can cover the center of a narrow day ribbon.
  // Activate its accessible details button directly with the keyboard.
  await calendar(page).getByTitle(`Cedar Studio · ${title}`, { exact: true }).first().focus();
  await page.keyboard.press("Enter");
  await expect(details(page)).toBeVisible();
  return details(page);
}

async function openEditor(page: Page) {
  const dialog = await openDetails(page);
  await expect(dialog.getByText("Allowed work dates", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Allowed work dates", { exact: true }).locator("..")).toContainText("Sep 10");
  await dialog.getByRole("button", { name: "Edit work", exact: true }).click();
  await expect(editor(page).getByLabel("Limit work to selected dates", { exact: true })).toBeChecked();
  await expect(editor(page).getByLabel("Allowed work date 1", { exact: true })).toHaveValue(sourceDate);
  return editor(page);
}

async function addFriday(page: Page) {
  const form = editor(page);
  await form.getByRole("button", { name: "Add allowed work date", exact: true }).click();
  await expect(form.getByLabel("Allowed work date 2", { exact: true })).toHaveValue("");
  await form.getByLabel("Allowed work date 2", { exact: true }).fill(targetDate);
  await expect(form.getByLabel("Allowed work date 1", { exact: true })).toHaveValue(sourceDate);
}

async function previewMove(page: Page) {
  await moveHandle(page).focus();
  await page.keyboard.press("Enter");
  const picker = page.getByRole("region", { name: "Choose a day for booked hours", exact: true });
  await picker.getByLabel("Move booking to date", { exact: true }).fill(targetDate);
  await picker.getByRole("button", { name: "Preview move", exact: true }).click();
  await expect(moveDialog(page)).toBeVisible();
  return moveDialog(page);
}

for (const width of [1440, 390]) {
  test(`owner adds an allowed day without changing bookings, then moves the same hours at ${width}px`, async ({ page, baseURL }, info) => {
    expect(baseURL).toBe(origin);
    const context = await setup(page, width);
    const rejected = await previewMove(page);
    await expect(rejected.getByRole("alert")).toContainText(/allowed work dates/i);
    await expect(rejected.getByRole("button", { name: "Confirm move", exact: true })).toHaveCount(0);
    expect(context.fixture()).toEqual(context.before);
    await rejected.getByRole("button", { name: "Cancel move", exact: true }).click();

    const form = await openEditor(page);
    await addFriday(page);
    await form.getByLabel("Allowed work date 2", { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`allowed-work-dates-editor-${width}.png`) });
    expect(await form.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await form.getByRole("button", { name: "Check schedule", exact: true }).click();
    await expect(form.getByRole("heading", { name: "This fits your schedule", exact: true })).toBeVisible();
    expect(context.fixture()).toEqual(context.before);
    expect(context.requests.at(-1)).toMatchObject({ action: "preview", commands: [
      { type: "update", itemId, patch: { allowedDates: [sourceDate, targetDate] } },
      { type: "schedule", itemId, sessions: context.before.sessions.filter(session => session.workItemId === itemId) },
    ] });
    await expect(form.locator(".proposal-date-changes")).toContainText("Before: Sep 10, 2026");
    await expect(form.locator(".proposal-date-changes")).toContainText("After: Sep 10, 2026, Sep 11, 2026");
    await form.getByRole("button", { name: "Confirm changes", exact: true }).click();
    await expect(form).toHaveCount(0);
    const saved = structuredClone(context.fixture());
    expect(saved.items.find(item => item.id === itemId)).toMatchObject({
      allowedDates: [sourceDate, targetDate], estimatedMinutes: 120, remainingMinutes: 120,
      windowStart: sourceDate, windowEnd: sourceDate, targetDate: null, deadline: null,
    });
    expect(saved.sessions).toEqual(context.before.sessions);
    expect(saved.blocks).toEqual(context.before.blocks);
    expect(saved.settings).toEqual(context.before.settings);
    const dates = details(page).getByText("Allowed work dates", { exact: true }).locator("..");
    await expect(dates).toContainText("Sep 10");
    await expect(dates).toContainText("Sep 11");
    await details(page).getByRole("button", { name: "Close dialog", exact: true }).click();

    const move = await previewMove(page);
    await expect(move.getByRole("button", { name: "Confirm move", exact: true })).toBeEnabled();
    expect(context.fixture()).toEqual(saved);
    await move.screenshot({ path: info.outputPath(`allowed-work-dates-move-preview-${width}.png`) });
    await move.getByRole("button", { name: "Confirm move", exact: true }).click();
    await expect(move).toHaveCount(0);
    const moved = context.fixture();
    expect(moved.sessions.map(session => session.id)).toEqual(saved.sessions.map(session => session.id));
    const booking = moved.sessions.find(session => session.workItemId === itemId)!;
    expect(localDate(booking.start, moved.settings.timeZone)).toBe(targetDate);
    expect(minutesBetween(booking.start, booking.end)).toBe(120);
    expect(moved.sessions.filter(session => session.workItemId !== itemId)).toEqual(saved.sessions.filter(session => session.workItemId !== itemId));
    expect(moved.items.find(item => item.id === itemId)).toMatchObject({ allowedDates: [sourceDate, targetDate], estimatedMinutes: 120, remainingMinutes: 120 });
    expect(moved.blocks).toEqual(saved.blocks);
    expect(moved.settings).toEqual(saved.settings);
  });
}

test("cancelling an allowed-date preview discards the draft and keeps the original restriction", async ({ page }) => {
  const context = await setup(page);
  const form = await openEditor(page);
  await addFriday(page);
  await form.getByRole("button", { name: "Check schedule", exact: true }).click();
  await expect(form.getByRole("heading", { name: "This fits your schedule", exact: true })).toBeVisible();
  await form.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(context.fixture()).toEqual(context.before);
  expect(context.requests.map(request => request.action)).toEqual(["preview"]);
  await details(page).getByRole("button", { name: "Edit work", exact: true }).click();
  await expect(form.getByLabel("Allowed work date 1", { exact: true })).toHaveValue(sourceDate);
  await expect(form.getByLabel("Allowed work date 2", { exact: true })).toHaveCount(0);
});

test("extending only the faded project span preserves allowed dates and still blocks an unapproved day", async ({ page }) => {
  const context = await setup(page);
  const form = await openEditor(page);
  await form.getByLabel(/^Project span ends/).fill("2026-09-30");
  await form.getByRole("button", { name: "Check schedule", exact: true }).click();
  await expect(form.getByRole("heading", { name: "This fits your schedule", exact: true })).toBeVisible();
  await form.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(form).toHaveCount(0);
  const saved = structuredClone(context.fixture());
  expect(saved.items.find(item => item.id === itemId)).toMatchObject({ windowEnd: "2026-09-30", allowedDates: [sourceDate] });
  expect(saved.sessions).toEqual(context.before.sessions);
  await details(page).getByRole("button", { name: "Close dialog", exact: true }).click();
  const move = await previewMove(page);
  await expect(move.getByRole("alert")).toContainText(/allowed work dates/i);
  await expect(move.getByRole("button", { name: "Confirm move", exact: true })).toHaveCount(0);
  expect(context.fixture()).toEqual(saved);
});

test("requesters can see the allowed work dates without owner editing or move controls", async ({ page }) => {
  const context = await setup(page, 1440, "kyle");
  await expect(moveHandle(page)).toHaveCount(0);
  const dialog = await openDetails(page);
  await expect(dialog.getByText("Allowed work dates", { exact: true }).locator("..")).toContainText("Sep 10");
  await expect(dialog.getByRole("button", { name: "Edit work", exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Limit work to selected dates", { exact: true })).toHaveCount(0);
  expect(context.requests).toEqual([]);
  expect(context.fixture()).toEqual(context.before);
});

test("waiting work can change its allowed dates without resuming or booking hours", async ({ page }) => {
  const context = await setup(page, 1440, "bryan", true);
  const form = await openEditor(page);
  await addFriday(page);
  await form.getByRole("button", { name: "Check schedule", exact: true }).click();
  await expect(form.getByRole("heading", { name: "This fits your schedule", exact: true })).toBeVisible();
  expect(context.requests.at(-1)?.commands).toHaveLength(1);
  expect(context.fixture()).toEqual(context.before);
  await form.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(context.fixture().items.find(item => item.id === itemId)).toMatchObject({ status: "waiting", allowedDates: [sourceDate, targetDate], estimatedMinutes: null, remainingMinutes: null });
  expect(context.fixture().sessions).toEqual(context.before.sessions);
});

test("the owner can explicitly remove the date restriction while retaining exact bookings", async ({ page }) => {
  const context = await setup(page);
  const form = await openEditor(page);
  await form.getByLabel("Limit work to selected dates", { exact: true }).uncheck();
  await form.getByRole("button", { name: "Check schedule", exact: true }).click();
  await expect(form.locator(".proposal-date-changes")).toContainText("After: Any working day");
  expect(context.fixture()).toEqual(context.before);
  await form.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(context.fixture().items.find(item => item.id === itemId)?.allowedDates).toEqual([]);
  expect(context.fixture().sessions).toEqual(context.before.sessions);
});
