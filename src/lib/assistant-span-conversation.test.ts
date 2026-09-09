import { afterEach, describe, expect, it, vi } from "vitest";
import { nextContinuation, type AssistantContinuation } from "./assistant-conversation";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { dayCapacity, planCommands, validateSchedule } from "./scheduler";
import { compileInterpretation, emptyAssistantAction, interpretInput, type AssistantAction } from "./server/assistant";
import { newWorkItem } from "./work";
import type { Actor, Interpretation, ScheduleSnapshot } from "./types";

const provider = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("openai", async importOriginal => {
  const actual = await importOriginal<typeof import("openai")>();
  return { ...actual, default: class { responses = { parse: provider.parse }; } };
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

// Fictional private conversations and workload only. Provider responses are
// captured in the test; no live model, persistence, or notification calls occur.
const now = new Date("2026-09-09T16:00:00Z");
const owner: Actor = { id: "span-owner", name: "Test owner", email: "owner@example.test", role: "owner" };
const client = { id: "span-client", name: "Cedar Lantern Studio", aliases: ["Cedar Lantern"] };
const otherClient = { id: "other-span-client", name: "Juniper Sample Works", aliases: [] };
const title = "Website edits";
const original = `For ${client.name}, I have to complete website edits for the sample storefront. Unknown hours. Can you book the rest of this month and next month and I will be adding hours to specific days in the future?`;
const malformedOriginal = `For ${client.name}, add website edits. Unknown hours. The project timeline runs September through mid-October.`;
const oldQuestion: Interpretation = { kind: "clarification", message: "What start and end dates should the project span show? I won't guess a partial or conflicting month range, or reserve any hours.", commands: [] };

function snapshot(): ScheduleSnapshot {
  const existing = newWorkItem(owner, "2026-09-10", {
    id: "existing-inventory-project", clientId: client.id, title: "Inventory dashboard", category: "software", webKind: null,
    status: "planned", estimatedMinutes: 120, remainingMinutes: 120, windowEnd: "2026-09-10", allowedDates: ["2026-09-10"],
  });
  return {
    workspaceId: "fictional-span-conversation", version: 0,
    settings: { ...structuredClone(DEFAULT_SETTINGS), reserveMinutes: 0 }, priorities: structuredClone(DEFAULT_PRIORITIES),
    clients: [client, otherClient], items: [existing], blocks: [],
    sessions: [{ id: "existing-inventory-session", workItemId: existing.id, start: "2026-09-10T09:00:00-04:00", end: "2026-09-10T11:00:00-04:00", status: "planned", protected: true, usesReserve: false }],
  };
}

function extraction(quote: string, patch: Partial<AssistantAction> = {}) {
  return { kind: "commands", message: "Prepared the waiting project.", draft: null, actions: [{
    ...emptyAssistantAction("create", quote), clientName: client.name, title, category: "web", webKind: "edit", ...patch,
  }] };
}

function pending(prior = malformedOriginal, previousReplies: string[] = []): AssistantContinuation {
  let continuation = nextContinuation(prior, oldQuestion, now)!;
  // Reconstruct private unfinished history written before this regression was
  // fixed, including an already answered question that ADA repeated.
  for (const reply of previousReplies) continuation = nextContinuation(reply, oldQuestion, now, continuation)!;
  return continuation;
}

function assertWaitingSpan(result: Interpretation, state: ScheduleSnapshot, start: string, end: string) {
  const before = structuredClone(state);
  expect(result.kind, result.message).toBe("commands");
  expect(result.commands).toHaveLength(1);
  expect(result.commands[0]).toMatchObject({ type: "create", item: {
    title, clientId: client.id, status: "waiting", estimatedMinutes: null, remainingMinutes: null,
    windowStart: start, windowEnd: end, targetDate: null, deadline: null, updateDate: null, forecastDate: null, allowedDates: [],
  } });
  const command = result.commands[0];
  expect(command.type).toBe("create");
  if (command.type === "create") expect(command.sessions ?? []).toEqual([]);
  const proposal = planCommands(state, result.commands, owner, { now: now.toISOString() });
  expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
  expect(proposal.items).toHaveLength(2);
  expect(proposal.items[0]).toEqual(state.items[0]);
  expect(proposal.sessions).toEqual(state.sessions);
  expect(proposal.blocks).toEqual(state.blocks);
  const after = { ...state, items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks };
  expect(dayCapacity(after, "2026-09-10").plannedMinutes).toBe(120);
  expect(dayCapacity(after, "2026-10-01").plannedMinutes).toBe(0);
  expect(after.settings.reserveMinutes).toBe(0);
  expect(validateSchedule(after, now.toISOString())).toEqual([]);
  expect(state).toEqual(before);
}

describe("plain-language project spans through private clarification replies (offline)", () => {
  it("understands a long narrative with relative months, trailing prose, and unknown hours", async () => {
    vi.stubEnv("OPENAI_API_KEY", "offline-span-test-placeholder");
    const state = snapshot();
    provider.parse.mockResolvedValueOnce({ output_parsed: extraction(original) });
    const result = await interpretInput(original, state, owner, { now });
    assertWaitingSpan(result, state, "2026-09-09", "2026-10-31");
    expect(provider.parse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      model: "gpt-5.6-sol", store: false, reasoning: { effort: "medium" },
      input: [expect.any(Object), { role: "user", content: original }],
    }));
  });

  for (const quoteMode of ["latest reply", "all user turns"] as const) {
    it.each([
      ["Add it as waiting from today until the end of next month", "2026-09-09", "2026-10-31"],
      ["Add it from today 2026-09-09 to the end of October 31st", "2026-09-09", "2026-10-31"],
      ["From tomorrow through the end of October.", "2026-09-10", "2026-10-31"],
      ["Show it from September 15th through November 30th.", "2026-09-15", "2026-11-30"],
    ])(`resolves a repeated old question using %s when the provider quotes ${quoteMode}`, async (reply, start, end) => {
      vi.stubEnv("OPENAI_API_KEY", "offline-span-test-placeholder");
      const state = snapshot();
      const continuation = pending(malformedOriginal, ["Add it as waiting from today until the end of next month"]);
      const combined = [...continuation.turns.map(turn => turn.userText), reply].join("\n");
      provider.parse.mockResolvedValueOnce({ output_parsed: extraction(quoteMode === "latest reply" ? reply : combined, { windowStart: start, windowEnd: end }) });
      const result = await interpretInput(reply, state, owner, { now, continuation });
      assertWaitingSpan(result, state, start, end);
      expect(provider.parse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        model: "gpt-5.6-sol", input: [expect.objectContaining({ content: expect.stringContaining("latestReply") }), { role: "user", content: combined }],
      }));
      expect(combined).not.toContain(oldQuestion.message);
    });
  }

  it.each([
    ["From today until the end of next month.", "2026-09-09", "2026-10-31"],
    ["From 2026-09-09 through October 31st.", "2026-09-09", "2026-10-31"],
    ["From September 15th to the end of November.", "2026-09-15", "2026-11-30"],
  ])("uses the corrected display range when extraction omits both endpoints: %s", (reply, start, end) => {
    const state = snapshot();
    const combined = `${malformedOriginal}\n${reply}`;
    const result = compileInterpretation(extraction(reply), combined, state, owner, now, reply);
    assertWaitingSpan(result, state, start, end);
  });

  it("retains a resolved date correction through a subsequent identity-only reply", async () => {
    vi.stubEnv("OPENAI_API_KEY", "offline-span-test-placeholder");
    const correction = "Add it as waiting from today until the end of next month";
    const continuation = pending(malformedOriginal, [correction]);
    const reply = `${client.name} ${title}`;
    provider.parse.mockResolvedValueOnce({ output_parsed: extraction(reply) });
    const state = snapshot();
    const result = await interpretInput(reply, state, owner, { now, continuation });
    assertWaitingSpan(result, state, "2026-09-09", "2026-10-31");
  });

  it("uses the newest clear correction even when earlier turns contain valid but superseded endpoints", () => {
    const prior = `${client.name}: website edits, unknown hours. Project timeline from 2026-09-09 through 2026-10-31.`;
    const reply = "Actually, show it from October 1st through the end of November instead.";
    const state = snapshot();
    const combined = `${prior}\n${reply}`;
    const result = compileInterpretation(extraction(combined, { windowStart: "2026-10-01", windowEnd: "2026-11-30" }), combined, state, owner, now, reply);
    assertWaitingSpan(result, state, "2026-10-01", "2026-11-30");
  });

  it("replaces stale extracted endpoints with the newest clear display correction", () => {
    const prior = `${client.name}: website edits, unknown hours. Project timeline from 2026-09-09 through 2026-10-31.`;
    const reply = "Actually, show it from October 1st through the end of November instead.";
    const combined = `${prior}\n${reply}`;
    const state = snapshot();
    const result = compileInterpretation(extraction(combined, { windowStart: "2026-09-09", windowEnd: "2026-10-31" }), combined, state, owner, now, reply);
    assertWaitingSpan(result, state, "2026-10-01", "2026-11-30");
  });

  it.each(["requester", "viewer"] as const)("does not grant unknown-effort creation to a %s through a date reply", role => {
    const reply = "Add it as waiting from today until the end of next month";
    const state = snapshot();
    const before = structuredClone(state);
    const combined = `${malformedOriginal}\n${reply}`;
    const result = compileInterpretation(extraction(combined, { windowStart: "2026-09-09", windowEnd: "2026-10-31" }), combined, state, { ...owner, role }, now, reply);
    expect(result.kind).toBe("clarification");
    expect(result.commands).toEqual([]);
    expect(state).toEqual(before);
  });

  it("cannot borrow another client's unknown-effort narrative for a short date reply", () => {
    const prior = malformedOriginal.replace(client.name, otherClient.name);
    const reply = `For ${client.name}, from today through the end of next month.`;
    const result = compileInterpretation(extraction(reply, { windowStart: "2026-09-09", windowEnd: "2026-10-31" }), `${prior}\n${reply}`, snapshot(), owner, now, reply);
    expect(result.kind).toBe("clarification");
    expect(result.commands).toEqual([]);
  });

  it("does not apply a date-only continuation to a different project title", () => {
    const reply = "From today through the end of next month.";
    const result = compileInterpretation(extraction(reply, { title: "Inventory dashboard", windowStart: "2026-09-09", windowEnd: "2026-10-31" }), `${malformedOriginal}\n${reply}`, snapshot(), owner, now, reply);
    expect(result.kind).toBe("clarification");
    expect(result.commands).toEqual([]);
  });

  it("does not treat a named second project as a continuation of the pending project", async () => {
    vi.stubEnv("OPENAI_API_KEY", "offline-span-test-placeholder");
    await expect(interpretInput(`Add a new inventory dashboard for ${otherClient.name} from today through the end of next month.`, snapshot(), owner, { now, continuation: pending() })).rejects.toThrow(/new task/i);
    expect(provider.parse).not.toHaveBeenCalled();
  });

  it.each([
    "The client wrote: ‘Show it from today until the end of next month.’",
    'Their note says: "From 2026-09-09 through October 31st."',
    "From today until mid-October.",
    "From today until October 31st or November 30th.",
    "From today until February 30th, 2027.",
    "From November 30th, 2026 until October 1st, 2026.",
  ])("keeps an unsupported or quoted correction from resolving the pending date question: %s", reply => {
    const state = snapshot();
    const before = structuredClone(state);
    const combined = `${malformedOriginal}\n${reply}`;
    const result = compileInterpretation(extraction(combined, { windowStart: "2026-09-09", windowEnd: "2026-10-31" }), combined, state, owner, now, reply);
    expect(result.kind, result.message).toBe("clarification");
    expect(result.commands).toEqual([]);
    expect(state).toEqual(before);
  });

  it.each(["deadline", "targetDate", "updateDate", "allowedDates"] as const)("does not use a relative display range as %s authority", field => {
    const reply = "Add it as waiting from today until the end of next month";
    const combined = `${malformedOriginal}\n${reply}`;
    const patch = field === "allowedDates" ? { allowedDates: ["2026-10-31"] } : { [field]: "2026-10-31" };
    const result = compileInterpretation(extraction(combined, { windowStart: "2026-09-09", windowEnd: "2026-10-31", ...patch }), combined, snapshot(), owner, now, reply);
    if (field === "deadline") expect(result.commands[0]).toMatchObject({ item: { deadline: null } });
    else { expect(result.kind).toBe("clarification"); expect(result.commands).toEqual([]); }
  });

  it("does not invent effort or sessions while recovering a waiting project and its corrected dates", () => {
    const reply = "Add it as waiting from today until the end of next month";
    const combined = `${malformedOriginal}\n${reply}`;
    for (const patch of [
      { estimatedMinutes: 120 },
      { sessions: [{ start: "2026-10-01T09:00:00-04:00", end: "2026-10-01T11:00:00-04:00", protected: false, usesReserve: false }] },
    ]) {
      const result = compileInterpretation(extraction(combined, { windowStart: "2026-09-09", windowEnd: "2026-10-31", ...patch }), combined, snapshot(), owner, now, reply);
      expect(result.kind).toBe("clarification");
      expect(result.commands).toEqual([]);
    }
  });

  it.each([
    `${otherClient.name} project runs from October 1st through November 30th.`,
    "The inventory dashboard project runs from October 1st through November 30th.",
  ])("does not replace the pending project's dates with a different project's narrative: %s", reply => {
    const state = snapshot();
    const before = structuredClone(state);
    // The provider still targets and quotes the original project. A broad
    // latest-reply fallback must not supply dates from another project to it.
    const result = compileInterpretation(extraction(malformedOriginal), `${malformedOriginal}\n${reply}`, state, owner, now, reply);
    expect(result.kind, result.message).toBe("clarification");
    expect(result.commands).toEqual([]);
    expect(state).toEqual(before);
  });

  it.each([
    "Should the project run from today through the end of next month?",
    "Could the project run from today through the end of next month?",
    "Should I show it from today through the end of next month?",
    "If the project runs from today through the end of next month, what changes?",
    "The client says show it from today until the end of next month.",
    "‘Show it from today until the end of next month.’",
    "'Show it from today until the end of next month.'",
  ])("does not use a hypothetical or quoted correction to authorize the pending create: %s", reply => {
    const state = snapshot();
    const before = structuredClone(state);
    const result = compileInterpretation(extraction(malformedOriginal), `${malformedOriginal}\n${reply}`, state, owner, now, reply);
    expect(result.kind, result.message).toBe("clarification");
    expect(result.commands).toEqual([]);
    expect(state).toEqual(before);
  });

  it.each([
    `Add web work for ${client.name}: website edits, 2 hours tomorrow from 9am to 11am.`,
    `Add web work for ${client.name}: website edits, 2 hours on 2026-09-10 from 9am to 11am.`,
    `${client.name} website edits, 2 hours. Book it tomorrow from 9am to 11am.`,
  ])("keeps an explicit single-day clock booking out of project-span clarification: %s", text => {
    const state = snapshot();
    // Make the intended morning available while retaining unrelated saved work.
    state.sessions[0].start = "2026-09-10T14:00:00-04:00";
    state.sessions[0].end = "2026-09-10T16:00:00-04:00";
    const before = structuredClone(state);
    const sessions = [{ start: "2026-09-10T09:00:00-04:00", end: "2026-09-10T11:00:00-04:00", protected: false, usesReserve: false }];
    const result = compileInterpretation(extraction(text, { estimatedMinutes: 120, windowStart: "2026-09-10", windowEnd: "2026-09-10", sessions }), text, state, owner, now);
    expect(result.kind, result.message).toBe("commands");
    expect(result.commands[0]).toMatchObject({ type: "create", item: { status: "planned", estimatedMinutes: 120, windowStart: "2026-09-10", windowEnd: "2026-09-10" }, sessions });
    const proposal = planCommands(state, result.commands, owner, { now: now.toISOString() });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.items[0]).toEqual(state.items[0]);
    expect(proposal.sessions).toHaveLength(2);
    expect(proposal.sessions.find(session => session.id === state.sessions[0].id)).toEqual(state.sessions[0]);
    expect(dayCapacity({ ...state, items: proposal.items, sessions: proposal.sessions }, "2026-09-10").plannedMinutes).toBe(240);
    expect(state).toEqual(before);
  });

  it.each(["deadline", "targetDate", "updateDate", "allowedDates"] as const)("does not reuse a named display endpoint as invented %s authority", field => {
    const reply = "Show it from September 15th through November 30th.";
    const combined = `${malformedOriginal}\n${reply}`;
    const patch = field === "allowedDates" ? { allowedDates: ["2026-11-30"] } : { [field]: "2026-11-30" };
    const result = compileInterpretation(extraction(combined, { windowStart: "2026-09-15", windowEnd: "2026-11-30", ...patch }), combined, snapshot(), owner, now, reply);
    if (field === "deadline") expect(result.commands[0]).toMatchObject({ item: { deadline: null } });
    else { expect(result.kind).toBe("clarification"); expect(result.commands).toEqual([]); }
  });

  it("preserves separately stated deadline and session dates beside a display timeline", () => {
    const text = `${client.name} needs website edits. Unknown hours. Show the project timeline from September 15th through November 30th. The firm deadline is November 30th. Reserve two hours on September 18th from 9am to 11am.`;
    const state = snapshot();
    const before = structuredClone(state);
    const sessions = [{ start: "2026-09-18T09:00:00-04:00", end: "2026-09-18T11:00:00-04:00", protected: false, usesReserve: false }];
    const result = compileInterpretation(extraction(text, { windowStart: "2026-09-15", windowEnd: "2026-11-30", deadline: "2026-11-30", sessions }), text, state, owner, now);
    expect(result.kind, result.message).toBe("commands");
    expect(result.commands[0]).toMatchObject({ type: "create", item: {
      status: "planned", estimatedMinutes: null, remainingMinutes: null,
      windowStart: "2026-09-15", windowEnd: "2026-11-30", deadline: "2026-11-30",
    }, sessions });
    const proposal = planCommands(state, result.commands, owner, { now: now.toISOString() });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.items[0]).toEqual(state.items[0]);
    expect(proposal.sessions).toHaveLength(2);
    expect(proposal.sessions.find(session => session.id === state.sessions[0].id)).toEqual(state.sessions[0]);
    expect(dayCapacity({ ...state, items: proposal.items, sessions: proposal.sessions }, "2026-09-18").plannedMinutes).toBe(120);
    expect(state).toEqual(before);
  });

  it.each([
    "Could the project run from today through the end of next month?",
    "‘Show it from today until the end of next month.’",
    "Show it from today until mid-October.",
  ])("accepts a later direct correction after an earlier rejected date reply: %s", async earlierReply => {
    vi.stubEnv("OPENAI_API_KEY", "offline-span-test-placeholder");
    const continuation = pending(malformedOriginal, [earlierReply]);
    const reply = "Show it from today until the end of next month.";
    const state = snapshot();
    provider.parse.mockResolvedValueOnce({ output_parsed: extraction(reply) });
    const result = await interpretInput(reply, state, owner, { now, continuation });
    assertWaitingSpan(result, state, "2026-09-09", "2026-10-31");
  });

  it.each([
    `For ${client.name}, show the ${title} project from today through the end of next month.`,
    `For ${client.aliases[0]}, show the ${title} project from today through the end of next month.`,
    "The project runs from today through the end of next month.",
    "The project spans today through the end of next month.",
    "Show it from today through the end of next month and I will add hours later.",
    "Show it from today through the end of next month and as I get updates I will add hours later.",
  ])("accepts a clear same-project date statement without requiring a pronoun-only reply: %s", reply => {
    const state = snapshot();
    const combined = `${malformedOriginal}\n${reply}`;
    const result = compileInterpretation(extraction(reply), combined, state, owner, now, reply);
    assertWaitingSpan(result, state, "2026-09-09", "2026-10-31");
  });

  it.each([
    "From today until the end of next month.",
    "From September 15th through November 30th.",
    "From 2026-09-15 through 2026-11-30.",
    "Add it as waiting from today until the end of next month.",
  ])("clarifies a spoken display range that conflicts with selected project dates: %s", reply => {
    const prior = `${client.name} needs website edits. Unknown hours.`;
    const combined = `${prior}\n${reply}`;
    const selection = { kind: "project_span" as const, start: "2026-09-09", end: "2026-09-30" };
    const state = snapshot();
    const before = structuredClone(state);
    // Omitted extraction endpoints must not hide a conflict with spoken dates.
    const result = compileInterpretation(extraction(combined), combined, state, owner, now, reply, [], selection);
    expect(result.kind, result.message).toBe("clarification");
    expect(result.message).toMatch(/conflict.*selected dates/i);
    expect(result.commands).toEqual([]);
    expect(state).toEqual(before);
  });

  it("accepts a field-only spoken range that agrees with selected project dates", () => {
    const prior = `${client.name} needs website edits. Unknown hours.`;
    const reply = "From today until the end of next month.";
    const combined = `${prior}\n${reply}`;
    const selection = { kind: "project_span" as const, start: "2026-09-09", end: "2026-10-31" };
    const state = snapshot();
    const result = compileInterpretation(extraction(combined), combined, state, owner, now, reply, [], selection);
    assertWaitingSpan(result, state, selection.start, selection.end);
  });

  it("uses selected project dates after explicit acceptance replaces a conflicting spoken range", () => {
    const prior = `${client.name} needs website edits. Unknown hours.`;
    const earlierReply = "From today until the end of next month.";
    const reply = "Use the selected dates";
    const combined = `${prior}\n${earlierReply}\n${reply}`;
    const selection = { kind: "project_span" as const, start: "2026-09-09", end: "2026-09-30" };
    const state = snapshot();
    const result = compileInterpretation(extraction(combined), combined, state, owner, now, reply, [earlierReply], selection);
    assertWaitingSpan(result, state, selection.start, selection.end);
  });
});
