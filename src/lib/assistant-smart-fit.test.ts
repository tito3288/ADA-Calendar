import { describe, expect, it } from "vitest";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { compileInterpretation, emptyAssistantAction, interpretInput, type AssistantAction } from "./server/assistant";
import { nextContinuation } from "./assistant-conversation";
import { planCommands, validateSchedule } from "./scheduler";
import { commandSchema } from "./schemas";
import { localDate } from "./time";
import { newWorkItem } from "./work";
import type { Actor, ScheduleSnapshot } from "./types";

// Fictional offline fixture. No model calls, persistence, or outgoing messages.
const now = new Date("2026-09-09T12:00:00Z");
const owner: Actor = { id: "fit-owner", name: "Test owner", email: "owner@example.test", role: "owner" };
const client = { id: "cedar-fit", name: "Cedar Studio", aliases: [] };
const title = "Oil survey connector";
function snapshot(): ScheduleSnapshot {
  const item = newWorkItem(owner, "2026-09-08", { id: "fit-oil", title, clientId: client.id, category: "software", estimatedMinutes: null, remainingMinutes: null, status: "waiting", blockedReason: "Awaiting client input", windowEnd: "2026-10-31", minimumSessionMinutes: 120 });
  const other = newWorkItem(owner, "2026-09-09", { id: "fit-other", title: "Existing commitment", clientId: client.id, estimatedMinutes: 180, remainingMinutes: 180 });
  return { workspaceId: "fictional-fit", version: 0, settings: { ...structuredClone(DEFAULT_SETTINGS), reserveMinutes: 0 }, priorities: structuredClone(DEFAULT_PRIORITIES), clients: [client], items: [item, other],
    sessions: [{ id: "existing-morning", workItemId: other.id, start: "2026-09-09T09:00:00-04:00", end: "2026-09-09T12:00:00-04:00", status: "planned", protected: true, usesReserve: false }], blocks: [] };
}
function interpret(text = `Find time for 2 hours today for ${title}.`, patch: Partial<AssistantAction> = {}, actor = owner, selection?: { start: string; end: string; kind: "work_window" }, reply = text) {
  return compileInterpretation({ kind: "commands", message: "Find an open time", draft: null, actions: [{ ...emptyAssistantAction("fit", text), itemReference: title, estimatedMinutes: 120, ...patch }] }, text, snapshot(), actor, now, reply, [], selection);
}

