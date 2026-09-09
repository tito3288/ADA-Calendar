import { expect, test, type Locator, type Page } from "@playwright/test";
import { asActor, commit, futureDate, makeItem, preview, state } from "./helpers";

async function fillBooking(form: Locator, title: string, date: string) {
  await form.getByRole("combobox", { name: "Client", exact: true }).selectOption("higher-ground");
  await form.getByLabel("What needs doing?").fill(title);
  await form.getByLabel("Hours to book", { exact: true }).fill("0.5");
  await form.getByLabel("Work day", { exact: true }).fill(date);
}

async function saveBooking(page: Page, form: Locator, requester = false) {
  const before = await state(page.request);
  await form.getByRole("button", { name: "Check schedule", exact: true }).click();
  await expect(form.getByRole("heading", { name: "This fits your schedule" })).toBeVisible();
  expect((await state(page.request)).version).toBe(before.version);
  await form.getByRole("button", { name: requester ? "Book this work" : "Confirm changes", exact: true }).click();
  await expect(form).toHaveCount(0);
  return state(page.request);
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000, days: 175 },
  { name: "mobile", width: 390, height: 844, days: 182 },
]) {
  test(`${viewport.name} owner can save the IT Urgent default or explicitly choose Normal`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await asActor(page.request, "bryan");
    const before = await state(page.request);
    const date = futureDate(before, viewport.days);
    await page.goto("/");
    await page.getByRole("button", { name: "Add work", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Make room for new work" });
    const category = form.getByRole("combobox", { name: "Work category", exact: true });
    const priority = form.getByRole("combobox", { name: "Priority", exact: true });
    // Until a priority is explicitly chosen, changing category updates its default.
    await category.selectOption("it");
    await expect(priority).toHaveValue("urgent");
    await category.selectOption("web-edit");
    await expect(priority).toHaveValue("normal");
    await category.selectOption("it");
    const urgentTitle = `E2E ${viewport.name} default urgent IT`;
    await fillBooking(form, urgentTitle, date);
    await expect(priority).toHaveValue("urgent");
    await priority.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-it-priority.png`), fullPage: true });
    const urgentSaved = await saveBooking(page, form);
    const urgentWork = urgentSaved.items.find(item => item.title === urgentTitle)!;
    expect(urgentWork).toMatchObject({ category: "it", priorityId: "urgent", requesterId: "bryan" });
    expect(urgentSaved.sessions.filter(session => session.workItemId === urgentWork.id && session.status === "planned")).toHaveLength(1);

    await page.getByRole("button", { name: "Add work", exact: true }).click();
    await category.selectOption("it");
    await priority.selectOption("normal");
    // An explicit Normal choice survives subsequent category changes.
    await category.selectOption("web-edit");
    await category.selectOption("it");
    await expect(priority).toHaveValue("normal");
    const normalTitle = `E2E ${viewport.name} explicit normal IT`;
    await fillBooking(form, normalTitle, date);
    const normalSaved = await saveBooking(page, form);
    const normalWork = normalSaved.items.find(item => item.title === normalTitle)!;
    expect(normalWork).toMatchObject({ category: "it", priorityId: "normal", requesterId: "bryan" });

    await page.goto(`/?work=${normalWork.id}`);
    await page.getByRole("dialog").getByRole("button", { name: "Edit work", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Edit work" }).getByRole("combobox", { name: "Priority", exact: true })).toHaveValue("normal");
  });
}

test("requester IT suggests Urgent while a clean-fit booking retains Normal effective priority", async ({ page }) => {
  await asActor(page.request, "william");
  const before = await state(page.request);
  await page.goto("/");
  await page.getByRole("button", { name: "Request work", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Find an opening" });
  await form.getByRole("combobox", { name: "Work category", exact: true }).selectOption("it");
  await expect(form.getByRole("combobox", { name: "Suggested priority", exact: true })).toHaveValue("urgent");
  const title = "E2E requester IT advisory urgent";
  await fillBooking(form, title, futureDate(before, 189));
  const after = await saveBooking(page, form, true);
  expect(after.items.find(item => item.title === title)).toMatchObject({
    category: "it", requesterId: "william", requestedPriorityId: "urgent", priorityId: "normal",
  });
});

test("changing existing Normal work to IT preserves its saved priority", async ({ page }) => {
  await asActor(page.request, "bryan");
  const before = await state(page.request);
  const date = futureDate(before, 196);
  const work = makeItem(before, "E2E existing Normal work becomes IT", {
    category: "web", webKind: "edit", priorityId: "normal", windowStart: date, windowEnd: date,
  });
  const booked = await commit(page.request, await preview(page.request, [{ type: "create", item: work }]));
  await page.goto(`/?work=${work.id}`);
  await page.getByRole("dialog").getByRole("button", { name: "Edit work", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Edit work" });
  await form.getByRole("combobox", { name: "Work category", exact: true }).selectOption("it");
  await expect(form.getByRole("combobox", { name: "Priority", exact: true })).toHaveValue("normal");
  const after = await saveBooking(page, form);
  expect(after.items.find(item => item.id === work.id)).toMatchObject({ category: "it", priorityId: "normal" });
  expect(after.sessions.filter(session => session.workItemId === work.id)).toEqual(booked.sessions.filter(session => session.workItemId === work.id));
});
