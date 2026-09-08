import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AppState } from "../../src/lib/types";
import { asActor, origin, state } from "./helpers";

// Only the isolated local demo server may mutate these fictional clients.
// Its provider credentials are cleared and its mail is captured, never sent.
test.beforeEach(async ({ page, baseURL }) => {
  expect(baseURL).toBe(origin);
  await asActor(page.request, "bryan");
  expect((await state(page.request)).mode).toBe("demo");
  await page.goto("/");
});

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

async function createFictionalClient(page: Page, aliases: string) {
  const name = `E2E Pine Ridge Studio ${randomUUID().slice(0, 8)}`;
  const dialog = await openDirectory(page);
  await dialog.getByLabel("New client name", { exact: true }).fill(name);
  await dialog.getByLabel("Aliases", { exact: true }).fill(aliases);
  const saved = await saveDirectory(page, dialog);
  return { name, dialog, saved };
}

function expectCalendarUnchanged(before: AppState, after: AppState) {
  expect(after.items).toEqual(before.items);
  expect(after.sessions).toEqual(before.sessions);
  expect(after.blocks).toEqual(before.blocks);
  expect(after.events).toEqual(before.events);
  expect(after.notifications).toEqual(before.notifications);
  expect(after.requests).toEqual(before.requests);
  expect(after.emailDrafts).toEqual(before.emailDrafts);
}

test("existing aliases retain spaces and commas while typing, then persist normalized aliases", async ({ page }, testInfo) => {
  const original = await state(page.request);
  const { name, dialog, saved: before } = await createFictionalClient(page, "PR");
  const input = dialog.getByLabel(`Aliases for ${name}`, { exact: true });
  await input.focus();
  await input.press("End");

  // Check the intermediate keystrokes that previously vanished before the
  // next word or alias could be entered. Filling a complete string misses it.
  await input.pressSequentially(", ");
  await expect(input).toHaveValue("PR, ");
  await input.pressSequentially("Pine ");
  await expect(input).toHaveValue("PR, Pine ");
  await input.pressSequentially("Ridge, , Cedar Grove,  ");
  await expect(input).toHaveValue("PR, Pine Ridge, , Cedar Grove,  ");
  await expect(dialog.getByText("Saved.", { exact: true })).toHaveCount(0);
  expect((await state(page.request)).clients).toEqual(before.clients);
  await input.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("existing-aliases-raw-draft.png"), fullPage: true });

  const saved = await saveDirectory(page, dialog);
  const edited = saved.clients.find((client) => client.name === name)!;
  expect(edited.aliases).toEqual(["PR", "Pine Ridge", "Cedar Grove"]);
  expect(saved.clients).toEqual(before.clients.map((client) => client.id === edited.id ? { ...client, aliases: edited.aliases } : client));
  expectCalendarUnchanged(original, saved);
  await expect(input).toHaveValue("PR, Pine Ridge, Cedar Grove");
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();

  let reopened = await openDirectory(page);
  await expect(reopened.getByLabel(`Aliases for ${name}`, { exact: true })).toHaveValue("PR, Pine Ridge, Cedar Grove");
  await reopened.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.reload();
  reopened = await openDirectory(page);
  await expect(reopened.getByLabel(`Aliases for ${name}`, { exact: true })).toHaveValue("PR, Pine Ridge, Cedar Grove");
  const refreshed = await state(page.request);
  expect(refreshed.clients).toEqual(saved.clients);
  expectCalendarUnchanged(original, refreshed);
});

test("existing aliases can be cleared and stay empty after saving and reloading", async ({ page }) => {
  const original = await state(page.request);
  const { name, dialog, saved: before } = await createFictionalClient(page, "Pine Ridge, PR Studio");
  const input = dialog.getByLabel(`Aliases for ${name}`, { exact: true });
  await input.fill("");
  await expect(input).toHaveValue("");
  const saved = await saveDirectory(page, dialog);
  const edited = saved.clients.find((client) => client.name === name)!;
  expect(edited.aliases).toEqual([]);
  expect(saved.clients).toEqual(before.clients.map((client) => client.id === edited.id ? { ...client, aliases: [] } : client));
  expectCalendarUnchanged(original, saved);
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.reload();
  const reopened = await openDirectory(page);
  await expect(reopened.getByLabel(`Aliases for ${name}`, { exact: true })).toHaveValue("");
  expect((await state(page.request)).clients).toEqual(saved.clients);
});

test("a failed existing-alias save retains the exact raw draft for a successful retry", async ({ page }) => {
  const original = await state(page.request);
  const { name, dialog, saved: before } = await createFictionalClient(page, "Pine Ridge");
  const input = dialog.getByLabel(`Aliases for ${name}`, { exact: true });
  await input.focus();
  await input.press("End");
  await input.pressSequentially(",  Alternate Studio, ");
  const rawDraft = "Pine Ridge,  Alternate Studio, ";
  await expect(input).toHaveValue(rawDraft);

  const error = "Update workspace: Workspace changed. Refresh before editing.";
  await page.route("**/api/admin", async (route) => {
    const payload = route.request().postDataJSON();
    expect(payload.type).toBe("clients");
    expect(payload.clients).toHaveLength(before.clients.length);
    expect(payload.clients.find((client: { name: string }) => client.name === name).aliases).toEqual(["Pine Ridge", "Alternate Studio"]);
    await route.fulfill({ status: 409, json: { error } });
  });
  const pending = directoryResponse(page);
  await dialog.getByRole("button", { name: "Save directory", exact: true }).click();
  expect((await pending).status()).toBe(409);
  await expect(dialog.getByText(error, { exact: true })).toBeVisible();
  await expect(dialog.getByText("Saved.", { exact: true })).toHaveCount(0);
  await expect(input).toHaveValue(rawDraft);
  await expect(input).toBeEnabled();
  const rejected = await state(page.request);
  expect(rejected.clients).toEqual(before.clients);
  expectCalendarUnchanged(original, rejected);

  await page.unroute("**/api/admin");
  const saved = await saveDirectory(page, dialog);
  expect(saved.clients.find((client) => client.name === name)?.aliases).toEqual(["Pine Ridge", "Alternate Studio"]);
  await expect(input).toHaveValue("Pine Ridge, Alternate Studio");
  await expect(dialog.getByText(error, { exact: true })).toHaveCount(0);
  expectCalendarUnchanged(original, saved);
});
