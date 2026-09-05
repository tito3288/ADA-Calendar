import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DEMO_MEMBERS } from "./fixtures";
import { newWorkItem } from "./work";
import { planCommands } from "./scheduler";
import { addDays, localDate, nextWorkDate } from "./time";
import type { EmailDraft, Interpretation, ScheduleProposal } from "./types";

const storageMocks = vi.hoisted(() => ({ sign: vi.fn(), admin: vi.fn(), caller: vi.fn() }));
vi.mock("./server/supabase", () => ({ getSupabaseAdminClient: storageMocks.admin, getSupabaseServerClient: storageMocks.caller }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "bryan" }), set: vi.fn() }) }));
vi.mock("./server/service", async () => {
  const demo = await import("./server/demo-store");
  return {
    currentActor: vi.fn(async () => DEMO_MEMBERS[0]), demoEnabled: vi.fn(() => true),
    store: { getState: vi.fn(async (id: string) => demo.getDemoState(demo.demoActor(id))), commit: vi.fn(demo.commitDemoProposal), request: vi.fn(demo.submitDemoRequest),
      resolve: vi.fn(demo.resolveDemoRequest), undo: vi.fn(demo.undoDemoEvent), admin: vi.fn(demo.mutateDemoAdmin), beginAI: vi.fn(demo.beginDemoAIOperation), finishAI: vi.fn(demo.finishDemoAIOperation) },
  };
});
vi.mock("./server/assistant", async importOriginal => {
  const actual = await importOriginal<typeof import("./server/assistant")>();
  return { ...actual, interpretInput: vi.fn(actual.interpretInput), inspectAudioRecording: vi.fn(actual.inspectAudioRecording), transcribeAudio: vi.fn(actual.transcribeAudio) };
});

import { beginDemoAIOperation, commitDemoProposal, demoActor, demoDirectory, finishDemoAIOperation, getDemoState, mutateDemoAdmin, resolveDemoRequest, submitDemoRequest } from "./server/demo-store";
import { inspectAudioRecording, interpretInput, transcribeAudio } from "./server/assistant";
import { currentActor, demoEnabled, store } from "./server/service";
import { GET, POST } from "../app/api/[...path]/route";
import { reviewFingerprint, withReviewFingerprint } from "./server/preview";

