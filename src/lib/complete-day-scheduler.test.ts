import { describe, expect, it } from "vitest";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { commandSchema } from "./schemas";
import { planCommands, validateSchedule } from "./scheduler";
import { localDateTime, minutesBetween } from "./time";
import type { Actor, ScheduleSnapshot, WorkCommand, WorkItem, WorkSession } from "./types";
import { newWorkItem } from "./work";

// Fictional completion fixtures only; no database, provider, or real work data.
const owner: Actor = { id: "owner", name: "Fixture Owner", email: "owner@example.test", role: "owner" };
const day = "2026-09-09", next = "2026-09-10", zone = DEFAULT_SETTINGS.timeZone;
const at = (date: string, time: string) => localDateTime(date, time, zone);
const now = at(day, "10:15");
const booking = (id: string, start: string, end: string, patch: Partial<WorkSession> = {}): WorkSession => ({ id, workItemId: "project", start: at(day, start), end: at(day, end), status: "planned", protected: false, usesReserve: false, ...patch });
function state(patch: Partial<WorkItem> = {}): ScheduleSnapshot {
  return { workspaceId: "complete-day-fixture", version: 4, settings: { ...DEFAULT_SETTINGS, reserveMinutes: 0 }, priorities: DEFAULT_PRIORITIES,
    clients: [{ id: "client", name: "Fixture Client", aliases: [] }], blocks: [],
    items: [newWorkItem(owner, day, { id: "project", clientId: "client", title: "Fixture website edits", estimatedMinutes: 360, remainingMinutes: 360,
      dailyPlan: [{ date: day, minutes: 240 }, { date: next, minutes: 120 }], dateConstraints: undefined, timelineMode: undefined, ...patch })],
    sessions: [booking("morning", "09:00", "10:30"), booking("afternoon", "13:00", "14:30"), booking("next-day", "09:00", "11:00", { start: at(next, "09:00"), end: at(next, "11:00") }),
      booking("already-done", "10:30", "11:00", { status: "completed" }), booking("cancelled", "11:00", "12:00", { status: "cancelled" })] };
}
const command: WorkCommand = { type: "complete_day", itemId: "project", date: day };
const plan = (snapshot: ScheduleSnapshot, commands: WorkCommand[] = [command], actor = owner, clock = now) => planCommands(snapshot, commands, actor, { now: clock, operationId: "complete-day-operation" });
function ready(snapshot: ScheduleSnapshot, proposal: ReturnType<typeof plan>, clock = now) {
  expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
  expect(validateSchedule({ ...snapshot, ...proposal }, clock)).toEqual([]);
  expect(proposal.blocks).toEqual(snapshot.blocks);
}

