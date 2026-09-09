import { describe, expect, it } from "vitest";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { planCommands, validateSchedule } from "./scheduler";
import { localDate, localDateTime, minutesBetween } from "./time";
import type { Actor, ScheduleSnapshot, WorkCommand, WorkItem, WorkSession } from "./types";
import { newWorkItem } from "./work";

// Fictional scheduler fixtures. Elapsed planned bookings are not completed work.
const owner: Actor = { id: "owner", name: "Fixture Owner", email: "owner@example.test", role: "owner" };
const yesterday = "2026-09-09", today = "2026-09-10", tomorrow = "2026-09-11", later = "2026-09-14";
const at = (date: string, time: string) => localDateTime(date, time, DEFAULT_SETTINGS.timeZone);
const now = at(today, "10:07");
const booking = (id: string, date: string, start = "09:00", end = "11:00", patch: Partial<WorkSession> = {}): WorkSession => ({ id, workItemId: "project", start: at(date, start), end: at(date, end), status: "planned", protected: false, usesReserve: false, ...patch });
function state(patch: Partial<WorkItem> = {}): ScheduleSnapshot {
  return { workspaceId: "missed-planned-fixture", version: 1, settings: { ...DEFAULT_SETTINGS, reserveMinutes: 0 }, priorities: DEFAULT_PRIORITIES,
    clients: [{ id: "client", name: "Fixture Client", aliases: [] }], blocks: [],
    items: [newWorkItem(owner, yesterday, { id: "project", title: "Fixture ongoing edits", clientId: "client", estimatedMinutes: 240, remainingMinutes: 240, ...patch })],
    sessions: [booking("missed", yesterday), booking("later", later), booking("done", "2026-09-08", "09:00", "10:00", { status: "completed" }), booking("cancelled", "2026-09-08", "10:00", "11:00", { status: "cancelled" })] };
}
const plan = (snapshot: ScheduleSnapshot, commands: WorkCommand[], clock = now, actor = owner) => planCommands(snapshot, commands, actor, { now: clock, operationId: "missed-planned-operation", approveDisplacement: true });
const minutes = (snapshot: Pick<ScheduleSnapshot, "sessions">) => snapshot.sessions.filter(s => s.status === "planned").reduce((sum, s) => sum + minutesBetween(s.start, s.end), 0);
function ready(snapshot: ScheduleSnapshot, proposal: ReturnType<typeof plan>, clock = now) {
  expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
  expect(validateSchedule({ ...snapshot, ...proposal }, clock)).toEqual([]);
  for (const id of ["later", "done", "cancelled"]) expect(proposal.sessions.find(s => s.id === id)).toEqual(snapshot.sessions.find(s => s.id === id));
}

