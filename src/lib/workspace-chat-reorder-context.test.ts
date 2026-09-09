import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import { localDateTime, minutesBetween } from "./time";
import { newWorkItem } from "./work";
import type { AppState } from "./types";
import type { WorkspaceChatResponse } from "./workspace-chat";

// Fictional in-memory records and captured model responses only. No provider,
// saved calendar, database, or mail client is used by these regressions.
vi.mock("server-only", () => ({}));
const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("openai", () => ({ default: class { responses = { parse }; } }));
import {
  compileWorkspaceChatIntent, deterministicChatAnswer, interpretWorkspaceChat,
  readWorkspaceChatRecord, workspaceChatMessageDate, workspaceChatRecord,
  type WorkspaceChatRecord,
} from "./server/workspace-chat";

const owner = DEMO_MEMBERS[0], day = "2026-09-09", tomorrow = "2026-09-10", now = "2026-09-09T12:00:00Z";
const at = (clock: string) => localDateTime(day, clock, "America/Indiana/Indianapolis");
const references = ["Tyler", "Higher Ground", "Oral Surgery", "Pura Vida Chicas"];
const original = "I would like Tyler to be first, Higher Ground second, Oral Surgery third, and Pura Vida Chicas last today.";
const aside = "Could you change Pura Vida Chicas to just be a two-hour reserve? I don't want it to start at 2:30 p.m. and at 3:30 p.m., but more like for it to take two hours to finish, if that makes sense.";
const orderedIds = ["s-tyler", "s-tree", "s-oral", "s-pura-1", "s-pura-2"];

function fixture(): AppState {
  const state = createDemoState(now);
  state.workspaceId = "fictional-reorder-context";
  state.settings.reserveMinutes = 0;
  state.blocks = []; state.requests = []; state.events = []; state.notifications = [];
  state.clients = [{ id: "oral", name: "Oral Surgery", aliases: [] }, { id: "tree", name: "Higher Ground", aliases: [] },
    { id: "tyler", name: "Tyler", aliases: [] }, { id: "pura", name: "Pura Vida Chicas", aliases: [] }];
  state.items = state.clients.map((client, index) => newWorkItem(owner, day, {
    id: client.id, clientId: client.id, title: ["Fictional oral edits", "Fictional tree form", "Fictional header fix", "Fictional Pura edits"][index],
    remainingMinutes: index === 3 ? 120 : 60, estimatedMinutes: index === 3 ? 120 : 60,
    minimumSessionMinutes: 60, windowEnd: "2026-12-31",
  }));
  state.sessions = [
    ["s-oral", "oral", "09:00", "10:00"], ["s-tree", "tree", "10:00", "11:00"], ["s-tyler", "tyler", "11:00", "12:00"],
    ["s-pura-1", "pura", "14:30", "15:30"], ["s-pura-2", "pura", "15:30", "16:30"],
  ].map(([id, workItemId, start, end]) => ({ id, workItemId, start: at(start), end: at(end), protected: false, usesReserve: false, status: "planned" }));
  return state;
}
function raw(patch: Record<string, unknown> = {}) {
  return { intent: "reorder", message: "Would you like me to preview that order?", date: day, references,
    orderMode: "ordered", sourceQuote: original, sources: [], overrideProtected: false, edit: null, ...patch };
}
type Compilation = ReturnType<typeof compileWorkspaceChatIntent>;
function record(state: AppState, result: Compilation, text: string, date = day, previous?: WorkspaceChatRecord) {
  const response: WorkspaceChatResponse = { reply: result.reply, operationId: `fictional-turn-${previous?.turns.length ?? 0}`,
    stateVersion: state.version, asOf: now, contextDate: date };
  return workspaceChatRecord(owner, state, response, text, date, result.intent, previous, result.command, result.pendingReorder);
}
function pending(state = fixture(), patch: Record<string, unknown> = {}) {
  const result = compileWorkspaceChatIntent(raw({ intent: "clarification", ...patch }), original, state, owner, day, now, "initial", []);
  expect(result.reply.kind).toBe("clarification");
  expect(result.pendingReorder).toBeDefined();
  return record(state, result, original);
}
function compile(state: AppState, previous: WorkspaceChatRecord, text: string, patch: Record<string, unknown> = {}, date = day) {
  return compileWorkspaceChatIntent(raw(patch), text, state, owner, date, now, "continued", [], previous);
}

