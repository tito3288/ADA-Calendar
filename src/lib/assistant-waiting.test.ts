import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { nextContinuation } from "./assistant-conversation";
import { dayCapacity, planCommands, validateSchedule } from "./scheduler";
import { compileInterpretation, emptyAssistantAction, interpretInput, type AssistantAction } from "./server/assistant";
import type { Actor, ScheduleSnapshot, WorkCommand } from "./types";

const provider = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("openai", async importOriginal => {
  const actual = await importOriginal<typeof import("openai")>();
  return { ...actual, default: class { responses = { parse: provider.parse }; } };
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

const now = new Date("2026-09-08T12:00:00Z");
const owner: Actor = { id: "test-owner", name: "Test owner", email: "owner@example.test", role: "owner" };
const requester: Actor = { ...owner, id: "test-requester", role: "requester" };
const original = "I will be working on software for Drive and Shine this month and next month. I am working on Oil Survey system that connects to their POS. I am waiting on client details for the workdays and hours.";
const reply = 'add “Oil Survey system” for Drive and Shine now as unscheduled work with no estimate';
const question = "Should I add Oil Survey system now as unscheduled work with no estimate, or wait until you know the workdays and hours?";

// Empty fictional workspace: never uses hosted data, real API keys, or emails.
function snapshot(): ScheduleSnapshot {
  return { workspaceId: "test-waiting", version: 0, settings: structuredClone(DEFAULT_SETTINGS),
    priorities: structuredClone(DEFAULT_PRIORITIES), clients: [{ id: "test-drive", name: "Drive and Shine", aliases: [] }],
    items: [], sessions: [], blocks: [] };
}
function output(text: string, patch: Partial<AssistantAction> = {}) {
  return { kind: "commands", message: "Prepared waiting work without reserving time.", actions: [{
    ...emptyAssistantAction("create", text), clientName: "Drive and Shine", title: "Oil Survey system",
    category: "software", description: original, ...patch,
  }], draft: null };
}
function createWaiting() {
  const state = snapshot();
  const compiled = compileInterpretation(output(reply), reply, state, owner, now);
  const proposal = planCommands(state, compiled.commands, owner, { now: now.toISOString() });
  expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
  return { ...state, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks };
}
function plan(state: ScheduleSnapshot, commands: WorkCommand[], actor = owner) {
  return planCommands(state, commands, actor, { now: now.toISOString() });
}

describe("waiting with unknown effort — offline provider, compiler and scheduler", () => {
  it("accepts the reported pending reply and creates exactly one waiting task with no hours reserved", async () => {
    vi.stubEnv("OPENAI_API_KEY", "offline-test-placeholder");
    const state = snapshot();
    const before = structuredClone(state);
    const continuation = nextContinuation(original, { kind: "clarification", message: question, commands: [] }, now)!;
    const evidence = `${original}\n${reply}`;
    provider.parse.mockResolvedValueOnce({ output_parsed: output(evidence, { status: "waiting", reason: "Awaiting client workdays and hours" }) });
    const compiled = await interpretInput(reply, state, owner, { continuation, now });
    expect(compiled.kind).toBe("commands");
    expect(compiled.commands).toHaveLength(1);
    const result = plan(state, compiled.commands);
    expect(result.status).toBe("ready");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ title: "Oil Survey system", clientId: "test-drive", category: "software",
      description: original, status: "waiting", estimatedMinutes: null, remainingMinutes: null,
      forecastDate: null, blockedReason: "Awaiting client workdays and hours", allowedDates: [], deadline: null });
    expect(result.sessions).toEqual([]);
    expect(dayCapacity({ ...state, items: result.items }, "2026-09-08").plannedMinutes).toBe(0);
    expect(state).toEqual(before);
    expect(provider.parse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      model: "gpt-5.6-sol", store: false,
      input: [expect.objectContaining({ content: expect.stringContaining("Requesters always need a positive estimate") }), { role: "user", content: evidence }],
    }));
  });

  it("keeps unknown work waiting even if extraction omits its status", () => {
    expect(createWaiting().items[0]).toMatchObject({ status: "waiting", estimatedMinutes: null, remainingMinutes: null });
  });

  it.each(["Add Oil Survey system software for Drive and Shine.", "Schedule Oil Survey system software for Drive and Shine tomorrow."])("asks for missing effort rather than silently adding backlog: %s", text => {
    const result = compileInterpretation(output(text), text, snapshot(), owner, now);
    expect(result.kind).toBe("clarification");
    expect(result.commands).toEqual([]);
  });

  it("does not accept provider-invented waiting status or hours", () => {
    const text = "Add Oil Survey system software for Drive and Shine for 2 hours.";
    expect(compileInterpretation(output(text, { status: "waiting", estimatedMinutes: 120 }), text, snapshot(), owner, now).kind).toBe("clarification");
    expect(compileInterpretation(output(reply, { estimatedMinutes: 120 }), reply, snapshot(), owner, now).kind).toBe("clarification");
  });

  it("rejects timed reservations mixed with waiting/no estimate", () => {
    const text = `${reply}. Reserve 2026-09-09 from 9 AM to 11 AM.`;
    const result = compileInterpretation(output(text, { status: "waiting", sessions: [{ start: "2026-09-09T09:00:00-04:00", end: "2026-09-09T11:00:00-04:00", protected: false, usesReserve: false }] }), text, snapshot(), owner, now);
    expect(result.kind).toBe("clarification");
    expect(result.commands).toEqual([]);
  });

  it("keeps requester effort requirements at both compiler and scheduler boundaries", () => {
    expect(compileInterpretation(output(reply), reply, snapshot(), requester, now).kind).toBe("clarification");
    const waiting = createWaiting().items[0];
    const result = plan(snapshot(), [{ type: "create", item: waiting }], requester);
    expect(result.status).not.toBe("ready");
    expect(result.items).toEqual([]);
  });

  it("does not let a waiting record block unrelated work or global validation", () => {
    const state = createWaiting();
    expect(validateSchedule(state, now.toISOString())).toEqual([]);
    const result = plan(state, [{ type: "create", item: { ...state.items[0], id: "test-second", title: "Separate work", status: "planned", estimatedMinutes: 120, remainingMinutes: 120, blockedReason: null } }]);
    expect(result.status).toBe("ready");
    expect(result.items).toHaveLength(2);
    expect(result.sessions.every(session => session.workItemId === "test-second")).toBe(true);
    expect(validateSchedule({ ...state, items: result.items, sessions: result.sessions }, now.toISOString())).toEqual([]);
  });

  it.each(["update", "progress", "status"] as const)("initializes the first estimate only from explicit positive remaining effort via %s", type => {
    const state = createWaiting();
    const itemId = state.items[0].id;
    const command: WorkCommand = type === "update" ? { type, itemId, patch: { estimatedMinutes: null, remainingMinutes: 120 } }
      : type === "status" ? { type, itemId, status: "in_progress", remainingMinutes: 120 }
      : { type, itemId, remainingMinutes: 120 };
    const result = plan(state, [command]);
    expect(result.status).toBe("ready");
    expect(result.items[0]).toMatchObject({ estimatedMinutes: 120, remainingMinutes: 120, status: type === "status" ? "in_progress" : "waiting" });
    expect(result.sessions.length > 0).toBe(type === "status");
    expect(state.items[0].estimatedMinutes).toBeNull();
  });

  it("requires an estimate to resume and rejects scheduling without resuming", () => {
    const state = createWaiting();
    const itemId = state.items[0].id;
    for (const command of [{ type: "status", itemId, status: "in_progress" }, { type: "schedule", itemId }] as WorkCommand[]) {
      const result = plan(state, [command]);
      expect(result.status).toBe("infeasible");
      expect(result.items).toEqual(state.items);
      expect(result.sessions).toEqual([]);
    }
  });

  it.each(["completed", "cancelled"] as const)("can mark unknown work %s without fabricating an estimate", status => {
    const state = createWaiting();
    const result = plan(state, [{ type: "status", itemId: state.items[0].id, status }]);
    expect(result.status).toBe("ready");
    expect(result.items[0]).toMatchObject({ status, estimatedMinutes: null, remainingMinutes: status === "completed" ? 0 : null });
    expect(result.sessions).toEqual([]);
    expect(validateSchedule({ ...state, items: result.items }, now.toISOString())).toEqual([]);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("does not allow invalid remaining effort %s even when completing", remainingMinutes => {
    const state = createWaiting();
    for (const type of ["progress", "status", "update"] as const) {
      const itemId = state.items[0].id;
      const command: WorkCommand = type === "update" ? { type, itemId, patch: { remainingMinutes } }
        : type === "status" ? { type, itemId, status: "completed", remainingMinutes } : { type, itemId, remainingMinutes };
      expect(plan(state, [command]).status).toBe("infeasible");
    }
  });

  it("preserves a known original estimate when progress changes", () => {
    const state = createWaiting();
    state.items[0].estimatedMinutes = 240;
    state.items[0].remainingMinutes = 240;
    const result = plan(state, [{ type: "status", itemId: state.items[0].id, status: "in_progress", remainingMinutes: 120 }]);
    expect(result.status).toBe("ready");
    expect(result.items[0]).toMatchObject({ estimatedMinutes: 240, remainingMinutes: 120 });
  });
});
