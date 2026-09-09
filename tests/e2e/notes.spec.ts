import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { asActor, origin, post, state } from "./helpers";
import type { PersonalNote } from "../../src/lib/notes";

async function navigate(page: Page, name: "Notes" | "Calendar") {
  const mobile = page.getByRole("button", { name: "Open navigation", exact: true });
  if (await mobile.isVisible()) await mobile.click();
  await page.getByRole("button", { name, exact: true }).click();
}
async function openNotes(page: Page) {
  await page.goto("/");
  await navigate(page, "Notes");
  await expect(page.getByRole("heading", { name: "A place for your notes." })).toBeVisible();
  await expect(page.getByRole("button", { name: "New note", exact: true })).toBeEnabled();
}
async function savedNotes(page: Page): Promise<PersonalNote[]> {
  const result = await page.request.get("/api/notes");
  expect(result.ok()).toBeTruthy();
  return (await result.json()).notes;
}
function calendarOnly(snapshot: Awaited<ReturnType<typeof state>>) {
  return { version: snapshot.version, items: snapshot.items, sessions: snapshot.sessions,
    events: snapshot.events, notifications: snapshot.notifications, requests: snapshot.requests };
}

// These tests write only to the isolated .data-e2e demo fixture. External
// provider credentials are blank in playwright.config.ts; no live data or mail.
for (const width of [1440, 390]) test(`independent private notes persist and reopen at ${width}px`, async ({ page }, info) => {
  await asActor(page.request, "bryan");
  const before = await state(page.request);
  expect(before.mode).toBe("demo");
  const title = `Websites to Build from Scratch (${width}px fixture)`;
  const secondTitle = `Ideas for next month (${width}px fixture)`;
  const body = "First client website\n\nSecond client website\nKeep this spacing.  ";
  await page.setViewportSize({ width, height: 1000 });
  await openNotes(page);
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Note", { exact: true }).fill(body);
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.locator(".notes-save-status")).toHaveText("Saved");
  const first = (await savedNotes(page)).find(note => note.title === title)!;
  expect(first.body).toBe(body);

  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill(secondTitle);
  await page.getByLabel("Note", { exact: true }).fill("A separate note, not a replacement.");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.locator(".notes-save-status")).toHaveText("Saved");
  const directory = page.getByRole("complementary", { name: "Saved notes" });
  await directory.getByRole("button", { name: new RegExp(title.replace(/[()]/g, "\\$&")) }).click();
  await expect(page.getByLabel("Note", { exact: true })).toHaveValue(body);
  await page.getByLabel("Note", { exact: true }).fill(body + "\nThird client website");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.locator(".notes-save-status")).toHaveText("Saved");
  const notes = await savedNotes(page);
  expect(notes.find(note => note.id === first.id)?.version).toBe(2);
  expect(notes.filter(note => note.title === title)).toHaveLength(1);
  expect(notes.find(note => note.title === secondTitle)?.body).toBe("A separate note, not a replacement.");
  await page.locator(".notes-panel").screenshot({ path: info.outputPath(`notes-${width}.png`) });
  expect((await new AxeBuilder({ page }).include(".notes-panel").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();

  await page.reload();
  await navigate(page, "Notes");
  await directory.getByRole("button", { name: new RegExp(title.replace(/[()]/g, "\\$&")) }).click();
  await expect(page.getByLabel("Note", { exact: true })).toHaveValue(body + "\nThird client website");
  const after = await state(page.request);
  expect(calendarOnly(after)).toEqual(calendarOnly(before));
  expect(JSON.stringify(after)).not.toContain(title);
});

test("drafts survive calendar navigation, failed saves, and confirmed note switching", async ({ page }) => {
  await asActor(page.request, "bryan");
  await openNotes(page);
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Unsaved private draft fixture");
  await page.getByLabel("Note", { exact: true }).fill("Do not lose these edits.");
  await navigate(page, "Calendar");
  await navigate(page, "Notes");
  await expect(page.getByLabel("Note", { exact: true })).toHaveValue("Do not lose these edits.");
  await page.getByRole("button", { name: "New note", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Keep your unsaved edits?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Unsaved private draft fixture");
  await page.route(`${origin}/api/notes`, route => route.request().method() === "POST"
    ? route.fulfill({ status: 503, json: { error: "Temporary local fixture failure. Please retry." } }) : route.continue());
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.locator(".notes-panel").getByRole("alert")).toContainText("Please retry");
  await expect(page.getByLabel("Note", { exact: true })).toHaveValue("Do not lose these edits.");
  await page.unroute(`${origin}/api/notes`);
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.locator(".notes-save-status")).toHaveText("Saved");
  await page.getByLabel("Note", { exact: true }).fill("Unsaved change to discard.");
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await confirm.getByRole("button", { name: "Discard edits", exact: true }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue("");
  expect((await savedNotes(page)).find(note => note.title === "Unsaved private draft fixture")?.body).toBe("Do not lose these edits.");
});

test("stale saves keep both versions and allow saving the draft separately", async ({ page }) => {
  await asActor(page.request, "bryan");
  await openNotes(page);
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Concurrency fixture");
  await page.getByLabel("Note", { exact: true }).fill("Original text");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.locator(".notes-save-status")).toHaveText("Saved");
  const original = (await savedNotes(page)).find(note => note.title === "Concurrency fixture")!;
  expect((await post(page.request, "notes", { id: original.id, title: original.title, body: "Saved from another window", expectedVersion: original.version })).ok()).toBeTruthy();
  await page.getByLabel("Note", { exact: true }).fill("Draft from this window");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.locator(".notes-panel").getByRole("alert")).toContainText("changed in another window");
  await expect(page.getByLabel("Note", { exact: true })).toHaveValue("Draft from this window");
  await page.getByRole("button", { name: "Keep edits as a new note", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Separate recovered draft fixture");
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.locator(".notes-save-status")).toHaveText("Saved");
  const all = await savedNotes(page);
  expect(all.find(note => note.id === original.id)?.body).toBe("Saved from another window");
  expect(all.find(note => note.title === "Separate recovered draft fixture")?.body).toBe("Draft from this window");
});

test("requesters and viewers cannot see personal notes or access their endpoint", async ({ page }) => {
  for (const actor of ["kyle", "william", "viewer"] as const) {
    await asActor(page.request, actor);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Notes", exact: true })).toHaveCount(0);
    expect((await page.request.get("/api/notes")).status()).toBe(403);
    expect((await post(page.request, "notes", { id: "not-authorized", title: "Denied", body: "", expectedVersion: 0 })).status()).toBe(403);
    expect(JSON.stringify(await state(page.request))).not.toContain("Websites to Build from Scratch (1440px fixture)");
  }
});
