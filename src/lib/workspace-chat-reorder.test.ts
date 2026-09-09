import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import { localDateTime, minutesBetween } from "./time";
import { newWorkItem } from "./work";
import type { WorkspaceChatReply } from "./workspace-chat";

vi.mock("server-only", () => ({}));
const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("openai", () => ({ default: class { responses = { parse }; } }));
import { compileWorkspaceChatIntent, deterministicChatAnswer, interpretWorkspaceChat, requestsReorder } from "./server/workspace-chat";

const owner = DEMO_MEMBERS[0];
const day = "2026-09-09";
const now = "2026-09-09T12:00:00Z"; // 8 AM EDT, before any fixture booking starts.
const at = (clock: string) => localDateTime(day, clock, "America/Indiana/Indianapolis");
const references = ["Tyler", "Higher Ground Tree Care", "Oral Surgery Michiana", "Pura Vida Chicas", "CIDWP"];
const numberedOrder = references.map((reference, index) => `${index + 1}. ${reference}`).join("\n");
const directRequests = [
  `I would like to move the order of the tasks.\n${numberedOrder}`,
  `Perfect. Now that you see the list, here’s the order that I want them to go for today.\n${numberedOrder}`,
  `I want:\n${numberedOrder}`,
  "I would like Tech Tyler to be first, Higher Ground Tree Care second, Oral Surgery Michiana third, Pura Vida Chicas fourth, and CIDWP last today.",
];

/** Isolated reproduction: five projects, with two separate bookings for Pura Vida. */
function fixture() {
  const state = createDemoState(now);
  state.settings.reserveMinutes = 0;
  state.blocks = [];
  state.requests = [];
  state.events = [];
  state.notifications = [];
  state.clients = [
    { id: "oral", name: "Oral Surgery Michiana", aliases: ["Oral Surgery"] },
    { id: "tree", name: "Higher Ground Tree Care", aliases: ["Higher Ground"] },
    { id: "tyler", name: "Tech Tyler", aliases: ["Tyler"] },
    { id: "cidwp", name: "CIDWP", aliases: [] },
    { id: "pura", name: "Pura Vida Chicas", aliases: ["Pura Vida"] },
  ];
  state.items = state.clients.map((client, index) => newWorkItem(owner, day, {
    id: client.id,
    clientId: client.id,
    title: ["Website edits", "Contact form repair", "WordPress header repair", "Homepage demo", "Landing page batch"][index],
    estimatedMinutes: index < 3 ? 60 : 120,
    remainingMinutes: index < 3 ? 60 : 120,
    minimumSessionMinutes: 60,
    windowEnd: "2026-12-31",
  }));
  state.sessions = [
    ["s-oral", "oral", "09:00", "10:00"],
    ["s-tree", "tree", "10:00", "11:00"],
    ["s-tyler", "tyler", "11:00", "12:00"],
    ["s-cidwp", "cidwp", "12:30", "14:30"],
    ["s-pura-1", "pura", "14:30", "15:30"],
    ["s-pura-2", "pura", "15:30", "16:30"],
  ].map(([id, workItemId, start, end]) => ({
    id, workItemId, start: at(start), end: at(end), protected: false, status: "planned" as const, usesReserve: false,
  }));
  return state;
}

function reorderIntent(text: string, patch: Record<string, unknown> = {}) {
  return {
    intent: "reorder", message: "Preview the requested order.", date: day, orderMode: "ordered",
    references, sourceQuote: text, sources: [], overrideProtected: false, edit: null, ...patch,
  };
}

function expectReorderedBookings(reply: WorkspaceChatReply, state: ReturnType<typeof fixture>) {
  expect(reply.kind, reply.message).toBe("preview");
  const proposal = reply.proposal!;
  expect(proposal.items).toEqual(state.items);
  expect(proposal.sessions.map(session => [session.id, session.workItemId, minutesBetween(session.start, session.end)]).sort())
    .toEqual(state.sessions.map(session => [session.id, session.workItemId, minutesBetween(session.start, session.end)]).sort());
  expect([...proposal.sessions].sort((a, b) => a.start.localeCompare(b.start)).map(session => [session.id, session.start, session.end]))
    .toEqual([
      ["s-tyler", at("09:00"), at("10:00")],
      ["s-tree", at("10:00"), at("11:00")],
      ["s-oral", at("11:00"), at("12:00")],
      ["s-pura-1", at("12:30"), at("13:30")],
      ["s-pura-2", at("13:30"), at("14:30")],
      ["s-cidwp", at("14:30"), at("16:30")],
    ]);
  expect(reply.dayImpacts).toEqual([{
    date: day, beforePlannedMinutes: 420, afterPlannedMinutes: 420, afterAvailableMinutes: 30, capacityMinutes: 450,
  }]);
}

beforeEach(() => {
  parse.mockReset().mockRejectedValue(new Error("Unexpected provider call in isolated reorder test"));
});
afterEach(() => vi.unstubAllEnvs());

