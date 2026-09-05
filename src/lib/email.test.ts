import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import { buildCommitNotifications, buildDraftNotifications, buildRequestNotifications, buildSendPayload, buildWeeklyNotifications, sendNotification, verifyEmailWebhook } from "./server/email";
import { attachmentPath, authorizeAttachmentAccess, validateUpload } from "./server/uploads";
import type { EmailDraft, PendingRequest, WorkEvent } from "./types";

const now = "2026-09-07T12:00:00Z";
function fixture() {
  const state = createDemoState(now);
  const before = structuredClone({ items: state.items, sessions: state.sessions, blocks: state.blocks });
  state.items[0].priorityId = "urgent";
  const event: WorkEvent = { id: "event-1", operationId: "operation-1", actorId: "bryan", actorName: "Bryan", type: "update", summary: ["Priority updated"], itemIds: [state.items[0].id], createdAt: now, version: 1, before, after: { items: state.items, sessions: state.sessions, blocks: state.blocks }, undoneBy: null };
  return { state, event };
}
afterEach(() => vi.unstubAllEnvs());
describe("transaction notification payloads", () => {
  it("notifies Kyle and William for each commit, with stable per-recipient deduplication", () => {
    const { state, event } = fixture();
    const first = buildCommitNotifications(event, state);
    expect(first.map((mail) => mail.recipient)).toEqual(["kyle@example.test", "william@example.test"]);
    expect(first).toEqual(buildCommitNotifications(event, state));
    expect(first.every((mail) => mail.status === "captured")).toBe(true);
    expect(first[0].body).toContain("Priority changed: high → urgent");
    expect(buildCommitNotifications({ ...event, id: "event-2" }, state)[0].id).not.toBe(first[0].id);
  });
  it("adds Bryan when another person books work", () => {
    const { state, event } = fixture();
    expect(buildCommitNotifications({ ...event, actorId: "william", actorName: "William" }, state).map((mail) => mail.recipient)).toContain("bryan@example.test");
  });
  it("links directly to the work ID understood by the dashboard", () => {
    vi.stubEnv("APP_URL", "https://calendar.example.test");
    const { state, event } = fixture();
    expect(buildCommitNotifications(event, state)[0].body).toContain(`https://calendar.example.test/?work=${encodeURIComponent(event.itemIds[0])}`);
  });
  it("sends pending approval only to the owner and says no calendar change occurred", () => {
    const { state } = fixture();
    const request = { id: "request-1", requesterName: "William", note: "Client update", createdAt: now, proposal: { summary: ["Needs 2 hours"], conflicts: [{ message: "Protected work would move" }] } } as PendingRequest;
    const mail = buildRequestNotifications(request, state);
    expect(mail.map((message) => message.recipient)).toEqual(["bryan@example.test"]);
    expect(mail[0].body).toContain("has not changed the calendar");
  });
  it("keeps distinct commits distinct and emits a corrective undo message", () => {
    const { state, event } = fixture();
    const messages = buildCommitNotifications({ ...event, id: "undo-1", type: "undo" }, state);
    expect(messages[0].subject).toContain("Change undone");
    expect(messages[0].id).not.toBe(buildCommitNotifications(event, state)[0].id);
  });
  it("only sends drafts for their author after explicit send, never to an injected address", () => {
    const { state } = fixture();
    const draft: EmailDraft = { id: "draft-1", authorId: "bryan", itemId: null, subject: "Update\r\nBcc: outsider@example.com", body: "A draft with outsider@example.com in the text.", status: "draft", createdAt: now };
    expect(() => buildDraftNotifications(draft, state, DEMO_MEMBERS[2])).toThrow();
    const messages = buildDraftNotifications(draft, state, DEMO_MEMBERS[0]);
    expect(messages.map((message) => message.recipient)).toEqual(["kyle@example.test", "william@example.test"]);
    expect(messages[0].subject).not.toMatch(/[\r\n]/);
    expect(() => buildDraftNotifications({ ...draft, status: "sent" }, state, DEMO_MEMBERS[0])).toThrow();
  });
  it("captures email by default without provider credentials or network activity", async () => {
    const { state, event } = fixture();
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_MODE", "capture");
    const message = { ...buildCommitNotifications(event, state)[0], status: "queued" as const };
    expect(await sendNotification(message)).toMatchObject({ status: "captured", attempts: 0 });
    expect(() => buildSendPayload({ ...message, recipient: "bad\nBcc:evil@example.com" }, "ADA <calendar@example.com>")).toThrow();
  });
  it("does not resend uncertain delivery or bypass the development allowlist", async () => {
    const { state, event } = fixture();
    const message = { ...buildCommitNotifications(event, state)[0], status: "uncertain" as const };
    expect(await sendNotification(message, { allowLive: true })).toEqual(message);
    vi.stubEnv("EMAIL_MODE", "test");
    expect(await sendNotification({ ...message, status: "queued" }, { allowLive: true, allowlist: ["someone-else@example.test"] })).toMatchObject({ status: "failed", attempts: 0 });
  });
  it("weekly summaries do not equate elapsed time with completion", () => {
    const { state } = fixture();
    expect(buildWeeklyNotifications(state, new Date(now))[0].body).toContain("No tasks were marked complete");
  });
});

