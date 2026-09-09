import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import { localDateTime } from "./time";
import { newWorkItem } from "./work";
import { planCommands } from "./scheduler";
import { withReviewFingerprint } from "./server/preview";
import { workspaceChatOperationId, workspaceChatRecord, type WorkspaceChatCommand } from "./server/workspace-chat";
import type { WorkspaceChatResponse } from "./workspace-chat";

// These tests use only isolated fictional demo storage and captured mail.
// Every live client is blocked; no real provider/database/email call is possible.
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "bryan" }), set: vi.fn() }) }));
vi.mock("openai", () => ({ default: class { constructor() { throw new Error("No live model in workspace chat route tests"); } } }));
vi.mock("./server/supabase", () => ({ getSupabaseAdminClient: vi.fn(() => { throw new Error("No live database in chat tests"); }), getSupabaseServerClient: vi.fn(() => { throw new Error("No live database in chat tests"); }) }));
vi.mock("./server/service", async () => {
  const demo = await import("./server/demo-store");
  return { currentActor: vi.fn(async () => DEMO_MEMBERS[0]), demoEnabled: vi.fn(() => true), store: {
    getState: vi.fn(async (id: string) => demo.getDemoState(demo.demoActor(id))), commit: vi.fn(demo.commitDemoProposal),
    beginAI: vi.fn(demo.beginDemoAIOperation), getAI: vi.fn(demo.getDemoAIOperation), finishAI: vi.fn(demo.finishDemoAIOperation),
  } };
});
vi.mock("./server/notes", async importOriginal => { const original = await importOriginal<typeof import("./server/notes")>(); return { ...original, listNotes: vi.fn(original.listNotes) }; });
import { POST } from "../app/api/workspace-chat/route";
import { currentActor, demoEnabled, store } from "./server/service";
import { listNotes } from "./server/notes";
import { demoTransaction, getDemoState } from "./server/demo-store";
const owner = DEMO_MEMBERS[0], origin = "http://localhost:3000", day = "2026-09-09";
async function send(body: unknown, requestOrigin = origin) {
  return POST(new NextRequest(`${origin}/api/workspace-chat`, { method: "POST", headers: { origin: requestOrigin, "content-type": "application/json" }, body: JSON.stringify(body) }));
}
async function message(text: string, operationId = "chat-first", extra: Record<string, unknown> = {}) {
  return send({ action: "message", text, operationId, date: day, ...extra });
}
async function preview() {
  const result = await message("Put Tyler first, Higher Ground second, Oral Surgery third and Homepage demo last today.");
  expect(result.status).toBe(200);
  const body = await result.json() as WorkspaceChatResponse;
  expect(body.reply.kind, body.reply.message).toBe("preview"); return body;
}
function confirm(body: WorkspaceChatResponse) {
  return send({ action: "confirm", operationId: body.operationId, baseVersion: body.stateVersion, reviewFingerprint: body.reply.proposal!.reviewFingerprint });
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
  vi.stubEnv("ADA_DEMO_MODE", "true"); vi.stubEnv("APP_URL", origin); vi.stubEnv("ADA_DATA_DIR", await mkdtemp(path.join(tmpdir(), "ada-workspace-chat-test-")));
  for (const key of ["OPENAI_API_KEY", "RESEND_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) vi.stubEnv(key, "");
  vi.mocked(currentActor).mockResolvedValue(owner); vi.mocked(demoEnabled).mockReturnValue(true);
  await demoTransaction(state => {
    Object.assign(state, createDemoState()); state.settings.reserveMinutes = 0; state.blocks = []; state.requests = []; state.events = []; state.notifications = [];
    state.clients = [{ id: "oral", name: "Oral Surgery", aliases: [] }, { id: "tree", name: "Higher Ground", aliases: [] }, { id: "tyler", name: "Tech Tyler", aliases: ["Tyler"] }, { id: "demo", name: "CIDWP", aliases: [] }];
    state.items = state.clients.map((client, index) => newWorkItem(owner, day, { id: client.id, clientId: client.id, title: ["Website edits", "Form fix", "Header fix", "Homepage demo"][index], remainingMinutes: index === 3 ? 120 : 60, estimatedMinutes: index === 3 ? 120 : 60, minimumSessionMinutes: 60, windowEnd: "2026-12-31", webKind: index === 3 ? "build" : "edit" }));
    const at = (clock: string) => localDateTime(day, clock, state.settings.timeZone);
    state.sessions = state.items.map((item, index) => ({ id: `s-${item.id}`, workItemId: item.id, start: at(["09:00", "10:00", "11:00", "12:30"][index]), end: at(["10:00", "11:00", "12:00", "14:30"][index]), protected: false, status: "planned", usesReserve: false }));
    state.personalNotes = [{ workspaceId: state.workspaceId, authorId: owner.id, note: { id: "private", title: "Private owner note", body: "Never expose this to requesters", version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }];
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("separate workspace chat API", () => {
  it("answers fresh agendas without calendar writes and keeps its private history out of state", async () => {
    const before = await getDemoState(owner);
    const first = await message("What is on my schedule today?"); expect(first.status).toBe(200);
    const body = await first.json(); expect(body.reply.message).toContain("5h planned");
    expect(store.commit).not.toHaveBeenCalled(); expect(await getDemoState(owner)).toEqual(before);
    expect(JSON.stringify(await getDemoState(owner))).not.toContain("Private owner note");
    const next = await message("What about tomorrow?", "chat-followup", { replyToOperationId: "chat-first" });
    const nextBody = await next.json(); expect(nextBody.reply.message).toContain("No work sessions"); expect(nextBody.contextDate).toBe("2026-09-10"); expect(store.commit).not.toHaveBeenCalled();
    const followup = await message("Put Tyler first", "tomorrow-order", { replyToOperationId: "chat-followup", date: nextBody.contextDate });
    const followupBody = await followup.json(); expect(followupBody.contextDate).toBe("2026-09-10"); expect(followupBody.reply.kind).toBe("clarification");
  });
  it("previews only, then confirms exactly once through the real shared scheduler/store", async () => {
    const before = await getDemoState(owner), body = await preview();
    expect(await getDemoState(owner)).toEqual(before); expect(store.commit).not.toHaveBeenCalled();
    expect(body.reply.changes?.map(change => change.workItemId)).toEqual(["tyler", "oral"]);
    const saved = await confirm(body); expect(saved.status).toBe(200);
    const state = (await saved.json()).state;
    expect(state.version).toBe(1); expect(state.items).toEqual(before.items); expect(state.sessions.map((session: { id: string }) => session.id)).toEqual(before.sessions.map(session => session.id));
    expect(state.notifications.every((notification: { status: string }) => notification.status === "captured")).toBe(true);
    expect((await confirm(body)).status).toBe(200); expect((await getDemoState(owner)).events).toHaveLength(1);
  });
  it("keeps an unfinished reorder private across agenda questions and clears it when a new order is previewed", async () => {
    const before = await getDemoState(owner);
    const first = await (await message("Rearrange my tasks today", "pending-order")).json();
    expect(first.reply.kind).toBe("clarification");
    const remembered = await store.getAI(owner, "pending-order");
    expect(remembered.result).toMatchObject({ pendingReorder: { requestText: "Rearrange my tasks today", date: day } });
    const answer = await (await message("What is on my schedule tomorrow?", "pending-question", { replyToOperationId: "pending-order" })).json();
    expect(answer.contextDate).toBe("2026-09-10");
    const continued = await (await message("Can you make the changes please", "pending-resume", { date: "2026-09-10", replyToOperationId: "pending-question" })).json();
    expect(continued.contextDate).toBe(day);
    expect(continued.reply.kind).toBe("clarification"); // No ordered names were supplied yet.
    const ordered = await (await message("I want:\n1. Tyler\n2. Higher Ground\n3. Oral Surgery\n4. Homepage demo", "pending-complete", { replyToOperationId: "pending-resume" })).json();
    expect(ordered.reply.kind, ordered.reply.message).toBe("preview");
    expect((await store.getAI(owner, "pending-complete")).result).not.toHaveProperty("pendingReorder");
    expect(await getDemoState(owner)).toEqual(before);
    expect(store.commit).not.toHaveBeenCalled();
  });
  it("resizes existing booked hours without changing effort and replays confirmation safely", async () => {
    const before = await getDemoState(owner);
    const reply = await message("Reduce Homepage demo from 2 hours to 1 hour today", "resize-booking");
    const body = await reply.json() as WorkspaceChatResponse;
    expect(body.reply.kind, body.reply.message).toBe("preview");
    expect(body.reply.totals).toEqual({ beforeMinutes: 120, afterMinutes: 60, deltaMinutes: -60 });
    expect(await getDemoState(owner)).toEqual(before);
    expect((await confirm(body)).status).toBe(200); expect((await confirm(body)).status).toBe(200);
    const after = await getDemoState(owner);
    expect(after.items.find(item => item.id === "demo")).toMatchObject({ estimatedMinutes: 120, remainingMinutes: 120 });
    expect(after.sessions).toHaveLength(before.sessions.length); expect(after.events).toHaveLength(1);
  });
  it("adds smart-fit hours to existing waiting work and preserves unknown totals", async () => {
    await demoTransaction(state => { const item = state.items.find(item => item.id === "demo")!; item.status = "waiting"; item.estimatedMinutes = item.remainingMinutes = null; state.sessions = state.sessions.filter(session => session.workItemId !== item.id); });
    const body = await (await message("Add 1 hour to Homepage demo tomorrow", "add-booking")).json() as WorkspaceChatResponse;
    expect(body.reply.kind, body.reply.message).toBe("preview"); expect(body.contextDate).toBe("2026-09-10");
    expect(body.reply.details?.[0]).toContain("Resume this waiting project");
    expect((await confirm(body)).status).toBe(200);
    const after = await getDemoState(owner);
    expect(after.items).toHaveLength(4); expect(after.items.find(item => item.id === "demo")).toMatchObject({ estimatedMinutes: null, remainingMinutes: null });
    expect(after.sessions.filter(session => session.workItemId === "demo")).toHaveLength(1);
  });
  it("keeps edit intent through date questions and accepts a short destination answer", async () => {
    const first = await (await message("Move Homepage demo from today", "missing-destination")).json() as WorkspaceChatResponse;
    expect(first.reply.kind).toBe("clarification"); expect(first.reply.message).toContain("Which day");
    const next = await (await message("Tomorrow", "answered-destination", { replyToOperationId: first.operationId })).json() as WorkspaceChatResponse;
    expect(next.reply.kind, next.reply.message).toBe("preview"); expect(next.contextDate).toBe("2026-09-10");
    expect(next.reply.proposal!.commands[0]).toMatchObject({ type: "move_booking", sessionId: "s-demo", date: "2026-09-10" });
    expect(store.commit).not.toHaveBeenCalled();
  });
  it("keeps the amount through an ambiguous resize-date question", async () => {
    const first = await (await message("Reduce Homepage demo from 2 hours to 1 hour today or tomorrow", "ambiguous-resize-date")).json() as WorkspaceChatResponse;
    expect(first.reply.kind).toBe("clarification");
    const next = await (await message("Today", "answered-resize-date", { replyToOperationId: first.operationId })).json() as WorkspaceChatResponse;
    expect(next.reply.kind, next.reply.message).toBe("preview");
    expect(next.reply.proposal!.commands[0]).toMatchObject({ type: "resize_booking", sessionId: "s-demo", minutes: 60 });
    expect(store.commit).not.toHaveBeenCalled();
  });
  it("refreshes a stale preview without mutation, confirms the new fingerprint, and handles its retry", async () => {
    const original = await preview();
    await demoTransaction(state => { state.version++; });
    const stale = await confirm(original); expect(stale.status).toBe(409);
    const fresh = await stale.json() as WorkspaceChatResponse;
    expect(fresh.stateVersion).toBe(1); expect(fresh.reply.kind).toBe("preview"); expect((await getDemoState(owner)).events).toHaveLength(0);
    expect(fresh.reply.proposal!.reviewFingerprint).not.toBe(original.reply.proposal!.reviewFingerprint);
    expect((await confirm(fresh)).status).toBe(200);
    expect((await confirm(fresh)).status).toBe(200); expect((await getDemoState(owner)).events).toHaveLength(1);
  });
  it("invalidates a reviewed preview when a session starts before confirmation", async () => {
    const body = await preview(); vi.setSystemTime(new Date("2026-09-09T13:01:00Z"));
    const result = await confirm(body); expect(result.status).toBe(409); expect((await result.json()).reply.kind).toBe("clarification");
    expect((await getDemoState(owner)).events).toHaveLength(0);
  });
  it("requires a fresh review when an old day-total preview excluded elapsed planned hours", async () => {
    vi.setSystemTime(new Date("2026-09-09T18:30:00Z"));
    await demoTransaction(state => {
      state.items = [newWorkItem(owner, day, { id: "missed-total", clientId: "demo", title: "Fictional missed work", remainingMinutes: 240, estimatedMinutes: 240 })];
      const at = (clock: string) => localDateTime(day, clock, state.settings.timeZone);
      state.sessions = [{ id: "elapsed", workItemId: "missed-total", start: at("09:00"), end: at("11:00"), status: "planned", protected: false, usesReserve: false },
        { id: "upcoming", workItemId: "missed-total", start: at("15:00"), end: at("17:00"), status: "planned", protected: false, usesReserve: false }];
    });
    const before = await getDemoState(owner), now = new Date().toISOString(), operationId = "legacy-upcoming-total";
    const command: WorkspaceChatCommand = { type: "set_day_hours", itemId: "missed-total", days: [{ date: day, minutes: 60 }] };
    // The old 1h upcoming-only interpretation kept the elapsed 2h, for 3h total.
    const oldPlan = withReviewFingerprint({ ...planCommands(before, [{ ...command, days: [{ date: day, minutes: 180 }] }], owner, { now, operationId: workspaceChatOperationId(operationId) }), commands: [command] });
    expect(oldPlan.status).toBe("ready");
    const oldResponse: WorkspaceChatResponse = { reply: { kind: "preview", message: "Set upcoming hours to 1h", sources: [], proposal: oldPlan }, operationId, stateVersion: before.version, asOf: now };
    await store.beginAI(owner, { id: operationId, kind: "assistant", inputHash: "c".repeat(64), reserveUsd: 0 });
    await store.finishAI(owner, operationId, workspaceChatRecord(owner, before, oldResponse, "Set Fictional missed work to 1 hour today", day, "edit", undefined, command));
    const response = await confirm(oldResponse);
    expect(response.status).toBe(409);
    const refreshed = await response.json() as WorkspaceChatResponse;
    expect(refreshed.reply.proposal!.reviewFingerprint).not.toBe(oldPlan.reviewFingerprint);
    expect(await getDemoState(owner)).toEqual(before);
    expect(store.commit).not.toHaveBeenCalled();
  });
  it("binds message retries to exact text, day and parent without rerunning or mutating", async () => {
    const before = await preview();
    const retry = await message("Put Tyler first, Higher Ground second, Oral Surgery third and Homepage demo last today.");
    expect(await retry.json()).toEqual(before);
    expect((await message("Put Oral Surgery first today")).status).toBe(400);
    expect((await message("Put Tyler first, Higher Ground second, Oral Surgery third and Homepage demo last today.", "chat-first", { date: "2026-09-10" })).status).toBe(400);
    expect((await getDemoState(owner)).version).toBe(0);
  });
  it("requesters receive read-only chat with no owner notes or foreign history", async () => {
    await message("What is in my notes?"); expect(listNotes).toHaveBeenCalledWith(owner);
    vi.mocked(listNotes).mockClear(); vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[1]);
    const qa = await message("How busy is this week?", "requester-qa"); expect(qa.status).toBe(200);
    const denied = await message("Put Tyler first today", "requester-order"); expect((await denied.json()).reply.kind).toBe("clarification");
    expect(listNotes).not.toHaveBeenCalled();
    expect((await message("What did the note say?", "foreign-parent", { replyToOperationId: "chat-first" })).status).toBe(400);
    expect((await send({ action: "confirm", operationId: "chat-first", baseVersion: 0, reviewFingerprint: "a".repeat(64) })).status).toBe(403);
    expect(store.commit).not.toHaveBeenCalled();
  });
  it("rejects other assistant namespaces, expired parents, viewers, forged commands and foreign origins", async () => {
    await store.beginAI(owner, { id: "old-assistant", kind: "assistant", inputHash: "a".repeat(64), reserveUsd: 0 });
    await store.finishAI(owner, "old-assistant", { interpretation: { kind: "clarification", message: "private other assistant" }, continuation: {} });
    const foreign = await message("yes", "foreign-surface", { replyToOperationId: "old-assistant" });
    expect(foreign.status).toBe(409); expect((await foreign.json()).resetNeeded).toBe(true);
    await message("What is on my schedule today?"); vi.setSystemTime(new Date("2026-09-10T12:01:00Z"));
    const expired = await message("What about tomorrow?", "expired", { replyToOperationId: "chat-first" }); expect(expired.status).toBe(409);
    expect((await message("hello", "bad-command", { commands: [{ type: "create" }] })).status).toBe(400);
    expect((await send({ action: "message", text: "hello", operationId: "bad-origin" }, "https://foreign.example.test")).status).toBe(403);
    vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[3]); expect((await message("hello", "viewer")).status).toBe(403);
  });
  it("requires a real cached reorder preview and the exact reviewed fingerprint", async () => {
    const body = await preview();
    expect((await send({ action: "confirm", operationId: body.operationId, baseVersion: 0, reviewFingerprint: "a".repeat(64) })).status).toBe(409);
    await message("How busy am I this week?", "answer-only");
    expect((await send({ action: "confirm", operationId: "answer-only", baseVersion: 0, reviewFingerprint: "a".repeat(64) })).status).toBe(409);
    expect((await getDemoState(owner)).events).toHaveLength(0);
  });
  it("fails closed without live AI credentials before reserving budget or touching work", async () => {
    vi.mocked(demoEnabled).mockReturnValue(false); vi.mocked(store.beginAI).mockClear();
    const result = await message("Tell me details about my Header fix task", "not-connected");
    expect(result.status).toBe(503); expect(store.beginAI).not.toHaveBeenCalled(); expect(store.commit).not.toHaveBeenCalled();
  });
  it("marks definitely failed model attempts for a new operation but not uncertain processing", async () => {
    vi.mocked(store.beginAI).mockResolvedValueOnce({ status: "failed", result: null });
    const failed = await message("How busy am I this week?", "failed");
    expect(failed.status).toBe(409); expect((await failed.json()).retryWithNewOperation).toBe(true);
    vi.mocked(store.beginAI).mockResolvedValueOnce({ status: "processing", result: null });
    const processing = await message("How busy am I this week?", "processing");
    expect(processing.status).toBe(409); expect((await processing.json()).retryWithNewOperation).toBeUndefined();
  });
  it("cancellation and questions cannot become saved changes", async () => {
    const before = await getDemoState(owner);
    expect((await (await message("What if we put Tyler first?", "hypothetical")).json()).reply.kind).toBe("clarification");
    expect((await (await message("Never mind", "cancel")).json()).reply.message).toContain("Nothing was changed");
    expect(await getDemoState(owner)).toEqual(before); expect(store.commit).not.toHaveBeenCalled();
  });
});
