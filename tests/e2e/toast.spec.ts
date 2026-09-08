import { expect, test, type Page } from "@playwright/test";
import type { AppState } from "../../src/lib/types";
import { asActor, origin, state } from "./helpers";

const message = "Workspace updated. No new emails generated.";

// All requests stay on the isolated demo server. Assistant responses are mocked
// in the browser: no AI calls, calendar writes, or outgoing messages are needed.
test.beforeEach(async ({ page, baseURL }) => {
  expect(baseURL).toBe(origin);
  await asActor(page.request, "bryan");
  expect((await state(page.request)).mode).toBe("demo");
});

async function openAssistant(page: Page, snapshot: AppState) {
  await page.route("**/api/assistant", async (route) => {
    expect(route.request().method()).toBe("POST");
    await route.fulfill({
      json: {
        interpretation: {
          kind: "answer",
          message: "Local toast test only. No work or email was changed.",
          commands: [],
        },
        state: snapshot,
        replyToOperationId: null,
      },
    });
  });
  const start = Date.now();
  await page.clock.install({ time: start });
  await page.goto("/");
  await page.getByRole("button", { name: "Ask ADA", exact: true }).click();
  await expect(page.getByLabel("Instruction for ADA", { exact: true })).toBeVisible();
  // Let hydration and opening the dialog finish before freezing timer progress.
  await page.clock.pauseAt(start + 60_000);
}

async function showNotice(page: Page) {
  await page.getByLabel("Instruction for ADA", { exact: true }).fill("Explain only; do not change anything.");
  await page.getByRole("button", { name: "Send instruction", exact: true }).click();
  // Radix hides siblings from the accessibility tree while the modal is open;
  // the toast remains visually visible below it, as in the reported screenshot.
  const toast = page.getByRole("status", { includeHidden: true }).filter({ hasText: message });
  await expect(toast).toBeVisible();
  await expect(page.getByLabel("Instruction for ADA", { exact: true })).toHaveValue("");
  return toast;
}

test("workspace toast stays for 3999 ms and disappears at four seconds", async ({ page }, testInfo) => {
  const before = await state(page.request);
  await openAssistant(page, before);
  const toast = await showNotice(page);

  await page.clock.runFor(3999);
  await expect(toast).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("toast-before-expiry.png"), fullPage: true });
  await page.clock.runFor(1);
  await expect(toast).toHaveCount(0);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("toast-after-expiry.png"), fullPage: true });
  expect(await state(page.request)).toEqual(before);
});

test("an identical replacement notice receives a fresh four-second timeout", async ({ page }) => {
  const before = await state(page.request);
  await openAssistant(page, before);
  const toast = await showNotice(page);
  await page.clock.runFor(2000);
  await showNotice(page);

  // The old notice would expire now, but the replacement must remain visible.
  await page.clock.runFor(2000);
  await expect(toast).toBeVisible();
  await page.clock.runFor(1999);
  await expect(toast).toBeVisible();
  await page.clock.runFor(1);
  await expect(toast).toHaveCount(0);
  expect(await state(page.request)).toEqual(before);
});

test("manual dismissal removes the toast and its stale timer cannot close the next notice", async ({ page }) => {
  const before = await state(page.request);
  await openAssistant(page, before);
  const toast = await showNotice(page);
  await page.clock.runFor(1000);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await toast.getByRole("button", { name: "Dismiss notification", exact: true }).click();
  await expect(toast).toHaveCount(0);
  await page.clock.runFor(500);
  await page.getByRole("button", { name: "Ask ADA", exact: true }).click();
  await showNotice(page);

  // Reach the first notice's original deadline, 2500 ms into the new notice.
  await page.clock.runFor(2500);
  await expect(toast).toBeVisible();
  await page.clock.runFor(1499);
  await expect(toast).toBeVisible();
  await page.clock.runFor(1);
  await expect(toast).toHaveCount(0);
  expect(await state(page.request)).toEqual(before);
});

test("the latest unchanged event can still be undone from Activity after the toast expires", async ({ page }) => {
  const before = await state(page.request);
  const fixture = structuredClone(before);
  const calendar = { items: fixture.items, sessions: fixture.sessions, blocks: fixture.blocks };
  fixture.events = [{
    id: "toast-only-event-fixture",
    operationId: "toast-only-operation-fixture",
    actorId: fixture.actor.id,
    actorName: fixture.actor.name,
    type: "test",
    summary: ["Local browser-only undo visibility fixture."],
    itemIds: [],
    createdAt: new Date().toISOString(),
    version: fixture.version,
    before: calendar,
    after: calendar,
    undoneBy: null,
  }];
  await openAssistant(page, fixture);
  const toast = await showNotice(page);
  await expect(toast.getByRole("button", { name: "Undo", exact: true, includeHidden: true })).toBeVisible();
  await page.clock.runFor(4000);
  await expect(toast).toHaveCount(0);

  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Activity & email", exact: true }).click();
  await expect(page.getByText("Local browser-only undo visibility fixture.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
  // The synthetic event exists only in this browser response, never in storage.
  expect(await state(page.request)).toEqual(before);
});
