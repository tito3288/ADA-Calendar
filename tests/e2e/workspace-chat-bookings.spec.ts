import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { addDays, localDate, minutesBetween } from "../../src/lib/time";
import { asActor, commit, exactSession, futureDate, makeItem, preview, state } from "./helpers";

// Full browser → chat route → deterministic demo interpreter → scheduler →
// captured transaction. All seed work lives only in the isolated .data-e2e store.
async function seed(page: Page, offset: number, waiting = false) {
  await asActor(page.request, "bryan");
  const snapshot = await state(page.request), date = futureDate(snapshot, offset);
  const title = `Fictional Cedar booking ${offset}`;
  const item = makeItem(snapshot, title, { windowStart: date, minimumSessionMinutes: 120, category: "web", webKind: "build",
    remainingMinutes: waiting ? null : 120, estimatedMinutes: waiting ? null : 120,
    status: waiting ? "waiting" : "planned", blockedReason: waiting ? "Waiting for client details" : null });
  const sessions = waiting ? [] : [exactSession(snapshot, item, "09:00", "11:00")];
  const proposal = await preview(page.request, [{ type: "create", item, sessions }]);
  expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
  const saved = await commit(page.request, proposal);
  await page.goto("/");
  await page.getByRole("button", { name: "Open ADA helper", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "ADA helper", exact: true });
  await dialog.getByLabel("Day to discuss").fill(date);
  return { item, sessions, saved, date, title, dialog };
}
async function ask(page: Page, text: string) {
  await page.getByLabel("Message ADA helper").fill(text);
  await page.getByRole("button", { name: "Send to ADA helper", exact: true }).click();
  await expect(page.getByLabel("Message ADA helper")).toBeEnabled();
}

