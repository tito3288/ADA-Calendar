import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { compileInterpretation, emptyAssistantAction } from "./server/assistant";
import { compileWorkspaceChatIntent, readWorkspaceChatRecord, workspaceChatRecord } from "./server/workspace-chat";
import { planCommands } from "./scheduler";
import { localDateTime, minutesBetween } from "./time";
import { newWorkItem } from "./work";
import { commandSchema } from "./schemas";
import type { Actor, AppState, WorkSession } from "./types";

const owner: Actor = { id: "owner", name: "Owner", role: "owner", email: "owner@example.test" };
const date = "2026-09-09", tomorrow = "2026-09-10", at = (day: string, time: string) => localDateTime(day, time, DEFAULT_SETTINGS.timeZone);
function fixture(status: WorkSession["status"] = "planned"): AppState {
  const item = newWorkItem(owner, date, { id: "repair", clientId: "client", title: "Printer repairs", estimatedMinutes: 120, remainingMinutes: 120 });
  return { workspaceId: "missed-work-fixture", version: 0, actor: owner, members: [owner], settings: { ...DEFAULT_SETTINGS, reserveMinutes: 0 }, priorities: DEFAULT_PRIORITIES,
    clients: [{ id: "client", name: "Fictional client", aliases: [] }], items: [item],
    sessions: [{ id: "missed", workItemId: item.id, start: at(date, "09:00"), end: at(date, "11:00"), status, protected: false, usesReserve: false }],
    blocks: [], events: [], requests: [], notifications: [], emailDrafts: [], attachments: [], aiUsageUsd: 0, mode: "demo" };
}
function assistant(source: string, state: AppState, now: string, patch: Partial<ReturnType<typeof emptyAssistantAction>> = {}) {
  return compileInterpretation({ kind: "commands", message: "Move planned work", draft: null, actions: [{ ...emptyAssistantAction("move", source), itemReference: "Printer repairs", windowStart: tomorrow, windowEnd: tomorrow, ...patch }] }, source, state, owner, new Date(now));
}
function chat(source: string, state: AppState, now: string, actor = owner) {
  return compileWorkspaceChatIntent({ intent: "edit", message: "Move planned work", date, orderMode: null, references: [], sourceQuote: source, sources: [], overrideProtected: false,
    edit: { kind: "move", reference: "Printer repairs", sourceDate: date, targetDate: tomorrow, endDate: tomorrow, minutes: null, amountMode: "all", sourceStartTime: null, targetStartTime: null, dayHours: [] } }, source, state, actor, date, now, "missed-work-op", []);
}

