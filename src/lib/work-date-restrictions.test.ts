import { describe, expect, it } from "vitest";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { planCommands, validateSchedule } from "./scheduler";
import { addDays, localDateTime } from "./time";
import type { Actor, ScheduleProposal, ScheduleSnapshot, WorkCommand, WorkItem, WorkSession } from "./types";
import { newWorkItem } from "./work";

// Isolated fictional fixtures. These tests never call providers or persist work.
const owner: Actor = { id: "owner", name: "Fixture owner", email: "owner@example.test", role: "owner" };
const source = "2026-09-10", destination = "2026-09-11";
const at = (date: string, time: string) => localDateTime(date, time, DEFAULT_SETTINGS.timeZone);
const now = at("2026-09-09", "08:00");
const move: WorkCommand = { type: "move_bookings", sessionIds: ["booking"], date: destination };

function snapshot(patch: Partial<WorkItem> = {}): ScheduleSnapshot {
  const item = newWorkItem(owner, source, {
    id: "site", title: "Fictional website edits", clientId: "client", estimatedMinutes: 120, remainingMinutes: 120,
    windowEnd: source, allowedDates: [source], dateConstraints: { earliestStart: null, allowedDates: [source] }, minimumSessionMinutes: 60, ...patch,
  });
  const session: WorkSession = {
    id: "booking", workItemId: item.id, start: at(source, "10:00"), end: at(source, "12:00"),
    status: "planned", protected: false, usesReserve: false,
  };
  return {
    workspaceId: "work-date-fixture", version: 4, settings: { ...DEFAULT_SETTINGS, reserveMinutes: 0 },
    clients: [{ id: "client", name: "Fictional client", aliases: [] }], priorities: structuredClone(DEFAULT_PRIORITIES),
    items: [item], sessions: [session], blocks: [],
  };
}

function plan(state: ScheduleSnapshot, commands: WorkCommand[]) {
  return planCommands(state, commands, owner, { now, operationId: "work-date-operation" });
}

function widen(state: ScheduleSnapshot) {
  return plan(state, [
    { type: "update", itemId: "site", patch: { dateConstraints: { earliestStart: null, allowedDates: [source, destination] } } },
    { type: "schedule", itemId: "site", sessions: state.sessions.filter(session => session.workItemId === "site" && session.status === "planned") },
  ]);
}

function saved(state: ScheduleSnapshot, proposal: ScheduleProposal): ScheduleSnapshot {
  expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
  const result = { ...state, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks };
  expect(validateSchedule(result, now)).toEqual([]);
  return result;
}

function blocked(state: ScheduleSnapshot, proposal: ScheduleProposal, code: string) {
  expect(proposal.status).toBe("infeasible");
  expect(proposal.conflicts[0].code).toBe(code);
  expect(proposal.items).toEqual(state.items);
  expect(proposal.sessions).toEqual(state.sessions);
  expect(proposal.blocks).toEqual(state.blocks);
}

describe("visible and explicitly editable allowed work dates", () => {
  it("identifies the saved day restriction and directs the owner to its actual editor", () => {
    const state = snapshot(), proposal = plan(state, [move]);
    blocked(state, proposal, "outside_allowed_dates");
    const message = proposal.conflicts[0].message;
    expect(message).toContain("Sep 11, 2026 is not an allowed work date");
    expect(message).toContain("Allowed work dates: Sep 10, 2026");
    expect(message).toContain("Open Edit work");
    expect(message).toContain("explicit scheduling limits");
    expect(message).toContain("Display dates do not restrict moving work");
  });

  it("keeps the list readable and bounded for a project with many allowed days", () => {
    const state = snapshot({ dateConstraints: { earliestStart: null, allowedDates: Array.from({ length: 30 }, (_, index) => addDays(source, index * 2)) } });
    const proposal = plan(state, [move]);
    blocked(state, proposal, "outside_allowed_dates");
    expect(proposal.conflicts[0].message).toContain("and 24 more");
    expect(proposal.conflicts[0].message.length).toBeLessThan(650);
  });

  it.each([120, 600, null])("widens dates without refilling or changing %s minutes of remaining effort, then allows the move", remainingMinutes => {
    const state = snapshot({ remainingMinutes, estimatedMinutes: remainingMinutes });
    const before = structuredClone(state);
    const widened = saved(state, widen(state));
    expect(widened.sessions).toEqual(before.sessions);
    expect(widened.items[0]).toMatchObject({
      dateConstraints: { earliestStart: null, allowedDates: [source, destination] }, windowStart: source, windowEnd: source,
      estimatedMinutes: remainingMinutes, remainingMinutes, deadline: null,
    });
    expect(widened.settings).toEqual(before.settings);
    expect(widened.blocks).toEqual(before.blocks);
    const moved = saved(widened, plan(widened, [move]));
    expect(moved.sessions).toEqual([{ ...before.sessions[0], start: at(destination, "09:00"), end: at(destination, "11:00") }]);
    expect(moved.items[0]).toMatchObject({ estimatedMinutes: remainingMinutes, remainingMinutes, windowEnd: source });
    expect(state).toEqual(before);
  });

  it("keeps protected and daily planned reservations identical during a date-permission edit", () => {
    const state = snapshot({ dailyPlan: [{ date: source, minutes: 120 }] });
    state.sessions[0].protected = true;
    const widened = saved(state, widen(state));
    expect(widened.sessions).toEqual(state.sessions);
    expect(widened.items[0].dailyPlan).toEqual(state.items[0].dailyPlan);
    blocked(widened, plan(widened, [move]), "protected_session");
  });

  it("does not permit a different workday merely because the display span was extended", () => {
    const state = snapshot();
    const extended = saved(state, plan(state, [{ type: "update", itemId: "site", patch: { windowEnd: destination } }]));
    expect(extended.items[0].allowedDates).toEqual([source]);
    expect(extended.sessions).toEqual(state.sessions);
    blocked(extended, plan(extended, [move]), "outside_allowed_dates");
  });

  it("still rejects a move when the newly allowed day has insufficient capacity", () => {
    const state = snapshot();
    state.blocks = [{ id: "day-off", title: "Fictional time off", kind: "time_off", start: at(destination, "09:00"), end: at(destination, "16:30") }];
    const widened = saved(state, widen(state));
    blocked(widened, plan(widened, [move]), "booking_capacity");
  });

  it("identifies an actual earliest-start restriction instead of suggesting the display span", () => {
    const state = snapshot({ dateConstraints: { earliestStart: source, allowedDates: [] } });
    const proposal = plan(state, [{ ...move, date: "2026-09-09" }]);
    blocked(state, proposal, "outside_allowed_dates");
    expect(proposal.conflicts[0].message).toContain("Sep 9, 2026 is before this project's earliest start, Sep 10, 2026");
    expect(proposal.conflicts[0].message).toContain("explicit scheduling limits");
    expect(proposal.conflicts[0].message).not.toContain("Allowed work dates");
  });

  it("identifies a genuine firm deadline and preserves the explicit-override requirement", () => {
    const state = snapshot({ deadline: source });
    const proposal = plan(state, [move]);
    blocked(state, proposal, "outside_allowed_dates");
    expect(proposal.conflicts[0].message).toContain("Sep 11, 2026 is after this project's firm deadline, Sep 10, 2026");
    expect(proposal.conflicts[0].message).toContain("explicit override");
    expect(proposal.conflicts[0].message).not.toContain("Allowed work dates");
  });
});
