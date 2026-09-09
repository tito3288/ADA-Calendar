import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AppState } from "../../src/lib/types";
import { asActor, commit, exactSession, futureDate, makeItem, origin, preview, state } from "./helpers";

// Real browser → demo chat → scheduler → captured commit/undo. Fixtures stay in
// .data-e2e; Playwright clears live AI/email credentials and never uses port 3000.
test.beforeEach(async ({ page, baseURL }) => {
  expect(baseURL).toBe(origin);
  await asActor(page.request, "bryan");
  expect((await state(page.request)).mode).toBe("demo");
});

const schedule = ({ items, sessions, blocks }: AppState) => ({ items, sessions, blocks });
const helper = (page: Page) => page.getByRole("dialog", { name: "ADA helper", exact: true });
const savedCard = (dialog: Locator) => dialog.getByLabel("Last ADA schedule change", { exact: true });

async function open(page: Page) {
  await page.getByRole("button", { name: "Open ADA helper", exact: true }).click();
  const dialog = helper(page);
  await expect(dialog.getByLabel("Message ADA helper", { exact: true })).toBeEnabled();
  return dialog;
}

async function seed(page: Page, offset: number, partial = false) {
  const snapshot = await state(page.request), date = futureDate(snapshot, offset);
  const title = `Fictional undo Cedar ${offset}`;
  const item = makeItem(snapshot, title, {
    windowStart: date, windowEnd: futureDate(snapshot, offset + 10),
    estimatedMinutes: 120, remainingMinutes: 120, minimumSessionMinutes: 120,
    category: "web", webKind: "build",
  });
  const session = exactSession(snapshot, item, "09:00", "11:00");
  const proposal = await preview(page.request, [{ type: "create", item, sessions: [session] }]);
  expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
  let saved = await commit(page.request, proposal);
  if (partial) {
    const reduced = await preview(page.request, [{ type: "resize_booking", sessionId: session.id, minutes: 60 }]);
    expect(reduced.status, JSON.stringify(reduced.conflicts)).toBe("ready");
    saved = await commit(page.request, reduced);
  }
  await page.goto("/");
  const dialog = await open(page);
  await dialog.getByLabel("Day to discuss", { exact: true }).fill(date);
  return { saved, item, session, date, title, dialog };
}

async function ask(page: Page, text: string) {
  const dialog = helper(page);
  await dialog.getByLabel("Message ADA helper", { exact: true }).fill(text);
  await dialog.getByRole("button", { name: "Send to ADA helper", exact: true }).click();
  const review = dialog.getByRole("region", { name: "Proposed schedule changes", exact: true });
  await expect(review).toBeVisible();
  return review;
}

async function saveChatChange(page: Page, text: string) {
  const review = await ask(page, text);
  await review.getByRole("button", { name: "Confirm schedule changes", exact: true }).click();
  const dialog = helper(page), card = savedCard(dialog);
  await expect(dialog.getByRole("log")).toContainText("Your schedule is updated");
  await expect(review).toHaveCount(0);
  await expect(card).toBeVisible();
  await expect(card).toContainText(/saved ada change/i);
  await expect(card.getByRole("button", { name: "Undo last change", exact: true })).toBeEnabled();
  const saved = await state(page.request), event = saved.events[0];
  expect(event.operationId).toMatch(/^chat-order-[a-f0-9]{40}$/);
  expect(event.actorId).toBe(saved.actor.id);
  expect(event.type).not.toBe("schedule_undone");
  expect(event.version).toBe(saved.version);
  for (const summary of event.summary) await expect(card).toContainText(summary);
  return { saved, event, card };
}

async function undo(page: Page, eventId: string) {
  const request = page.waitForRequest(request => request.url() === `${origin}/api/undo` && request.method() === "POST");
  await savedCard(helper(page)).getByRole("button", { name: "Undo last change", exact: true }).click();
  expect((await request).postDataJSON()).toEqual({ id: eventId });
  await expect(helper(page).getByRole("log")).toContainText("That ADA change was undone.");
  await expect(savedCard(helper(page))).toContainText("CHANGE UNDONE");
  await expect(savedCard(helper(page)).getByRole("button", { name: "Undo last change", exact: true })).toHaveCount(0);
  return state(page.request);
}

