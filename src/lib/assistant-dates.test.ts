import { describe, expect, it } from "vitest";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { dayCapacity, planCommands, validateSchedule } from "./scheduler";
import { compileInterpretation, emptyAssistantAction, type AssistantAction } from "./server/assistant";
import { localDate, localDateTime, minutesBetween } from "./time";
import type { Actor, ScheduleSnapshot } from "./types";

const now = new Date("2026-09-08T14:20:00Z");
const today = "2026-09-08";
const tomorrow = "2026-09-09";
const owner: Actor = { id: "demo-owner", name: "Demo owner", email: "owner@example.test", role: "owner" };

// Fictional, empty snapshots only: no hosted workspace, credentials, or provider calls.
function snapshot(): ScheduleSnapshot {
  return {
    workspaceId: "demo-assistant-dates", version: 0,
    settings: structuredClone(DEFAULT_SETTINGS), priorities: structuredClone(DEFAULT_PRIORITIES),
    clients: [{ id: "demo-cidwp", name: "CIDWP", aliases: [] }],
    items: [], sessions: [], blocks: [],
  };
}

function action(text: string, patch: Partial<AssistantAction> = {}): AssistantAction {
  return {
    ...emptyAssistantAction("create", text), clientName: "CIDWP", title: "Homepage demo",
    description: "Fictional regression-test work", category: "web", webKind: "build",
    estimatedMinutes: 180, ...patch,
  };
}

function compile(text: string, patch: Partial<AssistantAction> = {}, state = snapshot()) {
  const raw = { kind: "commands", message: "Prepared", actions: [action(text, patch)], draft: null };
  return compileInterpretation(raw, text, state, owner, now);
}