beforeEach(async () => {
  vi.stubEnv("ADA_DEMO_MODE", "true");
  vi.stubEnv("ADA_DATA_DIR", await mkdtemp(path.join(tmpdir(), "ada-store-test-")));
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[0]);
  vi.mocked(demoEnabled).mockReturnValue(true);
  vi.mocked(interpretInput).mockClear();
  storageMocks.sign.mockResolvedValue({ data: { signedUrl: "https://storage.example.test/private-upload" }, error: null });
  storageMocks.admin.mockReturnValue({ storage: { from: () => ({ createSignedUploadUrl: storageMocks.sign }) } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

function request(route: string, body: unknown, origin = "http://localhost:3000") {
  return POST(new NextRequest(`http://localhost:3000/api/${route}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ path: route.split("/") }) });
}

describe("serialized demo operations", () => {
  it("claims one provider operation across concurrent retries and keeps its result private", async () => {
    const input = { id: "op-one", kind: "assistant" as const, inputHash: "same-text", reserveUsd: 0.5 };
    const results = await Promise.all([beginDemoAIOperation(DEMO_MEMBERS[0], input), beginDemoAIOperation(DEMO_MEMBERS[0], input)]);
    expect(results.map(result => result.status).sort()).toEqual(["claimed", "processing"]);
    expect((await getDemoState(DEMO_MEMBERS[0])).aiUsageUsd).toBe(0.5);
    await finishDemoAIOperation(DEMO_MEMBERS[0], input.id, { transcript: "Private spoken words" }, 0.1);
    expect(await beginDemoAIOperation(DEMO_MEMBERS[0], input)).toMatchObject({ status: "completed", result: { transcript: "Private spoken words" } });
    expect((await getDemoState(DEMO_MEMBERS[0])).aiUsageUsd).toBeCloseTo(0.1);
    expect(JSON.stringify(await getDemoState(DEMO_MEMBERS[2]))).not.toContain("Private spoken words");
    await expect(beginDemoAIOperation(DEMO_MEMBERS[2], input)).rejects.toThrow("different request");
    await expect(beginDemoAIOperation(DEMO_MEMBERS[0], { ...input, inputHash: "different-text" })).rejects.toThrow("different request");
  });
  it("retains one failed-attempt charge and does not resurrect settled reservations", async () => {
    const input = { id: "op-failed", kind: "assistant" as const, inputHash: "text", reserveUsd: 0.5 };
    await beginDemoAIOperation(DEMO_MEMBERS[0], input);
    await finishDemoAIOperation(DEMO_MEMBERS[0], input.id, null, undefined, "Unknown provider outcome");
    expect((await beginDemoAIOperation(DEMO_MEMBERS[0], input)).status).toBe("failed");
    expect((await getDemoState(DEMO_MEMBERS[0])).aiUsageUsd).toBe(0.5);
    await mutateDemoAdmin(DEMO_MEMBERS[0], { type: "reserve_ai", reservationId: "settled", amountUsd: 0.5 });
    await mutateDemoAdmin(DEMO_MEMBERS[0], { type: "settle_ai", reservationId: "settled", costUsd: 0.1 });
    await mutateDemoAdmin(DEMO_MEMBERS[0], { type: "reserve_ai", reservationId: "settled", amountUsd: 0.5 });
    expect((await getDemoState(DEMO_MEMBERS[0])).aiUsageUsd).toBeCloseTo(0.6);
    await expect(mutateDemoAdmin(DEMO_MEMBERS[2], { type: "settle_ai", reservationId: "settled", costUsd: 0 })).rejects.toThrow();
    await expect(mutateDemoAdmin(DEMO_MEMBERS[0], { type: "reserve_ai", reservationId: "negative", amountUsd: -10 })).rejects.toThrow();
  });
  it("enforces the allowance atomically for different simultaneous instructions", async () => {
    const state = await getDemoState(DEMO_MEMBERS[0]);
    await mutateDemoAdmin(DEMO_MEMBERS[0], { type: "settings", settings: { ...state.settings, aiLimitUsd: 0.75, aiWarningUsd: 0.5 } });
    const outcomes = await Promise.allSettled([beginDemoAIOperation(DEMO_MEMBERS[0], { id: "a", kind: "assistant", inputHash: "a", reserveUsd: 0.5 }), beginDemoAIOperation(DEMO_MEMBERS[0], { id: "b", kind: "assistant", inputHash: "b", reserveUsd: 0.5 })]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect((await getDemoState(DEMO_MEMBERS[0])).aiUsageUsd).toBe(0.5);
  });
  it("rejects role spoofing and makes send-draft retries produce one captured mail per recipient", async () => {
    await expect(getDemoState({ ...DEMO_MEMBERS[2], role: "owner" })).rejects.toThrow("membership");
    expect(() => demoActor("unknown")).toThrow();
    const draft: EmailDraft = { id: "draft-retry", authorId: "bryan", itemId: null, subject: "Progress update", body: "A factual update.", status: "draft", createdAt: new Date().toISOString() };
    await mutateDemoAdmin(DEMO_MEMBERS[0], { type: "draft", draft });
    await expect(mutateDemoAdmin(DEMO_MEMBERS[2], { type: "send_draft", id: draft.id, expectedSubject: draft.subject, expectedBody: draft.body })).rejects.toThrow();
    await mutateDemoAdmin(DEMO_MEMBERS[0], { type: "edit_draft", id: draft.id, subject: "Edited update", body: "Reviewed message." });
    await expect(mutateDemoAdmin(DEMO_MEMBERS[0], { type: "send_draft", id: draft.id, expectedSubject: draft.subject, expectedBody: draft.body })).rejects.toThrow("draft changed");
    const send = { type: "send_draft" as const, id: draft.id, expectedSubject: "Edited update", expectedBody: "Reviewed message." };
    await Promise.all([mutateDemoAdmin(DEMO_MEMBERS[0], send), mutateDemoAdmin(DEMO_MEMBERS[0], send)]);
    const state = await getDemoState(DEMO_MEMBERS[0]);
    expect(state.notifications).toHaveLength(2);
    expect(state.notifications.every(message => message.status === "captured" && message.body.startsWith("Reviewed message."))).toBe(true);
    expect((await getDemoState(DEMO_MEMBERS[2])).emailDrafts).toEqual([]);
  });
  it("commits once across concurrent same-operation retries and rejects changed payload reuse", async () => {
    const actor = DEMO_MEMBERS[0];
    const state = await getDemoState(actor);
    const date = nextWorkDate(addDays(localDate(new Date().toISOString(), state.settings.timeZone), 30), state.settings);
    const item = newWorkItem(actor, date, { id: "new-work", clientId: "higher-ground", title: "Retry test", estimatedMinutes: 60, remainingMinutes: 60 });
    const proposal = planCommands(state, [{ type: "create", item }], actor, { operationId: "commit-once", approveDisplacement: true });
    expect(proposal.status).toBe("ready");
    await Promise.all([commitDemoProposal(actor, proposal), commitDemoProposal(actor, proposal)]);
    const saved = await getDemoState(actor);
    expect(saved.events.filter(event => event.operationId === "commit-once")).toHaveLength(1);
    expect(saved.notifications).toHaveLength(2);
    await expect(commitDemoProposal(actor, { ...proposal, commands: [{ type: "create", item: { ...item, title: "Different request" } }] })).rejects.toThrow("different change");
    expect(JSON.parse(await readFile(path.join(demoDirectory(), "ada-demo.json"), "utf8")).events).toHaveLength(1);
  });
});

async function pendingRequest() {
  const actor = DEMO_MEMBERS[2];
  const state = await getDemoState(actor);
  const date = nextWorkDate(addDays(localDate(new Date().toISOString(), state.settings.timeZone), 30), state.settings);
  const item = newWorkItem(actor, date, { id: "pending-work", clientId: "higher-ground", title: "Large pending request", estimatedMinutes: 600, remainingMinutes: 600, windowEnd: date, deadline: date });
  const proposal = planCommands(state, [{ type: "create", item }], actor, { operationId: "pending-request" });
  expect(proposal.status).not.toBe("ready");
  await submitDemoRequest(actor, proposal);
  return { item, proposal, date };
}
describe("approval and pending attachment boundaries", () => {
  it("rejects missing or stale approval versions at route and transaction boundaries", async () => {
    const { item } = await pendingRequest();
    const commands = [{ type: "create", item: { ...item, estimatedMinutes: 60, remainingMinutes: 60, requesterId: "forged", requestedBy: "Forged author" } }];
    const preview = await (await request("requests/resolve", { id: "pending-request", decision: "approved", commands, preview: true })).json();
    expect(preview.proposal.status).toBe("ready");
    expect((await request("requests/resolve", { id: "pending-request", decision: "approved", commands })).status).toBe(409);
    const before = await getDemoState(DEMO_MEMBERS[0]);
    await mutateDemoAdmin(DEMO_MEMBERS[0], { type: "settings", settings: before.settings });
    expect((await request("requests/resolve", { id: "pending-request", decision: "approved", commands, baseVersion: preview.proposal.baseVersion })).status).toBe(409);
    await expect(resolveDemoRequest(DEMO_MEMBERS[0], "pending-request", "approved", "", preview.proposal)).rejects.toThrow("schedule changed");
    const fresh = await (await request("requests/resolve", { id: "pending-request", decision: "approved", commands, preview: true })).json();
    expect(fresh.state.version).toBe(fresh.proposal.baseVersion);
    expect(fresh.state.version).toBeGreaterThan(preview.proposal.baseVersion);
    expect(fresh.state.events).toEqual(before.events);
    expect(fresh.state.notifications).toEqual(before.notifications);
    expect(fresh.state.items).toEqual(before.items);
    expect(fresh.state.requests.find((entry: { id: string }) => entry.id === "pending-request").status).toBe("pending");
    expect((await getDemoState(DEMO_MEMBERS[0])).version).toBe(fresh.state.version);
    const saved = await request("requests/resolve", { id: "pending-request", decision: "approved", commands: fresh.proposal.commands, baseVersion: fresh.proposal.baseVersion, reviewFingerprint: fresh.proposal.reviewFingerprint });
    expect(saved.status).toBe(200);
    expect((await saved.json()).state.items.find((work: { id: string }) => work.id === item.id)).toMatchObject({ requesterId: "william", requestedBy: "William" });
  });
  it("allows private original files on pending work and preserves them when approved", async () => {
    const { item } = await pendingRequest();
    vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[2]);
    const preparedResponse = await request("attachments/prepare", { workItemId: item.id, name: "notes.md", contentType: "text/markdown", size: 5 });
    expect(preparedResponse.status).toBe(200);
    const { attachment, uploadUrl } = await preparedResponse.json();
    expect((await getDemoState(DEMO_MEMBERS[2])).attachments).toHaveLength(0);
    const uploaded = await POST(new NextRequest(`http://localhost:3000${uploadUrl}`, { method: "POST", headers: { origin: "http://localhost:3000", "content-type": "text/markdown" }, body: "Notes" }), { params: Promise.resolve({ path: ["attachments", "upload", attachment.id] }) });
    expect(uploaded.status).toBe(200);
    expect((await request("attachments/complete", { id: attachment.id })).status).toBe(200);
    expect((await getDemoState(DEMO_MEMBERS[2])).attachments).toHaveLength(1);
    expect((await getDemoState(DEMO_MEMBERS[0])).attachments).toHaveLength(1);
    expect((await getDemoState(DEMO_MEMBERS[1])).attachments).toHaveLength(0);
    expect((await getDemoState(DEMO_MEMBERS[3])).attachments).toHaveLength(0);
    const ctx = { params: Promise.resolve({ path: ["attachments", attachment.id] }) };
    expect(await (await GET(new NextRequest(`http://localhost:3000/api/attachments/${attachment.id}`), ctx)).text()).toBe("Notes");
    vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[1]);
    expect((await GET(new NextRequest(`http://localhost:3000/api/attachments/${attachment.id}`), ctx)).status).toBe(404);
    expect((await request("attachments/prepare", { workItemId: item.id, name: "other.md", contentType: "text/markdown", size: 5 })).status).toBe(400);
    vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[0]);
    const commands = [{ type: "create", item: { ...item, estimatedMinutes: 60, remainingMinutes: 60 } }];
    const { proposal } = await (await request("requests/resolve", { id: "pending-request", decision: "approved", commands, preview: true })).json();
    expect((await request("requests/resolve", { id: "pending-request", decision: "approved", commands, baseVersion: proposal.baseVersion, reviewFingerprint: proposal.reviewFingerprint })).status).toBe(200);
    expect((await getDemoState(DEMO_MEMBERS[3])).attachments).toHaveLength(1);
  });
  it("requires an exact reviewed draft and captures nothing if another editor changed it", async () => {
    const draft: EmailDraft = { id: "draft-exact", authorId: "bryan", itemId: null, subject: "Original", body: "Original body", status: "draft", createdAt: new Date().toISOString() };
    await mutateDemoAdmin(DEMO_MEMBERS[0], { type: "draft", draft });
    expect((await request("admin", { type: "send_draft", id: draft.id })).status).toBe(400);
    await request("admin", { type: "edit_draft", id: draft.id, subject: "New version", body: "Another editor's text" });
    expect((await request("admin", { type: "send_draft", id: draft.id, expectedSubject: draft.subject, expectedBody: draft.body })).status).toBe(400);
    expect((await getDemoState(DEMO_MEMBERS[0])).notifications).toHaveLength(0);
  });
});

