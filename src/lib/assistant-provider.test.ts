import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import { nextContinuation } from "./assistant-conversation";
import { assistantReservationUsd, emptyAssistantAction, interpretInput } from "./server/assistant";

const provider = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("openai", async importOriginal => {
  const actual = await importOriginal<typeof import("openai")>();
  return { ...actual, default: class { responses = { parse: provider.parse }; } };
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("Responses adapter follow-up context (mocked provider, no paid calls)", () => {
  it("passes selected dates as explicit data without adding them to source quotes or changing the model", async () => {
    vi.stubEnv("OPENAI_API_KEY", "offline-provider-test-placeholder");
    const now = new Date("2026-09-08T13:00:00Z");
    const state = { ...createDemoState(now.toISOString()), clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }], items: [], sessions: [], blocks: [] };
    const text = "Add web work for Cedar Studio: page edits, two hours.";
    const dateSelection = { start: "2026-09-09", end: "2026-09-11", kind: "work_window" as const };
    provider.parse.mockResolvedValueOnce({ output_parsed: { kind: "commands", message: "Prepared", draft: null, actions: [{ ...emptyAssistantAction("create", text), clientName: "Cedar Studio", title: "Page edits", category: "web", webKind: "edit", estimatedMinutes: 120 }] } });
    const result = await interpretInput(text, state, state.actor, { now, dateSelection });
    expect(result.commands[0]).toMatchObject({ item: { windowStart: dateSelection.start, windowEnd: dateSelection.end, estimatedMinutes: 120 } });
    expect(provider.parse).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.6-sol", store: false, input: [expect.objectContaining({ role: "developer", content: expect.stringContaining(`"selectedDates":${JSON.stringify(dateSelection)}`) }), { role: "user", content: text }] }));
  });
  it("sends retained task/date plus latest short answer and validates their combined evidence", async () => {
    vi.stubEnv("OPENAI_API_KEY", "offline-provider-test-placeholder");
    const now = new Date("2026-09-07T14:00:00Z");
    const state = createDemoState(now.toISOString());
    const text = "Add IT work for Higher Ground Tree: fix form, on 2026-09-08";
    const continuation = nextContinuation(text, { kind: "clarification", message: "How many hours?", commands: [] }, now)!;
    const evidence = `${text}\nTwo hours`;
    provider.parse.mockResolvedValueOnce({ output_parsed: { kind: "commands", message: "Prepared", actions: [{ ...emptyAssistantAction("create", evidence), clientName: "Higher Ground Tree", title: "Fix form", category: "it", estimatedMinutes: 120, windowStart: "2026-09-08", windowEnd: "2026-09-08" }], draft: null }, usage: { input_tokens: 500, output_tokens: 200 } });
    const result = await interpretInput("Two hours", state, DEMO_MEMBERS[0], { continuation, now });
    expect(result.commands[0]).toMatchObject({ type: "create", item: { clientId: "higher-ground", estimatedMinutes: 120, windowStart: "2026-09-08" } });
    expect(provider.parse).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.6-sol", store: false, input: [expect.objectContaining({ role: "developer", content: expect.stringContaining('"question":"How many hours?"') }), { role: "user", content: evidence }] }));
    expect(assistantReservationUsd("Two hours", state, continuation)).toBeGreaterThanOrEqual(assistantReservationUsd("Two hours", state));
  });
  it("does not use the assistant's question as evidence for invented user effort", async () => {
    vi.stubEnv("OPENAI_API_KEY", "offline-provider-test-placeholder");
    const now = new Date("2026-09-07T14:00:00Z");
    const text = "Add IT work for Higher Ground Tree on 2026-09-08";
    const continuation = nextContinuation(text, { kind: "clarification", message: "Will it take 4 hours?", commands: [] }, now)!;
    provider.parse.mockResolvedValueOnce({ output_parsed: { kind: "commands", message: "Prepared", actions: [{ ...emptyAssistantAction("create", "Will it take 4 hours?"), clientName: "Higher Ground Tree", title: "Fix form", category: "it", estimatedMinutes: 240 }], draft: null } });
    expect((await interpretInput("Not sure", createDemoState(now.toISOString()), DEMO_MEMBERS[0], { continuation, now })).commands).toEqual([]);
  });
  it("anchors a clarified single-day task to its work date when the provider omits its start", async () => {
    vi.stubEnv("OPENAI_API_KEY", "offline-provider-test-placeholder");
    const now = new Date("2026-09-08T14:20:00Z");
    const state = createDemoState(now.toISOString());
    state.clients.push({ id: "test-cidwp", name: "CIDWP", aliases: [] });
    const before = structuredClone(state);
    const original = "CIDWP needs a new website build. I will work on the homepage demo from start to finish on September, 9th. It should take 3 hours.";
    const reply = "The date is 2026-09-09. Allow 3 hours total for the CIDWP homepage demo only. The rest of the website will be scheduled later, after approval.";
    const continuation = nextContinuation(original, { kind: "clarification", message: "Please confirm the dates using YYYY-MM-DD.", commands: [] }, now)!;
    const evidence = `${original}\n${reply}`;
    provider.parse.mockResolvedValueOnce({ output_parsed: { kind: "commands", message: "Prepared", actions: [{
      ...emptyAssistantAction("create", evidence), clientName: "CIDWP", title: "Homepage demo", category: "web", webKind: "build",
      estimatedMinutes: 180, targetDate: "2026-09-09", deadline: "2026-09-09", allowedDates: ["2026-09-09"],
    }], draft: null } });
    const result = await interpretInput(reply, state, DEMO_MEMBERS[0], { continuation, now });
    expect(result.kind).toBe("commands");
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({ type: "create", item: {
      clientId: "test-cidwp", title: "Homepage demo", estimatedMinutes: 180,
      windowStart: "2026-09-09", targetDate: "2026-09-09", deadline: null, allowedDates: [],
    } });
    expect(state).toEqual(before);
    expect(provider.parse).toHaveBeenCalledTimes(1);
  });
});
