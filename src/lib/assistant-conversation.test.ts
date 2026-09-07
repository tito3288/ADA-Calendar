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
  it("recognizes cancellation only when it is the instruction itself", () => {
    expect(isConversationCancellation("Never mind.")).toBe(true);
    expect(isConversationCancellation("Cancel that")).toBe(true);
    expect(isConversationCancellation("Fix the cancel button on the website")).toBe(false);
  });
});
