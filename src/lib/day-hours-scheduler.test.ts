import { describe, expect, it } from "vitest";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { planCommands, validateSchedule } from "./scheduler";
import { localDate, localDateTime, minutesBetween } from "./time";
import type { Actor, ScheduleProposal, ScheduleSnapshot, WorkCommand, WorkItem, WorkSession } from "./types";
import { newWorkItem } from "./work";

// Isolated fictional bookings; no database, mail or live account access.
const owner: Actor = { id: "owner", name: "Fixture owner", email: "owner@example.test", role: "owner" };
const monday = "2026-09-14", tuesday = "2026-09-15", friday = "2026-09-18";
const at = (date: string, time: string) => localDateTime(date, time, DEFAULT_SETTINGS.timeZone);
const now = at("2026-09-09", "08:00");
const booking = (id: string, date: string, start = "09:00", end = "11:00", patch: Partial<WorkSession> = {}): WorkSession => ({
  id, workItemId: "project", start: at(date, start), end: at(date, end), status: "planned", protected: false, usesReserve: false, ...patch,
});
function state(patch: Partial<WorkItem> = {}): ScheduleSnapshot {
  return { workspaceId: "day-hours", version: 4, settings: { ...DEFAULT_SETTINGS, reserveMinutes: 0 },
    priorities: structuredClone(DEFAULT_PRIORITIES), clients: [{ id: "client", name: "Fictional client", aliases: [] }], blocks: [],
    items: [newWorkItem(owner, monday, { id: "project", title: "Fictional edits", clientId: "client", estimatedMinutes: 240, remainingMinutes: 240,
      windowEnd: tuesday, minimumSessionMinutes: 120, allowedDates: [monday, tuesday], timelineMode: undefined, dateConstraints: undefined, ...patch })],
    sessions: [booking("monday", monday), booking("tuesday", tuesday)] };
}
const command = (days: { date: string; minutes: number }[], overrideProtected = false): WorkCommand => ({ type: "set_day_hours", itemId: "project", days, ...(overrideProtected ? { overrideProtected } : {}) });
const plan = (snapshot: ScheduleSnapshot, input: WorkCommand, actor = owner, clock = now) => planCommands(snapshot, [input], actor, { now: clock, operationId: "day-hours-fixture-op" });
function ready(snapshot: ScheduleSnapshot, proposal: ScheduleProposal, clock = now) {
  expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
  expect(validateSchedule({ ...snapshot, ...proposal }, clock)).toEqual([]);
}
function failed(snapshot: ScheduleSnapshot, proposal: ScheduleProposal, code: string) {
  expect(proposal.status).toBe("infeasible"); expect(proposal.conflicts[0].code).toBe(code);
  expect(proposal.items).toEqual(snapshot.items); expect(proposal.sessions).toEqual(snapshot.sessions); expect(proposal.blocks).toEqual(snapshot.blocks);
}
const reserved = (sessions: WorkSession[]) => sessions.reduce((total, session) => total + minutesBetween(session.start, session.end), 0);

