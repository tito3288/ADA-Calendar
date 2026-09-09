import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import { dayCapacity, validateSchedule } from "./scheduler";
import { localDateTime, minutesBetween } from "./time";
import { newWorkItem } from "./work";
import type { ScheduleProposal, WorkCommand } from "./types";

// Fictional meetings and captured mail only. Live providers are unavailable.
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "bryan" }), set: vi.fn() }) }));
vi.mock("./server/supabase", () => ({ getSupabaseAdminClient: vi.fn(() => { throw new Error("No live database in meeting tests"); }), getSupabaseServerClient: vi.fn(() => { throw new Error("No live database in meeting tests"); }), clearSupabaseSessionCookies: vi.fn() }));
vi.mock("./server/assistant", () => ({ interpretInput: vi.fn(() => { throw new Error("No model calls in meeting tests"); }), assistantReservationUsd: vi.fn(() => 0), inspectAudioRecording: vi.fn(), transcribeAudio: vi.fn() }));
vi.mock("./server/service", async () => {
  const demo = await import("./server/demo-store");
  return { currentActor: vi.fn(async () => DEMO_MEMBERS[0]), demoEnabled: () => true,
    store: { getState: vi.fn(async (id: string) => demo.getDemoState(demo.demoActor(id))), commit: vi.fn(demo.commitDemoProposal), request: vi.fn(demo.submitDemoRequest) } };
});
import { POST } from "../app/api/[...path]/route";
import { getDemoState } from "./server/demo-store";
import { currentActor } from "./server/service";

