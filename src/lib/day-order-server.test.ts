import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import { newWorkItem } from "./work";
import { localDateTime, minutesBetween } from "./time";
import type { ScheduleProposal, WorkCommand } from "./types";

// Authenticated local demo transactions, captured notifications, and fictional
// private notes only. Every test uses an isolated directory and no hosted client.
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "bryan" }), set: vi.fn() }) }));
vi.mock("./server/supabase", () => ({ getSupabaseAdminClient: vi.fn(() => { throw new Error("No live database in day-order tests"); }), getSupabaseServerClient: vi.fn(() => { throw new Error("No live database in day-order tests"); }), clearSupabaseSessionCookies: vi.fn() }));
vi.mock("./server/assistant", () => ({ interpretInput: vi.fn(() => { throw new Error("No model calls in day-order tests"); }), assistantReservationUsd: vi.fn(() => 0), inspectAudioRecording: vi.fn(), transcribeAudio: vi.fn() }));
vi.mock("./server/service", async () => {
  const demo = await import("./server/demo-store");
  return { currentActor: vi.fn(async () => DEMO_MEMBERS[0]), demoEnabled: () => true, store: { getState: vi.fn(async (id: string) => demo.getDemoState(demo.demoActor(id))), commit: vi.fn(demo.commitDemoProposal), request: vi.fn(demo.submitDemoRequest) } };
});
import { POST } from "../app/api/[...path]/route";
import { currentActor } from "./server/service";
import { getDemoState } from "./server/demo-store";