describe("reviewed placement fingerprints", () => {
  function clock() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-09-09T13:00:01Z"));
  }
  async function clockPreview(operationId: string) {
    const state = await getDemoState(DEMO_MEMBERS[0]);
    const item = newWorkItem(DEMO_MEMBERS[0], "2030-09-09", { id: `${operationId}-work`, clientId: "higher-ground", title: "Clock boundary work", estimatedMinutes: 30, remainingMinutes: 30 });
    const response = await request("commands", { commands: [{ type: "create", item }], operationId, action: "preview" });
    expect(response.status).toBe(200);
    return { state, proposal: (await response.json()).proposal as ScheduleProposal };
  }
  const commitInput = (proposal: ScheduleProposal) => ({ commands: proposal.commands, operationId: proposal.operationId, baseVersion: proposal.baseVersion, reviewFingerprint: proposal.reviewFingerprint, action: "commit" });
  it("rejects clock-only changed placement, returns a fresh preview, and keeps committed retries idempotent", async () => {
    clock();
    const { state: before, proposal } = await clockPreview("clock-route");
    expect(proposal.reviewFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(proposal.sessions.at(-1)?.start).toBe("2030-09-09T13:15:00Z");
    vi.setSystemTime(new Date("2030-09-09T13:15:01Z"));
    const denied = await request("commands", commitInput(proposal));
    expect(denied.status).toBe(409);
    const updated = await denied.json();
    expect(updated.proposal.baseVersion).toBe(proposal.baseVersion);
    expect(updated.proposal.reviewFingerprint).not.toBe(proposal.reviewFingerprint);
    expect(updated.proposal.sessions.at(-1)?.start).toBe("2030-09-09T13:30:00Z");
    const unchanged = await getDemoState(DEMO_MEMBERS[0]);
    expect(unchanged.items).toEqual(before.items);
    expect(unchanged.events).toEqual(before.events);
    expect(unchanged.notifications).toEqual(before.notifications);
    expect((await request("commands", commitInput(updated.proposal))).status).toBe(200);
    const saved = await getDemoState(DEMO_MEMBERS[0]);
    vi.setSystemTime(new Date("2030-09-09T14:01:00Z"));
    expect((await request("commands", commitInput(updated.proposal))).status).toBe(200);
    expect((await getDemoState(DEMO_MEMBERS[0])).events).toEqual(saved.events);
    expect((await getDemoState(DEMO_MEMBERS[0])).notifications).toEqual(saved.notifications);
  });
  it("ignores regenerated session IDs and lifecycle timestamps but detects user-visible fields", async () => {
    clock();
    const { proposal } = await clockPreview("clock-stable");
    vi.setSystemTime(new Date("2030-09-09T13:00:20Z"));
    const same = (await (await request("commands", { commands: proposal.commands, operationId: proposal.operationId, action: "preview" })).json()).proposal as ScheduleProposal;
    expect(same.sessions.at(-1)?.id).not.toBe(proposal.sessions.at(-1)?.id);
    expect(same.reviewFingerprint).toBe(proposal.reviewFingerprint);
    for (const mutate of [
      (p: ScheduleProposal) => { p.items.at(-1)!.priorityId = "high"; },
      (p: ScheduleProposal) => { p.items.at(-1)!.remainingMinutes = 60; },
      (p: ScheduleProposal) => { p.sessions.at(-1)!.protected = true; },
      (p: ScheduleProposal) => { p.conflicts.push({ code: "test", message: "New conflict", itemIds: [] }); },
    ]) {
      const changed = structuredClone(same); mutate(changed);
      expect(reviewFingerprint(changed)).not.toBe(proposal.reviewFingerprint);
    }
    expect((await request("commands", commitInput(proposal))).status).toBe(200);
  });
  it("checks again if the clock crosses a slot after route validation but before the store replans", async () => {
    clock();
    const { proposal } = await clockPreview("clock-store");
    vi.mocked(store.commit).mockImplementationOnce(async (actor, reviewed) => {
      vi.setSystemTime(new Date("2030-09-09T13:15:01Z"));
      return commitDemoProposal(actor, reviewed);
    });
    const response = await request("commands", commitInput(proposal));
    expect(response.status).toBe(409);
    expect((await response.json()).proposal.reviewFingerprint).not.toBe(proposal.reviewFingerprint);
    expect((await getDemoState(DEMO_MEMBERS[0])).events).toHaveLength(0);
  });
  it("also prevents clock-only drift in a pending owner approval", async () => {
    clock();
    const { item } = await pendingRequest();
    const commands = [{ type: "create", item: { ...item, windowStart: "2030-09-09", windowEnd: "2030-09-09", deadline: null, estimatedMinutes: 30, remainingMinutes: 30 } }];
    const { proposal } = await (await request("requests/resolve", { id: "pending-request", decision: "approved", commands, preview: true })).json();
    vi.setSystemTime(new Date("2030-09-09T13:15:01Z"));
    const denied = await request("requests/resolve", { id: "pending-request", decision: "approved", commands: proposal.commands, baseVersion: proposal.baseVersion, reviewFingerprint: proposal.reviewFingerprint });
    expect(denied.status).toBe(409);
    expect((await getDemoState(DEMO_MEMBERS[0])).requests[0].status).toBe("pending");
    expect((await getDemoState(DEMO_MEMBERS[0])).events).toHaveLength(0);
    const fresh = (await denied.json()).proposal;
    expect((await request("requests/resolve", { id: "pending-request", decision: "approved", commands: fresh.commands, baseVersion: fresh.baseVersion, reviewFingerprint: fresh.reviewFingerprint })).status).toBe(200);
  });
  it("guards a reviewed proposal passed directly to the transactional store", async () => {
    clock();
    const { state, proposal } = await clockPreview("clock-direct");
    const reviewed = withReviewFingerprint(planCommands(state, proposal.commands, DEMO_MEMBERS[0], { operationId: proposal.operationId, approveDisplacement: true }));
    vi.setSystemTime(new Date("2030-09-09T13:15:01Z"));
    await expect(commitDemoProposal(DEMO_MEMBERS[0], reviewed)).rejects.toMatchObject({ name: "PreviewChangedError" });
  });
});