const origin = "http://localhost:3000", owner = DEMO_MEMBERS[0], date = "2026-09-10";
const at = (clock: string, day = date) => localDateTime(day, clock, "America/Indiana/Indianapolis");
const command: WorkCommand = { type: "block", block: { id: "meeting", title: "Fictional client review", start: at("10:00"), end: at("11:00"), kind: "meeting" } };
async function send(body: unknown, requestOrigin = origin) {
  return POST(new NextRequest(`${origin}/api/commands`, { method: "POST", headers: { origin: requestOrigin, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ path: ["commands"] }) });
}
async function preview(operationId: string, change: WorkCommand = command): Promise<ScheduleProposal> {
  const response = await send({ commands: [change], operationId, action: "preview" });
  expect(response.status).toBe(200);
  const { proposal } = await response.json();
  expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
  return proposal;
}
async function commit(proposal: ScheduleProposal) {
  return send({ commands: proposal.commands, operationId: proposal.operationId, action: "commit", baseVersion: proposal.baseVersion, reviewFingerprint: proposal.reviewFingerprint });
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(at("08:00", "2026-09-09")));
  vi.stubEnv("ADA_DEMO_MODE", "true"); vi.stubEnv("APP_URL", origin);
  const directory = await mkdtemp(path.join(tmpdir(), "ada-meeting-fixture-")); vi.stubEnv("ADA_DATA_DIR", directory);
  for (const key of ["OPENAI_API_KEY", "RESEND_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) vi.stubEnv(key, "");
  const fixture = createDemoState();
  fixture.clients = [{ id: "fixture-client", name: "Fictional client", aliases: [] }];
  fixture.items = [newWorkItem(owner, date, { id: "work", clientId: "fixture-client", title: "Fictional work", estimatedMinutes: 180, remainingMinutes: 180, minimumSessionMinutes: 15, dateConstraints: { earliestStart: date, allowedDates: [] } })];
  fixture.sessions = [{ id: "work-session", workItemId: "work", start: at("09:00"), end: at("12:00"), status: "planned", protected: false, usesReserve: false }];
  fixture.settings.reserveMinutes = 0; fixture.blocks = []; fixture.events = []; fixture.notifications = []; fixture.requests = []; fixture.version = 0;
  await writeFile(path.join(directory, "ada-demo.json"), JSON.stringify(fixture), { mode: 0o600 });
  vi.mocked(currentActor).mockResolvedValue(owner);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("meetings through authenticated schedule transactions", () => {
  it("previews without writes and saves a fixed meeting plus the reviewed replan exactly once", async () => {
    const before = await getDemoState(owner), proposal = await preview("new-meeting");
    expect(await getDemoState(owner)).toEqual(before);
    expect((await commit(proposal)).status).toBe(200);
    const saved = await getDemoState(owner);
    expect(saved.version).toBe(1);
    expect(saved.events).toHaveLength(1);
    expect(saved.blocks).toEqual([command.block]);
    expect(saved.sessions.map(({ start, end }) => ({ start, end }))).toEqual(proposal.sessions.map(({ start, end }) => ({ start, end })));
    expect(saved.sessions.reduce((sum, work) => sum + minutesBetween(work.start, work.end), 0)).toBe(180);
    expect(saved.items[0]).toMatchObject({ estimatedMinutes: 180, remainingMinutes: 180 });
    expect(saved.settings.reserveMinutes).toBe(0);
    expect(dayCapacity(saved, date)).toEqual({ capacityMinutes: 390, plannedMinutes: 180, availableMinutes: 210 });
    expect(validateSchedule(saved, new Date().toISOString())).toEqual([]);
    expect(saved.notifications.every(message => message.status === "captured")).toBe(true);
    expect((await commit(proposal)).status).toBe(200);
    expect(await getDemoState(owner)).toEqual(saved);
  });

  it("edits and removes the same meeting while freeing capacity and preserving unaffected work", async () => {
    expect((await commit(await preview("meeting-add"))).status).toBe(200);
    const added = await getDemoState(owner);
    const edited = { ...command, block: { ...command.block, title: "Fictional follow-up", start: at("15:00"), end: at("16:30") } };
    expect((await commit(await preview("meeting-edit", edited))).status).toBe(200);
    const updated = await getDemoState(owner);
    expect(updated.blocks).toEqual([edited.block]);
    expect(updated.sessions).toEqual(added.sessions);
    expect(dayCapacity(updated, date).capacityMinutes).toBe(360);
    expect((await commit(await preview("meeting-remove", { ...edited, remove: true }))).status).toBe(200);
    const removed = await getDemoState(owner);
    expect(removed.blocks).toEqual([]);
    expect(removed.sessions).toEqual(added.sessions);
    expect(dayCapacity(removed, date).capacityMinutes).toBe(450);
  });

  it("requires a reviewed fingerprint and rejects stale concurrent meeting changes atomically", async () => {
    const before = await getDemoState(owner);
    expect((await send({ commands: [command], operationId: "unreviewed-meeting", action: "commit", baseVersion: 0 })).status).toBe(409);
    expect(await getDemoState(owner)).toEqual(before);
    const first = await preview("first-meeting"), competing = await preview("second-meeting", { ...command, block: { ...command.block, id: "another-meeting" } });
    expect((await commit(first)).status).toBe(200);
    const saved = await getDemoState(owner);
    expect((await commit(competing)).status).toBe(409);
    expect(await getDemoState(owner)).toEqual(saved);
  });

  it("invalidates an earlier preview if the displaced work starts before save", async () => {
    const before = await getDemoState(owner), proposal = await preview("started-meeting");
    vi.setSystemTime(new Date(at("09:01")));
    expect((await commit(proposal)).status).toBe(409);
    expect(await getDemoState(owner)).toEqual(before);
  });

  it.each([1, 3])("does not let requester/viewer fixture %s add, edit or remove a meeting", async index => {
    expect((await commit(await preview("owner-meeting"))).status).toBe(200);
    const saved = await getDemoState(owner);
    vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[index]);
    for (const change of [command, { ...command, remove: true }]) {
      const response = await send({ commands: [change], operationId: "unauthorized-meeting", action: "preview" });
      if (index === 1) expect((await response.json()).proposal.conflicts[0].code).toBe("forbidden");
      else expect(response.status).toBe(403);
    }
    expect(await getDemoState(owner)).toEqual(saved);
  });

  it("rejects invalid clock ranges, blank names and cross-origin writes", async () => {
    const before = await getDemoState(owner);
    for (const block of [{ ...command.block, title: " " }, { ...command.block, end: at("09:00") }])
      expect((await send({ commands: [{ ...command, block }], operationId: "invalid-meeting", action: "preview" })).status).toBe(400);
    expect((await send({ commands: [command], operationId: "cross-meeting", action: "preview" }, "https://invalid.example.test")).status).toBe(400);
    expect(await getDemoState(owner)).toEqual(before);
  });
});