const origin = "http://localhost:3000", owner = DEMO_MEMBERS[0], date = "2026-09-09";
const at = (clock: string) => localDateTime(date, clock, "America/Indiana/Indianapolis");
const commands: WorkCommand[] = [{ type: "reorder_day", date, sessionIds: ["tyler-session", "tree-session", "oral-session", "demo-session"] }];
let filename: string;
async function send(body: unknown, requestOrigin = origin) {
  return POST(new NextRequest(`${origin}/api/commands`, { method: "POST", headers: { origin: requestOrigin, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ path: ["commands"] }) });
}
async function preview(operationId: string, proposed = commands): Promise<ScheduleProposal> {
  const response = await send({ commands: proposed, operationId, action: "preview" });
  expect(response.status).toBe(200);
  const { proposal } = await response.json(); expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready"); return proposal;
}
async function commit(proposal: ScheduleProposal, proposed = proposal.commands) {
  return send({ commands: proposed, operationId: proposal.operationId, action: "commit", baseVersion: proposal.baseVersion, reviewFingerprint: proposal.reviewFingerprint });
}
async function savedPrivateNotes() { return JSON.parse(await readFile(filename, "utf8")).personalNotes; }
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(at("08:00")));
  vi.stubEnv("ADA_DEMO_MODE", "true"); vi.stubEnv("APP_URL", origin);
  const directory = await mkdtemp(path.join(tmpdir(), "ada-day-order-fixture-")); vi.stubEnv("ADA_DATA_DIR", directory);
  for (const key of ["OPENAI_API_KEY", "RESEND_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) vi.stubEnv(key, "");
  const fixture = createDemoState();
  fixture.items = ["oral", "tree", "tyler", "demo"].map(id => newWorkItem(owner, date, { id, clientId: "fixture-client", title: `Fictional ${id} project`, estimatedMinutes: id === "demo" ? 120 : 60, remainingMinutes: id === "demo" ? 120 : 60, minimumSessionMinutes: 60, windowEnd: "2026-12-31" }));
  fixture.clients = [{ id: "fixture-client", name: "Fictional client", aliases: [] }];
  fixture.settings.reserveMinutes = 0; fixture.blocks = []; fixture.events = []; fixture.notifications = []; fixture.requests = []; fixture.version = 0;
  fixture.sessions = [
    { id: "oral-session", workItemId: "oral", start: at("09:00"), end: at("10:00"), status: "planned", protected: false, usesReserve: false },
    { id: "tree-session", workItemId: "tree", start: at("10:00"), end: at("11:00"), status: "planned", protected: true, usesReserve: false },
    { id: "tyler-session", workItemId: "tyler", start: at("11:00"), end: at("12:00"), status: "planned", protected: false, usesReserve: false },
    { id: "demo-session", workItemId: "demo", start: at("12:30"), end: at("14:30"), status: "planned", protected: false, usesReserve: false },
  ];
  const personalNotes = [{ workspaceId: fixture.workspaceId, authorId: owner.id, note: { id: "private-note", title: "Fictional website list", body: "This note is not a scheduling command. Keep it unchanged.", version: 1, createdAt: at("07:00"), updatedAt: at("07:00") } }];
  filename = path.join(directory, "ada-demo.json");
  await writeFile(filename, JSON.stringify({ ...fixture, personalNotes }), { mode: 0o600 });
  vi.mocked(currentActor).mockResolvedValue(owner);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("day ordering through the authenticated command route", () => {
  it("previews without work writes, commits preserved sessions atomically, and retries once", async () => {
    const before = await getDemoState(owner), notes = await savedPrivateNotes(), proposal = await preview("day-order-once");
    expect(await getDemoState(owner)).toEqual(before); expect(await savedPrivateNotes()).toEqual(notes);
    const response = await commit(proposal); expect(response.status).toBe(200); const saved = (await response.json()).state;
    expect(saved.version).toBe(1); expect(saved.events).toHaveLength(1); expect(saved.sessions.map((s: { id: string }) => s.id)).toEqual(before.sessions.map(s => s.id));
    expect(saved.items).toEqual(before.items); expect(saved.sessions[1]).toEqual(before.sessions[1]);
    expect(saved.sessions.find((s: { id: string }) => s.id === "tyler-session").start).toBe(at("09:00"));
    expect(saved.sessions.reduce((total: number, s: { start: string; end: string }) => total + minutesBetween(s.start, s.end), 0)).toBe(300);
    expect(await savedPrivateNotes()).toEqual(notes); expect(saved.personalNotes).toBeUndefined();
    expect(saved.notifications.length).toBeGreaterThan(0); expect(saved.notifications.every((n: { status: string }) => n.status === "captured")).toBe(true);
    const retry = await commit(proposal); expect(retry.status).toBe(200); expect((await retry.json()).state).toEqual(saved);
  });
  it("requires a reviewed preview before saving an order", async () => {
    const before = await getDemoState(owner);
    const response = await send({ commands, operationId: "unreviewed-order", action: "commit", baseVersion: 0 });
    expect(response.status).toBe(409); expect(await getDemoState(owner)).toEqual(before);
  });
  it("rejects stale competing previews without duplicating events or changing notes", async () => {
    const notes = await savedPrivateNotes(), first = await preview("first-order"), second = await preview("second-order");
    expect((await commit(first)).status).toBe(200); const saved = await getDemoState(owner);
    expect((await commit(second)).status).toBe(409); expect(await getDemoState(owner)).toEqual(saved); expect(await savedPrivateNotes()).toEqual(notes);
  });
  it("cannot reuse a completed operation ID with a different session order", async () => {
    const proposal = await preview("bound-order"); expect((await commit(proposal)).status).toBe(200);
    const saved = await getDemoState(owner);
    const changed: WorkCommand[] = [{ type: "reorder_day", date, sessionIds: ["oral-session", "tree-session", "tyler-session", "demo-session"] }];
    expect((await commit(proposal, changed)).status).toBe(400); expect(await getDemoState(owner)).toEqual(saved);
  });
  it("requires another preview when selected work starts after the original preview", async () => {
    const before = await getDemoState(owner), proposal = await preview("clock-order");
    vi.setSystemTime(new Date(at("09:01")));
    expect((await commit(proposal)).status).toBe(409); expect(await getDemoState(owner)).toEqual(before);
  });
  it("cannot silently move a protected session and creates no event or notification when refused", async () => {
    const before = await getDemoState(owner);
    const response = await send({ commands: [{ type: "reorder_day", date, sessionIds: ["oral-session", "tyler-session", "tree-session", "demo-session"] }], operationId: "protected-order", action: "preview" });
    const { proposal } = await response.json(); expect(proposal.conflicts[0].code).toBe("protected_session");
    expect((await commit(proposal)).status).toBe(400); expect(await getDemoState(owner)).toEqual(before);
  });
  it.each([1, 3])("cannot reorder as another role (fixture index %s)", async index => {
    const before = await getDemoState(owner); vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[index]);
    const response = await send({ commands, operationId: "unauthorized-order", action: "preview" });
    if (index === 1) expect((await response.json()).proposal.conflicts[0].code).toBe("forbidden"); else expect(response.status).toBe(403);
    expect(await getDemoState(owner)).toEqual(before);
  });
  it("rejects cross-origin and malformed order payloads before mutation", async () => {
    const before = await getDemoState(owner);
    expect((await send({ commands, operationId: "cross-origin-order", action: "preview" }, "https://invalid.example.test")).status).toBe(400);
    expect((await send({ commands: [{ ...commands[0], sessions: [] }], operationId: "injected-order", action: "preview" })).status).toBe(400);
    expect((await send({ commands: [{ ...commands[0], sessionIds: ["oral-session", "oral-session"] }], operationId: "duplicate-order", action: "preview" })).status).toBe(400);
    expect(await getDemoState(owner)).toEqual(before);
  });
});
