import { describe, expect, it } from "vitest";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { planCommands } from "./scheduler";
import { compileInterpretation, emptyAssistantAction, interpretDemoInput, type AssistantAction } from "./server/assistant";
import type { Actor, Category, ScheduleSnapshot } from "./types";

const now = new Date("2026-09-09T12:00:00Z");
const owner: Actor = { id: "test-owner", name: "Test owner", email: "owner@example.test", role: "owner" };
const requester: Actor = { ...owner, id: "test-requester", role: "requester" };
const text = "Add IT work for Cedar Studio: repair printer, 2 hours on 2026-09-11.";

// Isolated fictional workspace; compiler and scheduler calls never save or send.
function snapshot(): ScheduleSnapshot {
  return { workspaceId: "test-priority", version: 0, settings: { ...DEFAULT_SETTINGS, reserveMinutes: 0 },
    priorities: structuredClone(DEFAULT_PRIORITIES), clients: [{ id: "test-cedar", name: "Cedar Studio", aliases: [] }],
    items: [], sessions: [], blocks: [] };
}
function output(source: string, patch: Partial<AssistantAction> = {}) {
  return { kind: "commands", message: "Prepared", draft: null, actions: [{
    ...emptyAssistantAction("create", source), clientName: "Cedar Studio", title: "Repair printer", category: "it",
    estimatedMinutes: 120, windowStart: "2026-09-11", windowEnd: "2026-09-11", ...patch,
  }] };
}