describe("explicit moves of missed planned work", () => {
  it.each(["09:30", "11:30", "17:30"])("ADA and the helper preserve the same two hours after the source start/end (%s)", time => {
    const state = fixture(), before = structuredClone(state), now = at(date, time), source = "Move Printer repairs from today to tomorrow.";
    const interpreted = assistant(source, state, now);
    expect(interpreted.commands).toEqual([{ type: "move_booking", sessionId: "missed", date: tomorrow }]);
    const proposal = planCommands(state, interpreted.commands, owner, { now });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions).toHaveLength(1);
    expect(minutesBetween(proposal.sessions[0].start, proposal.sessions[0].end)).toBe(120);
    expect(proposal.items[0]).toMatchObject({ remainingMinutes: 120, estimatedMinutes: 120 });
    const helper = chat(source, state, now);
    expect(helper.reply.kind, helper.reply.message).toBe("preview");
    expect(helper.command).toEqual({ type: "move_booking", sessionId: "missed", date: tomorrow });
    expect(helper.reply.proposal?.items[0]).toMatchObject({ remainingMinutes: 120, estimatedMinutes: 120 });
    expect(state).toEqual(before);
  });
  it.each(["completed", "cancelled"] as const)("never moves explicitly %s sessions", status => {
    const state = fixture(status), source = "Move Printer repairs from today to tomorrow.", now = at(date, "17:30");
    expect(assistant(source, state, now).commands).toEqual([]);
    expect(chat(source, state, now).command).toBeUndefined();
  });
  it.each([["1 hour", 60], ["45 minutes", 45]] as const)("moves only the explicitly requested %s of missed work", (amount, minutes) => {
    const state = fixture(), now = at(date, "17:30");
    const interpreted = assistant(`Move ${amount} of Printer repairs from today to tomorrow.`, state, now);
    expect(interpreted.commands).toEqual([{ type: "move_booking", sessionId: "missed", date: tomorrow, minutes }]);
    const proposal = planCommands(state, interpreted.commands, owner, { now });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions.filter(s => s.start.startsWith(tomorrow)).reduce((sum, s) => sum + minutesBetween(s.start, s.end), 0)).toBe(minutes);
    expect(proposal.sessions.reduce((sum, s) => sum + minutesBetween(s.start, s.end), 0)).toBe(120);
    expect(proposal.items[0]).toMatchObject({ remainingMinutes: 120, estimatedMinutes: 120 });
  });
  it.each(["some hours", "1 or 2 hours", "eleven hours", "20 minutes"])("clarifies an unsupported or excessive %s instead of moving all two hours", amount => {
    expect(assistant(`Move ${amount} of Printer repairs from today to tomorrow.`, fixture(), at(date, "17:30")).commands).toEqual([]);
  });
  it("does not let a model-selected session override the user's source day", () => {
    const state = fixture(), now = at(date, "17:30"), source = "Move Printer repairs from today to tomorrow.";
    state.sessions.push({ ...state.sessions[0], id: "yesterday", start: at("2026-09-08", "09:00"), end: at("2026-09-08", "11:00") });
    expect(assistant(source, state, now, { sessionId: "yesterday" }).commands).toEqual([]);
    expect(assistant(source, state, now, { sessionId: "missing" }).commands).toEqual([]);
    state.sessions[0].protected = true;
    const interpreted = assistant(source, state, now, { sessionId: "missed" });
    expect(interpreted.commands).toEqual([{ type: "move_booking", sessionId: "missed", date: tomorrow }]);
    expect(planCommands(state, interpreted.commands, owner, { now }).conflicts.some(conflict => conflict.code === "protected_session")).toBe(true);
  });
  it("keeps unknown effort unknown and preserves all same-day fragments", () => {
    const state = fixture(); state.items[0].estimatedMinutes = null; state.items[0].remainingMinutes = null;
    state.sessions[0].end = at(date, "10:00"); state.sessions.push({ ...state.sessions[0], id: "second", start: at(date, "10:00"), end: at(date, "11:00") });
    const now = at(date, "17:30"), result = assistant("Move Printer repairs from today to tomorrow.", state, now);
    expect(result.commands).toEqual([{ type: "move_bookings", sessionIds: ["missed", "second"], date: tomorrow }]);
    const proposal = planCommands(state, result.commands, owner, { now });
    expect(proposal.status).toBe("ready");
    expect(proposal.items[0]).toMatchObject({ estimatedMinutes: null, remainingMinutes: null });
    expect(proposal.sessions.reduce((sum, s) => sum + minutesBetween(s.start, s.end), 0)).toBe(120);
    const helper = chat("Move Printer repairs from today to tomorrow.", state, now);
    expect(helper.command).toEqual({ type: "move_bookings", sessionIds: ["missed", "second"], date: tomorrow });
    expect(helper.reply.kind, helper.reply.message).toBe("preview");
    expect(helper.reply.totals).toEqual({ beforeMinutes: 120, afterMinutes: 120, deltaMinutes: 0 });
    const record = workspaceChatRecord(owner, state, { reply: helper.reply, asOf: now, operationId: "missed-work-op", stateVersion: state.version }, "Move Printer repairs from today to tomorrow.", date, "edit", undefined, helper.command);
    expect(readWorkspaceChatRecord(record, owner, state, now).command).toEqual(helper.command);
    expect(commandSchema.safeParse(helper.command).success).toBe(true);
    for (const sessionIds of [[], ["missed", "missed"], [""]])
      expect(() => readWorkspaceChatRecord({ ...record, command: { ...helper.command, sessionIds } }, owner, state, now)).toThrow();
    expect(assistant("Move 1 hour of Printer repairs from today to tomorrow.", state, now).commands).toEqual([]);
    state.sessions[0].protected = true;
    expect(assistant("Move Printer repairs from today to tomorrow. Override protected time.", state, now).commands).toEqual([]);
  });
  it("keeps source identity, protection, and requester permissions grounded", () => {
    const state = fixture(), now = at(date, "17:30"), source = "Move Printer repairs from today to tomorrow.";
    expect(chat(source, state, now, { ...owner, role: "requester" }).command).toBeUndefined();
    state.sessions[0].protected = true;
    expect(chat(source, state, now).reply.proposal?.status).toBe("infeasible");
    expect(assistant("Do not move Printer repairs from today to tomorrow.", state, now).commands).toEqual([]);
    expect(assistant("The client wrote: move Printer repairs from today to tomorrow.", state, now).commands).toEqual([]);
    expect(assistant("Move Printer repairs from yesterday to tomorrow.", state, now).commands).toEqual([]);
  });
});
