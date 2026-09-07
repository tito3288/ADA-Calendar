import { expect, test } from "@playwright/test";
import { validateSchedule } from "../../src/lib/scheduler";
import { asActor, commit, exactSession, futureDate, makeItem, origin, post, preview, state } from "./helpers";

test("a retried booking is one event; completion and undo each produce corrective captured email", async ({ request }) => {
  await asActor(request, "bryan");
  const before = await state(request);
  const work = makeItem(before, "E2E idempotent work");
  const proposal = await preview(request, [{ type: "create", item: work }]);
  expect(proposal.status).toBe("ready");
  const unreviewed = await post(request, "commands", { commands: proposal.commands, operationId: proposal.operationId, baseVersion: proposal.baseVersion, reviewFingerprint: "0".repeat(64), action: "commit" });
  expect(unreviewed.status()).toBe(409);
  expect((await state(request)).version).toBe(before.version);
  const booked = await commit(request, proposal);
  const retried = await commit(request, proposal);
  expect(retried.version).toBe(booked.version);
  expect(retried.events.filter(event => event.operationId === proposal.operationId)).toHaveLength(1);
  const createdEvent = retried.events.find(event => event.operationId === proposal.operationId)!;
  expect(retried.notifications.filter(notification => notification.eventId === createdEvent.id).map(notification => notification.recipient).sort()).toEqual(["kyle@example.test", "william@example.test"]);
  expect(retried.notifications.every(notification => notification.status === "captured")).toBe(true);

  const completed = await commit(request, await preview(request, [{ type: "status", itemId: work.id, status: "completed" }]));
  expect(completed.items.find(item => item.id === work.id)?.status).toBe("completed");
  const response = await post(request, "undo", { id: completed.events[0].id });
  expect(response.ok(), await response.text()).toBe(true);
  const undone = (await response.json()).state;
  expect(undone.items.find((item: { id: string }) => item.id === work.id).status).toBe("planned");
  expect(undone.events[0].type).toBe("schedule_undone");
  expect(undone.notifications.filter((notification: { eventId: string }) => notification.eventId === undone.events[0].id)).toHaveLength(2);
});

test("same-slot previews from two requesters cannot both commit", async ({ playwright, request }) => {
  await asActor(request, "bryan");
  const original = await state(request);
  const kyle = await playwright.request.newContext({ baseURL: origin });
  const william = await playwright.request.newContext({ baseURL: origin });
  try {
    await asActor(kyle, "kyle"); await asActor(william, "william");
    const date = futureDate(original, 49);
    const first = makeItem(await state(kyle), "E2E Kyle collision", { windowStart: date, windowEnd: date });
    const second = makeItem(await state(william), "E2E William collision", { windowStart: date, windowEnd: date });
    const [a, b] = await Promise.all([
      preview(kyle, [{ type: "create", item: first, sessions: [exactSession(original, first)] }]),
      preview(william, [{ type: "create", item: second, sessions: [exactSession(original, second)] }]),
    ]);
    expect(a.status).toBe("ready"); expect(b.status).toBe("ready");
    expect(a.baseVersion).toBe(b.baseVersion);
    const responses = await Promise.all([
      post(kyle, "commands", { commands: a.commands, operationId: a.operationId, baseVersion: a.baseVersion, reviewFingerprint: a.reviewFingerprint, action: "commit" }),
      post(william, "commands", { commands: b.commands, operationId: b.operationId, baseVersion: b.baseVersion, reviewFingerprint: b.reviewFingerprint, action: "commit" }),
    ]);
    expect(responses.filter(response => response.ok())).toHaveLength(1);
    expect(responses.filter(response => [400, 409].includes(response.status()))).toHaveLength(1);
    const after = await state(request);
    expect(after.items.filter(item => [first.id, second.id].includes(item.id))).toHaveLength(1);
    expect(validateSchedule(after)).toEqual([]);
    const event = after.events.find(event => event.itemIds.includes(first.id) || event.itemIds.includes(second.id))!;
    expect(after.notifications.filter(notification => notification.eventId === event.id).map(notification => notification.recipient).sort()).toEqual(["bryan@example.test", "kyle@example.test", "william@example.test"]);
  } finally { await kyle.dispose(); await william.dispose(); }
});

