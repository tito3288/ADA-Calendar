import { describe, expect, it } from "vitest";
import { dateSelectionSchema, type AssistantDateSelection } from "./assistant-date-selection";
import { nextContinuation, readContinuation, conversationText } from "./assistant-conversation";
import { compileInterpretation, emptyAssistantAction, interpretInput } from "./server/assistant";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { planCommands, validateSchedule } from "./scheduler";
import { localDate } from "./time";
import type { Actor, ScheduleSnapshot } from "./types";

// Fictional, offline compiler/scheduler fixture. No provider or storage access.
const now = new Date("2026-09-08T13:00:00Z");
const owner: Actor = { id: "test-owner", name: "Test owner", email: "owner@example.test", role: "owner" };
const requester: Actor = { ...owner, id: "test-requester", role: "requester" };
const selection: AssistantDateSelection = { start: "2026-09-09", end: "2026-09-11", kind: "work_window" };
const question = { kind: "clarification" as const, message: "How many hours?", commands: [] };
function snapshot(): ScheduleSnapshot {
  return { workspaceId: "fictional-selected-dates", version: 0, clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }], priorities: structuredClone(DEFAULT_PRIORITIES), settings: structuredClone(DEFAULT_SETTINGS), items: [], sessions: [], blocks: [] };
}
function interpret(text = "Add web work for Cedar Studio: Page edits, 2 hours.", dates: AssistantDateSelection = selection, actor = owner, patch = {}, reply = text) {
  return compileInterpretation({ kind: "commands", message: "Prepared work", draft: null, actions: [{ ...emptyAssistantAction("create", text), clientName: "Cedar Studio", title: "Page edits", category: "web", webKind: "edit", estimatedMinutes: 120, ...patch }] }, text, snapshot(), actor, now, reply, [], dates);
}