describe("workspace reorder request regressions", () => {
  it.each(directRequests)("recognizes the owner's requested order: %s", text => {
    const state = fixture();
    const before = structuredClone(state);
    expect(requestsReorder(text)).toBe(true);
    expect(deterministicChatAnswer(text, state, day)).toBeNull();
    const result = compileWorkspaceChatIntent(reorderIntent(text), text, state, owner, day, now, "reorder-regression", []);
    expect(result.command).toEqual({
      type: "reorder_day", date: day, sessionIds: ["s-tyler", "s-tree", "s-oral", "s-pura-1", "s-pura-2", "s-cidwp"],
    });
    expectReorderedBookings(result.reply, state);
    expect(state).toEqual(before);
  });

  it.each(directRequests)("produces the same grouped preview in isolated demo mode: %s", async text => {
    const state = fixture();
    const before = structuredClone(state);
    const result = await interpretWorkspaceChat(text, state, owner, [], { date: day, now, operationId: "demo-reorder", demo: true });
    expectReorderedBookings(result.reply, state);
    expect(parse).not.toHaveBeenCalled();
    expect(state).toEqual(before);
  });

  it("routes the conversational numbered request to a mocked provider and verifies its grouped proposal", async () => {
    const state = fixture();
    const before = structuredClone(state);
    const text = directRequests[1];
    vi.stubEnv("OPENAI_API_KEY", "fake-test-key-never-sent");
    parse.mockResolvedValue({ output_parsed: reorderIntent(text), usage: { input_tokens: 100, output_tokens: 20 } });
    const result = await interpretWorkspaceChat(text, state, owner, [], { date: day, now, operationId: "mocked-reorder", demo: false });
    expect(parse).toHaveBeenCalledOnce();
    expectReorderedBookings(result.reply, state);
    expect(state).toEqual(before);
  });

  it("clarifies when one client actually names two different projects", () => {
    const state = fixture();
    state.items.find(item => item.id === "pura")!.estimatedMinutes = 60;
    state.items.find(item => item.id === "pura")!.remainingMinutes = 60;
    state.items.push(newWorkItem(owner, day, {
      id: "pura-other", clientId: "pura", title: "Separate website repair", estimatedMinutes: 60, remainingMinutes: 60,
      minimumSessionMinutes: 60, windowEnd: "2026-12-31",
    }));
    state.sessions.find(session => session.id === "s-pura-2")!.workItemId = "pura-other";
    const before = structuredClone(state);
    const text = `Reorder today's tasks:\n${numberedOrder}`;
    const result = compileWorkspaceChatIntent(reorderIntent(text), text, state, owner, day, now, "ambiguous-project", []);
    expect(result.reply.kind).toBe("clarification");
    expect(result.reply.message).toContain("more than one project");
    expect(result.command).toBeUndefined();
    expect(result.reply.proposal).toBeUndefined();
    expect(state).toEqual(before);
  });

  it("swaps one booking with a two-booking project without duplicating or losing sessions", () => {
    const state = fixture();
    const before = structuredClone(state);
    const text = "Swap CIDWP and Pura Vida Chicas today";
    const result = compileWorkspaceChatIntent(reorderIntent(text, {
      references: ["CIDWP", "Pura Vida Chicas"], orderMode: "swap",
    }), text, state, owner, day, now, "unequal-project-swap", []);
    expect(result.reply.kind, result.reply.message).toBe("preview");
    expect(result.command).toEqual({
      type: "reorder_day", date: day, sessionIds: ["s-oral", "s-tree", "s-tyler", "s-pura-1", "s-pura-2", "s-cidwp"],
    });
    const proposed = result.reply.proposal!;
    expect(proposed.items).toEqual(state.items);
    expect(proposed.sessions.map(session => [session.id, session.workItemId, minutesBetween(session.start, session.end)]).sort())
      .toEqual(state.sessions.map(session => [session.id, session.workItemId, minutesBetween(session.start, session.end)]).sort());
    expect(proposed.sessions.filter(session => ["oral", "tree", "tyler"].includes(session.workItemId)))
      .toEqual(state.sessions.filter(session => ["oral", "tree", "tyler"].includes(session.workItemId)));
    expect(proposed.sessions.filter(session => ["pura", "cidwp"].includes(session.workItemId))
      .sort((a, b) => a.start.localeCompare(b.start)).map(session => [session.id, session.start, session.end])).toEqual([
      ["s-pura-1", at("12:30"), at("13:30")],
      ["s-pura-2", at("13:30"), at("14:30")],
      ["s-cidwp", at("14:30"), at("16:30")],
    ]);
    expect(state).toEqual(before);
  });

  it("declines the whole project when one booking has started instead of moving its remaining booking", () => {
    const state = fixture();
    Object.assign(state.sessions.find(session => session.id === "s-pura-1")!, { start: at("09:00"), end: at("10:00") });
    Object.assign(state.sessions.find(session => session.id === "s-oral")!, { start: at("14:30"), end: at("15:30") });
    const before = structuredClone(state);
    const text = "Put Pura Vida Chicas first today";
    const result = compileWorkspaceChatIntent(reorderIntent(text, {
      references: ["Pura Vida Chicas"], orderMode: "first",
    }), text, state, owner, day, at("09:30"), "partly-started-project", []);
    expect(result.reply.kind).toBe("clarification");
    expect(result.reply.message).toContain("already started");
    expect(result.command).toBeUndefined();
    expect(result.reply.proposal).toBeUndefined();
    expect(state).toEqual(before);
  });

  it.each([false, true])("does not authorize a protected project move from model override=%s", overrideProtected => {
    const state = fixture();
    state.sessions.find(session => session.id === "s-pura-1")!.protected = true;
    const before = structuredClone(state);
    const text = directRequests[0];
    const result = compileWorkspaceChatIntent(reorderIntent(text, { overrideProtected }), text, state, owner, day, now, "protected-project", []);
    expect(result.reply.kind).toBe("clarification");
    expect(result.reply.message).toMatch(/protected/i);
    if (overrideProtected) {
      expect(result.command).toBeUndefined();
      expect(result.reply.proposal).toBeUndefined();
    } else {
      expect(result.command).not.toHaveProperty("overrideProtected");
      expect(result.reply.proposal?.status).toBe("infeasible");
      expect(result.reply.proposal?.sessions).toEqual(state.sessions);
    }
    expect(state).toEqual(before);
  });

  it("keeps the user's numbered order when the model scrambles references and chooses another order mode", () => {
    const state = fixture();
    const before = structuredClone(state);
    const text = directRequests[0];
    const result = compileWorkspaceChatIntent(reorderIntent(text, {
      references: [...references].reverse(), orderMode: "last",
    }), text, state, owner, day, now, "model-cannot-change-order", []);
    expect(result.command).toEqual({
      type: "reorder_day", date: day, sessionIds: ["s-tyler", "s-tree", "s-oral", "s-pura-1", "s-pura-2", "s-cidwp"],
    });
    expectReorderedBookings(result.reply, state);
    expect(state).toEqual(before);
  });

  it.each([
    numberedOrder.replace("3. Oral", "2. Oral"),
    numberedOrder.replace("3. Oral", "6. Oral"),
    numberedOrder.replace("1. Tyler", "0. Tyler"),
    numberedOrder.replace("2. Higher Ground Tree Care", "2. Tyler"),
  ])("clarifies malformed numbering or a repeated project instead of inventing a valid order: %s", list => {
    const state = fixture();
    const before = structuredClone(state);
    const text = `Reorder today's tasks:\n${list}`;
    const result = compileWorkspaceChatIntent(reorderIntent(text), text, state, owner, day, now, "malformed-numbered-order", []);
    expect(result.reply.kind).toBe("clarification");
    expect(result.reply.message).toMatch(/once|twice/);
    expect(result.command).toBeUndefined();
    expect(result.reply.proposal).toBeUndefined();
    expect(state).toEqual(before);
  });

  it("accepts an exact supporting clause when the full ordinal request supplies authority", () => {
    const state = fixture();
    const before = structuredClone(state);
    const text = directRequests[3];
    const result = compileWorkspaceChatIntent(reorderIntent(text, {
      sourceQuote: "Tech Tyler to be first",
    }), text, state, owner, day, now, "supporting-quote-clause", []);
    expectReorderedBookings(result.reply, state);
    expect(state).toEqual(before);
  });

  it("does not authorize the same supporting clause inside a hypothetical request", () => {
    const state = fixture();
    const before = structuredClone(state);
    const text = `Hypothetically, ${directRequests[3]}`;
    const result = compileWorkspaceChatIntent(reorderIntent(text, {
      sourceQuote: "Tech Tyler to be first",
    }), text, state, owner, day, now, "hypothetical-quote-clause", []);
    expect(result.reply.kind).toBe("clarification");
    expect(result.command).toBeUndefined();
    expect(result.reply.proposal).toBeUndefined();
    expect(state).toEqual(before);
  });

  it.each([
    `I do not want to reorder today's tasks:\n${numberedOrder}`,
    `What if I wanted today's tasks in this order?\n${numberedOrder}`,
    `Hypothetically, I want:\n${numberedOrder}`,
    `The client said: I want:\n${numberedOrder}`,
    `“I want:\n${numberedOrder}”`,
    `> I want:\n${numberedOrder}`,
    "Yes",
  ])("does not give provider output authority for: %s", text => {
    const state = fixture();
    const before = structuredClone(state);
    expect(requestsReorder(text)).toBe(false);
    const result = compileWorkspaceChatIntent(reorderIntent(text), text, state, owner, day, now, "unsafe-reorder", []);
    expect(result.command).toBeUndefined();
    expect(result.reply.proposal).toBeUndefined();
    expect(state).toEqual(before);
  });
});
