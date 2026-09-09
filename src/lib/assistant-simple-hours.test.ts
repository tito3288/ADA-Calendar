import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { compileInterpretation, emptyAssistantAction, type AssistantAction } from "./server/assistant";
import { compileWorkspaceChatIntent } from "./server/workspace-chat";
import { planCommands } from "./scheduler";
import { localDate, localDateTime, minutesBetween } from "./time";
import { newWorkItem } from "./work";
import { projectSpanCorrectionEvidence } from "./assistant-work-context";
import type { Actor, AppState, ScheduleSnapshot } from "./types";

const now = new Date("2026-09-09T12:00:00Z"), day = "2026-09-11";
const owner: Actor = { id: "simple-owner", name: "Owner", email: "owner@example.test", role: "owner" };
function state(): ScheduleSnapshot {
  return { workspaceId: "simple-hours", version: 0, settings: { ...DEFAULT_SETTINGS, reserveMinutes: 0 }, priorities: structuredClone(DEFAULT_PRIORITIES),
    clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }], items: [], sessions: [], blocks: [] };
}
function compile(source: string, patch: Partial<AssistantAction>, snapshot = state()) {
  return compileInterpretation({ kind: "commands", message: "Prepared", draft: null, actions: [{
    ...emptyAssistantAction("create", source), clientName: "Cedar Studio", title: "Printer repairs", category: "it", estimatedMinutes: 120,
    windowStart: day, windowEnd: day, ...patch,
  }] }, source, snapshot, owner, now);
}
function chatState(unknown = false): AppState {
  const snapshot = state();
  snapshot.items = [newWorkItem(owner, day, { id: "printer", clientId: "cedar", title: "Printer repairs", estimatedMinutes: unknown ? null : 240, remainingMinutes: unknown ? null : 240, timelineMode: unknown ? "span" : "bookings" })];
  snapshot.sessions = [day, "2026-09-14"].map((date, index) => ({ id: `session-${index}`, workItemId: "printer", start: localDateTime(date, "09:00", snapshot.settings.timeZone), end: localDateTime(date, "11:00", snapshot.settings.timeZone), status: "planned", protected: false, usesReserve: false }));
  return { ...snapshot, actor: owner, members: [owner], requests: [], events: [], notifications: [], attachments: [], emailDrafts: [], aiUsageUsd: 0, mode: "demo" };
}
function chat(source: string, rows: AssistantAction["dayHours"], snapshot = chatState()) {
  return compileWorkspaceChatIntent({ intent: "edit", message: "Prepared", date: day, orderMode: null, references: [], sourceQuote: source, sources: [], overrideProtected: false,
    edit: { kind: "set_day_hours", reference: "Printer repairs", sourceDate: null, targetDate: null, endDate: null, minutes: null, amountMode: null, sourceStartTime: null, targetStartTime: null, dayHours: rows } },
  source, snapshot, owner, day, now.toISOString(), "simple-hours-preview", []);
}