describe("explicit owner completion of a booked day", () => {
  it("completes only planned sessions, deducts their full hours and preserves other days and unbooked work", () => {
    const snapshot = state(), before = structuredClone(snapshot), proposal = plan(snapshot); ready(snapshot, proposal);
    expect(snapshot).toEqual(before);
    expect(proposal.sessions).toEqual(snapshot.sessions.map(session => ["morning", "afternoon"].includes(session.id) ? { ...session, status: "completed" } : session));
    expect(proposal.items[0]).toMatchObject({ estimatedMinutes: 360, remainingMinutes: 180, status: "planned", completedAt: null,
      dailyPlan: [{ date: day, minutes: 60 }, { date: next, minutes: 120 }], forecastDate: null, timelineMode: "bookings" });
    expect(proposal.affectedItemIds).toEqual(["project"]);
    expect(proposal.summary.join(" ")).toContain("Finish 3h");
  });
  it.each([at(day, "08:00"), at(day, "10:15"), at(day, "18:00"), at(next, "18:00")])("uses the full scheduled duration and retains exact times when reported at %s", clock => {
    const snapshot = state(), proposal = plan(snapshot, [command], owner, clock); ready(snapshot, proposal, clock);
    expect(proposal.items[0].remainingMinutes).toBe(180);
    for (const id of ["morning", "afternoon"]) {
      const before = snapshot.sessions.find(s => s.id === id)!, after = proposal.sessions.find(s => s.id === id)!;
      expect(after).toEqual({ ...before, status: "completed" });
      expect(minutesBetween(after.start, after.end)).toBe(90);
    }
  });
  it("preserves a null ongoing total, its span and its other bookings", () => {
    const snapshot = state({ estimatedMinutes: null, remainingMinutes: null, windowEnd: "2026-10-31" });
    const proposal = plan(snapshot); ready(snapshot, proposal);
    expect(proposal.items[0]).toMatchObject({ estimatedMinutes: null, remainingMinutes: null, timelineMode: "span", windowEnd: "2026-10-31", status: "planned", completedAt: null });
    expect(proposal.sessions.find(s => s.id === "next-day")).toEqual(snapshot.sessions.find(s => s.id === "next-day"));
  });
  it("is a complete no-op on repeated completion without subtracting existing completed hours", () => {
    const snapshot = state(), first = plan(snapshot); ready(snapshot, first);
    const saved = { ...snapshot, items: first.items, sessions: first.sessions }, repeated = plan(saved, [command], owner, at(next, "14:00"));
    expect(repeated.status).toBe("ready"); expect(repeated.affectedItemIds).toEqual([]);
    expect(repeated.items).toEqual(saved.items); expect(repeated.sessions).toEqual(saved.sessions);
    expect(repeated.items[0].remainingMinutes).toBe(180);
  });
  it("leaves a day with only completed/cancelled sessions and its legacy timeline metadata unchanged", () => {
    const snapshot = state(); snapshot.sessions = snapshot.sessions.filter(s => s.status !== "planned");
    const proposal = plan(snapshot); expect(proposal.status).toBe("ready");
    expect(proposal.items).toEqual(snapshot.items); expect(proposal.sessions).toEqual(snapshot.sessions); expect(proposal.affectedItemIds).toEqual([]);
  });
  it("keeps the project open after its final booked day is finished", () => {
    const snapshot = state({ estimatedMinutes: 180, remainingMinutes: 180, dailyPlan: [{ date: day, minutes: 180 }], status: "in_progress" });
    snapshot.sessions = snapshot.sessions.filter(s => s.id !== "next-day");
    const proposal = plan(snapshot); ready(snapshot, proposal);
    expect(proposal.items[0]).toMatchObject({ estimatedMinutes: 180, remainingMinutes: 0, dailyPlan: [], status: "in_progress", completedAt: null });
    expect(proposal.sessions.some(s => s.status === "planned")).toBe(false);
    expect(proposal.sessions).toHaveLength(snapshot.sessions.length);
  });
  it("floors a legacy remaining estimate at zero without changing other planned bookings", () => {
    const snapshot = state({ remainingMinutes: 60 });
    const proposal = plan(snapshot); ready(snapshot, proposal);
    expect(proposal.items[0]).toMatchObject({ estimatedMinutes: 360, remainingMinutes: 0, status: "planned" });
    expect(proposal.sessions.find(s => s.id === "next-day")).toEqual(snapshot.sessions.find(s => s.id === "next-day"));
  });
  it("rounds a legacy67m45s booking once and leaves its52-minute residual estimate unbooked", () => {
    const snapshot = state({ estimatedMinutes: 180, remainingMinutes: 180, dailyPlan: [{ date: day, minutes: 120 }, { date: next, minutes: 60 }] });
    snapshot.sessions = [booking("legacy-clipped", "09:00", "10:07:45"), booking("future", "09:00", "10:00", { start: at(next, "09:00"), end: at(next, "10:00") })];
    const proposal = plan(snapshot); ready(snapshot, proposal);
    expect(proposal.sessions[0]).toEqual({ ...snapshot.sessions[0], status: "completed" });
    expect(proposal.sessions[1]).toEqual(snapshot.sessions[1]);
    expect(proposal.items[0]).toMatchObject({ estimatedMinutes: 180, remainingMinutes: 112, dailyPlan: [{ date: next, minutes: 60 }], forecastDate: null });
    expect(proposal.summary.join(" ")).toContain("leftover estimate stays unbooked");
  });
  it("rounds the combined legacy duration rather than rounding each session separately", () => {
    const snapshot = state({ estimatedMinutes: 180, remainingMinutes: 180, dailyPlan: [{ date: day, minutes: 120 }, { date: next, minutes: 60 }] });
    snapshot.sessions = [booking("legacy-one", "09:00", "09:45:24"), booking("legacy-two", "13:00", "13:45:24"), booking("future", "09:00", "10:00", { start: at(next, "09:00"), end: at(next, "10:00") })];
    const proposal = plan(snapshot); ready(snapshot, proposal);
    expect(proposal.items[0].remainingMinutes).toBe(89);
    expect(proposal.items[0].dailyPlan).toEqual([{ date: next, minutes: 60 }]);
    expect(proposal.sessions.slice(0, 2)).toEqual(snapshot.sessions.slice(0, 2).map(session => ({ ...session, status: "completed" })));
  });
  it("treats protected completion as the owner's explicit report, retaining protection and legacy metadata", () => {
    const snapshot = state(); snapshot.sessions[0] = { ...snapshot.sessions[0], protected: true, focusOverrideMinutes: 30 };
    const proposal = plan(snapshot); ready(snapshot, proposal);
    expect(proposal.sessions[0]).toEqual({ ...snapshot.sessions[0], status: "completed" });
  });
  it("keeps the reserve released by explicitly completed work even before its scheduled end", () => {
    const snapshot = state({ estimatedMinutes: 60, remainingMinutes: 60, dailyPlan: undefined }); snapshot.settings.reserveMinutes = 60;
    snapshot.items.push(newWorkItem(owner, day, { id: "ordinary", title: "Fixture ordinary work", clientId: "client", estimatedMinutes: 60, remainingMinutes: 60 }));
    snapshot.sessions = [booking("reserve-work", "09:00", "10:00", { usesReserve: true }), booking("ordinary-late", "16:00", "17:00", { workItemId: "ordinary", protected: true })];
    const clock = at(day, "08:00"); expect(validateSchedule(snapshot, clock)).toEqual([]);
    const proposal = plan(snapshot, [command], owner, clock); ready(snapshot, proposal, clock);
    expect(proposal.sessions[0]).toEqual({ ...snapshot.sessions[0], status: "completed" });
    expect(proposal.sessions[1]).toEqual(snapshot.sessions[1]);
    expect(proposal.items[1]).toEqual(snapshot.items[1]);
    expect(proposal.items[0].remainingMinutes).toBe(0);
  });
  it("preserves waiting status and its reason when reporting a past booked day", () => {
    const snapshot = state({ status: "waiting", blockedReason: "Fixture dependency" });
    snapshot.sessions = snapshot.sessions.filter(s => s.id !== "next-day");
    const clock = at(next, "09:00"), proposal = plan(snapshot, [command], owner, clock); ready(snapshot, proposal, clock);
    expect(proposal.items[0]).toMatchObject({ status: "waiting", blockedReason: "Fixture dependency", remainingMinutes: 180 });
  });
  it.each(["requester", "viewer"] as const)("rejects %s completion before mutation", role => {
    const snapshot = state(), proposal = plan(snapshot, [command], { ...owner, role });
    expect(proposal.status).toBe("infeasible"); expect(proposal.conflicts[0].code).toBe("forbidden");
    expect(proposal.items).toEqual(snapshot.items); expect(proposal.sessions).toEqual(snapshot.sessions);
  });
  it.each(["completed", "cancelled"] as const)("does not change a %s project, even when that day has no planned sessions", status => {
    const snapshot = state({ status });
    for (const sessions of [snapshot.sessions, snapshot.sessions.filter(s => s.status !== "planned")]) {
      const before = { ...snapshot, sessions }, proposal = plan(before);
      expect(proposal.status).toBe("infeasible"); expect(proposal.conflicts[0].code).toBe("inactive_work");
      expect(proposal.items).toEqual(before.items); expect(proposal.sessions).toEqual(before.sessions);
    }
  });
  it("rejects mixed commands and malformed dates atomically", () => {
    const snapshot = state();
    const mixed = plan(snapshot, [command, { type: "set_day_hours", itemId: "project", days: [{ date: next, minutes: 0 }] }]);
    expect(mixed.conflicts[0].code).toBe("completion_mixed_commands"); expect(mixed.items).toEqual(snapshot.items); expect(mixed.sessions).toEqual(snapshot.sessions);
    const invalid: WorkCommand = { type: "complete_day", itemId: "project", date: "2026-02-31" };
    expect(commandSchema.safeParse(invalid).success).toBe(false); expect(plan(snapshot, [invalid]).conflicts[0].code).toBe("invalid_completion");
    expect(plan(snapshot, [{ type: "complete_day", itemId: "missing", date: day }]).conflicts[0].code).toBe("unknown_work");
  });
});