for (const width of [1440, 390]) test(`changes a booked day's hours and remaining total while preserving the original estimate at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
  const context = await seed(page, width === 1440 ? 100 : 110);
  await ask(page, `Set ${context.title} to 1 hour on ${context.date}`);
  const review = context.dialog.getByRole("region", { name: "Proposed schedule changes" });
  await expect(review, await context.dialog.innerText()).toBeVisible();
  await expect(review).toContainText("1h freed");
  await expect(review).toContainText("2h → 1h");
  await expect(review).toContainText("estimate");
  expect((await state(page.request)).sessions).toEqual(context.saved.sessions);
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual([]);
  expect(await context.dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath(`booking-hours-preview-${width}.png`) });
  await review.getByRole("button", { name: "Confirm schedule changes", exact: true }).click();
  await expect(context.dialog.getByRole("log")).toContainText("Your schedule is updated");
  const saved = await state(page.request), booking = saved.sessions.find(session => session.id === context.sessions[0].id)!;
  expect(minutesBetween(booking.start, booking.end)).toBe(60);
  expect(saved.items.find(item => item.id === context.item.id)).toMatchObject({ remainingMinutes: 60, estimatedMinutes: 120, minimumSessionMinutes: 120 });
  expect(saved.sessions.filter(session => session.workItemId !== context.item.id)).toEqual(context.saved.sessions.filter(session => session.workItemId !== context.item.id));
  // The advanced manual editor must preserve the shorter booking without
  // requiring a focus exception or refilling released hours.
  await context.dialog.getByRole("button", { name: "Close ADA helper" }).click();
  const menu = page.getByRole("button", { name: "Open navigation", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: "All work", exact: true }).click();
  await page.getByLabel("Search work").fill(context.title);
  await page.getByRole("button", { name: new RegExp(context.title) }).click();
  const details = page.getByRole("dialog", { name: context.title, exact: true });
  await details.getByRole("button", { name: "Edit hours", exact: true }).click();
  await details.getByText("Advanced", { exact: true }).click();
  await details.getByLabel("Set exact times", { exact: true }).check();
  await details.getByLabel("Session 1 start", { exact: true }).fill("10:00");
  await details.getByLabel("Session 1 end", { exact: true }).fill("11:00");
  await details.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(details.getByRole("heading", { name: "This fits your schedule" })).toBeVisible();
  await details.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(details.getByRole("heading", { name: "Edit hours", exact: true })).toHaveCount(0);
  const manuallyMoved = (await state(page.request)).sessions.filter(session => session.workItemId === context.item.id);
  expect(manuallyMoved).toHaveLength(1);
  expect(minutesBetween(manuallyMoved[0].start, manuallyMoved[0].end)).toBe(60);
  expect(manuallyMoved[0].focusOverrideMinutes).toBeUndefined();
});

test("adds hours to an existing waiting project without turning them into its estimate", async ({ page }) => {
  const context = await seed(page, 120, true);
  await ask(page, `Add 1 hour to ${context.title} on ${context.date}`);
  const review = context.dialog.getByRole("region", { name: "Proposed schedule changes" });
  await expect(review, await context.dialog.innerText()).toBeVisible();
  await expect(review).toContainText("1h added");
  await expect(review).toContainText(/resum/i);
  await expect(review).toContainText("Not booked");
  expect((await state(page.request)).items.find(item => item.id === context.item.id)!.status).toBe("waiting");
  await review.getByRole("button", { name: "Confirm schedule changes" }).click();
  await expect(context.dialog.getByRole("log")).toContainText("Your schedule is updated");
  const saved = await state(page.request);
  expect(saved.items).toHaveLength(context.saved.items.length);
  expect(saved.items.find(item => item.id === context.item.id)).toMatchObject({ estimatedMinutes: null, remainingMinutes: null, status: "planned" });
  expect(saved.sessions.filter(session => session.workItemId === context.item.id).map(session => minutesBetween(session.start, session.end))).toEqual([60]);
});

test("moves an existing booking to another day and shows both days before confirmation", async ({ page }) => {
  const context = await seed(page, 130), target = futureDate(context.saved, 137);
  await ask(page, `Move ${context.title} from ${context.date} to ${target}`);
  const review = context.dialog.getByRole("region", { name: "Proposed schedule changes" });
  await expect(review, await context.dialog.innerText()).toBeVisible();
  await expect(review).toContainText("Same hours");
  await expect(review.getByLabel("Daily availability after these changes").locator("p")).toHaveCount(2);
  expect((await state(page.request)).sessions).toEqual(context.saved.sessions);
  await review.getByRole("button", { name: "Confirm schedule changes" }).click();
  await expect(context.dialog.getByRole("log")).toContainText("Your schedule is updated");
  const saved = await state(page.request), booking = saved.sessions.find(session => session.id === context.sessions[0].id)!;
  expect(localDate(booking.start, saved.settings.timeZone)).toBe(target);
  expect(minutesBetween(booking.start, booking.end)).toBe(120);
  expect(saved.sessions.map(session => session.id).sort()).toEqual(context.saved.sessions.map(session => session.id).sort());
});

test("transfers part of a booking to another day without adding work hours", async ({ page }) => {
  const context = await seed(page, 145), target = futureDate(context.saved, 152);
  await ask(page, `Move 1 hour of ${context.title} from ${context.date} to ${target}`);
  const review = context.dialog.getByRole("region", { name: "Proposed schedule changes" });
  await expect(review, await context.dialog.innerText()).toBeVisible();
  await expect(review).toContainText("Same hours");
  await review.getByRole("button", { name: "Confirm schedule changes" }).click();
  await expect(context.dialog.getByRole("log")).toContainText("Your schedule is updated");
  const saved = await state(page.request), sessions = saved.sessions.filter(session => session.workItemId === context.item.id);
  expect(sessions.map(session => minutesBetween(session.start, session.end))).toEqual([60, 60]);
  expect(sessions.map(session => localDate(session.start, saved.settings.timeZone)).sort()).toEqual([context.date, target]);
  expect(sessions.some(session => session.id === context.sessions[0].id)).toBe(true);
  expect(saved.items.find(item => item.id === context.item.id)!.remainingMinutes).toBe(120);
});

test("a failed destination never removes the original booking", async ({ page }) => {
  const context = await seed(page, 160);
  // Choose the weekend following the source working day, regardless of test date.
  let target = addDays(context.date, 1);
  while (![0, 6].includes(new Date(`${target}T12:00:00Z`).getUTCDay())) target = addDays(target, 1);
  await ask(page, `Move ${context.title} from ${context.date} to ${target}`);
  await expect(context.dialog.getByRole("button", { name: "Confirm schedule changes" })).toHaveCount(0);
  await expect(context.dialog.getByRole("log")).toContainText(/fit|working|weekend|available/i);
  expect((await state(page.request)).sessions).toEqual(context.saved.sessions);
});

test("sets unequal hours across two days atomically, then removes one day without completing the project", async ({ page }) => {
  const context = await seed(page, 170), target = futureDate(context.saved, 177);
  await ask(page, `Set ${context.title} to 1 hour on ${context.date} and 2 hours on ${target}`);
  const review = context.dialog.getByRole("region", { name: "Proposed schedule changes" });
  await expect(review, await context.dialog.innerText()).toBeVisible();
  expect((await state(page.request)).sessions).toEqual(context.saved.sessions);
  await review.getByRole("button", { name: "Confirm schedule changes" }).click();
  await expect(context.dialog.getByRole("log")).toContainText("Your schedule is updated");
  let saved = await state(page.request);
  const hours = (date: string) => saved.sessions.filter(session => session.workItemId === context.item.id && localDate(session.start, saved.settings.timeZone) === date).reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0);
  expect(hours(context.date)).toBe(60); expect(hours(target)).toBe(120);
  expect(saved.items.find(item => item.id === context.item.id)).toMatchObject({ remainingMinutes: 180, estimatedMinutes: 120, status: "planned" });
  await ask(page, `Set ${context.title} to 0 hours on ${context.date}`);
  await expect(review, await context.dialog.innerText()).toBeVisible();
  await review.getByRole("button", { name: "Confirm schedule changes" }).click();
  await expect(review).toHaveCount(0);
  saved = await state(page.request);
  expect(hours(context.date)).toBe(0); expect(hours(target)).toBe(120);
  expect(saved.items.find(item => item.id === context.item.id)).toMatchObject({ remainingMinutes: 120, estimatedMinutes: 120, status: "planned", completedAt: null });
});
