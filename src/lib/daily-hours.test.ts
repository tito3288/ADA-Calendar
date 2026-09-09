import { describe, expect, it } from "vitest";
import { dailyHoursPlan } from "./assistant-daily-hours";
import { compileInterpretation, emptyAssistantAction } from "./server/assistant";
import { DEFAULT_SETTINGS, DEFAULT_PRIORITIES } from "./defaults";
import { planCommands, validateSchedule } from "./scheduler";
import { localDate, localDateTime, minutesBetween } from "./time";
import { newWorkItem } from "./work";
import { workItemSchema } from "./schemas";
import type { Actor, ScheduleSnapshot, WorkItem, WorkSession } from "./types";

const owner: Actor = { id: "test-owner", name: "Test owner", role: "owner", email: "owner@example.test" };
const requester: Actor = { ...owner, id: "requester", role: "requester" };
const dates = [14, 15, 16, 17, 18].map(day => `2026-09-${day}`);
const zone = DEFAULT_SETTINGS.timeZone;
const at = (date: string, time: string) => localDateTime(date, time, zone);
const now = at("2026-09-08", "08:00");
const selected = { start: dates[0], end: dates[4], kind: "work_window" as const };
function base(): ScheduleSnapshot { return { workspaceId: "fictional-daily-hours", version: 0, settings: structuredClone(DEFAULT_SETTINGS), clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }], priorities: structuredClone(DEFAULT_PRIORITIES), items: [], sessions: [], blocks: [] }; }
function work(patch: Partial<WorkItem> = {}) { return newWorkItem(owner, dates[0], { id: "cedar-build", clientId: "cedar", title: "Cedar website", estimatedMinutes: 600, remainingMinutes: 600, windowEnd: dates[4], dailyPlan: dates.map(date => ({ date, minutes: 120 })), minimumSessionMinutes: 120, ...patch }); }
function session(id: string, date: string, start: string, end: string): WorkSession { return { id, workItemId: "cedar-build", start: at(date, start), end: at(date, end), status: "planned", protected: false, usesReserve: false }; }
function interpret(phrase: string, actor = owner, patch = {}) {
  const text = `Add web work for Cedar Studio: build a website, ${phrase}.`;
  return compileInterpretation({ kind: "commands", message: "Prepared", draft: null, actions: [{ ...emptyAssistantAction("create", text), clientName: "Cedar Studio", title: "Cedar website", category: "web", webKind: "build", estimatedMinutes: 120, ...patch }] }, text, base(), actor, new Date(now), text, [], selected);
}
describe("grounded daily hours", () => {
  it.each(["2 hours each day", "two hours each selected day", "2 hours of work for each day", "for each of those days, two hours", "2 hours daily", "2 hours a day", "2 hours on each selected date", "spread ten hours evenly", "divide 10 hours equally", "2 hours each day, 10 hours total"])("understands %s", phrase => {
    const result = interpret(phrase);
    expect(result.kind, result.message).toBe("commands");
    expect(result.commands[0]).toMatchObject({ item: { estimatedMinutes: 600, remainingMinutes: 600, dailyPlan: dates.map(date => ({ date, minutes: 120 })) } });
    const proposal = planCommands(base(), result.commands, owner, { now });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions.map(s => [localDate(s.start, zone), minutesBetween(s.start, s.end)])).toEqual(dates.map(date => [date, 120]));
  });
  it("does not turn a flexible total into a daily rule", () => {
    expect(interpret("10 hours sometime within these dates", owner, { estimatedMinutes: 600 }).commands[0]).toMatchObject({ item: { estimatedMinutes: 600 } });
    expect(dailyHoursPlan("10 hours sometime within these dates", dates[0], dates[4], [], [1,2,3,4,5])).toEqual({});
  });
  it("does not let incomplete model dates omit selected days", () => {
    const result = interpret("2 hours each selected day", owner, { allowedDates: dates.slice(0,2), windowStart: dates[0], windowEnd: dates[1] });
    expect(result.commands[0]).toMatchObject({ item: { dailyPlan: dates.map(date => ({ date, minutes: 120 })), windowEnd: dates[4] } });
  });
  it("supports daily one-hour bookings below the default two-hour build minimum", () => {
    const result = interpret("one hour each day");
    const proposal = planCommands(base(), result.commands, owner, { now });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions.map(s => minutesBetween(s.start,s.end))).toEqual([60,60,60,60,60]);
  });
  it.each(["one and a half hours each day", "an hour and a half each day"])("does not misread the fraction in %s", phrase => {
    expect(dailyHoursPlan(phrase,dates[0],dates[4],[],[1,2,3,4,5]).total).toBe(450);
  });
  it("sets each selected day's hours on an existing unknown-total project without inventing an estimate", () => {
    const state = base(); state.items = [work({ dailyPlan: undefined, estimatedMinutes: null, remainingMinutes: null })]; state.sessions = [session("old",dates[0],"09:00","10:00")];
    const text = "Schedule Cedar Studio Cedar website for two hours each selected day.";
    const interpreted = compileInterpretation({ kind: "commands", message: "Prepared", draft: null, actions: [{ ...emptyAssistantAction("schedule",text), clientName: "Cedar Studio", itemReference: "Cedar website" }] }, text, state, owner, new Date(now), text, [], selected);
    expect(interpreted.kind, interpreted.message).toBe("commands");
    expect(interpreted.commands).toEqual([{ type: "set_day_hours", itemId: "cedar-build", days: dates.map(date => ({ date, minutes: 120 })) }]);
    const proposal = planCommands(state, interpreted.commands, owner, { now });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(dates.map(date => proposal.sessions.filter(session => localDate(session.start, zone) === date).reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0))).toEqual([120, 120, 120, 120, 120]);
    expect(proposal.items[0].remainingMinutes).toBeNull();
  });
  it.each(["2 hours each day, 8 hours total", "2 hours each day which would equal 8 hours", "spread 1 hour evenly", "two hours each day and three hours every day", "not two hours each day"])("clarifies %s", phrase => expect(interpret(phrase).kind).toBe("clarification"));
  it("preserves unknown overall effort and books explicit daily amounts", () => {
    const result = interpret("total project effort is unknown. Book 2 hours each selected day", owner, { estimatedMinutes: null });
    expect(result.kind, result.message).toBe("commands");
    expect(result.commands[0]).toMatchObject({ item: { estimatedMinutes: null, remainingMinutes: null, status: "planned" } });
    expect(planCommands(base(), result.commands, owner, { now }).sessions).toHaveLength(5);
  });
  it("uses all selected days unless weekdays are explicitly requested", () => {
    expect(dailyHoursPlan("2 hours each day", "2026-09-11", "2026-09-14", [], [1,2,3,4,5]).plan).toHaveLength(4);
    expect(dailyHoursPlan("2 hours each weekday", "2026-09-11", "2026-09-14", [], [1,2,3,4,5]).plan).toHaveLength(2);
  });
});
describe("persistent daily allocation", () => {
  it.each([owner, requester])("books exactly two hours on all five days for $role", actor => {
    const original = base();
    const proposal = planCommands(original, [{ type: "create", item: work() }], actor, { now });
    expect(proposal.status).toBe("ready");
    expect(proposal.sessions.map(s => minutesBetween(s.start, s.end))).toEqual([120,120,120,120,120]);
    expect(validateSchedule({ ...original, items: proposal.items, sessions: proposal.sessions }, now)).toEqual([]);
    expect(original.items).toEqual([]);
  });
  it("reports the exact unavailable day and applies none of the partial plan", () => {
    const state = base(); state.blocks = [{ id: "closed", title: "Fictional time off", start: at(dates[2], "09:00"), end: at(dates[2], "17:00"), kind: "time_off" }];
    const proposal = planCommands(state, [{ type: "create", item: work() }], owner, { now, approveDisplacement: true });
    expect(proposal.status).toBe("infeasible");
    expect(proposal.conflicts[0]).toMatchObject({ code: "daily_capacity", message: expect.stringContaining(dates[2]) });
    expect(proposal.sessions).toEqual([]); expect(proposal.items).toEqual([]);
  });
  it("does not silently skip closed weekend dates", () => {
    const proposal = planCommands(base(), [{ type: "create", item: work({ dailyPlan: [{ date: "2026-09-19", minutes: 120 }] }) }], owner, { now });
    expect(proposal.conflicts[0].message).toContain("2026-09-19");
  });
  it("splits around lunch while retaining each day's total", () => {
    const state = base(); state.blocks = [{ id: "meeting", title: "Fictional meeting", start: at(dates[0], "09:00"), end: at(dates[0], "11:00"), kind: "meeting" }];
    const proposal = planCommands(state, [{ type: "create", item: work({ minimumSessionMinutes: 60 }) }], owner, { now });
    expect(proposal.status).toBe("ready");
    expect(proposal.sessions.slice(0,2).map(s => [s.start,s.end])).toEqual([[at(dates[0],"11:00"),at(dates[0],"12:00")],[at(dates[0],"12:30"),at(dates[0],"13:30")]]);
  });
  it("replaces the earlier greedy distribution with a daily rule", () => {
    const state = base(); state.items = [work({ dailyPlan: undefined })]; state.sessions = [session("old", dates[0], "12:30", "16:00")];
    const proposal = planCommands(state, [{ type: "update", itemId: "cedar-build", patch: { dailyPlan: work().dailyPlan } }, { type: "schedule", itemId: "cedar-build" }], owner, { now });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready"); expect(proposal.sessions).toHaveLength(5);
    expect(proposal.sessions.every(s => minutesBetween(s.start,s.end) === 120)).toBe(true);
  });
  it("requires explicit protection override before redistributing an old booking", () => {
    const state = base(); state.items = [work({ dailyPlan: undefined })]; state.sessions = [{ ...session("locked",dates[0],"12:30","16:00"), protected: true }];
    expect(planCommands(state, [{ type: "update", itemId: "cedar-build", patch: { dailyPlan: work().dailyPlan } }], owner, { now }).conflicts[0].code).toBe("protected_session");
  });
  it("rejects excess or out-of-plan sessions instead of silently changing quotas", () => {
    const state = base(); state.items = [work()]; state.sessions = [session("too-long",dates[0],"09:00","12:00")];
    expect(validateSchedule(state, now).some(c => c.code === "daily_hours")).toBe(true);
  });
  it("does not infer completion when a selected date has passed", () => {
    const proposal = planCommands(base(), [{ type: "create", item: work() }], owner, { now: at(dates[1],"08:00") });
    expect(proposal.status).toBe("infeasible"); expect(proposal.conflicts[0].message).toContain(dates[0]);
  });
  it("explicit session completion releases the daily booking without rebooking or completing the project", () => {
    const state = base(); state.items = [work()]; state.sessions = dates.map((date, index) => session(`session-${index}`,date,"09:00","11:00"));
    const proposal = planCommands(state, [{ type: "complete_session", sessionId: "session-0" }], owner, { now });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.items[0].remainingMinutes).toBe(600); expect(proposal.items[0].status).toBe("planned");
    expect(proposal.items[0].dailyPlan).toHaveLength(4);
    expect(proposal.sessions.filter(s => s.status === "planned")).toHaveLength(4);
  });
  it("validates optional persisted quota shape without breaking old work", () => {
    expect(workItemSchema.safeParse(work({ dailyPlan: undefined })).success).toBe(true);
    expect(workItemSchema.safeParse(work({ dailyPlan: [{date: dates[0],minutes: 17}] })).success).toBe(false);
    expect(workItemSchema.safeParse(work({ dailyPlan: [work().dailyPlan![0],work().dailyPlan![0]] })).success).toBe(false);
  });
});