describe("privileged upload signing after trusted reservation", () => {
  it("signs through the admin client only after metadata authorization succeeds", async () => {
    vi.mocked(demoEnabled).mockReturnValue(false);
    const state = await getDemoState(DEMO_MEMBERS[0]);
    const response = await request("attachments/prepare", { workItemId: state.items[0].id, name: "brief.md", contentType: "text/markdown", size: 5 });
    expect(response.status).toBe(200);
    expect((await response.json()).uploadUrl).toBe("https://storage.example.test/private-upload");
    expect(storageMocks.caller).not.toHaveBeenCalled();
    expect(storageMocks.sign).toHaveBeenCalledWith(expect.stringContaining(`${state.workspaceId}/${state.items[0].id}/`), { upsert: false });
    expect(vi.mocked(store.admin).mock.invocationCallOrder[0]).toBeLessThan(storageMocks.admin.mock.invocationCallOrder[0]);
  });
  it("never obtains privileged signing authority when reservation or requester authorization fails", async () => {
    vi.mocked(demoEnabled).mockReturnValue(false);
    const state = await getDemoState(DEMO_MEMBERS[0]);
    const input = { workItemId: state.items[0].id, name: "brief.md", contentType: "text/markdown", size: 5 };
    vi.mocked(store.admin).mockRejectedValueOnce(new Error("Reservation rejected"));
    expect((await request("attachments/prepare", input)).status).toBe(400);
    expect(storageMocks.admin).not.toHaveBeenCalled();
    vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[1]);
    expect((await request("attachments/prepare", input)).status).toBe(400);
    expect(storageMocks.admin).not.toHaveBeenCalled();
    expect(storageMocks.sign).not.toHaveBeenCalled();
  });
});