for (const [index, kind] of ["resize", "move", "add"].entries()) {
  test(`Undo last change restores the exact schedule before a confirmed ${kind}`, async ({ page }) => {
    const context = await seed(page, 200 + index * 12, kind === "add");
    const text = kind === "resize" ? `Reduce ${context.title} from 2 hours to 1 hour`
      : kind === "move" ? `Move ${context.title} from ${context.date} to ${futureDate(context.saved, 200 + index * 12 + 4)}`
        : `Add 1 hour to ${context.title} on ${context.date}`;
    const change = await saveChatChange(page, text);
    expect(change.event.before).toEqual(schedule(context.saved));
    expect(schedule(change.saved)).not.toEqual(schedule(context.saved));
    const restored = await undo(page, change.event.id);
    expect(schedule(restored)).toEqual(schedule(context.saved));
    expect(restored.version).toBe(change.saved.version + 1);
    expect(restored.events[0].type).toBe("schedule_undone");
    expect(restored.events.find(event => event.id === change.event.id)?.undoneBy).toBe(restored.events[0].id);
    expect(restored.notifications.filter(notification => notification.eventId === restored.events[0].id).every(notification => notification.status === "captured")).toBe(true);
    await expect(helper(page).getByRole("region", { name: "Proposed schedule changes", exact: true })).toHaveCount(0);
  });
}