describe("webhook authenticity", () => {
  it("verifies the raw signed body and rejects tampering", () => {
    const secretBytes = Buffer.from("a-local-only-test-signing-key");
    const secret = `whsec_${secretBytes.toString("base64")}`;
    const id = "msg_test";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const payload = JSON.stringify({ type: "email.delivered", created_at: now, data: { email_id: "email-1" } });
    const signature = createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${payload}`).digest("base64");
    const headers = { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` };
    expect(verifyEmailWebhook(payload, headers, secret)).toMatchObject({ type: "email.delivered" });
    expect(() => verifyEmailWebhook(payload.replace("delivered", "bounced"), headers, secret)).toThrow();
    expect(() => verifyEmailWebhook(payload, {}, secret)).toThrow();
  });
});

describe("private attachment scoping", () => {
  it("rejects cross-workspace traversal and unsupported MIME masquerading", () => {
    const { state } = fixture();
    expect(() => attachmentPath("../elsewhere", state.items[0].id, "attachment-1", "notes.md")).toThrow();
    expect(() => validateUpload({ workItemId: state.items[0].id, name: "script.html", contentType: "application/pdf", size: 10 }, state, DEMO_MEMBERS[0])).toThrow();
    expect(() => validateUpload({ workItemId: state.items[0].id, name: "notes.md", contentType: "text/markdown", size: 10 }, state, DEMO_MEMBERS[3])).toThrow();
    expect(() => validateUpload({ workItemId: state.items[0].id, name: "notes.md", contentType: "text/markdown", size: 10 }, state, DEMO_MEMBERS[2])).toThrow();
  });
  it("authorizes only registered, non-removed attachment paths", () => {
    const { state } = fixture();
    const attachment = { id: "attachment-1", workItemId: state.items[0].id, name: "notes.md", contentType: "text/markdown", size: 10, path: attachmentPath(state.workspaceId, state.items[0].id, "attachment-1", "notes.md"), uploadedBy: "bryan", createdAt: now, removedAt: null };
    expect(() => authorizeAttachmentAccess(attachment, state, DEMO_MEMBERS[0])).toThrow();
    state.attachments.push(attachment);
    expect(() => authorizeAttachmentAccess(attachment, state, DEMO_MEMBERS[3])).not.toThrow();
    expect(() => authorizeAttachmentAccess({ ...attachment, path: `another-workspace/${attachment.path}` }, state, DEMO_MEMBERS[0])).toThrow();
    expect(() => authorizeAttachmentAccess({ ...attachment, removedAt: now }, state, DEMO_MEMBERS[0])).toThrow();
  });
});
