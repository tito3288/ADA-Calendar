import { describe, expect, it } from "vitest";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { conversationText, nextContinuation } from "./assistant-conversation";
import { compileInterpretation, emptyAssistantAction } from "./server/assistant";
import { dayCapacity, planCommands, validateSchedule } from "./scheduler";
import { commandSchema } from "./schemas";
import { newWorkItem } from "./work";
import type { Actor, ScheduleSnapshot, WorkCommand, WorkSession } from "./types";

// Entirely fictional, offline workload. No provider calls or persistence.
const now = new Date("2026-09-08T17:00:00Z");
const owner: Actor = { id: "test-owner", name: "Test owner", email: "owner@example.test", role: "owner" };
const client = { id: "fictional-studio", name: "Cedar Studio", aliases: [] };
const title = "Catalog rebuild";
const original = `${client.name} needs a catalog rebuild. Show the project for the rest of this month. Start with 4 hours this Friday the 10th from 9am–1pm.`;
const correction = "Sorry, I meant September 11th. The total estimated effort is unknown; 4 hours is just this session. Show the project this month until the end of the year. For now Friday 4 hours from 9am–1pm.";
const finalReply = "Split around lunch and extend the finish.";
const sessions = [
  { start: "2026-09-11T09:00:00-04:00", end: "2026-09-11T12:00:00-04:00", protected: false, usesReserve: false },
  { start: "2026-09-11T12:30:00-04:00", end: "2026-09-11T13:30:00-04:00", protected: false, usesReserve: false },
];
function snapshot(): ScheduleSnapshot {
  return { workspaceId: "fictional-ongoing", version: 0, clients: [client], priorities: structuredClone(DEFAULT_PRIORITIES), settings: structuredClone(DEFAULT_SETTINGS), items: [], sessions: [], blocks: [] };
}
function interpret(reply = finalReply, proposed = sessions, actor = owner, estimate: number | null = null) {
  const combined = `${original}\n${correction}\n${reply}`;
  return compileInterpretation({ kind: "commands", message: "Prepared ongoing project", draft: null, actions: [{
    ...emptyAssistantAction("create", combined), clientName: client.name, title, category: "web", webKind: "build", estimatedMinutes: estimate, sessions: proposed,
  }] }, combined, snapshot(), actor, now, reply, [correction]);
}
function ready() {
  const state = snapshot();
  const interpretation = interpret();
  expect(interpretation.kind, interpretation.message).toBe("commands");
  expect(commandSchema.safeParse(interpretation.commands[0]).success).toBe(true);
  const proposal = planCommands(state, interpretation.commands, owner, { now: now.toISOString() });
  expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
  return { ...state, items: proposal.items, sessions: proposal.sessions };
}