test("requesters cannot edit existing work and viewers cannot submit mutations", async ({ request }) => {
  await asActor(request, "bryan");
  const before = await state(request);
  await asActor(request, "william");
  const forbidden = await preview(request, [{ type: "update", itemId: "drive-software", patch: { title: "Unauthorized edit" } }]);
  expect(forbidden.status).toBe("infeasible");
  expect(forbidden.conflicts.some(conflict => conflict.code === "forbidden")).toBe(true);
  const denied = await post(request, "commands", { commands: forbidden.commands, operationId: forbidden.operationId, baseVersion: forbidden.baseVersion, reviewFingerprint: forbidden.reviewFingerprint, action: "commit" });
  expect(denied.ok()).toBe(false);
  await asActor(request, "viewer");
  const viewerState = await state(request);
  expect(viewerState.items.some(item => item.id === "drive-software")).toBe(true);
  const viewerDenied = await post(request, "commands", { commands: [{ type: "create", item: makeItem(viewerState, "Unauthorized viewer booking") }], operationId: crypto.randomUUID(), action: "commit" });
  expect(viewerDenied.status()).toBe(403);
  await asActor(request, "bryan");
  const after = await state(request);
  expect(after.version).toBe(before.version);
  expect(after.notifications).toHaveLength(before.notifications.length);
});

test("future-tense client communication remains a private draft until explicitly sent", async ({ request }) => {
  await asActor(request, "bryan");
  const before = await state(request);
  const operationId = crypto.randomUUID();
  const first = await post(request, "assistant", { text: "I have to tell her about the completed landings", operationId });
  expect(first.ok(), await first.text()).toBe(true);
  const result = await first.json();
  expect(result.interpretation.kind).toBe("email_draft");
  expect(result.state.version).toBe(before.version);
  expect(result.state.notifications).toHaveLength(before.notifications.length);
  expect(result.state.items).toEqual(before.items);
  const again = await post(request, "assistant", { text: "I have to tell her about the completed landings", operationId });
  expect(again.ok(), await again.text()).toBe(true);
  expect((await again.json()).state.emailDrafts).toHaveLength(before.emailDrafts.length + 1);
  await asActor(request, "william");
  expect((await state(request)).emailDrafts).toEqual([]);
});

test("clarification and its retried short reply commit only one task and notification event", async ({ request }) => {
  await asActor(request, "bryan");
  const before = await state(request);
  const date = futureDate(before, 126);
  const title = "E2E retry clarification task";
  const operationId = crypto.randomUUID();
  const pendingResponse = await post(request, "assistant", { text: `Add IT work for Higher Ground Tree: ${title}, on ${date}`, operationId });
  expect(pendingResponse.ok(), await pendingResponse.text()).toBe(true);
  const pending = await pendingResponse.json();
  expect(pending.interpretation.kind).toBe("clarification");
  expect(pending.replyToOperationId).toBe(operationId);
  expect(pending.state.version).toBe(before.version);
  expect(pending.state.events).toHaveLength(before.events.length);
  expect(pending.state.notifications).toHaveLength(before.notifications.length);
  const reply = { text: "Two hours", operationId: crypto.randomUUID(), replyToOperationId: pending.replyToOperationId };
  const response = await post(request, "assistant", reply);
  expect(response.ok(), await response.text()).toBe(true);
  const result = await response.json();
  expect(result.interpretation.kind).toBe("commands");
  expect(result.replyToOperationId).toBeNull();
  const retried = await post(request, "assistant", reply);
  expect(retried.ok(), await retried.text()).toBe(true);
  expect((await retried.json()).replyToOperationId).toBeNull();
  const after = await state(request);
  const matches = after.items.filter(item => item.title === title);
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({ clientId: "higher-ground", category: "it", estimatedMinutes: 120, remainingMinutes: 120, windowStart: date, windowEnd: date });
  expect(after.version).toBe(before.version + 1);
  expect(after.events).toHaveLength(before.events.length + 1);
  const event = after.events.find(event => event.operationId === reply.operationId)!;
  expect(event.itemIds).toContain(matches[0].id);
  expect(after.notifications.filter(notification => notification.eventId === event.id).map(notification => notification.recipient).sort()).toEqual(["kyle@example.test", "william@example.test"]);
  expect(after.notifications.every(notification => notification.status === "captured")).toBe(true);
});

test("mutation requests require a verified same-site origin", async ({ request }) => {
  const response = await request.post("/api/demo/actor", { data: { id: "william" } });
  expect(response.ok()).toBe(false);
  expect((await response.json()).error).toContain("origin");
});
