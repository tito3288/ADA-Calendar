import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DEMO_MEMBERS } from "./fixtures";
import { newWorkItem } from "./work";

// Only the local AI ledger is real here. Interpretation and all mutation/sending
// services are mocked; no production credentials or provider calls are used.
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "bryan" }), set: vi.fn() }) }));
vi.mock("./server/assistant", () => ({ interpretInput: vi.fn(), assistantReservationUsd: vi.fn(() => 0), inspectAudioRecording: vi.fn(), transcribeAudio: vi.fn() }));
vi.mock("./server/service", async () => {
  const demo = await import("./server/demo-store");
  return { currentActor: vi.fn(async () => DEMO_MEMBERS[0]), demoEnabled: () => true,
    store: { getState: vi.fn(async (id: string) => ({ ...await demo.getDemoState(demo.demoActor(id)), clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }], items: [], sessions: [], blocks: [], notifications: [], events: [], emailDrafts: [] })),
      beginAI: vi.fn(demo.beginDemoAIOperation), finishAI: vi.fn(demo.finishDemoAIOperation), getAI: vi.fn(demo.getDemoAIOperation), hasCommittedOperation: vi.fn(demo.hasCommittedDemoOperation),
      commit: vi.fn(), admin: vi.fn(), request: vi.fn(), resolve: vi.fn(), undo: vi.fn() } };
});
import { currentActor, store } from "./server/service";
import { interpretInput } from "./server/assistant";
import { POST } from "../app/api/[...path]/route";
const selected = { start: "2026-09-09", end: "2026-09-11", kind: "work_window" };
const question = { kind: "clarification" as const, message: "How many hours?", commands: [] };
const text = "Add web work for Cedar Studio: Page edits";
async function send(body: unknown) {
  return POST(new NextRequest("http://localhost:3000/api/assistant", { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ path: ["assistant"] }) });
}
beforeEach(async () => {
  vi.stubEnv("ADA_DEMO_MODE", "true");
  vi.stubEnv("ADA_DATA_DIR", await mkdtemp(path.join(tmpdir(), "ada-date-context-test-")));
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[0]);
  vi.mocked(interpretInput).mockReset().mockResolvedValue(question);
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("selected-date API handoff", () => {
  it("retains a smart-fit capacity failure so try tomorrow continues the same work", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
    try {
      const fitText = "Find time for 8 hours today for a Cedar Studio website task.";
      const item = newWorkItem(DEMO_MEMBERS[0], "2026-09-09", { id: "cedar-fit", clientId: "cedar", title: "Cedar website", estimatedMinutes: 480, remainingMinutes: 480 });
      vi.mocked(interpretInput).mockResolvedValueOnce({ kind: "commands", message: "Ready to check", commands: [{ type: "create", item, smartFit: { startDate: "2026-09-09", endDate: "2026-09-09", minutes: 480, distribution: "total" } }] });
      const response = await send({ text: fitText, operationId: "smart-fit-conflict" });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.interpretation).toMatchObject({ kind: "clarification", commands: [] });
      expect(body.replyToOperationId).toBe("smart-fit-conflict");
      expect(store.commit).not.toHaveBeenCalled();
      await send({ text: "Try tomorrow instead", replyToOperationId: "smart-fit-conflict", operationId: "smart-fit-reply" });
      expect(interpretInput).toHaveBeenLastCalledWith("Try tomorrow instead", expect.anything(), expect.anything(), expect.objectContaining({ continuation: expect.objectContaining({ turns: [expect.objectContaining({ userText: fitText })] }) }));
    } finally { vi.useRealTimers(); }
  });
  it("retains a daily-capacity conflict as a private clarification instead of saving a partial week", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-08T13:00:00Z"));
    try {
      const dailyText = "Add web work for Cedar Studio, two hours each selected day.";
      const item = newWorkItem(DEMO_MEMBERS[0], "2026-09-11", { id: "cedar-daily", clientId: "cedar", title: "Cedar website", estimatedMinutes: 240, remainingMinutes: 240, windowEnd: "2026-09-12", dailyPlan: [{ date: "2026-09-11", minutes: 120 }, { date: "2026-09-12", minutes: 120 }] });
      vi.mocked(interpretInput).mockResolvedValueOnce({ kind: "commands", message: "Ready to check", commands: [{ type: "create", item }] });
      const response = await send({ text: dailyText, dateSelection: { start: "2026-09-11", end: "2026-09-12", kind: "work_window" }, operationId: "daily-conflict" });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.interpretation).toMatchObject({ kind: "clarification", commands: [], message: expect.stringContaining("2026-09-12") });
      expect(body.replyToOperationId).toBe("daily-conflict");
      expect(store.commit).not.toHaveBeenCalled();
      await send({ text: "Use Friday only, two hours", replyToOperationId: "daily-conflict", operationId: "daily-reply" });
      expect(interpretInput).toHaveBeenLastCalledWith("Use Friday only, two hours", expect.anything(), expect.anything(), expect.objectContaining({ continuation: expect.objectContaining({ turns: [expect.objectContaining({ userText: dailyText })] }) }));
    } finally { vi.useRealTimers(); }
  });
  it("retains dates in the private continuation, inherits them on follow-up, and clears on a terminal answer", async () => {
    const first = await send({ text, dateSelection: selected, operationId: "selection-first" });
    expect(first.status).toBe(200); expect((await first.json()).dateSelection).toEqual(selected);
    vi.mocked(interpretInput).mockResolvedValueOnce({ kind: "answer", message: "No change requested", commands: [] });
    const reply = await send({ text: "Two hours", replyToOperationId: "selection-first", operationId: "selection-reply" });
    expect(reply.status).toBe(200); expect((await reply.json()).dateSelection).toBeNull();
    expect(interpretInput).toHaveBeenLastCalledWith("Two hours", expect.anything(), expect.anything(), expect.objectContaining({ dateSelection: selected, continuation: expect.objectContaining({ dateSelection: selected }) }));
    expect(store.commit).not.toHaveBeenCalled(); expect(store.admin).not.toHaveBeenCalled();
  });
  it("supports explicit replacement and clearing without stale inherited context", async () => {
    await send({ text, dateSelection: selected, operationId: "selection-first" });
    const changed = { ...selected, end: "2026-09-10" };
    expect((await send({ text: "Two hours", dateSelection: changed, replyToOperationId: "selection-first", operationId: "selection-replace" })).status).toBe(200);
    expect(interpretInput).toHaveBeenLastCalledWith("Two hours", expect.anything(), expect.anything(), expect.objectContaining({ dateSelection: changed }));
    expect((await send({ text: "Two hours", dateSelection: null, replyToOperationId: "selection-replace", operationId: "selection-clear" })).status).toBe(200);
    expect(interpretInput).toHaveBeenLastCalledWith("Two hours", expect.anything(), expect.anything(), expect.objectContaining({ dateSelection: null }));
  });
  it("binds retry identity to the selected range and reuses exact retries", async () => {
    const body = { text, dateSelection: selected, operationId: "selection-repeat" };
    expect((await send(body)).status).toBe(200);
    expect((await send(body)).status).toBe(200); expect(interpretInput).toHaveBeenCalledTimes(1);
    expect((await send({ ...body, dateSelection: { ...selected, end: "2026-09-10" } })).status).toBe(400);
    expect(interpretInput).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed dates before interpretation or ledger reservation", async () => {
    for (const dateSelection of [{ ...selected, start: "2026-02-30" }, { ...selected, start: "2026-09-12" }, { ...selected, overrideProtected: true }])
      expect((await send({ text, dateSelection, operationId: "invalid-selection" })).status).toBe(400);
    expect(interpretInput).not.toHaveBeenCalled(); expect(store.beginAI).not.toHaveBeenCalled();
  });
  it("does not let another actor inherit the owner's pending dates or submit an owner-only timeline", async () => {
    await send({ text, dateSelection: selected, operationId: "owner-selection" });
    vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[1]);
    expect((await send({ text: "Two hours", replyToOperationId: "owner-selection", operationId: "private-reply" })).status).toBe(400);
    expect((await send({ text, dateSelection: { ...selected, kind: "project_span" }, operationId: "requester-span" })).status).toBe(400);
    expect(interpretInput).toHaveBeenCalledTimes(1); expect(store.commit).not.toHaveBeenCalled();
  });
  it("cancels selected context without a paid interpretation or mutation", async () => {
    const response = await send({ text: "Never mind", dateSelection: selected, operationId: "selection-cancel" });
    expect(response.status).toBe(200); expect((await response.json()).dateSelection).toBeNull();
    expect(interpretInput).not.toHaveBeenCalled(); expect(store.beginAI).not.toHaveBeenCalled(); expect(store.commit).not.toHaveBeenCalled();
  });
});
