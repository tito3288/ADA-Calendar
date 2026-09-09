import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import { newWorkItem } from "./work";
import { localDateTime } from "./time";
import type { AppState, WorkCommand } from "./types";

// Fictional local storage only; no live database, model or message providers.
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "bryan" }), set: vi.fn() }) }));
vi.mock("./server/supabase", () => ({ getSupabaseAdminClient: vi.fn(() => { throw new Error("No live DB in Undo tests"); }), getSupabaseServerClient: vi.fn(() => { throw new Error("No live DB in Undo tests"); }), clearSupabaseSessionCookies: vi.fn() }));
vi.mock("./server/assistant", () => ({ interpretInput: vi.fn(() => { throw new Error("No model in Undo tests"); }), assistantReservationUsd: vi.fn(() => 0), inspectAudioRecording: vi.fn(), transcribeAudio: vi.fn() }));
vi.mock("./server/service", async () => {
  const demo = await import("./server/demo-store");
  return { currentActor: vi.fn(async () => DEMO_MEMBERS[0]), demoEnabled: () => true, store: { getState: vi.fn(async (id: string) => demo.getDemoState(demo.demoActor(id))), commit: vi.fn(demo.commitDemoProposal), undo: vi.fn(demo.undoDemoEvent), request: vi.fn(demo.submitDemoRequest) } };
});
import { POST } from "../app/api/[...path]/route";
import { currentActor } from "./server/service";
import { demoTransaction, getDemoState } from "./server/demo-store";

const origin = "http://localhost:3000", owner = DEMO_MEMBERS[0], day = "2026-09-09", next = "2026-09-10";
const at = (date: string, clock: string) => localDateTime(date, clock, "America/Indiana/Indianapolis");
const complete: WorkCommand = { type: "complete_day", itemId: "project", date: day };
async function send(route: string, body: unknown) {
  return POST(new NextRequest(`${origin}/api/${route}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ path: [route] }) });
}
async function save(command: WorkCommand = complete): Promise<AppState> {
  const commands = [command], operationId = `test-${command.type}`;
  const response = await send("commands", { commands, operationId, action: "preview" }); expect(response.status).toBe(200);
  const { proposal } = await response.json(); expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
  const committed = await send("commands", { commands, operationId, action: "commit", baseVersion: proposal.baseVersion, reviewFingerprint: proposal.reviewFingerprint });
  expect(committed.status).toBe(200); return (await committed.json()).state;
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(at(day, "18:00")));
  vi.stubEnv("ADA_DEMO_MODE", "true"); vi.stubEnv("APP_URL", origin);
  const directory = await mkdtemp(path.join(tmpdir(), "ada-completion-undo-")); vi.stubEnv("ADA_DATA_DIR", directory);
  for (const key of ["OPENAI_API_KEY", "RESEND_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) vi.stubEnv(key, "");
  const fixture = createDemoState(); fixture.items = [newWorkItem(owner, day, { id: "project", clientId: fixture.clients[0].id, title: "Fictional day work", estimatedMinutes: 240, remainingMinutes: 240, dailyPlan: [{ date: day, minutes: 120 }, { date: next, minutes: 60 }] })];
  fixture.sessions = [
    { id: "selected", workItemId: "project", start: at(day, "09:00"), end: at(day, "10:00"), status: "planned", protected: true, usesReserve: false },
    { id: "split", workItemId: "project", start: at(day, "11:00"), end: at(day, "12:00"), status: "planned", protected: false, usesReserve: false },
    { id: "next", workItemId: "project", start: at(next, "09:00"), end: at(next, "10:00"), status: "planned", protected: false, usesReserve: false },
    { id: "history", workItemId: "project", start: at(day, "08:00"), end: at(day, "08:30"), status: "completed", protected: true, usesReserve: false },
    { id: "cancelled", workItemId: "project", start: at(day, "12:00"), end: at(day, "12:30"), status: "cancelled", protected: false, usesReserve: false },
  ];
  fixture.settings.reserveMinutes = 0; fixture.blocks = []; fixture.events = []; fixture.notifications = []; fixture.requests = []; fixture.version = 0;
  await writeFile(path.join(directory, "ada-demo.json"), JSON.stringify(fixture), { mode: 0o600 });
  vi.mocked(currentActor).mockResolvedValue(owner);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("authenticated Undo of one booked day completion", () => {
  it.each([240, null])("restores only the exact prior schedule, budgets and remaining %s once", async remaining => {
    await demoTransaction(state => { state.items[0].estimatedMinutes = state.items[0].remainingMinutes = remaining; });
    const before = await getDemoState(owner), saved = await save();
    expect(saved.events[0].completedDay).toEqual({ itemId: "project", date: day }); expect(saved.events[0]).not.toHaveProperty("commands");
    const response = await send("undo", { id: saved.events[0].id }); expect(response.status).toBe(200);
    const restored: AppState = (await response.json()).state;
    expect(restored.items).toEqual(before.items); expect(restored.sessions).toEqual(before.sessions); expect(restored.blocks).toEqual(before.blocks);
    expect(restored.events[0].type).toBe("schedule_undone"); expect(restored.events[1].undoneBy).toBe(restored.events[0].id);
    expect(restored.notifications.every(notification => notification.status === "captured")).toBe(true);
    expect((await send("undo", { id: saved.events[0].id })).status).toBe(400); expect(await getDemoState(owner)).toEqual(restored);
  });
  it("restores legacy fractional-minute source times and the original dated quota exactly", async () => {
    await demoTransaction(state => { state.sessions = state.sessions.filter(session => session.id !== "split"); state.sessions[0].end = new Date(Date.parse(at(day, "10:07")) + 45_000).toISOString(); });
    const before = await getDemoState(owner), saved = await save(); expect(saved.items[0].remainingMinutes).toBe(172);
    expect((await send("undo", { id: saved.events[0].id })).status).toBe(200);
    const restored = await getDemoState(owner); expect(restored.items).toEqual(before.items); expect(restored.sessions).toEqual(before.sessions);
  });
  it.each([1, 3])("denies completion Undo to non-owner %s", async index => {
    const saved = await save(); vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[index]);
    expect((await send("undo", { id: saved.events[0].id })).status).not.toBe(200); expect(await getDemoState(owner)).toEqual(saved);
  });
  it("rejects an older completion after another schedule save", async () => {
    const saved = await save(); await demoTransaction(state => { state.version++; }); const changed = await getDemoState(owner);
    expect((await send("undo", { id: saved.events[0].id })).status).toBe(400); expect(await getDemoState(owner)).toEqual(changed);
  });
  it("keeps the existing completed-session history rule for other completion commands", async () => {
    const saved = await save({ type: "complete_session", sessionId: "selected" }); expect(saved.events[0].completedDay).toBeUndefined();
    expect((await send("undo", { id: saved.events[0].id })).status).toBe(400); expect(await getDemoState(owner)).toEqual(saved);
  });
});