describe("direct booked-day hours", () => {
  it("changes Tuesday to one hour and the regular total from four to three, retaining Monday", () => {
    const snapshot = state(), before = structuredClone(snapshot);
    const proposal = plan(snapshot, command([{ date: tuesday, minutes: 60 }])); ready(snapshot, proposal);
    expect(proposal.sessions).toEqual([snapshot.sessions[0], { ...snapshot.sessions[1], end: at(tuesday, "10:00") }]);
    expect(proposal.items[0]).toMatchObject({ remainingMinutes: 180, estimatedMinutes: 240, status: "planned", completedAt: null, timelineMode: "bookings" });
    expect(snapshot).toEqual(before);
  });
  it.each([540, 660])("preserves unbooked effort when the resulting known total is %i minutes", expected => {
    const snapshot = state({ remainingMinutes: 600, estimatedMinutes: 600 });
    const proposal = plan(snapshot, command([{ date: tuesday, minutes: expected === 540 ? 60 : 180 }])); ready(snapshot, proposal);
    expect(proposal.items[0].remainingMinutes).toBe(expected);
    expect(proposal.items[0].remainingMinutes! - reserved(proposal.sessions)).toBe(360);
    expect(proposal.items[0].forecastDate).toBeNull();
    expect(proposal.sessions[0]).toEqual(snapshot.sessions[0]);
  });
  it("increases beyond the previous remaining total and preserves already booked times", () => {
    const snapshot = state();
    const proposal = plan(snapshot, command([{ date: tuesday, minutes: 240 }])); ready(snapshot, proposal);
    expect(proposal.sessions.slice(0, 2)).toEqual(snapshot.sessions);
    expect(proposal.items[0]).toMatchObject({ estimatedMinutes: 240, remainingMinutes: 360 });
    expect(proposal.sessions.filter(session => localDate(session.start, snapshot.settings.timeZone) === tuesday).map(session => minutesBetween(session.start, session.end))).toEqual([120, 60, 60]);
  });
  it.each([null, 240])("removes all reservations without completion, refill or timeline loss (remaining %s)", remainingMinutes => {
    const snapshot = state({ remainingMinutes, estimatedMinutes: remainingMinutes, ...(remainingMinutes === null ? { windowEnd: "2026-10-31" } : {}) });
    const proposal = plan(snapshot, command([{ date: monday, minutes: 0 }, { date: tuesday, minutes: 0 }])); ready(snapshot, proposal);
    expect(proposal.sessions).toEqual([]);
    expect(proposal.items[0]).toMatchObject({ remainingMinutes: remainingMinutes === null ? null : 0, estimatedMinutes: remainingMinutes,
      status: "planned", completedAt: null, timelineMode: remainingMinutes === null ? "span" : "bookings", windowEnd: snapshot.items[0].windowEnd });
  });
  it("resumes waiting ongoing work when booking positive hours without inventing an estimate", () => {
    const snapshot = state({ status: "waiting", estimatedMinutes: null, remainingMinutes: null, windowEnd: null, blockedReason: "Awaiting details" }); snapshot.sessions = [];
    const proposal = plan(snapshot, command([{ date: friday, minutes: 180 }])); ready(snapshot, proposal);
    expect(proposal.items[0]).toMatchObject({ status: "planned", blockedReason: null, estimatedMinutes: null, remainingMinutes: null, windowEnd: null, timelineMode: "span" });
    expect(proposal.summary.join(" ")).toContain("Waiting → Planned");
    expect(reserved(proposal.sessions)).toBe(180);
  });
  it("keeps zero and unchanged requests true no-ops, even on protected work", () => {
    const snapshot = state(); snapshot.sessions[1].protected = true;
    const proposal = plan(snapshot, command([{ date: tuesday, minutes: 120 }, { date: friday, minutes: 0 }]));
    expect(proposal.affectedItemIds).toEqual([]); expect(proposal.items).toEqual(snapshot.items); expect(proposal.sessions).toEqual(snapshot.sessions);
    const waiting = state({ status: "waiting", estimatedMinutes: null, remainingMinutes: null }); waiting.sessions = [];
    expect(plan(waiting, command([{ date: friday, minutes: 0 }])).items).toEqual(waiting.items);
  });
  it("keeps every change atomic when a later requested day cannot fit", () => {
    const snapshot = state(); snapshot.blocks = [{ id: "off", title: "Fictional time off", kind: "time_off", start: at(friday, "09:00"), end: at(friday, "17:00") }];
    failed(snapshot, plan(snapshot, command([{ date: tuesday, minutes: 60 }, { date: friday, minutes: 180 }])), "booking_capacity");
  });
  it("requires an override only for protected bookings that actually change", () => {
    const snapshot = state(); snapshot.sessions[1].protected = true;
    const increase = plan(snapshot, command([{ date: tuesday, minutes: 180 }])); ready(snapshot, increase);
    expect(increase.sessions[1]).toEqual(snapshot.sessions[1]);
    failed(snapshot, plan(snapshot, command([{ date: tuesday, minutes: 60 }])), "protected_session");
    const permitted = plan(snapshot, command([{ date: tuesday, minutes: 60 }], true)); ready(snapshot, permitted);
    expect(permitted.sessions[1]).toMatchObject({ protected: true, end: at(tuesday, "10:00") });
  });
  it("permits tomorrow edits while another session is underway, retaining history exactly", () => {
    const snapshot = state(), clock = at(monday, "10:00");
    const proposal = plan(snapshot, command([{ date: tuesday, minutes: 60 }]), owner, clock); ready(snapshot, proposal, clock);
    expect(proposal.sessions[0]).toEqual(snapshot.sessions[0]);
    const sameDay=plan(snapshot, command([{ date: monday, minutes: 60 }]), owner, clock); ready(snapshot,sameDay,clock);
    expect(sameDay.sessions[0]).toEqual(snapshot.sessions[0]);
    expect(sameDay.sessions.at(-1)?.start).toBe(at(monday,"11:00"));
    failed(snapshot,plan(snapshot,command([{date:"2026-09-08",minutes:60}])),"historical_session");
  });
  it("changes only requested daily quotas and keeps unrelated unbooked daily amounts", () => {
    const snapshot = state({ remainingMinutes: 360, estimatedMinutes: 360, dailyPlan: [{ date: monday, minutes: 120 }, { date: tuesday, minutes: 120 }, { date: friday, minutes: 120 }] });
    const proposal = plan(snapshot, command([{ date: tuesday, minutes: 0 }])); ready(snapshot, proposal);
    expect(proposal.items[0].dailyPlan).toEqual([{ date: monday, minutes: 120 }, { date: friday, minutes: 120 }]);
    expect(proposal.items[0].remainingMinutes).toBe(240); expect(proposal.sessions).toEqual([snapshot.sessions[0]]);
  });
  it("retains a started booking in today's daily quota when adding upcoming hours", () => {
    const snapshot = state({ dailyPlan: [{ date: monday, minutes: 120 }, { date: tuesday, minutes: 120 }] });
    const clock = at(monday, "10:07"), proposal = plan(snapshot, command([{ date: monday, minutes: 60 }]), owner, clock);
    ready(snapshot, proposal, clock);
    expect(proposal.sessions.slice(0, 2)).toEqual(snapshot.sessions);
    expect(proposal.sessions[2]).toMatchObject({ start: at(monday, "11:00"), end: at(monday, "12:00") });
    expect(proposal.items[0].dailyPlan).toEqual([{ date: monday, minutes: 180 }, { date: tuesday, minutes: 120 }]);
    expect(proposal.items[0].remainingMinutes).toBe(300);
  });
  it("ignores old start, allowed-date and focus locks, including before the display span", () => {
    const snapshot = state({ windowStart: friday, allowedDates: [friday], minimumSessionMinutes: 480 });
    const proposal = plan(snapshot, command([{ date: "2026-09-10", minutes: 15 }])); ready(snapshot, proposal);
    expect(proposal.sessions.slice(0, 2)).toEqual(snapshot.sessions);
    expect(proposal.sessions.at(-1)).toMatchObject({ start: at("2026-09-10", "09:00"), end: at("2026-09-10", "09:15") });
    expect(proposal.sessions.at(-1)?.focusOverrideMinutes).toBeUndefined();
    expect(proposal.items[0]).toMatchObject({ windowStart: friday, allowedDates: [friday], minimumSessionMinutes: 480 });
  });
  it.each([{ dateConstraints: { earliestStart: friday, allowedDates: [] } }, { dateConstraints: { earliestStart: null, allowedDates: [monday, tuesday] } }, { deadline: tuesday }])("still enforces deliberate scheduling restrictions %j", patch => {
    const snapshot = state(patch);
    const date = "dateConstraints" in patch && patch.dateConstraints?.earliestStart ? "2026-09-10" : friday;
    failed(snapshot, plan(snapshot, command([{ date, minutes: 60 }])), "outside_allowed_dates");
  });
  it.each(["requester", "viewer"] as const)("rejects %s day edits at shared authorization", role => {
    const snapshot = state(); failed(snapshot, plan(snapshot, command([{ date: tuesday, minutes: 0 }]), { ...owner, role }), "forbidden");
  });
  it.each([-15, 1, 485])("rejects invalid day minutes %i", minutes => {
    const snapshot = state(); failed(snapshot, plan(snapshot, command([{ date: tuesday, minutes }])), "invalid_booking_edit");
  });
  it("does not fit on weekends or silently consume saved reserve", () => {
    const snapshot = state(); failed(snapshot, plan(snapshot, command([{ date: "2026-09-19", minutes: 60 }])), "booking_capacity");
    snapshot.settings.reserveMinutes = 60;
    failed(snapshot, plan(snapshot, command([{ date: friday, minutes: 420 }])), "booking_capacity");
    const permitted = plan(snapshot, command([{ date: friday, minutes: 390 }])); ready(snapshot, permitted);
  });
  it("generates identical fragments on preview retry without touching other work", () => {
    const snapshot = state(), input = command([{ date: tuesday, minutes: 240 }, { date: friday, minutes: 60 }]);
    expect(plan(snapshot, input).sessions).toEqual(plan(snapshot, input).sessions);
  });
});