describe("owner edits to missed planned bookings", () => {
  it.each(["move", "move_booking", "move_bookings"] as const)("moves all elapsed source minutes with %s without changing effort or other days", type => {
    const snapshot = state({ dailyPlan: [{ date: yesterday, minutes: 120 }, { date: later, minutes: 120 }] });
    const command: WorkCommand = type === "move" ? { type, sessionId: "missed", start: at(tomorrow, "09:00"), end: at(tomorrow, "11:00") }
      : type === "move_booking" ? { type, sessionId: "missed", date: tomorrow } : { type, sessionIds: ["missed"], date: tomorrow };
    const proposal = plan(snapshot, [command]); ready(snapshot, proposal);
    expect(proposal.sessions.find(s => s.id === "missed")).toMatchObject({ start: at(tomorrow, "09:00"), end: at(tomorrow, "11:00"), status: "planned" });
    expect(minutes(proposal)).toBe(240);
    expect(proposal.items[0]).toMatchObject({ estimatedMinutes: 240, remainingMinutes: 240, status: "planned", completedAt: null, dailyPlan: [{ date: tomorrow, minutes: 120 }, { date: later, minutes: 120 }] });
  });
  it("splits an elapsed source across today's future openings, preserving full duration and unrelated bookings", () => {
    const snapshot = state();
    snapshot.blocks = [{ id: "late-morning", title: "Fixture meeting", kind: "meeting", start: at(today, "11:15"), end: at(today, "12:00") }];
    const proposal = plan(snapshot, [{ type: "move_bookings", sessionIds: ["missed"], date: today }]); ready(snapshot, proposal);
    const moved = proposal.sessions.filter(s => localDate(s.start, snapshot.settings.timeZone) === today);
    expect(moved.map(s => [s.start, s.end])).toEqual([[at(today, "10:15"), at(today, "11:15")], [at(today, "12:30"), at(today, "13:30")]]);
    expect(moved.reduce((sum, s) => sum + minutesBetween(s.start, s.end), 0)).toBe(120);
    expect(proposal.items[0].remainingMinutes).toBe(240);
  });
  it("moves part of a missed booking and transfers only that part of its daily quota", () => {
    const snapshot = state({ dailyPlan: [{ date: yesterday, minutes: 120 }, { date: later, minutes: 120 }] });
    const proposal = plan(snapshot, [{ type: "move_booking", sessionId: "missed", date: tomorrow, minutes: 60 }]); ready(snapshot, proposal);
    expect(proposal.sessions.find(s => s.id === "missed")).toMatchObject({ start: at(yesterday, "09:00"), end: at(yesterday, "10:00") });
    expect(proposal.items[0].dailyPlan).toEqual([{ date: yesterday, minutes: 60 }, { date: tomorrow, minutes: 60 }, { date: later, minutes: 120 }]);
    expect(minutes(proposal)).toBe(240); expect(proposal.items[0].remainingMinutes).toBe(240);
  });
  it.each([0, 60])("reduces a past day's planned total to %i without completing work", target => {
    const snapshot = state({ remainingMinutes: 300, dailyPlan: [{ date: yesterday, minutes: 120 }, { date: later, minutes: 120 }] });
    const proposal = plan(snapshot, [{ type: "set_day_hours", itemId: "project", days: [{ date: yesterday, minutes: target }] }]); ready(snapshot, proposal);
    expect(proposal.items[0]).toMatchObject({ estimatedMinutes: 240, remainingMinutes: 180 + target, status: "planned", completedAt: null });
    expect(proposal.items[0].dailyPlan).toEqual([...(target ? [{ date: yesterday, minutes: target }] : []), { date: later, minutes: 120 }]);
    expect(proposal.sessions.filter(s => s.id === "missed").reduce((sum, s) => sum + minutesBetween(s.start, s.end), 0)).toBe(target);
  });
  it("preserves unknown ongoing totals when moving and removing missed bookings", () => {
    const snapshot = state({ estimatedMinutes: null, remainingMinutes: null, timelineMode: "span", windowEnd: "2026-10-31" });
    for (const command of [{ type: "move_bookings" as const, sessionIds: ["missed"], date: tomorrow }, { type: "set_day_hours" as const, itemId: "project", days: [{ date: yesterday, minutes: 0 }] }]) {
      const proposal = plan(snapshot, [command]); ready(snapshot, proposal);
      expect(proposal.items[0]).toMatchObject({ estimatedMinutes: null, remainingMinutes: null, timelineMode: "span", windowEnd: "2026-10-31", status: "planned" });
    }
  });
  it("preserves an existing legacy overbooking balance without adding another estimate alert", () => {
    const snapshot = state({ remainingMinutes: 180 });
    const reduced = plan(snapshot, [{ type: "set_day_hours", itemId: "project", days: [{ date: yesterday, minutes: 60 }] }]); ready(snapshot, reduced);
    expect(minutes(reduced)).toBe(180); expect(reduced.items[0].remainingMinutes).toBe(120);
    const moved = plan(snapshot, [{ type: "move_bookings", sessionIds: ["missed"], date: tomorrow }]); ready(snapshot, moved);
    expect(minutes(moved)).toBe(240); expect(moved.items[0].remainingMinutes).toBe(180);
    const exact = plan(snapshot, [{ type: "schedule", itemId: "project", sessions: [{ ...snapshot.sessions[0], start: at(tomorrow, "09:00"), end: at(tomorrow, "11:00") }, snapshot.sessions[1]] }]); ready(snapshot, exact);
    expect(minutes(exact)).toBe(240);
    const added = plan(snapshot, [{ type: "add_booking", itemId: "project", request: { startDate: tomorrow, endDate: tomorrow, minutes: 15, distribution: "total" } }]);
    expect(added.status).toBe("infeasible"); expect(added.conflicts[0].code).toBe("booking_effort");
  });
  it("edits an unrelated future day with past planned60 + future240 against remaining240", () => {
    const snapshot = state(); snapshot.sessions[0].end = at(yesterday, "10:00");
    snapshot.sessions.push(booking("tomorrow", tomorrow));
    const proposal = plan(snapshot, [{ type: "set_day_hours", itemId: "project", days: [{ date: tomorrow, minutes: 60 }] }]); ready(snapshot, proposal);
    expect(proposal.sessions.find(s => s.id === "missed")).toEqual(snapshot.sessions[0]);
    expect(minutes(proposal)).toBe(240); expect(proposal.items[0].remainingMinutes).toBe(180);
  });
  it("rejects past increases and past destinations atomically", () => {
    const snapshot = state();
    for (const command of [{ type: "set_day_hours" as const, itemId: "project", days: [{ date: yesterday, minutes: 180 }] }, { type: "move_bookings" as const, sessionIds: ["missed"], date: "2026-09-08" }, { type: "move" as const, sessionId: "missed", start: at(yesterday, "13:00"), end: at(yesterday, "15:00") }]) {
      const proposal = plan(snapshot, [command]); expect(proposal.status).toBe("infeasible"); expect(proposal.sessions).toEqual(snapshot.sessions); expect(proposal.items).toEqual(snapshot.items);
    }
  });
  it("permits explicit replacement/removal of elapsed planned rows while retaining completed and cancelled history", () => {
    const snapshot = state();
    for (const replacement of [[{ ...snapshot.sessions[0], start: at(tomorrow, "09:00"), end: at(tomorrow, "11:00") }, snapshot.sessions[1]], [snapshot.sessions[1]]]) {
      const proposal = plan(snapshot, [{ type: "schedule", itemId: "project", sessions: replacement }]); ready(snapshot, proposal);
      expect(proposal.sessions.filter(s => s.status === "planned")).toHaveLength(replacement.length);
      expect(proposal.items[0].remainingMinutes).toBe(240);
    }
  });
  it("rejects changed exact bookings in elapsed time but keeps identical elapsed rows", () => {
    const snapshot = state();
    const unchanged = plan(snapshot, [{ type: "schedule", itemId: "project", sessions: snapshot.sessions.filter(s => s.status === "planned") }]); ready(snapshot, unchanged);
    const changed = plan(snapshot, [{ type: "schedule", itemId: "project", sessions: [{ ...snapshot.sessions[0], end: at(yesterday, "10:00") }, snapshot.sessions[1]] }]);
    expect(changed.status).toBe("infeasible"); expect(changed.conflicts[0].code).toBe("past_session"); expect(changed.sessions).toEqual(snapshot.sessions);
  });
  it.each(["completed", "cancelled"] as const)("keeps %s sources read-only", status => {
    const snapshot = state(); snapshot.sessions[0].status = status;
    for (const command of [{ type: "move_booking" as const, sessionId: "missed", date: tomorrow }, { type: "move_bookings" as const, sessionIds: ["missed"], date: tomorrow }, { type: "move" as const, sessionId: "missed", start: at(tomorrow, "09:00"), end: at(tomorrow, "11:00") }])
      expect(plan(snapshot, [command]).conflicts[0].code).toBe("historical_session");
  });
  it("preserves protected-source authorization after the clock passes", () => {
    const snapshot = state(); snapshot.sessions[0].protected = true;
    expect(plan(snapshot, [{ type: "set_day_hours", itemId: "project", days: [{ date: yesterday, minutes: 0 }] }]).conflicts[0].code).toBe("protected_session");
    const allowed = plan(snapshot, [{ type: "move_booking", sessionId: "missed", date: tomorrow, overrideProtected: true }]); ready(snapshot, allowed);
    expect(allowed.sessions.find(s => s.id === "missed")?.protected).toBe(true);
  });
  it("does not automatically displace another elapsed planned booking to fit an exact move", () => {
    const snapshot = state();
    snapshot.items.push(newWorkItem(owner, today, { id: "other", title: "Other fictional work", clientId: "client", estimatedMinutes: 120, remainingMinutes: 120 }));
    snapshot.sessions.push(booking("other", today, "09:00", "11:00", { workItemId: "other" }));
    const proposal = plan(snapshot, [{ type: "move", sessionId: "missed", start: at(today, "10:15"), end: at(today, "12:15") }]);
    expect(proposal.status).toBe("infeasible"); expect(proposal.conflicts[0].code).toBe("historical_session"); expect(proposal.sessions).toEqual(snapshot.sessions);
  });
});
