import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AppState } from "../../src/lib/types";
import { asActor, origin, state } from "./helpers";

// Only the dedicated demo server may run these directory mutations. It uses
// .data-e2e and captured messages, with all live provider credentials cleared.
test.beforeEach(async ({ page, baseURL }) => {
  expect(baseURL).toBe(origin);
  await asActor(page.request, "bryan");
  expect((await state(page.request)).mode).toBe("demo");
  await page.goto("/");
});

const newName = (description: string) => `E2E ${description} ${randomUUID().slice(0, 8)}`;

async function openDirectory(page: Page) {
  const navigation = page.getByRole("button", { name: "Open navigation", exact: true });
  if (await navigation.isVisible()) await navigation.click();
  await page.getByRole("button", { name: "Manage clients", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "clients", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Your client directory", exact: true })).toBeVisible();
  return dialog;
}

function directoryResponse(page: Page) {
  return page.waitForResponse((response) => (
    response.url() === `${origin}/api/admin`
    && response.request().method() === "POST"
    && response.request().postDataJSON()?.type === "clients"
  ));
}

async function saveDirectory(page: Page, dialog: Locator) {
  const pending = directoryResponse(page);
  await dialog.getByRole("button", { name: "Save directory", exact: true }).click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(dialog.getByText("Saved.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save directory", exact: true })).toBeEnabled();
  return (await response.json() as { state: AppState }).state;
}

function expectCalendarUnchanged(before: AppState, after: AppState) {
  expect(after.items).toEqual(before.items);
  expect(after.sessions).toEqual(before.sessions);
  expect(after.blocks).toEqual(before.blocks);
  expect(after.events).toEqual(before.events);
  expect(after.notifications).toEqual(before.notifications);
}

test("Save directory includes a typed client with blank aliases and persists after reopen and refresh", async ({ page }, testInfo) => {
  const before = await state(page.request);
  const name = newName("direct-save client");
  let dialog = await openDirectory(page);
  await dialog.getByLabel("New client name", { exact: true }).fill(name);
  await expect(dialog.getByLabel("Aliases", { exact: true })).toHaveValue("");
  const saved = await saveDirectory(page, dialog);
  const matches = saved.clients.filter((client) => client.name === name);
  expect(matches).toHaveLength(1);
  expect(matches[0].aliases).toEqual([]);
  expect(saved.clients).toEqual([...before.clients, matches[0]]);
  expectCalendarUnchanged(before, saved);
  await expect(dialog.getByLabel("New client name", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("Aliases", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel(`Name for ${name}`, { exact: true })).toHaveValue(name);

  // Repeated save must not re-add the already consumed new-client draft.
  const repeated = await saveDirectory(page, dialog);
  expect(repeated.clients).toEqual(saved.clients);
  await dialog.getByLabel(`Name for ${name}`, { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("saved-client-directory.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(page.getByTitle(name, { exact: true })).toBeVisible();

  dialog = await openDirectory(page);
  await expect(dialog.getByLabel(`Name for ${name}`, { exact: true })).toHaveValue(name);
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.reload();
  await expect(page.getByTitle(name, { exact: true })).toBeVisible();
  expect((await state(page.request)).clients).toEqual(saved.clients);
});

test("Add client followed by Save directory keeps the legacy flow without duplicates", async ({ page }) => {
  const before = await state(page.request);
  const name = newName("staged client");
  const dialog = await openDirectory(page);
  await dialog.getByLabel("New client name", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "Add client", exact: true }).click();
  await expect(dialog.getByLabel(`Name for ${name}`, { exact: true })).toHaveValue(name);
  await expect(dialog.getByLabel("New client name", { exact: true })).toHaveValue("");
  expect((await state(page.request)).clients).toEqual(before.clients);

  const saved = await saveDirectory(page, dialog);
  expect(saved.clients.filter((client) => client.name === name)).toHaveLength(1);
  expect(saved.clients).toHaveLength(before.clients.length + 1);
  const repeated = await saveDirectory(page, dialog);
  expect(repeated.clients).toEqual(saved.clients);
  expectCalendarUnchanged(before, repeated);
});

test("Save directory includes staged additions and a final unstaged draft once each", async ({ page }) => {
  const before = await state(page.request);
  const stagedName = newName("batch staged");
  const finalName = newName("batch final draft");
  const dialog = await openDirectory(page);
  await dialog.getByLabel("New client name", { exact: true }).fill(stagedName);
  await dialog.getByRole("button", { name: "Add client", exact: true }).click();
  await dialog.getByLabel("New client name", { exact: true }).fill(finalName);
  const saved = await saveDirectory(page, dialog);
  expect(saved.clients.filter((client) => client.name === stagedName)).toHaveLength(1);
  expect(saved.clients.filter((client) => client.name === finalName)).toHaveLength(1);
  expect(saved.clients).toHaveLength(before.clients.length + 2);
  expectCalendarUnchanged(before, saved);
});

test("direct save trims the client name and optional comma-separated aliases", async ({ page }) => {
  const name = newName("alias client");
  const dialog = await openDirectory(page);
  await dialog.getByLabel("New client name", { exact: true }).fill(`  ${name}  `);
  await dialog.getByLabel("Aliases", { exact: true }).fill("  Short name  , ,  Alternate name,  ");
  const saved = await saveDirectory(page, dialog);
  const matches = saved.clients.filter((client) => client.name === name);
  expect(matches).toHaveLength(1);
  expect(matches[0].aliases).toEqual(["Short name", "Alternate name"]);
  await expect(dialog.getByLabel(`Aliases for ${name}`, { exact: true })).toHaveValue("Short name, Alternate name");
  await expect(dialog.getByLabel("Aliases", { exact: true })).toHaveValue("");
});

test("aliases without a new name stay unsaved, then Enter saves after the name is supplied", async ({ page }) => {
  const before = await state(page.request);
  const name = newName("keyboard client");
  const dialog = await openDirectory(page);
  await dialog.getByLabel("Aliases", { exact: true }).fill("Keyboard alias");
  await dialog.getByRole("button", { name: "Save directory", exact: true }).click();
  await expect(dialog.getByText("Enter a new client name for these aliases before saving.", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Aliases", { exact: true })).toHaveValue("Keyboard alias");
  await expect(dialog.getByText("Saved.", { exact: true })).toHaveCount(0);
  expect((await state(page.request)).clients).toEqual(before.clients);

  const input = dialog.getByLabel("New client name", { exact: true });
  await input.fill(name);
  const pending = directoryResponse(page);
  await input.press("Enter");
  expect((await pending).ok()).toBe(true);
  await expect(dialog.getByText("Saved.", { exact: true })).toBeVisible();
  const saved = await state(page.request);
  const matches = saved.clients.filter((client) => client.name === name);
  expect(matches).toHaveLength(1);
  expect(matches[0].aliases).toEqual(["Keyboard alias"]);
  expectCalendarUnchanged(before, saved);
});

test("editing a new draft or directory row clears the old Saved notice", async ({ page }) => {
  const name = newName("notice client");
  const dialog = await openDirectory(page);
  await saveDirectory(page, dialog);
  await dialog.getByLabel("New client name", { exact: true }).fill(name);
  await expect(dialog.getByText("Saved.", { exact: true })).toHaveCount(0);
  await saveDirectory(page, dialog);
  await dialog.getByLabel("Aliases", { exact: true }).fill("Unsaved draft alias");
  await expect(dialog.getByText("Saved.", { exact: true })).toHaveCount(0);
  await dialog.getByLabel("Aliases", { exact: true }).fill("");
  await saveDirectory(page, dialog);
  await dialog.getByLabel(`Aliases for ${name}`, { exact: true }).fill("Changed alias");
  await expect(dialog.getByText("Saved.", { exact: true })).toHaveCount(0);
  await saveDirectory(page, dialog);
  await dialog.getByLabel(`Name for ${name}`, { exact: true }).fill(`${name} edited`);
  await expect(dialog.getByText("Saved.", { exact: true })).toHaveCount(0);
});

test("a rejected save retains both the pending client and staged edits without a success notice", async ({ page }) => {
  const before = await state(page.request);
  const stagedName = newName("retained staged client");
  const name = newName("retained draft client");
  const dialog = await openDirectory(page);
  await saveDirectory(page, dialog);
  await dialog.getByLabel("New client name", { exact: true }).fill(stagedName);
  await dialog.getByRole("button", { name: "Add client", exact: true }).click();
  await dialog.getByLabel("New client name", { exact: true }).fill(name);
  await dialog.getByLabel("Aliases", { exact: true }).fill("  Keep this alias  ");

  const error = "Update workspace: Workspace changed. Refresh before editing.";
  await page.route("**/api/admin", async (route) => {
    const input = route.request().postDataJSON();
    expect(input.type).toBe("clients");
    expect(input.clients.filter((client: { name: string }) => client.name === stagedName)).toHaveLength(1);
    expect(input.clients.filter((client: { name: string }) => client.name === name)).toHaveLength(1);
    await route.fulfill({ status: 409, json: { error } });
  });
  const pending = directoryResponse(page);
  await dialog.getByRole("button", { name: "Save directory", exact: true }).click();
  expect((await pending).status()).toBe(409);
  await expect(dialog.getByText(error, { exact: true })).toBeVisible();
  await expect(dialog.getByText("Saved.", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel(`Name for ${stagedName}`, { exact: true })).toHaveValue(stagedName);
  await expect(dialog.getByLabel("New client name", { exact: true })).toHaveValue(name);
  await expect(dialog.getByLabel("Aliases", { exact: true })).toHaveValue("  Keep this alias  ");
  await expect(dialog.getByRole("button", { name: "Save directory", exact: true })).toBeEnabled();
  const after = await state(page.request);
  expect(after.clients).toEqual(before.clients);
  expectCalendarUnchanged(before, after);
});

test("mobile direct save locks inputs and ignores concurrent form submissions", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const name = newName("mobile single-save client");
  const dialog = await openDirectory(page);
  const nameInput = dialog.getByLabel("New client name", { exact: true });
  await nameInput.fill(name);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  await page.route("**/api/admin", async (route) => {
    calls++;
    await gate;
    await route.continue();
  });
  const pending = directoryResponse(page);
  try {
    await dialog.getByRole("button", { name: "Save directory", exact: true }).click();
    await expect.poll(() => calls).toBe(1);
    await expect(nameInput).toBeDisabled();
    await expect(dialog.getByLabel("Aliases", { exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Add client", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Save directory", exact: true })).toBeDisabled();
    // Simulate repeated submission events while the first request is in flight.
    await dialog.locator("form").evaluate((form: HTMLFormElement) => {
      form.requestSubmit();
      form.requestSubmit();
    });
  } finally {
    release();
  }
  expect((await pending).ok()).toBe(true);
  await expect(dialog.getByText("Saved.", { exact: true })).toBeVisible();
  await expect(nameInput).toBeEnabled();
  expect(calls).toBe(1);
  expect((await state(page.request)).clients.filter((client) => client.name === name)).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("mobile-saved-client-directory.png"), fullPage: true });
});