describe("flexible day moves and ongoing display identity", () => {
  it("splits a three-hour day across gaps, retains its first ID and all destination bookings", () => {
    const snapshot = state({ estimatedMinutes: 240, remainingMinutes: 240 });
    snapshot.sessions = [booking("source", monday, "09:00", "12:00"), booking("destination", friday, "09:00", "10:00")];
    snapshot.blocks = [{ id: "afternoon", title: "Fictional meeting", kind: "meeting", start: at(friday, "13:30"), end: at(friday, "17:00") }];
    const input: WorkCommand = { type: "move_bookings", sessionIds: ["source"], date: friday };
    const proposal = plan(snapshot, input); ready(snapshot, proposal);
    expect(proposal.sessions[0]).toEqual({ ...snapshot.sessions[0], start: at(friday, "10:00"), end: at(friday, "12:00") });
    expect(proposal.sessions[1]).toEqual(snapshot.sessions[1]);
    expect(proposal.sessions[2]).toMatchObject({ start: at(friday, "12:30"), end: at(friday, "13:30") });
    expect(proposal.sessions[2].id).not.toBe("source"); expect(reserved(proposal.sessions)).toBe(240);
    expect(proposal.items[0]).toMatchObject({ remainingMinutes: 240, estimatedMinutes: 240 });
    expect(plan(snapshot, input).sessions).toEqual(proposal.sessions);
  });
  it.each(["update", "progress", "status"] as const)("latches a legacy ongoing timeline before its first estimate through %s", type => {
    const snapshot = state({ estimatedMinutes: null, remainingMinutes: null, windowEnd: "2026-10-31" });
    const input: WorkCommand = type === "update" ? { type, itemId: "project", patch: { remainingMinutes: 240 } }
      : type === "progress" ? { type, itemId: "project", remainingMinutes: 240 }
      : { type, itemId: "project", status: "planned", remainingMinutes: 240 };
    const proposal = plan(snapshot, input); ready(snapshot, proposal);
    expect(proposal.items[0]).toMatchObject({ timelineMode: "span", estimatedMinutes: 240, remainingMinutes: 240, windowEnd: "2026-10-31" });
  });
});
