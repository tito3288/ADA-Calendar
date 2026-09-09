import { describe, expect, it } from "vitest";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { bookingWindowSchema } from "./schemas";
import { planCommands, validateSchedule } from "./scheduler";
import { addDays, localDate, localDateTime, minutesBetween } from "./time";
import type { Actor, ScheduleSnapshot, WorkCommand, WorkItem } from "./types";
import { newWorkItem } from "./work";

// Fictional fixtures only; no saved calendar or provider calls.
const owner: Actor = { id: "owner", name: "Fixture Owner", email: "owner@example.test", role: "owner" };
const requester: Actor = { ...owner, id: "requester", role: "requester" };
const day = "2026-09-14", next = addDays(day, 1), last = addDays(day, 2);
const at = (date: string, time: string) => localDateTime(date, time, DEFAULT_SETTINGS.timeZone);
const now = at("2026-09-09", "08:00");
const work = (id: string, patch: Partial<WorkItem> = {}) => newWorkItem(owner, day, { id, clientId: "client", title: `Fixture ${id}`, estimatedMinutes: 120, remainingMinutes: 120, ...patch });
function state(): ScheduleSnapshot {
  return { workspaceId: "booking-window-fixture", version: 1, settings: { ...DEFAULT_SETTINGS, reserveMinutes: 0 }, priorities: DEFAULT_PRIORITIES,
    clients: [{ id: "client", name: "Fixture Client", aliases: [] }], items: [], sessions: [], blocks: [] };
}
function occupied() {
  const snapshot = state();
  snapshot.items = [work("busy", { estimatedMinutes: 450, remainingMinutes: 450 })];
  snapshot.sessions = [["morning", "09:00", "12:00"], ["afternoon", "12:30", "17:00"]].map(([id, start, end]) => ({ id, workItemId: "busy", start: at(day, start), end: at(day, end), status: "planned" as const, protected: false, usesReserve: false }));
  return snapshot;
}
const create = (patch: Partial<WorkItem> = {}): WorkCommand => ({ type: "create", item: work("request", patch), bookingWindow: { startDate: day, endDate: day } });