describe("simple hours with flexible booking dates (offline)", () => {
  it("books a future regular task only on the requested day without making a permanent date lock", () => {
    const snapshot = state(), text = "Add IT work for Cedar Studio: Printer repairs, 2 hours on 2026-09-11.";
    const result = compile(text, { windowEnd: null, allowedDates: [day] }, snapshot);
    expect(result.commands[0]).toMatchObject({ type: "create", item: { allowedDates: [], dateConstraints: { earliestStart: null, allowedDates: [] }, timelineMode: "bookings" }, smartFit: { startDate: day, endDate: day } });
    const proposal = planCommands(snapshot, result.commands, owner, { now: now.toISOString() });
    expect(proposal.status).toBe("ready");
    expect(proposal.sessions.every(session => localDate(session.start, snapshot.settings.timeZone) === day)).toBe(true);
  });
  it("keeps an ongoing project open-ended and unknown while booking the initial Friday hours", () => {
    const source = "Add ongoing IT work for Cedar Studio: Printer repairs. Total effort is unknown with no end date. Book 2 hours on 2026-09-11.";
    const result = compile(source, {});
    expect(result.commands[0]).toMatchObject({ item: { estimatedMinutes: null, remainingMinutes: null, windowEnd: null, timelineMode: "span" }, smartFit: { startDate: day, endDate: day, minutes: 120 } });
    expect(planCommands(state(), result.commands, owner, { now: now.toISOString() }).status).toBe("ready");
  });
  it("grounds unequal day amounts and derives a known total without permanent date constraints", () => {
    const source = "Add IT work for Cedar Studio: Printer repairs. 2 hours on 2026-09-11, 1 hour on 2026-09-14.";
    const result = compile(source, { windowEnd: "2026-09-14", dayHours: [
      { date: day, minutes: 120, sourceQuote: "2 hours on 2026-09-11" }, { date: "2026-09-14", minutes: 60, sourceQuote: "1 hour on 2026-09-14" },
    ] });
    expect(result.commands[0]).toMatchObject({ item: { estimatedMinutes: 180, remainingMinutes: 180, allowedDates: [], dailyPlan: [{ date: day, minutes: 120 }, { date: "2026-09-14", minutes: 60 }] } });
    const proposal = planCommands(state(), result.commands, owner, { now: now.toISOString() });
    expect(proposal.status).toBe("ready");
    expect(proposal.sessions.reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0)).toBe(180);
  });
  it("rejects swapped row amounts and invented permanent constraints", () => {
    const source = "Add IT work for Cedar Studio: Printer repairs. 2 hours on 2026-09-11, 1 hour on 2026-09-14.";
    expect(compile(source, { dayHours: [{ date: day, minutes: 60, sourceQuote: "2 hours on 2026-09-11" }] }).commands).toEqual([]);
    expect(compile(source, { dayHours: [{ date: day, minutes: 120, sourceQuote: "2 hours on 2026-09-11" }] }).commands).toEqual([]);
    expect(compile(source, { dateConstraints: { earliestStart: day, allowedDates: [] } }).commands).toEqual([]);
  });
  it("retains a positively requested earliest start and allowed dates", () => {
    const source = "Add IT work for Cedar Studio: Printer repairs, 2 hours on 2026-09-11. Earliest start 2026-09-11. Allowed work dates 2026-09-11 and 2026-09-14.";
    const dateConstraints = { earliestStart: day, allowedDates: [day, "2026-09-14"] };
    expect(compile(source, { dateConstraints }).commands[0]).toMatchObject({ item: { dateConstraints } });
  });
  it.each(["Book only on 2026-09-11", "Do not add allowed work dates 2026-09-11"])("does not turn initial booking or negated limits into lasting constraints: %s", clause => {
    const source = `Add IT work for Cedar Studio: Printer repairs, 2 hours on 2026-09-11. ${clause}.`;
    expect(compile(source, { dateConstraints: { earliestStart: null, allowedDates: [day] } }).commands).toEqual([]);
  });
  it("previews a multi-day final-total change including removing a day", () => {
    const source = "Set Printer repairs to 1 hour on 2026-09-11 and 0 hours on 2026-09-14.";
    const result = chat(source, [{ date: day, minutes: 60, sourceQuote: "1 hour on 2026-09-11" }, { date: "2026-09-14", minutes: 0, sourceQuote: "0 hours on 2026-09-14" }]);
    expect(result.command).toMatchObject({ type: "set_day_hours", itemId: "printer", days: [{ date: day, minutes: 60 }, { date: "2026-09-14", minutes: 0 }] });
    expect(result.reply.kind, result.reply.message).toBe("preview");
    expect(result.reply.proposal?.items[0]).toMatchObject({ remainingMinutes: 60, estimatedMinutes: 240 });
  });
  it("keeps unknown totals unknown after changing day hours", () => {
    const source = "Set Printer repairs to 1 hour on 2026-09-11.";
    const result = chat(source, [{ date: day, minutes: 60, sourceQuote: "1 hour on 2026-09-11" }], chatState(true));
    expect(result.reply.kind, result.reply.message).toBe("preview");
    expect(result.reply.proposal?.items[0]).toMatchObject({ remainingMinutes: null, estimatedMinutes: null });
  });
  it("rejects partial or forged day-total proposals", () => {
    const source = "Set Printer repairs to 1 hour on 2026-09-11 and 0 hours on 2026-09-14.";
    expect(chat(source, [{ date: day, minutes: 60, sourceQuote: "1 hour on 2026-09-11" }]).command).toBeUndefined();
    expect(chat(source, [{ date: day, minutes: 120, sourceQuote: "1 hour on 2026-09-11" }]).command).toBeUndefined();
  });
  it("sets a grounded uniform weekday range and rejects provider rows that change its amounts", () => {
    const source = "Set Printer repairs to 1 hour each weekday from 2026-09-11 through 2026-09-14.";
    const result = chat(source, []);
    expect(result.command).toMatchObject({ type: "set_day_hours", days: [{ date: day, minutes: 60 }, { date: "2026-09-14", minutes: 60 }] });
    expect(result.reply.kind, result.reply.message).toBe("preview");
    expect(result.reply.proposal?.items[0]).toMatchObject({ remainingMinutes: 120, estimatedMinutes: 240 });
    expect(chat(source, [{ date: day, minutes: 120, sourceQuote: source }, { date: "2026-09-14", minutes: 120, sourceQuote: source }]).command).toBeUndefined();
  });
  it("accepts an explicit month-list correction for the same unfinished project while keeping quoted dates untrusted", () => {
    const snapshot = state(), prior = "Cedar Studio needs Printer repairs. Total effort unknown. Show this project this month.";
    const reply = "Add it for months of September, October, November and December and for now 2 hours on Friday.";
    expect(projectSpanCorrectionEvidence(reply, prior, "Printer repairs", snapshot.clients[0], snapshot.clients)).toContain("months of September");
    expect(projectSpanCorrectionEvidence(`The client wrote: ${reply}`, prior, "Printer repairs", snapshot.clients[0], snapshot.clients)).toBeNull();
  });
});