describe("grounded calendar start dates (offline compiler and scheduler)", () => {
  it("starts the CIDWP three-hour September 9 demo on September 9, not the day it was entered", () => {
    const text = "CIDWP needs a homepage demo. Allow 3 hours total on 2026-09-09 only.";
    const state = snapshot();
    const before = structuredClone(state);
    // Reproduce a provider extraction that supplied the allowed day but omitted the start.
    const raw = { kind: "commands", message: "Prepared", actions: [action(text, { allowedDates: [tomorrow], windowEnd: tomorrow })], draft: null };
    const interpretation = compileInterpretation(raw, text, state, owner, now);
    expect(interpretation.kind).toBe("commands");
    expect(interpretation.commands).toHaveLength(1);
    expect(interpretation.commands[0]).toMatchObject({ type: "create", item: { windowStart: tomorrow, windowEnd: tomorrow, allowedDates: [] } });

    const plan = planCommands(state, interpretation.commands, owner, { now: now.toISOString() });
    expect(plan.status).toBe("ready");
    expect(plan.conflicts).toEqual([]);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ windowStart: tomorrow, forecastDate: tomorrow, remainingMinutes: 180 });
    expect(plan.sessions).toHaveLength(1);
    expect(plan.sessions[0]).toMatchObject({
      start: localDateTime(tomorrow, "09:00", state.settings.timeZone),
      end: localDateTime(tomorrow, "12:00", state.settings.timeZone),
    });
    expect(plan.sessions.reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0)).toBe(180);
    const planned = { ...state, items: plan.items, sessions: plan.sessions, blocks: plan.blocks };
    expect(dayCapacity(planned, today).plannedMinutes).toBe(0);
    expect(dayCapacity(planned, tomorrow).plannedMinutes).toBe(180);
    expect(validateSchedule(planned, now.toISOString())).toEqual([]);
    expect(state).toEqual(before);
    expect(raw.actions[0].windowStart).toBeNull();
  });

  it("asks for a range or day amounts for separate alternative workdays", () => {
    const text = "Schedule CIDWP for 3 hours on 2026-09-11 or 2026-09-09.";
    const result = compile(text, { allowedDates: ["2026-09-11", tomorrow] });
    expect(result.kind).toBe("clarification");
    expect(result.commands).toEqual([]);
  });

  it("uses an explicit future timed session when neither a window start nor allowed dates were supplied", () => {
    const text = "Schedule the CIDWP homepage demo for 3 hours on 2026-09-09 from 9 AM to noon.";
    const state = snapshot();
    const sessions = [{ start: "2026-09-09T09:00:00-04:00", end: "2026-09-09T12:00:00-04:00", protected: false, usesReserve: false }];
    const result = compile(text, { sessions }, state);
    expect(result.kind).toBe("commands");
    expect(result.commands[0]).toMatchObject({ item: { windowStart: tomorrow }, sessions });
    const plan = planCommands(state, result.commands, owner, { now: now.toISOString() });
    expect(plan.status).toBe("ready");
    expect(plan.sessions).toHaveLength(1);
    expect(localDate(plan.sessions[0].start, state.settings.timeZone)).toBe(tomorrow);
  });

  it("derives timed-session dates in the workspace timezone instead of slicing the UTC timestamp", () => {
    const text = "Schedule CIDWP for 1 hour on 2026-09-09 from 9 PM to 10 PM.";
    const result = compile(text, {
      estimatedMinutes: 60,
      sessions: [{ start: "2026-09-10T01:00:00Z", end: "2026-09-10T02:00:00Z", protected: false, usesReserve: false }],
    });
    // This checks date extraction only; ordinary working-hour validation remains the scheduler's job.
    expect(result.kind).toBe("commands");
    expect(result.commands[0]).toMatchObject({ item: { windowStart: tomorrow } });
  });

  it("preserves an explicit genuine multi-day span before the first reserved day", () => {
    const text = "CIDWP is open from 2026-09-08 through 2026-09-11. Reserve 3 hours on 2026-09-09.";
    const state = snapshot();
    const result = compile(text, { windowStart: today, windowEnd: "2026-09-11", allowedDates: [tomorrow] }, state);
    expect(result.kind).toBe("commands");
    expect(result.commands[0]).toMatchObject({ item: { windowStart: today, windowEnd: "2026-09-11" } });
    const plan = planCommands(state, result.commands, owner, { now: now.toISOString() });
    expect(plan.status).toBe("ready");
    expect(plan.items[0].windowStart).toBe(today);
    expect(plan.sessions.every(session => localDate(session.start, state.settings.timeZone) === tomorrow)).toBe(true);
  });

  it.each(["targetDate", "deadline", "windowEnd", "updateDate"] as const)("does not turn a %s alone into a start date", field => {
    const text = "Add CIDWP homepage work for 3 hours, with a checkpoint on 2026-09-11.";
    const result = compile(text, { [field]: "2026-09-11" });
    expect(result.kind).toBe("commands");
    expect(result.commands[0]).toMatchObject({ item: { windowStart: today, [field]: field === "deadline" ? null : "2026-09-11", allowedDates: [] } });
  });

  it("retains today's default when no work dates were specified", () => {
    const result = compile("Add a CIDWP homepage demo for 3 hours.");
    expect(result.kind).toBe("commands");
    expect(result.commands[0]).toMatchObject({ item: { windowStart: today, allowedDates: [] } });
  });

  it.each(["2026-09-07", today])("rejects an ungrounded explicit start of %s rather than silently accepting or repairing it", windowStart => {
    const result = compile("Schedule CIDWP for 3 hours on 2026-09-09 only.", { windowStart, allowedDates: [tomorrow] });
    expect(result.kind).toBe("clarification");
    expect(result.commands).toEqual([]);
  });

  it("clarifies when a grounded window end precedes the start inferred from allowed work dates", () => {
    const text = "Schedule CIDWP for 3 hours on 2026-09-09 only; the work window ends on 2026-09-08.";
    const result = compile(text, { allowedDates: [tomorrow], windowEnd: today });
    expect(result.kind).toBe("clarification");
    expect(result.commands).toEqual([]);
    expect(result.message).toMatch(/end of the work window/i);
  });

  it("fails without adding or spilling work into another day when the sole allowed day has no capacity", () => {
    const text = "Schedule CIDWP for 3 hours on 2026-09-09 only.";
    const state = snapshot();
    state.blocks.push({
      id: "demo-time-off", title: "Fictional day off", kind: "time_off",
      start: localDateTime(tomorrow, "09:00", state.settings.timeZone),
      end: localDateTime(tomorrow, "17:00", state.settings.timeZone),
    });
    const before = structuredClone(state);
    const result = compile(text, { allowedDates: [tomorrow] }, state);
    expect(result.kind).toBe("commands");
    const plan = planCommands(state, result.commands, owner, { now: now.toISOString() });
    expect(plan.status).toBe("infeasible");
    expect(plan.conflicts.some(conflict => conflict.code === "smart_fit_capacity")).toBe(true);
    expect(plan.items).toEqual([]);
    expect(plan.sessions).toEqual([]);
    expect(plan.blocks).toEqual(state.blocks);
    expect(state).toEqual(before);
  });

  it("accepts the spoken-date punctuation September, 9th without changing the intended day", () => {
    const text = "CIDWP needs a homepage demo. Start to finish on September, 9th, for 3 hours.";
    const result = compile(text, { allowedDates: [tomorrow], windowEnd: tomorrow });
    expect(result.kind).toBe("commands");
    expect(result.commands[0]).toMatchObject({ item: { windowStart: tomorrow, windowEnd: tomorrow, allowedDates: [] } });
  });

  it("does not let comma-tolerant grounding accept a different day or an impossible date", () => {
    const result = compile("Schedule CIDWP for 3 hours on September, 9th.", { allowedDates: ["2026-09-10"] });
    expect(result.kind).toBe("clarification");
    expect(result.commands).toEqual([]);
    const impossible = compile("Schedule CIDWP for 3 hours on September, 31st.", { allowedDates: ["2026-09-31"] });
    expect(impossible.kind).toBe("clarification");
    expect(impossible.commands).toEqual([]);
  });
});