describe("explicit dates for one ADA instruction", () => {
  it.each([
    { ...selection, start: "2026-02-30" }, { ...selection, end: "2026-09-08" },
    { ...selection, end: "2027-09-10" }, { ...selection, overrideProtected: true }, { ...selection, kind: "anything" },
  ])("rejects malformed or overbroad context %j", value => expect(dateSelectionSchema.safeParse(value).success).toBe(false));
  it("retains, replaces, and explicitly clears dates without adding them to user authority", () => {
    const pending = nextContinuation("Add web work for Cedar Studio", question, now, undefined, selection)!;
    expect(readContinuation({ interpretation: question, continuation: pending }, now, DEFAULT_SETTINGS.timeZone).dateSelection).toEqual(selection);
    expect(conversationText("Two hours", pending)).not.toContain(selection.start);
    expect(nextContinuation("Two hours", question, now, pending)?.dateSelection).toEqual(selection);
    const changed = { ...selection, end: "2026-09-10" };
    expect(nextContinuation("Two hours", question, now, pending, changed)?.dateSelection).toEqual(changed);
    expect(nextContinuation("Two hours", question, now, pending, null)?.dateSelection).toBeNull();
    expect(nextContinuation("Two hours", { ...question, kind: "answer" }, now, pending, selection)).toBeNull();
    expect(() => readContinuation({ interpretation: question, continuation: pending }, new Date("2026-09-09T13:00:00Z"), DEFAULT_SETTINGS.timeZone)).toThrow(/earlier workday/);
  });
  it.each([owner, requester])("fits the total effort once inside the range for $role", actor => {
    const result = interpret(undefined, selection, actor);
    expect(result.kind, result.message).toBe("commands");
    expect(result.commands[0]).toMatchObject({ item: { windowStart: selection.start, windowEnd: selection.end, estimatedMinutes: 120, deadline: null } });
    const proposal = planCommands(snapshot(), result.commands, actor, { now: now.toISOString() });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions.reduce((sum, s) => sum + (Date.parse(s.end) - Date.parse(s.start)) / 60000, 0)).toBe(120);
    expect(proposal.sessions.every(s => localDate(s.start, DEFAULT_SETTINGS.timeZone) >= selection.start && localDate(s.end, DEFAULT_SETTINGS.timeZone) <= selection.end)).toBe(true);
    expect(validateSchedule({ ...snapshot(), items: proposal.items, sessions: proposal.sessions }, now.toISOString())).toEqual([]);
  });
  it.each(["tomorrow", "September 9th", "Wednesday the 9th", "2026-09-09"])("accepts matching spoken dates: %s", words => {
    expect(interpret(`Add web work for Cedar Studio: Page edits, 2 hours ${words}.`).kind).toBe("commands");
  });
  it.each(["today", "September 14th", "Monday", "2026-09-14", "Friday 2026-09-10"])("clarifies conflicting speech even if extraction ignores it: %s", words => {
    const result = interpret(`Add web work for Cedar Studio: Page edits, 2 hours ${words}.`);
    expect(result.kind).toBe("clarification"); expect(result.commands).toEqual([]);
  });
  it("supports explicit agreement to replace earlier conflicting dates", () => {
    const reply = "Use the selected dates";
    expect(interpret(`Add web work for Cedar Studio: Page edits, 2 hours today.\n${reply}`, selection, owner, {}, reply).kind).toBe("commands");
  });
  it("lets an explicitly spoken day narrow the work window without silently narrowing a plain range", () => {
    expect(interpret("Add web work for Cedar Studio: Page edits, 2 hours on September 11th.", selection, owner, { windowStart: "2026-09-11", windowEnd: "2026-09-11" }).commands[0]).toMatchObject({ item: { windowStart: "2026-09-11", windowEnd: "2026-09-11" } });
    expect(interpret(undefined, selection, owner, { windowStart: "2026-09-11", windowEnd: "2026-09-11" }).commands[0]).toMatchObject({ item: { windowStart: selection.start, windowEnd: selection.end } });
  });
  it("never infers effort from a range or bypasses the viewer boundary", () => {
    expect(interpret("Add web work for Cedar Studio: Page edits.", selection, owner, { estimatedMinutes: null }).kind).toBe("clarification");
    expect(interpret(undefined, selection, { ...owner, role: "viewer" }).kind).toBe("clarification");
  });
  it("creates an owner's timeline without allocating known or unknown hours", () => {
    for (const estimate of [null, 120]) {
      const result = interpret(undefined, { ...selection, end: "2026-10-31", kind: "project_span" }, owner, { estimatedMinutes: estimate });
      expect(result.kind, result.message).toBe("commands");
      const proposal = planCommands(snapshot(), result.commands, owner, { now: now.toISOString() });
      expect(proposal.status).toBe("ready"); expect(proposal.sessions).toEqual([]);
      expect(proposal.items[0]).toMatchObject({ status: "waiting", windowEnd: "2026-10-31", remainingMinutes: estimate });
    }
    expect(interpret(undefined, { ...selection, kind: "project_span" }, requester).kind).toBe("clarification");
  });
  it("rejects invented sessions, out-of-range dates, and implicit protected time", () => {
    const session = { start: "2026-09-09T09:00:00-04:00", end: "2026-09-09T11:00:00-04:00", protected: false, usesReserve: false };
    expect(interpret(undefined, selection, owner, { sessions: [session] }).kind).toBe("clarification");
    expect(interpret(undefined, selection, owner, { allowedDates: ["2026-09-14"] }).kind).toBe("clarification");
    const text = "Add web work for Cedar Studio: Page edits, 2 hours from 9am–11am.";
    expect(interpret(text, selection, owner, { sessions: [session] }).kind).toBe("commands");
    expect(interpret(text, selection, owner, { sessions: [{ ...session, protected: true }] }).kind).toBe("clarification");
    expect(interpret(text, selection, owner, { sessions: [{ ...session, start: "bad" }] }).kind).toBe("clarification");
  });
  it("still asks the scheduler about unavailable days instead of moving the work outside them", () => {
    const date = { start: "2026-09-12", end: "2026-09-12", kind: "work_window" as const };
    const result = interpret(undefined, date, requester);
    const proposal = planCommands(snapshot(), result.commands, requester, { now: now.toISOString() });
    expect(proposal.status).not.toBe("ready"); expect(proposal.sessions).toEqual([]);
  });
  it("hands selected context through the isolated demo parser and continuation", async () => {
    const pending = nextContinuation("Add web work for Cedar Studio: Page edits", question, now, undefined, selection)!;
    const result = await interpretInput("Two hours", snapshot(), owner, { demo: true, now, continuation: pending });
    expect(result.kind, result.message).toBe("commands");
    expect(result.commands[0]).toMatchObject({ item: { windowStart: selection.start, windowEnd: selection.end } });
  });
});