describe("assistant route admission and retries", () => {
  async function recording(operationId: string) {
    const form = new FormData();
    form.set("operationId", operationId);
    form.set("audio", new File([new Uint8Array([1, 2, 3])], "recording.wav", { type: "audio/wav" }));
    return POST(new NextRequest("http://localhost:3000/api/transcribe", { method: "POST", headers: { origin: "http://localhost:3000" }, body: form }), { params: Promise.resolve({ path: ["transcribe"] }) });
  }
  it("settles successful recording estimates from verified duration and caches retries", async () => {
    vi.mocked(demoEnabled).mockReturnValue(false);
    vi.stubEnv("OPENAI_API_KEY", "test-no-network-call");
    vi.mocked(inspectAudioRecording).mockResolvedValueOnce({ durationSeconds: 60 }).mockResolvedValueOnce({ durationSeconds: 60 });
    vi.mocked(transcribeAudio).mockResolvedValueOnce("Please add one hour of work.");
    const first = await recording("audio-estimate");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ transcript: "Please add one hour of work.", durationSeconds: 60 });
    expect((await recording("audio-estimate")).status).toBe(200);
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(store.beginAI).toHaveBeenCalledWith(DEMO_MEMBERS[0], expect.objectContaining({ reserveUsd: 0.01 }));
    const state = await getDemoState(DEMO_MEMBERS[0]);
    expect(state.aiUsageUsd).toBeCloseTo(0.0045);
    expect(state.events).toHaveLength(0);
    expect(state.notifications).toHaveLength(0);
  });
  it("retains the bounded reservation when transcription has an uncertain outcome", async () => {
    vi.mocked(demoEnabled).mockReturnValue(false);
    vi.stubEnv("OPENAI_API_KEY", "test-no-network-call");
    vi.mocked(inspectAudioRecording).mockResolvedValueOnce({ durationSeconds: 120 });
    vi.mocked(transcribeAudio).mockRejectedValueOnce(new Error("Provider outcome unknown"));
    expect((await recording("audio-uncertain")).status).toBe(400);
    expect((await getDemoState(DEMO_MEMBERS[0])).aiUsageUsd).toBeCloseTo(0.0135);
    expect(store.finishAI).toHaveBeenCalledWith(DEMO_MEMBERS[0], "audio-uncertain", null, undefined, expect.stringContaining("retained"));
  });
  it("calls the interpreter once and creates one private draft on repeated submission", async () => {
    const input = { text: "I have to tell her about the completed landings", operationId: "draft-route-retry" };
    expect((await request("assistant", input)).status).toBe(200);
    expect((await request("assistant", input)).status).toBe(200);
    expect(interpretInput).toHaveBeenCalledTimes(1);
    const state = await getDemoState(DEMO_MEMBERS[0]);
    expect(state.emailDrafts).toHaveLength(1);
    expect(state.notifications).toHaveLength(0);
  });
  it("does not call a provider or reserve money for unconfigured live AI", async () => {
    vi.mocked(demoEnabled).mockReturnValue(false);
    vi.stubEnv("OPENAI_API_KEY", "");
    expect((await request("assistant", { text: "A task", operationId: "no-key" })).status).toBe(503);
    expect(interpretInput).not.toHaveBeenCalled();
    expect(store.beginAI).not.toHaveBeenCalled();
  });
  it("reuses live-style settled result without extra spend on retry", async () => {
    vi.mocked(demoEnabled).mockReturnValue(false);
    vi.stubEnv("OPENAI_API_KEY", "test-no-network-call");
    const output: Interpretation = { kind: "clarification", message: "Which client?", commands: [], usage: { inputTokens: 100, outputTokens: 100, costUsd: 0.01 } };
    vi.mocked(interpretInput).mockResolvedValueOnce(output);
    const input = { text: "Please add work", operationId: "live-style-retry" };
    expect((await request("assistant", input)).status).toBe(200);
    expect((await request("assistant", input)).status).toBe(200);
    expect(interpretInput).toHaveBeenCalledTimes(1);
    expect((await getDemoState(DEMO_MEMBERS[0])).aiUsageUsd).toBeCloseTo(0.01);
  });
  it("denies another account's operation ID and cross-origin mutations", async () => {
    const input = { text: "I have to tell her about the completed landings", operationId: "private-op" };
    await request("assistant", input);
    vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[2]);
    expect((await request("assistant", input)).status).toBe(400);
    expect(interpretInput).toHaveBeenCalledTimes(1);
    expect((await request("assistant", { ...input, operationId: "different" }, "https://untrusted.example")).status).toBe(400);
  });
});
