import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { nextContinuation } from "./assistant-conversation";
import { waitingWorkRequested } from "./assistant-work-context";
import { dayCapacity, planCommands, validateSchedule } from "./scheduler";
import { compileInterpretation, emptyAssistantAction, interpretInput, type AssistantAction } from "./server/assistant";
import { newWorkItem } from "./work";
import type { Actor, ScheduleSnapshot } from "./types";

const provider = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("openai", async importOriginal => {
  const actual = await importOriginal<typeof import("openai")>();
  return { ...actual, default: class { responses = { parse: provider.parse }; } };
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

const now = new Date("2026-09-08T16:00:00Z");
const owner: Actor = { id: "fictional-owner", name: "Test owner", email: "owner@example.test", role: "owner" };
const client = { id: "fictional-client", name: "Birch Meadow Labs", aliases: ["Birch Labs"] };
const title = "Guest Follow-up Connector";
// Fictional projects only; no production workload descriptions or provider calls.
const original = "Software project: Guest Follow-up Connector integrates a sample service. Expected project context is the rest of September and October 2026, but specific work dates and hours are awaiting client details. This is a separate task from Fleet Health Dashboard.";
function snapshot(): ScheduleSnapshot {
  return { workspaceId: "fictional-natural-waiting", version: 0, settings: structuredClone(DEFAULT_SETTINGS),
    priorities: structuredClone(DEFAULT_PRIORITIES), clients: [client], blocks: [], sessions: [],
    items: [newWorkItem(owner, "2026-09-08", { id: "existing-dashboard", clientId: client.id, title: "Fleet Health Dashboard", category: "software", webKind: null,
      status: "waiting", estimatedMinutes: null, remainingMinutes: null, windowEnd: "2026-10-31" })] };
}
function extraction(quote: string, patch: Partial<AssistantAction> = {}) {
  return { kind: "commands", message: "Prepared the new waiting project.", actions: [{
    ...emptyAssistantAction("create", quote), clientName: client.name, title, category: "software", ...patch,
  }], draft: null };
}
function compile(text: string, patch: Partial<AssistantAction> = {}, actor = owner) {
  return compileInterpretation(extraction(text, patch), text, snapshot(), actor, now);
}

describe("natural waiting work and display spans (offline)", () => {
  it("creates a separate same-client project from ordinary descriptive language", () => {
    const state = snapshot();
    const before = structuredClone(state);
    const text = `${client.name}. ${original}`;
    const result = compileInterpretation(extraction(text), text, state, owner, now);
    expect(result.kind).toBe("commands");
    const proposal = planCommands(state, result.commands, owner, { now: now.toISOString() });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.items).toHaveLength(2);
    expect(proposal.items[0]).toEqual(state.items[0]);
    expect(proposal.items[1]).toMatchObject({ title, clientId: client.id, category: "software", status: "waiting", estimatedMinutes: null, remainingMinutes: null,
      windowStart: "2026-09-08", windowEnd: "2026-10-31", targetDate: null, deadline: null, allowedDates: [], description: text });
    expect(proposal.sessions).toEqual([]);
    const planned = { ...state, items: proposal.items, sessions: proposal.sessions };
    expect(dayCapacity(planned, "2026-10-01").plannedMinutes).toBe(0);
    expect(validateSchedule(planned, now.toISOString())).toEqual([]);
    expect(state).toEqual(before);
  });

  it.each([
    "Dates and hours are awaiting client details.",
    "I am waiting on them for the workdays and hours.",
    "Workdays and hours are pending client confirmation.",
    "The effort estimate is not yet known.",
    "I don't know the hours yet.",
    "Hours are TBD.",
  ])("recognizes unknown effort without magic words: %s", wording => {
    const result = compile(`${client.name} ${title} software project. ${wording}`);
    expect(result.kind).toBe("commands");
    expect(result.commands[0]).toMatchObject({ type: "create", item: { status: "waiting", estimatedMinutes: null, remainingMinutes: null } });
  });

  it.each([
    "We are not waiting on client details.",
    "We are no longer awaiting client details.",
    "Do not wait for the client.",
    "Build a waiting room display.",
    "This has a 2 hour estimate.",
  ])("does not infer waiting from negation or unrelated text: %s", wording => {
    expect(waitingWorkRequested(wording)).toBe(false);
    expect(compile(`${client.name} ${title}. ${wording}`).kind).toBe("clarification");
  });

  it("keeps the current model and retains original context behind a names-only reply", async () => {
    vi.stubEnv("OPENAI_API_KEY", "offline-test-placeholder");
    const pending = nextContinuation(original, { kind: "clarification", message: "Which client and task title?", commands: [] }, now)!;
    const reply = `${client.name} ${title}`;
    // Reproduce the provider quoting only the latest answer and omitting dates/status.
    provider.parse.mockResolvedValueOnce({ output_parsed: extraction(reply) });
    const result = await interpretInput(reply, snapshot(), owner, { continuation: pending, now });
    expect(result.kind).toBe("commands");
    expect(result.commands[0]).toMatchObject({ type: "create", item: { status: "waiting", estimatedMinutes: null, windowStart: "2026-09-08", windowEnd: "2026-10-31" } });
    expect(provider.parse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ model: "gpt-5.6-sol", store: false,
      input: [expect.objectContaining({ content: expect.stringContaining("Do not ask whether it is new again") }), { role: "user", content: `${original}\n${reply}` }] }));
  });

  it("retains waiting and span when a short reply only confirms this is new work for the client", async () => {
    vi.stubEnv("OPENAI_API_KEY", "offline-test-placeholder");
    const pending = nextContinuation(`${client.name}. ${original}`, { kind: "clarification", message: "Is this a new task?", commands: [] }, now)!;
    const reply = `It's a new ${client.name} task`;
    provider.parse.mockResolvedValueOnce({ output_parsed: extraction(reply) });
    const result = await interpretInput(reply, snapshot(), owner, { continuation: pending, now });
    expect(result.commands[0]).toMatchObject({ type: "create", item: { status: "waiting", windowEnd: "2026-10-31" } });
  });

  it("does not borrow waiting or dates from another client's pending task", () => {
    const state = snapshot();
    state.clients.push({ id: "another-client", name: "Cedar Hill", aliases: [] });
    const prior = `Cedar Hill. ${original}`;
    const reply = `${client.name} ${title}`;
    const result = compileInterpretation(extraction(reply), `${prior}\n${reply}`, state, owner, now, reply);
    expect(result.kind).toBe("clarification");
    expect(result.commands).toEqual([]);
  });

  it("does not borrow prior context for a different title or a substantive new instruction", () => {
    for (const reply of [`${client.name} Invoice Tracker`, `${client.name} ${title}. Schedule two hours tomorrow.`]) {
      const patch = reply.includes("Invoice Tracker") ? { title: "Invoice Tracker" } : {};
      const result = compileInterpretation(extraction(reply, patch), `${original}\n${reply}`, snapshot(), owner, now, reply);
      expect(result.kind).toBe("clarification");
      expect(result.commands).toEqual([]);
    }
  });

  it("does not borrow dates and waiting facts across two same-client project narratives", () => {
    const prior = `${client.name}: Guest Follow-up Connector is waiting on client details. Its project context is the rest of September and October 2026. The separate Fleet Health Dashboard project is ready for scheduling.`;
    for (const target of ["Fleet Health Dashboard", title]) {
      const reply = `${client.name} ${target}`;
      const result = compileInterpretation(extraction(reply, { title: target }), `${prior}\n${reply}`, snapshot(), owner, now, reply);
      expect(result.kind).toBe("clarification");
      expect(result.commands).toEqual([]);
    }
  });

  it("retains a descriptive title whose words span sentences within the same project", () => {
    const prior = `Software integration for guest follow-up. This connector will use a sample service. Project context is the rest of September and October 2026. Hours are awaiting client details. Separate task from Fleet Health Dashboard.`;
    const reply = `${client.name} ${title}`;
    const result = compileInterpretation(extraction(reply), `${prior}\n${reply}`, snapshot(), owner, now, reply);
    expect(result.commands[0]).toMatchObject({ type: "create", item: { title, status: "waiting", windowEnd: "2026-10-31" } });
  });

  it("never borrows waiting permission from the assistant's question", async () => {
    vi.stubEnv("OPENAI_API_KEY", "offline-test-placeholder");
    const pending = nextContinuation(`Software project ${title}.`, { kind: "clarification", message: "Shall I keep it waiting with no hours from September through October 2026?", commands: [] }, now)!;
    const reply = `${client.name} ${title}`;
    provider.parse.mockResolvedValueOnce({ output_parsed: extraction(reply) });
    expect((await interpretInput(reply, snapshot(), owner, { continuation: pending, now })).kind).toBe("clarification");
  });

  it("never turns separate-work wording into an update of the existing project", () => {
    const result = compile(`${client.name}. ${original}`, { type: "update", itemReference: "Fleet Health Dashboard" });
    expect(result.kind).toBe("clarification");
    expect(result.commands).toEqual([]);
  });

  it("preserves requester and viewer restrictions", () => {
    for (const role of ["requester", "viewer"] as const) {
      const result = compile(`${client.name}. ${original}`, {}, { ...owner, role });
      expect(result.kind).toBe("clarification");
      expect(result.commands).toEqual([]);
    }
  });

  it("supports current/next month and year rollover as display spans", () => {
    const text = `${client.name} ${title}. Ongoing for the rest of this month and next month. Hours are awaiting client details.`;
    const result = compileInterpretation(extraction(text), text, snapshot(), owner, new Date("2026-12-20T16:00:00Z"));
    expect(result.commands[0]).toMatchObject({ item: { windowStart: "2026-12-20", windowEnd: "2027-01-31", deadline: null, allowedDates: [] } });
  });

  it.each(["deadline", "targetDate", "updateDate", "allowedDates"] as const)("does not authorize %s from project-month language", field => {
    const text = `${client.name}. ${original}`;
    const patch = field === "allowedDates" ? { allowedDates: ["2026-10-31"] } : { [field]: "2026-10-31" };
    const result = compile(text, patch);
    if (field === "deadline") expect(result.commands[0]).toMatchObject({ item: { deadline: null } });
    else expect(result.kind).toBe("clarification");
  });

  it("rejects invented span endpoints instead of silently accepting them", () => {
    for (const patch of [{ windowStart: "2026-09-01" }, { windowEnd: "2026-10-15" }])
      expect(compile(`${client.name}. ${original}`, patch).kind).toBe("clarification");
  });

  it("does not use display months to reserve sessions or invent effort", () => {
    const text = `${client.name}. ${original}`;
    expect(compile(text, { estimatedMinutes: 480 }).kind).toBe("clarification");
    expect(compile(text, { sessions: [{ start: "2026-10-01T09:00:00-04:00", end: "2026-10-01T10:00:00-04:00", protected: false, usesReserve: false }] }).kind).toBe("clarification");
  });

  it("does not turn an incidental document month into the project span", () => {
    const text = `${client.name} ${title}. Its overall project timeline is not yet known. Awaiting client approval of an invoice issued October 2026.`;
    expect(compile(text).commands[0]).toMatchObject({ item: { status: "waiting", windowStart: "2026-09-08", windowEnd: null } });
  });

  it("asks about a partial month span even when the provider omits its endpoints", () => {
    const text = `${client.name} ${title}. Project span is September through mid-October 2026. Hours are awaiting client details.`;
    expect(compile(text).kind).toBe("clarification");
    expect(compile(text).commands).toEqual([]);
  });
});