describe("assistant defaults for new IT work", () => {
  it.each([null, "Normal"])("uses Urgent when priority is unstated even if the provider supplies %s", priorityLabel => {
    const state = snapshot();
    const before = structuredClone(state);
    const compiled = compileInterpretation(output(text, { priorityLabel }), text, state, owner, now);
    expect(compiled.commands).toHaveLength(1);
    expect(compiled.commands[0]).toMatchObject({ type: "create", item: { priorityId: "urgent", requestedPriorityId: null },
      smartFit: { startDate: "2026-09-11", endDate: "2026-09-11", minutes: 120 } });
    expect(compiled.commands[0]).not.toHaveProperty("urgent", true);
    expect(compiled.commands[0]).not.toHaveProperty("overrideProtected", true);
    const proposal = planCommands(state, compiled.commands, owner, { now: now.toISOString() });
    expect(proposal.status).toBe("ready");
    expect(proposal.items[0].priorityId).toBe("urgent");
    expect(proposal.sessions.every(session => !session.usesReserve && !session.protected)).toBe(true);
    expect(state).toEqual(before);
  });

  it.each(["Normal", "High", "Low"])("keeps an explicit %s priority", priorityLabel => {
    const source = `${text} Use ${priorityLabel} priority.`;
    const compiled = compileInterpretation(output(source, { priorityLabel }), source, snapshot(), owner, now);
    expect(compiled.commands[0]).toMatchObject({ item: { priorityId: priorityLabel.toLowerCase() } });
  });

  it.each([
    ["Restore normal service", "Normal"],
    ["Investigate high CPU usage", "High"],
    ["Fix low disk space", "Low"],
  ])("does not mistake task wording '%s' for an explicit priority", (description, priorityLabel) => {
    const source = text.replace("repair printer", description);
    const compiled = compileInterpretation(output(source, { priorityLabel, title: description }), source, snapshot(), owner, now);
    expect(compiled.commands[0]).toMatchObject({ item: { priorityId: "urgent" } });
  });

  it("does not use a client's name as a priority choice", () => {
    const state = snapshot();
    state.clients[0].name = "Low Tire";
    const source = text.replace("Cedar Studio", "Low Tire");
    const compiled = compileInterpretation(output(source, { clientName: "Low Tire", priorityLabel: "Low" }), source, state, owner, now);
    expect(compiled.commands[0]).toMatchObject({ item: { priorityId: "urgent" } });
  });

  it.each(["Priority is Normal.", "Set it to Normal.", "Use Normal.", "\nNormal"])("accepts an explicit priority selection: %s", choice => {
    const source = `${text} ${choice}`;
    const compiled = compileInterpretation(output(source, { priorityLabel: "Normal" }), source, snapshot(), owner, now);
    expect(compiled.commands[0]).toMatchObject({ item: { priorityId: "normal" } });
  });

  it("does not honor a negated priority assignment", () => {
    const source = `${text} Do not set it to Normal.`;
    const compiled = compileInterpretation(output(source, { priorityLabel: "Normal" }), source, snapshot(), owner, now);
    expect(compiled.commands[0]).toMatchObject({ item: { priorityId: "urgent" } });
  });

  it.each([null, "Normal"])("clarifies explicit not-urgent work instead of applying the default with provider priority %s", priorityLabel => {
    const source = `${text} This is not urgent.`;
    const compiled = compileInterpretation(output(source, { priorityLabel }), source, snapshot(), owner, now);
    expect(compiled.kind).toBe("clarification");
    expect(compiled.commands).toEqual([]);
    expect(compiled.message).toContain("Which other priority");
  });

  it("uses an explicit alternative when the user says not urgent", () => {
    const source = `${text} This is not urgent, use Low priority.`;
    const compiled = compileInterpretation(output(source, { priorityLabel: "Low" }), source, snapshot(), owner, now);
    expect(compiled.commands[0]).toMatchObject({ item: { priorityId: "low" } });
  });

  it.each(["web", "landings", "software"] satisfies Category[])("keeps unspecified %s work Normal", category => {
    const source = text.replace("IT", category);
    const compiled = compileInterpretation(output(source, { category }), source, snapshot(), owner, now);
    expect(compiled.commands[0]).toMatchObject({ item: { priorityId: "normal" } });
  });

  it("keeps the requester's default Urgent advisory and effective priority Normal", () => {
    const state = snapshot();
    const compiled = compileInterpretation(output(text), text, state, requester, now);
    expect(compiled.commands[0]).toMatchObject({ item: { priorityId: "normal", requestedPriorityId: "urgent" } });
    const proposal = planCommands(state, compiled.commands, requester, { now: now.toISOString() });
    expect(proposal.status).toBe("ready");
    expect(proposal.items[0]).toMatchObject({ priorityId: "normal", requestedPriorityId: "urgent" });
  });

  it("lets a requester choose another advisory priority", () => {
    const source = `${text} Use Low priority.`;
    const compiled = compileInterpretation(output(source, { priorityLabel: "Low" }), source, snapshot(), requester, now);
    expect(compiled.commands[0]).toMatchObject({ item: { priorityId: "normal", requestedPriorityId: "low" } });
  });

  it("uses the same default in the offline demo parser", () => {
    const compiled = interpretDemoInput(text, snapshot(), owner, now);
    expect(compiled.commands[0]).toMatchObject({ item: { category: "it", priorityId: "urgent" } });
  });

  it("does not reset a saved priority while updating existing IT work", () => {
    const state = snapshot();
    const source = `${text} Use Low priority.`;
    const compiled = compileInterpretation(output(source, { priorityLabel: "Low" }), source, state, owner, now);
    const creation = planCommands(state, compiled.commands, owner, { now: now.toISOString() });
    state.items = creation.items;
    state.sessions = creation.sessions;
    const instruction = "Change Repair printer description to Check its cable.";
    const update = { kind: "commands", message: "Prepared", draft: null, actions: [{
      ...emptyAssistantAction("update", instruction), itemReference: "Repair printer", description: "Check its cable.",
    }] };
    const proposal = compileInterpretation(update, instruction, state, owner, now);
    expect(proposal.commands).toEqual([{ type: "update", itemId: state.items[0].id, patch: { description: "Check its cable." } }]);
    const planned = planCommands(state, proposal.commands, owner, { now: now.toISOString() });
    expect(planned.status).toBe("ready");
    expect(planned.items[0].priorityId).toBe("low");
  });
});
