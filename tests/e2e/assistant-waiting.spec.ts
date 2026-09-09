import { expect, test } from "@playwright/test";
import { conversationText, nextContinuation } from "../../src/lib/assistant-conversation";
import { createDemoState } from "../../src/lib/fixtures";
import { planCommands } from "../../src/lib/scheduler";
import { compileInterpretation, emptyAssistantAction } from "../../src/lib/server/assistant";
import type { AppState, WorkCommand } from "../../src/lib/types";
import { asActor, origin, state } from "./helpers";

test("mocked-provider waiting work can be saved, edited without hours, then explicitly resumed", async ({ page, baseURL }, testInfo) => {
  expect(baseURL).toBe(origin);
  await asActor(page.request, "bryan");
  const storedBefore = await state(page.request);
  expect(storedBefore.mode).toBe("demo");
  const now = new Date("2026-09-08T12:00:00Z");
  await page.clock.setFixedTime(now);
  let fixture: AppState = { ...createDemoState(now.toISOString()),
    clients: [{ id: "test-drive", name: "Drive and Shine", aliases: [] }],
    items: [], sessions: [], blocks: [], events: [], notifications: [], requests: [], emailDrafts: [], attachments: [] };
  const original = "I am working on Oil Survey system software for Drive and Shine. I am waiting on the client for days and hours.";
  const reply = 'add “Oil Survey system” for Drive and Shine now as unscheduled work with no estimate';
  const question = "Should I add Oil Survey system as unscheduled work with no estimate?";
  const clarification = { kind: "clarification" as const, message: question, commands: [] };
  const continuation = nextContinuation(original, clarification, now)!;
  const pendingId = "00000000-0000-4000-8000-000000000001";
  let assistantRequests = 0;
  const committed: WorkCommand[][] = [];

  // HTTP responses and provider extraction are mocked. Conversation grounding,
  // compiler, and shared scheduler are real. No calendar persistence or sends.
  await page.route(`${origin}/api/assistant`, async route => {
    const body = route.request().postDataJSON();
    assistantRequests++;
    if (assistantRequests === 1) {
      expect(body.text).toBe(original);
      return route.fulfill({ json: { interpretation: clarification, state: fixture, replyToOperationId: pendingId } });
    }
    expect(body.text).toBe(reply);
    expect(body.replyToOperationId).toBe(pendingId);
    const evidence = conversationText(reply, continuation);
    const interpretation = compileInterpretation({ kind: "commands", message: "Saved waiting work; no time reserved.", actions: [{
      ...emptyAssistantAction("create", evidence), clientName: "Drive and Shine", title: "Oil Survey system",
      category: "software", description: original, status: "waiting", reason: "Awaiting client days and hours",
    }], draft: null }, evidence, fixture, fixture.actor, now, reply);
    const proposal = planCommands(fixture, interpretation.commands, fixture.actor, { now: now.toISOString() });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    fixture = { ...fixture, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks };
    await route.fulfill({ json: { interpretation, proposal, state: fixture, replyToOperationId: null } });
  });
  await page.route(`${origin}/api/commands`, async route => {
    const body = route.request().postDataJSON();
    const proposal = planCommands(fixture, body.commands, fixture.actor, { now: new Date(now.getTime() + (fixture.version + 1) * 1000).toISOString(), operationId: body.operationId });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    if (body.action === "commit") {
      committed.push(body.commands);
      fixture = { ...fixture, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks, version: fixture.version + 1 };
    }
    await route.fulfill({ json: { proposal, state: fixture } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Ask ADA", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Instruction for ADA", { exact: true }).fill(original);
  await dialog.getByRole("button", { name: "Send instruction", exact: true }).click();
  await expect(dialog.getByText(question, { exact: true })).toBeVisible();
  await dialog.getByLabel("Instruction for ADA", { exact: true }).fill(reply);
  await dialog.getByRole("button", { name: "Send instruction", exact: true }).click();
  await expect(dialog.getByText("Saved waiting work; no time reserved.", { exact: true })).toBeVisible();
  expect(assistantRequests).toBe(2);
  expect(fixture.items).toHaveLength(1);
  expect(fixture.sessions).toEqual([]);
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Oil Survey system Awaiting client days and hours", exact: true }).click();
  await expect(dialog.getByText("Hours added as needed", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByLabel(/^Remaining hours/)).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Resume work", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Save progress", exact: true })).toBeDisabled();
  await dialog.screenshot({ path: testInfo.outputPath("waiting-without-estimate.png") });

  await dialog.getByRole("button", { name: "Edit details", exact: true }).click();
  await expect(dialog.getByLabel(/^Remaining effort \(hours\)/)).toHaveCount(0);
  await dialog.getByLabel("What needs doing?", { exact: true }).fill("Oil Survey system — awaiting details");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Oil Survey system — awaiting details", exact: true })).toBeVisible();
  expect(committed[0][0]).toMatchObject({ type: "update", patch: { title: "Oil Survey system — awaiting details" } });
  expect(fixture.items[0]).toMatchObject({ remainingMinutes: null, estimatedMinutes: null });
  expect(fixture.items[0].status).toBe("waiting");
  expect(fixture.sessions).toEqual([]);
  await dialog.getByLabel(/^Remaining hours/).fill("2");
  await expect(dialog.getByRole("button", { name: "Resume work", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Resume work", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Mark waiting", exact: true })).toBeVisible();
  expect(committed[1][0]).toMatchObject({ type: "status", status: "in_progress", remainingMinutes: 120 });
  expect(fixture.items[0]).toMatchObject({ estimatedMinutes: 120, remainingMinutes: 120, status: "in_progress" });
  expect(fixture.sessions.length).toBeGreaterThan(0);
  expect(await state(page.request)).toEqual(storedBefore);
});