beforeEach(() => { parse.mockReset().mockRejectedValue(new Error("Unexpected provider call in context regression")); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("private pending reorder context", () => {
  it("accepts a literal request fragment as evidence but rejects a quote from another message", () => {
    const state = fixture();
    const result = compileWorkspaceChatIntent(raw({ sourceQuote: "Tyler to be first" }), original, state, owner, day, now, "fragment", []);
    expect(result.reply.kind, result.reply.message).toBe("preview");
    expect(result.command).toMatchObject({ sessionIds: orderedIds });
    const foreign = compileWorkspaceChatIntent(raw({ sourceQuote: "Put Pura Vida Chicas first" }), original, state, owner, day, now, "foreign-fragment", []);
    expect(foreign.command).toBeUndefined();
  });

  it.each([
    "I want to know what comes first today",
    "I would like to see my tasks in order",
    "I want a list of Tyler first, then Oral Surgery",
    'The example is "Put Tyler first"',
    "What if Tyler went first?",
    "Don't put Tyler first",
  ])("requires direct authority even if a model proposes an order for: %s", text => {
    const state = fixture();
    const result = compileWorkspaceChatIntent(raw({ references: ["Tyler"], orderMode: "first", sourceQuote: text }), text, state, owner, day, now, "read-only", []);
    expect(result.command).toBeUndefined();
    expect(result.pendingReorder).toBeUndefined();
  });

  it("retains the original ordinal request across a read-only question without retargeting its day", async () => {
    const state = fixture(), before = structuredClone(state), first = pending(state);
    expect(first.pendingReorder).toEqual({ requestText: original, date: day, references, orderMode: "ordered", awaitingReply: true });
    const question = "What is on tomorrow?";
    const answer = deterministicChatAnswer(question, state, tomorrow, first, day)!;
    expect(answer.intent).toBe("agenda");
    const next = record(state, answer, question, tomorrow, first);
    expect(next.pendingReorder).toEqual({ ...first.pendingReorder, awaitingReply: false });
    expect(readWorkspaceChatRecord(next, owner, state, now)).toEqual(next);
    const text = "Can you make the changes please";
    expect(workspaceChatMessageDate(text, day, tomorrow, next)).toEqual({ date: day });
    const result = await interpretWorkspaceChat(text, state, owner, [], { date: day, now, operationId: "resume", demo: true, previous: next });
    expect(result.reply.kind, result.reply.message).toBe("preview");
    expect(result.command).toEqual({ type: "reorder_day", date: day, sessionIds: orderedIds });
    expect(state).toEqual(before);
    expect(parse).not.toHaveBeenCalled();
  });

  it.each(["yes", "Yes, please", "go ahead", "okay that's fine"])("accepts %s only as a fresh preview of the verified reorder prompt", async text => {
    const state = fixture(), first = pending(state), before = structuredClone(state);
    const result = await interpretWorkspaceChat(text, state, owner, [], { date: day, now, operationId: "short-answer", demo: true, previous: first });
    expect(result.reply.kind, result.reply.message).toBe("preview");
    expect(result.command).toMatchObject({ type: "reorder_day", date: day, sessionIds: orderedIds });
    expect(result.reply.message).toContain("Nothing changes until you confirm");
    expect(state).toEqual(before);
  });

  it.each(["What is on tomorrow?", "What if we put Oral Surgery first?", "I would like to see my tasks in order"])("does not let this side question arm a later yes: %s", text => {
    const state = fixture(), first = pending(state);
    const answer = deterministicChatAnswer(text, state, tomorrow, first, day)
      ?? compile(state, first, text, { intent: "answer", message: "This is a read-only answer.", sources: [] }, tomorrow);
    expect(answer.command).toBeUndefined();
    const next = record(state, answer, text, tomorrow, first);
    expect(next.pendingReorder?.awaitingReply).toBe(false);
    const result = compile(state, next, "yes");
    expect(result.command).toBeUndefined();
    const afterYes = record(state, result, "yes", tomorrow, next);
    expect(afterYes.pendingReorder?.awaitingReply).toBe(false);
  });

  it("keeps side-question names, model order, clock text and protected override out of resumed authority", () => {
    const state = fixture(), first = pending(state);
    state.clients.push({ id: "other", name: "Unrequested Project", aliases: [] });
    state.items.push(newWorkItem(owner, day, { id: "other", clientId: "other", title: "Other saved work", remainingMinutes: 60, estimatedMinutes: 60 }));
    const question = "Does Unrequested Project start at 4 PM?";
    const next = record(state, compile(state, first, question, { intent: "answer", sources: [] }), question, tomorrow, first);
    const result = compile(state, next, "Can you make the changes please", {
      references: ["Unrequested Project"], orderMode: "first", date: tomorrow, sourceQuote: question, overrideProtected: true,
    });
    expect(result.reply.kind, result.reply.message).toBe("preview");
    expect(result.command).toEqual({ type: "reorder_day", date: day, sessionIds: orderedIds });
    expect(next.pendingReorder?.requestText).toBe(original);
    expect(next.pendingReorder?.references).toEqual(references);
  });

  it("fills omitted interpretation fields from the original request but refuses names found only in a side question", () => {
    const state = fixture(), empty = pending(state, { references: [], orderMode: null });
    const filled = compile(state, empty, "yes");
    expect(filled.reply.kind, filled.reply.message).toBe("preview");
    expect(filled.command).toMatchObject({ sessionIds: orderedIds });
    const question = "What about Unrequested Project?";
    const next = record(state, compile(state, empty, question, { intent: "answer", sources: [] }), question, day, empty);
    const forged = compile(state, next, "Can you make the changes please", { references: ["Unrequested Project"], orderMode: "first" });
    expect(forged.command).toBeUndefined();
    expect(forged.reply.message).toContain("name the saved task");
  });

  it("sends only original user evidence to the captured provider when filling an empty draft", async () => {
    const state = fixture(), empty = pending(state, { references: [], orderMode: null });
    const question = "What is on tomorrow?", answer = deterministicChatAnswer(question, state, tomorrow, empty, day)!;
    const next = record(state, answer, question, tomorrow, empty);
    vi.stubEnv("OPENAI_API_KEY", "fictional-test-key-never-sent");
    parse.mockResolvedValue({ output_parsed: raw(), usage: { input_tokens: 100, output_tokens: 20 } });
    const result = await interpretWorkspaceChat("Can you make the changes please", state, owner, [], { date: day, now, operationId: "captured", demo: false, previous: next });
    expect(result.reply.kind).toBe("preview");
    const input = JSON.parse(parse.mock.calls[0][0].input[1].content);
    expect(input.userEvidence).toBe(original);
    expect(input.serverPendingReorder).toEqual(next.pendingReorder);
    expect(input.latestUserMessage).toBe("Can you make the changes please");
    expect(parse.mock.calls[0][0]).not.toHaveProperty("tools");
  });

  it.each(["Never mind", "Actually, never mind", "Please cancel that", "Don't reorder anything", "Forget the reorder", "No thanks"])("clears pending authority after %s", text => {
    const state = fixture(), first = pending(state), result = deterministicChatAnswer(text, state, day, first, day)!;
    expect(result.command).toBeUndefined();
    const cancelled = record(state, result, text, day, first);
    expect(cancelled.pendingReorder).toBeUndefined();
    expect(compile(state, cancelled, "Can you make the changes please").command).toBeUndefined();
  });

  it("clears pending authority after a preview or an already-correct no-op", () => {
    const state = fixture(), first = pending(state), result = compile(state, first, "yes");
    expect(result.reply.kind).toBe("preview");
    expect(record(state, result, "yes", day, first).pendingReorder).toBeUndefined();
    const unchanged = { ...state, sessions: result.reply.proposal!.sessions };
    const noOp = compile(unchanged, first, "yes");
    expect(noOp.reply.kind).toBe("answer");
    expect(noOp.reply.proposal).toBeUndefined();
    expect(record(unchanged, noOp, "yes", day, first).pendingReorder).toBeUndefined();
  });

  it("replaces a superseded reorder and clears it for a distinct booking edit", () => {
    const state = fixture(), first = pending(state), newOrder = "Put Higher Ground last today";
    const replacement = compile(state, first, newOrder, { intent: "clarification", references: ["Higher Ground"], orderMode: "last", sourceQuote: newOrder });
    const newer = record(state, replacement, newOrder, day, first);
    expect(newer.pendingReorder?.requestText).toBe(newOrder);
    expect(newer.pendingReorder?.references).toEqual(["Higher Ground"]);
    const editText = "Shorten Fictional header fix by 30 minutes today";
    const edit = compile(state, newer, editText, { intent: "clarification", references: [], orderMode: null, sourceQuote: editText });
    expect(record(state, edit, editText, day, newer).pendingReorder).toBeUndefined();
  });

  it("drops authority when its originating request leaves the ten-turn window", () => {
    const state = fixture(); let previous = pending(state);
    for (let index = 0; index < 10; index++) {
      const text = `Read-only note question ${index}`;
      previous = record(state, compile(state, previous, text, { intent: "answer", sources: [] }), text, day, previous);
    }
    expect(previous.turns).toHaveLength(10);
    expect(previous.pendingReorder).toBeUndefined();
    expect(readWorkspaceChatRecord(previous, owner, state, now)).toEqual(previous);
    expect(compile(state, previous, "Can you make the changes please").command).toBeUndefined();
  });

  it("does not cache an unreadable draft when a numbered reference exceeds its bound", () => {
    const state = fixture(), text = `I want:\n1. ${"x".repeat(301)}\n2. Tyler`;
    const result = compileWorkspaceChatIntent(raw(), text, state, owner, day, now, "bounded-reference", []);
    expect(result.command).toBeUndefined();
    expect(result.pendingReorder).toBeUndefined();
    const saved = record(state, result, text);
    expect(readWorkspaceChatRecord(saved, owner, state, now)).toEqual(saved);
  });
});

describe("discussion of adjacent bookings during a pending reorder", () => {
  it("explains the exact two-hour aside without resizing, then previews the original order on yes", async () => {
    const state = fixture(), before = structuredClone(state), first = pending(state);
    const explanation = await interpretWorkspaceChat(aside, state, owner, [], { date: day, now, operationId: "group-question", demo: false, previous: first });
    expect(explanation.command).toBeUndefined();
    expect(explanation.reply.kind).toBe("clarification");
    expect(explanation.reply.message).toContain("already reserves 2h continuously");
    expect(explanation.pendingReorder).toEqual(first.pendingReorder);
    const next = record(state, explanation, aside, day, first);
    expect(next.pendingReorder?.requestText).toBe(original);
    expect(next.pendingReorderText).toBeUndefined();
    const result = await interpretWorkspaceChat("yes", state, owner, [], { date: day, now, operationId: "group-resume", demo: true, previous: next });
    expect(result.reply.kind, result.reply.message).toBe("preview");
    expect(result.command).toEqual({ type: "reorder_day", date: day, sessionIds: orderedIds });
    expect(result.reply.proposal!.sessions.map(session => [session.id, minutesBetween(session.start, session.end)])).toEqual(before.sessions.map(session => [session.id, minutesBetween(session.start, session.end)]));
    expect(state).toEqual(before);
    expect(parse).not.toHaveBeenCalled();
  });

  it.each(["changed total", "gap", "different project"])("does not claim a matching continuous reservation with %s", scenario => {
    const state = fixture(), first = pending(state);
    if (scenario === "changed total") state.sessions[4].end = at("17:00");
    if (scenario === "gap") { state.sessions[4].start = at("16:00"); state.sessions[4].end = at("17:00"); }
    if (scenario === "different project") first.pendingReorder!.references = references.slice(0, 3);
    const result = deterministicChatAnswer(aside, state, day, first, day);
    expect(result?.pendingReorder).toBeUndefined();
    expect(result?.reply.message ?? "").not.toContain("already reserves 2h continuously");
    expect(result?.command).toBeUndefined();
  });

  it.each([
    "Make Pura Vida Chicas a single two-hour reserve starting at 1 PM",
    "Move Pura Vida Chicas into one continuous two-hour booking at 1 PM",
    "Change Pura Vida Chicas to just be two hours tomorrow",
  ])("does not treat a new clock or day instruction as an unchanged-group aside: %s", text => {
    const state = fixture(), first = pending(state);
    const result = deterministicChatAnswer(text, state, day, first, day);
    expect(result?.pendingReorder).toBeUndefined();
    expect(result?.reply.message ?? "").not.toContain("already reserves 2h continuously");
  });
});