describe("transient creation and approval booking windows", () => {
  it("keeps a shared total on sparse chosen dates and permits later moves outside that selection", () => {
    const snapshot = state(); snapshot.blocks = [{ id: "closed", title: "Fixture closure", kind: "time_off", start: at(day, "09:00"), end: at(day, "17:00") }];
    const proposal = planCommands(snapshot, [{ type: "create", item: work("request"), bookingWindow: { startDate: day, endDate: last, dates: [day, last] } }], owner, { now });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions.map(s => [localDate(s.start, snapshot.settings.timeZone), minutesBetween(s.start, s.end)])).toEqual([[last, 120]]);
    expect(proposal.items[0].dateConstraints?.allowedDates ?? []).toEqual([]);
    expect(proposal.items[0].allowedDates).toEqual([]);
    const moved = planCommands({ ...snapshot, items: proposal.items, sessions: proposal.sessions }, [{ type: "move_bookings", sessionIds: proposal.sessions.map(s => s.id), date: next }], owner, { now });
    expect(moved.status).toBe("ready");
    expect(moved.sessions.every(s => localDate(s.start, snapshot.settings.timeZone) === next)).toBe(true);
  });
  it.each([false, true])("keeps requester displacement a proposal and allows only an owner-reviewed commit, daily plan=%s", daily => {
    const snapshot = occupied();
    const command = create(daily ? { dailyPlan: [{ date: day, minutes: 120 }] } : {});
    const requested = planCommands(snapshot, [command], requester, { now });
    expect(requested.status, JSON.stringify(requested.conflicts)).toBe("approval_required");
    expect(requested.requiresApproval).toBe(true);
    expect(requested.conflicts.some(c => c.code === "displacement_approval")).toBe(true);
    expect(snapshot.sessions[0].start).toBe(at(day, "09:00"));
    const unapproved = planCommands(snapshot, [command], owner, { now });
    expect(unapproved.status).toBe("infeasible");
    const approved = planCommands(snapshot, [command], owner, { now, approveDisplacement: true });
    expect(approved.status, JSON.stringify(approved.conflicts)).toBe("ready");
    expect(validateSchedule({ ...snapshot, ...approved }, now)).toEqual([]);
    expect(approved.sessions.filter(s => s.workItemId === "request").every(s => localDate(s.start, snapshot.settings.timeZone) === day)).toBe(true);
    expect(approved.sessions.filter(s => s.workItemId === "busy").reduce((sum, s) => sum + minutesBetween(s.start, s.end), 0)).toBe(450);
    expect(approved.items.find(item => item.id === "busy")).toMatchObject({ estimatedMinutes: 450, remainingMinutes: 450 });
  });
  it("preserves every explicit daily quota across an owner-reviewed multi-day request", () => {
    const snapshot = occupied();
    const proposal = planCommands(snapshot, [{ type: "create", item: work("request", { estimatedMinutes: 180, remainingMinutes: 180, dailyPlan: [{ date: day, minutes: 120 }, { date: last, minutes: 60 }] }), bookingWindow: { startDate: day, endDate: last } }], owner, { now, approveDisplacement: true });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    const totals: Record<string, number> = {};
    for (const session of proposal.sessions.filter(s => s.workItemId === "request")) {
      const date = localDate(session.start, snapshot.settings.timeZone); totals[date] = (totals[date] ?? 0) + minutesBetween(session.start, session.end);
    }
    expect(totals).toEqual({ [day]: 120, [last]: 60 });
  });
  it("keeps protected bookings fixed unless the owner explicitly overrides their project", () => {
    const snapshot = occupied(); snapshot.sessions = snapshot.sessions.map(s => ({ ...s, protected: true }));
    expect(planCommands(snapshot, [create()], owner, { now, approveDisplacement: true }).status).toBe("infeasible");
    const approved = planCommands(snapshot, [{ type: "update", itemId: "busy", patch: {}, overrideProtected: true }, create()], owner, { now, approveDisplacement: true });
    expect(approved.status, JSON.stringify(approved.conflicts)).toBe("ready");
    expect(approved.sessions.filter(s => s.workItemId === "busy").every(s => s.protected)).toBe(true);
  });
  it("never widens the requested window when protected capacity or genuine date constraints prevent fitting", () => {
    const snapshot = occupied(); snapshot.sessions = snapshot.sessions.map(s => ({ ...s, protected: true }));
    const blocked = planCommands(snapshot, [create()], owner, { now, approveDisplacement: true });
    expect(blocked.status).toBe("infeasible"); expect(blocked.sessions).toEqual(snapshot.sessions);
    for (const patch of [{ dateConstraints: { earliestStart: next, allowedDates: [] } }, { deadline: addDays(day, -1) }])
      expect(planCommands(state(), [create(patch)], owner, { now, approveDisplacement: true }).status).toBe("infeasible");
  });
  it("keeps ordinary day entry and smart fitting clean-fit even when owner approval is enabled", () => {
    const snapshot = occupied();
    const dayEntry = planCommands(snapshot, [{ type: "create", item: work("request", { dailyPlan: [{ date: day, minutes: 120 }] }) }], owner, { now, approveDisplacement: true });
    expect(dayEntry.conflicts[0].code).toBe("daily_capacity");
    const smartFit = planCommands(snapshot, [{ type: "create", item: work("request"), smartFit: { startDate: day, endDate: day, minutes: 120, distribution: "total" } }], owner, { now, approveDisplacement: true });
    expect(smartFit.conflicts[0].code).toBe("smart_fit_capacity");
  });
  it("rejects malformed, overlong, conflicting or out-of-range booking windows", () => {
    for (const bookingWindow of [{ startDate: day, endDate: addDays(day, -1) }, { startDate: day, endDate: addDays(day, 366) }, { startDate: day, endDate: next, dates: [last] }, { startDate: day, endDate: next, dates: [day, day] }]) {
      expect(bookingWindowSchema.safeParse(bookingWindow).success).toBe(false);
      expect(planCommands(state(), [{ type: "create", item: work("request"), bookingWindow }], owner, { now }).status).toBe("infeasible");
    }
    expect(planCommands(state(), [{ type: "create", item: work("request"), bookingWindow: { startDate: day, endDate: day }, smartFit: { startDate: day, endDate: day, minutes: 120, distribution: "total" } }], owner, { now }).status).toBe("infeasible");
  });
});