describe("ongoing projects with explicit sessions and an unknown total", () => {
  it("continues Add it instead of treating the corrected month list as a new task", () => {
    const pending = nextContinuation(original, { kind: "clarification", message: "Which Friday, and are these session hours?", commands: [] }, now)!;
    const reply = "Add it for months of September, October, November and December and for now 4 hours this Friday the 11th from 9am–1pm.";
    expect(conversationText(reply, pending)).toBe(`${original}\n${reply}`);
  });

  it("explains the actual lunch conflict after understanding the corrected date", () => {
    const result = interpret(correction, [{ ...sessions[0], end: "2026-09-11T13:00:00-04:00" }]);
    expect(result.kind).toBe("clarification");
    expect(result.message).toMatch(/12:00–12:30 lunch/);
    expect(result.message).not.toMatch(/YYYY/);
    expect(result.commands).toEqual([]);
  });

  it("books only four working hours after explicit lunch-split approval, with a December span and no total or finish forecast", () => {
    const state = ready();
    expect(state.items[0]).toMatchObject({ title, status: "planned", estimatedMinutes: null, remainingMinutes: null, windowEnd: "2026-12-31", forecastDate: null, deadline: null });
    expect(state.sessions).toHaveLength(2);
    expect(dayCapacity(state, "2026-09-11").plannedMinutes).toBe(240);
    expect(dayCapacity(state, "2026-12-01").plannedMinutes).toBe(0);
    expect(validateSchedule(state, now.toISOString())).toEqual([]);
  });

  it("does not mistake the provider's extracted first-session hours for a total estimate", () => {
    expect(interpret(finalReply, sessions, owner, 240).commands[0]).toMatchObject({ item: { estimatedMinutes: null, remainingMinutes: null } });
  });

  it("does not silently extend the finish without the user's explicit approval", () => {
    const result = interpret("The project total is still unknown.");
    expect(result.kind).toBe("clarification");
    expect(result.commands).toEqual([]);
  });

  it("can keep the original finish after explicit approval to book fewer working hours", () => {
    const interpretation = interpret("Keep the finish time and book fewer working hours.", [sessions[0], { ...sessions[1], end: "2026-09-11T13:00:00-04:00" }]);
    expect(interpretation.kind, interpretation.message).toBe("commands");
    const proposal = planCommands(snapshot(), interpretation.commands, owner, { now: now.toISOString() });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(dayCapacity({ ...snapshot(), items: proposal.items, sessions: proposal.sessions }, "2026-09-11").plannedMinutes).toBe(210);
    expect(proposal.items[0].remainingMinutes).toBeNull();
  });

  it("does not accept invented times or a stale date after correction", () => {
    for (const proposed of [
      [{ ...sessions[0], start: "2026-09-11T10:00:00-04:00", end: "2026-09-11T11:00:00-04:00" }],
      sessions.map(session => ({ ...session, start: session.start.replace("09-11", "09-10"), end: session.end.replace("09-11", "09-10") })),
    ]) expect(interpret(finalReply, proposed).kind).toBe("clarification");
  });

  it("does not save a project while silently omitting the requested session", () => {
    expect(interpret(finalReply, []).kind).toBe("clarification");
  });

  it("requesters cannot use a session duration as an unknown project's total", () => {
    const requester = { ...owner, role: "requester" as const };
    expect(interpret(finalReply, sessions, requester, 240).kind).toBe("clarification");
    const state = ready();
    const result = planCommands(snapshot(), [{ type: "create", item: state.items[0], sessions: state.sessions }], requester, { now: now.toISOString() });
    expect(result.status).toBe("infeasible");
  });

  it("metadata and display-span edits preserve all reservations without estimating or auto-allocating", () => {
    const state = ready();
    const result = planCommands(state, [{ type: "update", itemId: state.items[0].id, patch: { title: "Catalog refinement", windowEnd: "2027-01-31" } }], owner, { now: now.toISOString() });
    expect(result.status).toBe("ready");
    expect(result.sessions).toEqual(state.sessions);
    expect(result.items[0]).toMatchObject({ remainingMinutes: null, estimatedMinutes: null, forecastDate: null });
  });

  it("never treats a completed session or elapsed time as project completion", () => {
    const state = ready();
    const result = planCommands(state, [{ type: "complete_session", sessionId: state.sessions[0].id }], owner, { now: "2026-09-11T16:00:00Z" });
    expect(result.status, JSON.stringify(result.conflicts)).toBe("ready");
    expect(result.items[0]).toMatchObject({ status: "planned", remainingMinutes: null, completedAt: null, forecastDate: null });
    expect(validateSchedule(state, "2026-09-14T17:00:00Z")).toEqual([]);
  });

  it("requires explicit sessions when asking to schedule more unknown-total work", () => {
    const state = ready();
    const result = planCommands(state, [{ type: "schedule", itemId: state.items[0].id }], owner, { now: now.toISOString() });
    expect(result.status).toBe("infeasible");
    expect(result.sessions).toEqual(state.sessions);
  });

  it("adds another explicit session without losing prior bookings, including unchanged protected sessions", () => {
    const state = ready();
    state.sessions[0].protected = true;
    const text = `Book another session for ${client.name} ${title} on September 14th from 9am–11am.`;
    const result = compileInterpretation({ kind: "commands", message: "Additional session", draft: null, actions: [{
      ...emptyAssistantAction("schedule", text), clientName: client.name, itemReference: title,
      sessions: [{ start: "2026-09-14T09:00:00-04:00", end: "2026-09-14T11:00:00-04:00", protected: false, usesReserve: false }],
    }] }, text, state, owner, now);
    expect(result.kind, result.message).toBe("commands");
    const proposal = planCommands(state, result.commands, owner, { now: now.toISOString() });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions).toHaveLength(3);
    expect(proposal.sessions.slice(0, 2)).toEqual(state.sessions);
    expect(proposal.items[0]).toMatchObject({ estimatedMinutes: null, remainingMinutes: null, forecastDate: null });
    const underway = planCommands(state, result.commands, owner, { now: "2026-09-11T14:00:00Z" });
    expect(underway.status, JSON.stringify(underway.conflicts)).toBe("ready");
    expect(underway.sessions.slice(0, 2)).toEqual(state.sessions);
  });

  it("can start already-booked work without inventing a total or changing its sessions", () => {
    const state = ready();
    const proposal = planCommands(state, [{ type: "status", itemId: state.items[0].id, status: "in_progress" }], owner, { now: now.toISOString() });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.items[0]).toMatchObject({ status: "in_progress", estimatedMinutes: null, remainingMinutes: null });
    expect(proposal.sessions).toEqual(state.sessions);
  });

  it("does not equate finishing one session with completing an unknown-total project", () => {
    const state = ready();
    const text = `I completed the ${title} session for ${client.name}.`;
    const result = compileInterpretation({ kind: "commands", message: "Done", draft: null, actions: [{
      ...emptyAssistantAction("status", text), clientName: client.name, itemReference: title, status: "completed",
    }] }, text, state, owner, now);
    expect(result.kind).toBe("clarification");
    expect(result.commands).toEqual([]);
  });

  it("does not silently discard unknown-total reservations to make room for other work", () => {
    const state = ready();
    const item = newWorkItem(owner, "2026-09-11", { clientId: client.id, title: "Unrelated booking", estimatedMinutes: 180, remainingMinutes: 180 });
    const session: WorkSession = { ...state.sessions[0], id: "new-session", workItemId: item.id };
    const result = planCommands(state, [{ type: "create", item, sessions: [session] }], owner, { now: now.toISOString() });
    expect(result.status).toBe("infeasible");
    expect(result.conflicts.some(conflict => conflict.code === "unknown_effort_displacement")).toBe(true);
    expect(result.items).toEqual(state.items);
    expect(result.sessions).toEqual(state.sessions);
  });

  it("keeps protected sessions protected and enforces lunch, past time, and unavailable blocks", () => {
    const state = ready();
    state.sessions[0].protected = true;
    const commands: WorkCommand[] = [{ type: "move", sessionId: state.sessions[0].id, start: "2026-09-14T09:00:00-04:00", end: "2026-09-14T12:00:00-04:00" }];
    expect(planCommands(state, commands, owner, { now: now.toISOString() }).status).toBe("infeasible");
    for (const start of ["2026-09-11T11:00:00-04:00", "2026-09-07T09:00:00-04:00"]) {
      const end = new Date(Date.parse(start) + 180 * 60000).toISOString();
      expect(planCommands(state, [{ type: "move", sessionId: state.sessions[0].id, start, end, overrideProtected: true }], owner, { now: now.toISOString() }).status).toBe("infeasible");
    }
  });
});
