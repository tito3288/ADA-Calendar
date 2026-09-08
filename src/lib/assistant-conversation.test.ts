import { describe, expect, it } from "vitest";
import { conversationText, isConversationCancellation, nextContinuation, readContinuation } from "./assistant-conversation";

const now = new Date("2026-09-07T14:00:00Z");
const zone = "America/Indiana/Indianapolis";
const question = { kind: "clarification" as const, message: "How many hours?", commands: [] };

describe("private pending instruction context", () => {
  it("retains only the original user words as command evidence, not ADA's question", () => {
    const pending = nextContinuation("Add software for Drive and Shine", question, now)!;
    expect(readContinuation({ interpretation: question, continuation: pending }, now, zone)).toEqual(pending);
    expect(conversationText("Two hours", pending)).toBe("Add software for Drive and Shine\nTwo hours");
    expect(conversationText("Two hours", pending)).not.toContain("How many hours");
  });
  it("never carries completed instructions, drafts, or answers into new work", () => {
    for (const kind of ["commands", "email_draft", "answer", "undo"] as const) {
      expect(nextContinuation("An instruction", { kind, message: "Done", commands: [] }, now)).toBeNull();
      expect(() => readContinuation({ interpretation: { kind }, continuation: null }, now, zone)).toThrow(/not awaiting/);
    }
  });
  it("expires relative-date context on the next local day and rejects invalid context", () => {
    const pending = nextContinuation("Do this tomorrow", question, now)!;
    expect(() => readContinuation({ interpretation: question, continuation: pending }, new Date("2026-09-08T04:01:00Z"), zone)).toThrow(/earlier workday/);
    expect(() => readContinuation({ interpretation: question, continuation: { ...pending, turns: [] } }, now, zone)).toThrow(/not awaiting/);
    expect(() => readContinuation({ interpretation: question, continuation: pending }, new Date("2026-09-07T13:59:00Z"), zone)).toThrow(/earlier workday/);
  });
  it("bounds cumulative user input and does not silently truncate a pending instruction", () => {
    const pending = nextContinuation("x".repeat(11_999), question, now)!;
    expect(() => conversationText("Two hours", pending)).toThrow(/length limit/);
    expect(() => conversationText("Two hours", { ...pending, turns: Array(8).fill({ userText: "a", question: "Which?" }) })).toThrow(/length limit/);
  });
  it("rejects a topic switch instead of borrowing the new task's effort for the old one", () => {
    const pending = nextContinuation("Add IT for Higher Ground Tree: fix form", question, now)!;
    expect(() => conversationText("Instead, add web work for Higher Ground Tree: Change logo, 2 hours on 2026-09-10", pending)).toThrow(/new task/);
    expect(() => conversationText("Instead, schedule web work for Higher Ground Tree: Change logo, 2 hours on 2026-09-10", pending)).toThrow(/new task/);
  });
  it.each([
    "Add it for months of September, October, November and December and for now we are adding 4 hours of work this Friday the 11th from 9am - 1pm",
    "Add this for the rest of this month through the end of the year.",
    "Add that on September 11th from 9am to 1pm.",
    "Please book it for Friday from 9am to 1pm.",
    "Create it as unscheduled work with no estimate.",
    "Add it.",
  ])("accepts a pronoun reply about the pending work: %s", reply => {
    const original = "Cedar Lane Books needs a store rebuild. The total effort is unknown; reserve four hours on Friday the 10th.";
    const dateQuestion = { ...question, message: "Do you mean Thursday the 10th or Friday the 11th?" };
    const pending = nextContinuation(original, dateQuestion, now)!;
    expect(conversationText(reply, pending)).toBe(`${original}\n${reply}`);
    expect(conversationText(reply, pending)).not.toContain(dateQuestion.message);
  });
  it.each([
    "Add store edits for Maple Grove Co, two hours tomorrow",
    "Add this new project for Maple Grove Co",
    "Add this store project for Maple Grove Co",
    "Add it as a separate task for Maple Grove Co",
    "Also add it for Friday",
    "Instead, add that for Friday",
    "Separately book it for Friday",
    "Add it on Friday; add logo edits for Maple Grove Co, two hours tomorrow",
    "Add it on Friday and book website edits for Maple Grove Co, two hours tomorrow",
    "Add it on Friday. Please create a landing page for Maple Grove Co",
  ])("keeps named work and topic switches out of pronoun replies: %s", reply => {
    const pending = nextContinuation("Cedar Lane Books needs a store rebuild.", question, now)!;
    expect(() => conversationText(reply, pending)).toThrow(/new task/);
  });
  it("accepts the same named pending task as unscheduled work without an estimate", () => {
    const original = "For the rest of this month and next month I will be working on software for Drive and Shine. I am working on Oil Survey system that connects to their POS. I am waiting on details from their end to specify the days and hours.";
    const offer = { ...question, message: "Should I add Oil Survey system now as unscheduled work with no estimate?" };
    const pending = nextContinuation(original, offer, now)!;
    for (const reply of [
      "add “Oil Survey system” for Drive and Shine now as unscheduled work with no estimate",
      "Please create Oil Survey system for Drive and Shine as unscheduled work without an estimate.",
      'Add "oil survey SYSTEM" for DRIVE AND SHINE now as unscheduled work with no estimate!',
    ]) {
      expect(conversationText(reply, pending)).toBe(`${original}\n${reply}`);
      expect(conversationText(reply, pending)).not.toContain(offer.message);
    }
  });
  it("requires both the task and client in earlier user words, not just ADA's offer", () => {
    const offer = { ...question, message: 'Should I add "Oil Survey system" for Drive and Shine now as unscheduled work with no estimate?' };
    const reply = "Add Oil Survey system for Drive and Shine now as unscheduled work with no estimate";
    for (const original of [
      "I need software for Drive and Shine. I am waiting on details.",
      "Oil Survey system is a software project for Higher Ground Tree. I am waiting on details.",
      "The Oil Survey systems for Drive and Shine are already finished.",
    ]) {
      expect(() => conversationText(reply, nextContinuation(original, offer, now)!)).toThrow(/new task/);
    }
  });
  it("does not combine unrelated prior turns into a new task identity", () => {
    const first = nextContinuation("Drive and Shine needs website edits.", question, now)!;
    const pending = nextContinuation("The Oil Survey system belongs to Higher Ground Tree.", question, now, first)!;
    expect(() => conversationText("Add Oil Survey system for Drive and Shine as unscheduled work with no estimate", pending)).toThrow(/new task/);
  });
  it("keeps explicit topic switches and extra instructions blocked even when names match", () => {
    const pending = nextContinuation("Build the Oil Survey system for Drive and Shine. I am waiting on details. Override protected time if needed.", question, now)!;
    const acceptance = "add Oil Survey system for Drive and Shine now as unscheduled work with no estimate";
    for (const reply of [
      `Instead, ${acceptance}`,
      `Also ${acceptance}`,
      `Separately, ${acceptance}`,
      `${acceptance}; add a website edit for Higher Ground Tree, two hours tomorrow`,
      `${acceptance}. Use three hours tomorrow.`,
      `${acceptance} and override protected time`,
      "Add Homepage demo for Drive and Shine now as unscheduled work with no estimate",
      "Add Oil Survey system for Higher Ground Tree now as unscheduled work with no estimate",
      "Add Oil Survey system for Drive and Shine, two hours tomorrow",
    ]) expect(() => conversationText(reply, pending)).toThrow(/new task/);
  });
  it("recognizes cancellation only when it is the instruction itself", () => {
    expect(isConversationCancellation("Never mind.")).toBe(true);
    expect(isConversationCancellation("Cancel that")).toBe(true);
    expect(isConversationCancellation("Fix the cancel button on the website")).toBe(false);
  });
});