describe("grounded Ask ADA find-time requests", () => {
  it("supports the user's client-update phrasing and a no-moving safety instruction", async () => {
    const text = `I got information from Cedar Studio today. Find a time for me for 2 hours today on ${title}. Don't move other bookings.`;
    expect(interpret(text).commands[0]).toMatchObject({ type: "fit", request: { minutes: 120, startDate: "2026-09-09" } });
    const demo = await interpretInput(text, snapshot(), owner, { demo: true, now });
    expect(demo.kind, demo.message).toBe("commands");
    expect(demo.commands[0]).toMatchObject({ type: "fit", request: { minutes: 120 } });
  });

  it("supports find-time via the isolated demo route and a retained try-tomorrow reply", async () => {
    const text = `Find time for 2 hours today for ${title}.`;
    const pending = nextContinuation(text, { kind: "clarification", commands: [], message: "Today is full. Choose another day." }, now)!;
    const result = await interpretInput("Try tomorrow instead.", snapshot(), owner, { demo: true, now, continuation: pending });
    expect(result.kind, result.message).toBe("commands");
    expect(result.commands[0]).toMatchObject({ type: "fit", request: { startDate: "2026-09-10", endDate: "2026-09-10", minutes: 120 } });
  });
  it("finds two hours today, resumes the waiting project, and preserves its unknown total, span and all bookings", () => {
    const state = snapshot();
    const result = interpret();
    expect(result.kind, result.message).toBe("commands");
    expect(result.commands).toEqual([{ type: "fit", itemId: "fit-oil", request: { startDate: "2026-09-09", endDate: "2026-09-09", minutes: 120, distribution: "total", resumeWaiting: true } }]);
    expect(commandSchema.safeParse(result.commands[0]).success).toBe(true);
    const proposal = planCommands(state, result.commands, owner, { now: now.toISOString() });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions.find(session => session.id === "existing-morning")).toEqual(state.sessions[0]);
    expect(proposal.items.find(item => item.id === "fit-oil")).toMatchObject({ estimatedMinutes: null, remainingMinutes: null, windowEnd: "2026-10-31", status: "planned", forecastDate: null });
    const added = proposal.sessions.filter(session => session.workItemId === "fit-oil");
    expect(added.reduce((sum, session) => sum + (Date.parse(session.end) - Date.parse(session.start)) / 60000, 0)).toBe(120);
    expect(added.every(session => Date.parse(session.start) >= Date.parse("2026-09-09T12:30:00-04:00"))).toBe(true);
    expect(validateSchedule({ ...state, items: proposal.items, sessions: proposal.sessions }, now.toISOString())).toEqual([]);
  });

  it.each(["fit", "schedule", "update"] as const)("turns %s extraction into an append-only request and ignores invented estimates and slots", type => {
    const result = interpret(`Add two hours tomorrow for ${title}.`, { type, estimatedMinutes: 999, remainingMinutes: 999, sessions: [{ start: "invented", end: "invented", protected: true, usesReserve: true }] });
    expect(result.kind, result.message).toBe("commands");
    expect(result.commands[0]).toMatchObject({ type: "fit", request: { startDate: "2026-09-10", endDate: "2026-09-10", minutes: 120 } });
    expect(result.commands).toHaveLength(1);
  });

  it("uses selected dates with no repetition and distinguishes total from each day", () => {
    const selection = { start: "2026-09-14", end: "2026-09-18", kind: "work_window" as const };
    for (const [words, distribution] of [["two hours total", "total"], ["two hours each selected day", "per_day"]]) {
      const result = interpret(`Find time for ${words} for ${title}.`, {}, owner, selection);
      expect(result.kind, result.message).toBe("commands");
      expect(result.commands[0]).toMatchObject({ type: "fit", request: { startDate: selection.start, endDate: selection.end, minutes: 120, distribution } });
    }
  });

  it("continues try tomorrow with the same project and hours, rejecting stale proposed dates", () => {
    const original = `Find time for 2 hours today for ${title}.`;
    const reply = "Try tomorrow instead.";
    const text = `${original}\n${reply}`;
    expect(interpret(text, {}, owner, undefined, reply).commands[0]).toMatchObject({ request: { startDate: "2026-09-10", endDate: "2026-09-10", minutes: 120 } });
    expect(interpret(text, { windowStart: "2026-09-09", windowEnd: "2026-09-09" }, owner, undefined, reply).kind).toBe("clarification");
    const fewer = "One hour";
    expect(interpret(`${original}\n${fewer}`, {}, owner, undefined, fewer).commands[0]).toMatchObject({ request: { startDate: "2026-09-09", minutes: 60 } });
  });

  it.each([
    `Find time today for ${title}.`,
    `Find time for 2 hours for ${title}.`,
    `Find time for 2 or 3 hours today for ${title}.`,
    `Find time for 17 minutes today for ${title}.`,
    `Don't find time for 2 hours today for ${title}.`,
    `A client said find time for 2 hours today for ${title}.`,
    `Find time for 2 hours today for ${title}, but keep it waiting.`,
  ])("clarifies missing/ambiguous/unauthorized details: %s", text => {
    const result = interpret(text);
    expect(result.kind, result.message).toBe("clarification");
    expect(result.commands).toEqual([]);
  });

  it("does not invent a referenced project, date, or requester authority", () => {
    expect(interpret(undefined, { itemReference: "Something else" }).kind).toBe("clarification");
    expect(interpret(undefined, { windowStart: "2026-09-11", windowEnd: "2026-09-11" }).kind).toBe("clarification");
    expect(interpret(undefined, {}, { ...owner, role: "requester" }).kind).toBe("clarification");
    expect(interpret(undefined, {}, owner, { start: "2026-09-14", end: "2026-09-18", kind: "work_window" }).kind).toBe("clarification");
  });

  it.each([owner, { ...owner, role: "requester" as const }])("uses bounded clean-fit for new work from $role", actor => {
    const text = `Create web work for ${client.name}: Contact page. Find time for 2 hours tomorrow.`;
    const result = interpret(text, { type: "create", clientName: client.name, itemReference: null, title: "Contact page", category: "web", webKind: "edit" }, actor);
    expect(result.kind, result.message).toBe("commands");
    expect(result.commands[0]).toMatchObject({ type: "create", smartFit: { startDate: "2026-09-10", endDate: "2026-09-10", minutes: 120, distribution: "total" } });
    const proposal = planCommands(snapshot(), result.commands, actor, { now: now.toISOString() });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions.filter(session => session.id !== "existing-morning").every(session => localDate(session.start, DEFAULT_SETTINGS.timeZone) === "2026-09-10")).toBe(true);
  });

  it("can create an unknown-total project with only a smartly placed first session", () => {
    const text = `Create software work for ${client.name}: New connector. The total effort is unknown. Find time for 2 hours tomorrow.`;
    const result = interpret(text, { type: "create", clientName: client.name, itemReference: null, title: "New connector", category: "software", estimatedMinutes: null });
    expect(result.kind, result.message).toBe("commands");
    expect(result.commands[0]).toMatchObject({ type: "create", item: { estimatedMinutes: null, remainingMinutes: null, status: "planned" }, smartFit: { minutes: 120 } });
  });

  it("keeps explicit times on the manual scheduling path", () => {
    const text = `Book two hours for ${title} tomorrow from 9am–11am.`;
    const result = interpret(text, { type: "schedule", sessions: [{ start: "2026-09-10T09:00:00-04:00", end: "2026-09-10T11:00:00-04:00", protected: false, usesReserve: false }] });
    expect(result.commands[0]).toMatchObject({ type: "schedule" });
    expect(interpret(text, { type: "fit", sessions: [] }).kind).toBe("clarification");
    expect(interpret(`Find time for 2 hours today for ${title} after 3pm.`).kind).toBe("clarification");
  });
});