test("the saved-change control survives reopen, New chat and reload, while preserving unsent drafts and pending previews", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const context = await seed(page, 240);
  const change = await saveChatChange(page, `Reduce ${context.title} from 2 hours to 1 hour`);
  await context.dialog.getByRole("button", { name: "Close ADA helper", exact: true }).click();
  let dialog = await open(page);
  await expect(savedCard(dialog).getByRole("button", { name: "Undo last change", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(savedCard(dialog)).toContainText(context.title);
  await expect(savedCard(dialog).getByRole("button", { name: "Undo last change", exact: true })).toBeEnabled();
  await page.reload();
  dialog = await open(page);
  await expect(savedCard(dialog)).toContainText(context.title);
  await expect(savedCard(dialog).getByRole("button", { name: "Undo last change", exact: true })).toBeEnabled();

  const draft = "Keep this unsent follow-up for review";
  await dialog.getByLabel("Message ADA helper", { exact: true }).fill(draft);
  await expect(savedCard(dialog).getByRole("button", { name: "Undo last change", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Close ADA helper", exact: true }).click();
  dialog = await open(page);
  await expect(dialog.getByLabel("Message ADA helper", { exact: true })).toHaveValue(draft);
  expect(schedule(await state(page.request))).toEqual(schedule(change.saved));
  await dialog.getByLabel("Message ADA helper", { exact: true }).fill("");
  await expect(savedCard(dialog).getByRole("button", { name: "Undo last change", exact: true })).toBeEnabled();
  await dialog.getByLabel("Day to discuss", { exact: true }).fill(context.date);
  const review = await ask(page, `Move ${context.title} from ${context.date} to ${futureDate(context.saved, 244)}`);
  await expect(savedCard(dialog).getByRole("button", { name: "Undo last change", exact: true })).toBeDisabled();
  await review.getByRole("button", { name: "Discard preview", exact: true }).click();
  await expect(savedCard(dialog).getByRole("button", { name: "Undo last change", exact: true })).toBeEnabled();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await savedCard(dialog).screenshot({ path: info.outputPath("persistent-mobile-ada-undo.png") });
  await page.screenshot({ path: info.outputPath("persistent-mobile-ada-undo-dialog.png"), fullPage: true });
  expect(schedule(await undo(page, change.event.id))).toEqual(schedule(context.saved));
});

test("a newer unrelated event rejects a stale Undo request and disables the refreshed control", async ({ page }) => {
  const context = await seed(page, 260);
  const change = await saveChatChange(page, `Reduce ${context.title} from 2 hours to 1 hour`);
  const unrelated = makeItem(change.saved, "Fictional unrelated later booking", {
    windowStart: futureDate(change.saved, 266), windowEnd: futureDate(change.saved, 266),
    estimatedMinutes: 60, remainingMinutes: 60,
  });
  const newer = await commit(page.request, await preview(page.request, [{ type: "create", item: unrelated, sessions: [exactSession(change.saved, unrelated, "09:00", "10:00")] }]));
  // The browser still holds the previous version, exercising server authority.
  await expect(change.card.getByRole("button", { name: "Undo last change", exact: true })).toBeEnabled();
  const response = page.waitForResponse(response => response.url() === `${origin}/api/undo` && response.request().method() === "POST");
  await change.card.getByRole("button", { name: "Undo last change", exact: true }).click();
  const rejected = await response;
  expect(rejected.request().postDataJSON()).toEqual({ id: change.event.id });
  expect(rejected.ok()).toBe(false);
  await expect(change.card.getByRole("button", { name: "Undo last change", exact: true })).toBeDisabled();
  await expect(change.card).toContainText(/newer|later|changed|latest/i);
  expect(await state(page.request)).toEqual(newer);
  await page.reload();
  const dialog = await open(page);
  await expect(savedCard(dialog).getByRole("button", { name: "Undo last change", exact: true })).toBeDisabled();
  await expect(savedCard(dialog)).toContainText(context.title);
});

test("requesters never receive the owner's saved-change card or undo control", async ({ page }) => {
  const context = await seed(page, 280);
  const change = await saveChatChange(page, `Reduce ${context.title} from 2 hours to 1 hour`);
  await asActor(page.request, "kyle");
  await page.reload();
  const dialog = await open(page);
  await expect(savedCard(dialog)).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Undo last change", exact: true })).toHaveCount(0);
  expect(schedule(await state(page.request))).toEqual(schedule(change.saved));
});

test("a lost successful Undo response is reconciled from state without a second undo", async ({ page }) => {
  const context = await seed(page, 300);
  const change = await saveChatChange(page, `Reduce ${context.title} from 2 hours to 1 hour`);
  const undoIds: string[] = [];
  let committed: AppState | undefined;
  await page.route(`${origin}/api/undo`, async route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ id: change.event.id });
    undoIds.push(route.request().postDataJSON().id);
    // Commit through the real demo route, then lose only its browser response.
    const response = await route.fetch({ maxRetries: 0 });
    expect(response.ok(), await response.text()).toBe(true);
    committed = (await response.json()).state as AppState;
    await route.abort("failed");
  });
  const refreshed = page.waitForResponse(response => response.url() === `${origin}/api/state` && response.request().method() === "GET");
  await change.card.getByRole("button", { name: "Undo last change", exact: true }).click();
  await refreshed;
  await expect(context.dialog.getByRole("log")).toContainText("That ADA change was undone.");
  await expect(change.card).toContainText("CHANGE UNDONE");
  await expect(change.card.getByRole("button", { name: "Undo last change", exact: true })).toHaveCount(0);
  const restored = await state(page.request);
  expect(committed).toBeDefined();
  expect(schedule(restored)).toEqual(schedule(context.saved));
  expect(restored.version).toBe(change.saved.version + 1);
  expect(restored.events.filter(event => event.operationId === `undo-${change.event.id}`)).toHaveLength(1);
  expect(undoIds).toEqual([change.event.id]);
  await context.dialog.getByRole("button", { name: "Close ADA helper", exact: true }).click();
  const dialog = await open(page);
  await expect(savedCard(dialog)).toContainText("CHANGE UNDONE");
  await expect(savedCard(dialog).getByRole("button", { name: "Undo last change", exact: true })).toHaveCount(0);
  expect(undoIds).toEqual([change.event.id]);
});
