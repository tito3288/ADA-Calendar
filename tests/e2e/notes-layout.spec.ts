import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { asActor, origin } from "./helpers";
import type { PersonalNote } from "../../src/lib/notes";

const savedFixtures: PersonalNote[] = [
  {
    id: "notes-layout-websites",
    title: "Websites to Build from Scratch",
    body: "Example school website\nExample shop website\n\nCollect photos and approved copy before starting.",
    version: 1,
    createdAt: "2026-09-08T16:00:00.000Z",
    updatedAt: "2026-09-09T07:00:00.000Z",
  },
  {
    id: "notes-layout-long-title",
    title: "LongReferenceWithoutSpacesToCheckWrappingAndKeepTheNotesDirectoryInsideTheScreen",
    body: "A long reference should wrap inside the saved-note card without pushing the editor or the page sideways.",
    version: 1,
    createdAt: "2026-09-08T16:00:00.000Z",
    updatedAt: "2026-09-08T17:00:00.000Z",
  },
  {
    id: "notes-layout-onboarding",
    title: "Ideas for the next client onboarding",
    body: "Keep this separate from the website list.\nAsk about timeline, assets, and who approves changes.",
    version: 1,
    createdAt: "2026-09-08T16:00:00.000Z",
    updatedAt: "2026-09-08T16:00:00.000Z",
  },
];

async function navigate(page: Page, name: "Notes" | "Calendar") {
  const menu = page.getByRole("button", { name: "Open navigation", exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name, exact: true }).click();
}

async function openNotes(page: Page) {
  await navigate(page, "Notes");
  await expect(page.getByRole("heading", { name: "A place for your notes." })).toBeVisible();
  await expect(page.getByRole("button", { name: "New note", exact: true })).toBeEnabled();
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

async function expectPageGutters(page: Page, width: number) {
  const main = await box(page.locator(".workspace-main"));
  const heading = await box(page.getByRole("heading", { name: "A place for your notes." }));
  const panel = await box(page.locator(".notes-panel"));
  const layout = await box(page.locator(".notes-layout"));
  const gutter = width <= 760 ? 18 : width <= 1200 ? 22 : 32;
  expect(Math.abs(panel.x - heading.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.x - heading.x)).toBeLessThanOrEqual(1);
  expect(panel.x - main.x).toBeGreaterThanOrEqual(gutter - 1);
  expect(main.x + main.width - (panel.x + panel.width)).toBeGreaterThanOrEqual(gutter - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
}

// Synthetic note responses stay inside this browser test; neither empty nor
// saved fixtures touch real notes, the demo note store, or external providers.
for (const width of [1820, 1440, 1024, 768, 390, 320]) {
  test(`Notes keep comfortable page and editor spacing at ${width}px`, async ({ page }, info) => {
    await asActor(page.request, "bryan");
    await page.setViewportSize({ width, height: 1000 });
    let visibleNotes: PersonalNote[] = [];
    await page.route(`${origin}/api/notes`, async route => {
      if (route.request().method() !== "GET") {
        await route.abort();
        throw new Error("Layout coverage must not save or change notes.");
      }
      await route.fulfill({ json: { notes: visibleNotes } });
    });
    await page.goto("/");
    await openNotes(page);
    await expect(page.getByRole("heading", { name: "Make room for your ideas." })).toBeVisible();
    await expectPageGutters(page, width);
    await page.screenshot({ path: info.outputPath(`notes-empty-${width}-full-page.png`), fullPage: true });

    visibleNotes = savedFixtures;
    await page.reload();
    await openNotes(page);
    const directory = page.getByRole("complementary", { name: "Saved notes" });
    await directory.getByRole("button", { name: /Websites to Build from Scratch/ }).click();
    const editor = page.getByRole("form", { name: "Note editor" });
    const title = page.getByLabel("Title", { exact: true });
    const body = page.getByLabel("Note", { exact: true });
    await expect(title).toHaveValue(savedFixtures[0].title);
    await expect(body).toHaveValue(savedFixtures[0].body);
    await expectPageGutters(page, width);

    const directoryBounds = await box(directory);
    const editorBounds = await box(editor);
    if (width <= 1000) {
      expect(editorBounds.y).toBeGreaterThanOrEqual(directoryBounds.y + directoryBounds.height - 1);
      expect(Math.abs(editorBounds.x - directoryBounds.x)).toBeLessThanOrEqual(1);
    } else {
      expect(editorBounds.x).toBeGreaterThanOrEqual(directoryBounds.x + directoryBounds.width - 1);
      expect(Math.abs(editorBounds.y - directoryBounds.y)).toBeLessThanOrEqual(1);
    }

    const padding = await editor.evaluate(element => {
      const style = getComputedStyle(element);
      return { left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight) };
    });
    const minimumPadding = width > 1000 ? 28 : 20;
    expect(padding.left).toBeGreaterThanOrEqual(minimumPadding);
    expect(padding.right).toBeGreaterThanOrEqual(minimumPadding);
    const titleBounds = await box(title);
    expect(titleBounds.x - editorBounds.x).toBeGreaterThanOrEqual(minimumPadding);
    expect(editorBounds.x + editorBounds.width - (titleBounds.x + titleBounds.width)).toBeGreaterThanOrEqual(minimumPadding);

    if (width <= 480) {
      const toolbar = await box(page.locator(".notes-toolbar"));
      const privacy = await box(page.locator(".notes-privacy"));
      const newNote = await box(page.getByRole("button", { name: "New note", exact: true }));
      expect(newNote.y).toBeGreaterThanOrEqual(privacy.y + privacy.height);
      expect(Math.abs(newNote.width - toolbar.width)).toBeLessThanOrEqual(1);
      const saveNote = await box(page.getByRole("button", { name: "Save note", exact: true }));
      expect(newNote.height).toBeGreaterThanOrEqual(44);
      expect(saveNote.height).toBeGreaterThanOrEqual(44);
      expect(titleBounds.height).toBeGreaterThanOrEqual(44);
    }

    // Capture the complete page, including the heading and outside gutters.
    // A panel-only screenshot would miss the original flush-to-sidebar bug.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath(`notes-editor-${width}-full-page.png`), fullPage: true });
    if (width === 1440 || width === 390) {
      expect((await new AxeBuilder({ page }).include(".notes-panel").analyze()).violations).toEqual([]);
      await body.fill("An unsaved layout-test draft that must survive calendar navigation.");
      await navigate(page, "Calendar");
      await expect(page.locator(".notes-panel")).toBeHidden();
      await openNotes(page);
      await expect(body).toHaveValue("An unsaved layout-test draft that must survive calendar navigation.");
      await expectPageGutters(page, width);
    }
  });
}
