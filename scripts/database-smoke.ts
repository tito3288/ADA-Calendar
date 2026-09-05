/** Integration checks against the isolated local ADA Supabase only. No external email. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "../src/lib/defaults";
import { planCommands } from "../src/lib/scheduler";
import { buildCommitNotifications } from "../src/lib/server/email";
import type { Actor, AppState, ScheduleProposal, ScheduleSnapshot, WorkEvent, WorkItem } from "../src/lib/types";

async function main() {
  const output = execFileSync("node_modules/.bin/supabase", ["status", "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const settings = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)) as Record<string, string>;
  assert.equal(settings.API_URL, "http://127.0.0.1:55421", "Tests refuse every non-local/non-ADA endpoint.");
  const api = settings.API_URL;
  const admin = createClient(api, settings.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const workspaceId = randomUUID();
  const actors: Actor[] = [];
  const uploadedPaths: string[] = [];
  const webhookReceipts: string[] = [];
  const sessions = new Map<string, typeof admin>();
  const now = new Date().toISOString();
  const prefix = `ada-test-${randomUUID().slice(0,8)}`;
  const checked = <T extends { error: { message: string } | null }>(result: T): T => { assert.equal(result.error, null, result.error?.message ?? "Provider operation failed"); return result; };
  try {
    const publicClient = createClient(api, settings.ANON_KEY, { auth: { persistSession: false } });
    const signup = await publicClient.auth.signUp({ email: `${prefix}-uninvited@example.invalid`, password: `${randomUUID()}Aa1!` });
    if (signup.data.user) await admin.auth.admin.deleteUser(signup.data.user.id);
    assert.ok(signup.error, "Public signup must be disabled while invited email login remains enabled.");
    for (const [name, role] of [["Bryan", "owner"], ["Kyle", "requester"], ["William", "requester"], ["Observer", "viewer"]] as const) {
      const email = `${prefix}-${name.toLowerCase()}@example.invalid`;
      const password = `${randomUUID()}Aa1!`;
      const created = checked(await admin.auth.admin.createUser({ email, password, email_confirm: true }));
      const actor: Actor = { id: created.data.user!.id, name, role, email };
      actors.push(actor);
      const client = createClient(api, settings.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      checked(await client.auth.signInWithPassword({ email, password }));
      sessions.set(actor.id, client);
    }
    checked(await admin.from("workspaces").insert({ id: workspaceId, settings: DEFAULT_SETTINGS, priorities: DEFAULT_PRIORITIES, clients: [{ id: "test-client", name: "Test Client", aliases: [] }] }));
    checked(await admin.from("workspace_members").insert(actors.map((actor) => ({ workspace_id: workspaceId, user_id: actor.id, name: actor.name, email: actor.email, role: actor.role }))));
    const [owner, kyle, william, viewer] = actors;
    let state: AppState = { workspaceId, version: 0, settings: DEFAULT_SETTINGS, priorities: DEFAULT_PRIORITIES, clients: [{ id: "test-client", name: "Test Client", aliases: [] }], actor: owner, members: actors, items: [], sessions: [], blocks: [], events: [], requests: [], notifications: [], attachments: [], emailDrafts: [], aiUsageUsd: 0, mode: "live" };
    const item = (title: string): WorkItem => ({ id: randomUUID(), clientId: "test-client", title, description: "Integration fixture", category: "web", webKind: "edit", requesterId: null, requestedBy: "Bryan", priorityId: "normal", requestedPriorityId: null, status: "planned", estimatedMinutes: 30, remainingMinutes: 30, windowStart: "2030-09-09", windowEnd: null, targetDate: null, deadline: null, forecastDate: null, completedAt: null, blockedReason: null, minimumSessionMinutes: 15, allowedDates: [], checklist: [], progressTotal: null, progressCompleted: 0, updateDate: null, references: [], createdAt: now, updatedAt: now });
    const proposed = (actor: Actor, title: string) => planCommands(state, [{ type: "create", item: item(title) }], actor, { now });
    const commit = async (actor: Actor, p: ScheduleProposal) => {
      const event: WorkEvent = { id: randomUUID(), operationId: p.operationId, actorId: actor.id, actorName: actor.name, type: "schedule_changed", summary: p.summary, itemIds: p.affectedItemIds, createdAt: now, version: state.version + 1, before: { items: state.items, sessions: state.sessions, blocks: state.blocks }, after: { items: p.items, sessions: p.sessions, blocks: p.blocks }, undoneBy: null };
      return sessions.get(actor.id)!.rpc("commit_schedule", { p_proposal: p, p_event: event, p_notifications: buildCommitNotifications(event, { ...state, actor }) });
    };
    const first = proposed(kyle, "First clean-fit request");
    assert.equal(first.status, "ready");
    checked(await commit(kyle, first));
    assert.equal((await admin.from("notifications").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId)).count, 3);
    checked(await commit(kyle, first)); // Same operation cannot enqueue a duplicate event/email.
    assert.equal((await admin.from("work_events").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId)).count, 1);
    assert.ok((await commit(william, first)).error, "Cross-actor operation replay must fail.");
    state = { ...state, items: first.items, sessions: first.sessions, blocks: first.blocks, version: 1 };
    assert.ok((await sessions.get(kyle.id)!.from("workspaces").update({ items: [] }).eq("id", workspaceId)).error, "Direct table writes must fail.");
    assert.ok((await commit(viewer, proposed(viewer, "Viewer writes"))).error, "Viewer RPC writes must fail.");
    const malicious = proposed(kyle, "Malicious edit");
    malicious.items[0].title = "Changed existing work";
    assert.ok((await commit(kyle, malicious)).error, "Requester must not edit an existing item.");
    const protectedRequest = proposed(kyle, "Unauthorized protection");
    protectedRequest.sessions.at(-1)!.protected = true;
    assert.ok((await commit(kyle, protectedRequest)).error?.message.includes("protected or historical"), "Direct requester RPC cannot manufacture protected work.");
    const historicalRequest = proposed(kyle, "Unauthorized completion history");
    historicalRequest.sessions.at(-1)!.status = "completed";
    assert.ok((await commit(kyle, historicalRequest)).error?.message.includes("protected or historical"), "Direct requester RPC cannot manufacture completed sessions.");
    assert.ok((await sessions.get(kyle.id)!.rpc("commit_schedule_transaction", { p_proposal: protectedRequest, p_event: {} })).error, "Requesters cannot bypass the public RPC guard by calling its internal transaction.");
    const concurrent = [proposed(kyle, "Concurrent A"), proposed(william, "Concurrent B")];
    const outcomes = await Promise.all([commit(kyle, concurrent[0]), commit(william, concurrent[1])]);
    assert.equal(outcomes.filter((result) => !result.error).length, 1, "Exactly one stale same-slot proposal may commit.");
    assert.ok(outcomes.find((result) => result.error)?.error?.message.includes("Schedule changed"));
    const winner = outcomes[0].error ? concurrent[1] : concurrent[0];
    state = { ...state, items: winner.items, sessions: winner.sessions, blocks: winner.blocks, version: 2 };
    const overlapping = proposed(owner, "Overlapping work");
    overlapping.sessions.at(-1)!.start = state.sessions[0].start;
    overlapping.sessions.at(-1)!.end = state.sessions[0].end;
    assert.ok((await commit(owner, overlapping)).error, "Database exclusion must reject overlap even if server planning is bypassed.");
    const aiId = randomUUID();
    const aiHash = createHash("sha256").update("fixture").digest("hex");
    const ai = sessions.get(owner.id)!;
    const aiArgs = { p_actor: owner.id, p_id: aiId, p_kind: "assistant", p_input_hash: aiHash, p_reserve_usd: 0.1 };
    assert.ok((await ai.rpc("begin_ai_operation", aiArgs)).error, "Browser-authenticated callers cannot fabricate AI reservations or results.");
    assert.equal(checked(await admin.rpc("begin_ai_operation", aiArgs)).data.status, "claimed");
    assert.equal(checked(await admin.rpc("begin_ai_operation", aiArgs)).data.status, "processing");
    assert.ok((await ai.rpc("finish_ai_operation", { p_actor: owner.id, p_id: aiId, p_result: {}, p_cost_usd: 0 })).error, "Authenticated callers cannot invent zero-cost settlements.");
    assert.ok((await ai.rpc("mutate_workspace", { p_action: { type: "settle_ai", reservationId: aiId, costUsd: 0 }, p_base_version: state.version })).error?.message.includes("server-only"), "The generic workspace RPC cannot bypass trusted AI accounting.");
    assert.ok((await ai.rpc("mutate_workspace_transaction", { p_action: { type: "settle_ai", reservationId: aiId, costUsd: 0 }, p_base_version: state.version })).error, "The internal mutation implementation cannot bypass accounting permissions.");
    assert.ok((await admin.rpc("finish_ai_operation", { p_actor: kyle.id, p_id: aiId, p_result: {}, p_cost_usd: 0 })).error, "Trusted server calls still bind the operation to the active actor/workspace.");
    checked(await admin.rpc("finish_ai_operation", { p_actor: owner.id, p_id: aiId, p_result: { kind: "answer", message: "Private fixture" }, p_cost_usd: 0.05 }));
    assert.equal(checked(await admin.rpc("begin_ai_operation", aiArgs)).data.status, "completed");
    assert.equal(checked(await sessions.get(kyle.id)!.from("ai_operations").select("id")).data!.length, 0, "AI results stay private to their author.");
    assert.ok((await admin.rpc("begin_ai_operation", { ...aiArgs, p_id: randomUUID(), p_reserve_usd: 100 })).error, "Budget must reject oversized reservations.");
    const attachmentId = randomUUID();
    const filePath = `${workspaceId}/${state.items[0].id}/${attachmentId}/brief.md`;
    const metadata = { id: attachmentId, workItemId: state.items[0].id, name: "brief.md", contentType: "text/markdown", size: 4, path: filePath, uploadedBy: owner.id, createdAt: now, removedAt: null };
    checked(await ai.rpc("mutate_workspace", { p_action: { type: "attachment", attachment: metadata }, p_base_version: 2 }));
    const signed = checked(await admin.storage.from("work-attachments").createSignedUploadUrl(filePath, { upsert: false }));
    checked(await ai.storage.from("work-attachments").uploadToSignedUrl(filePath, signed.data!.token, new Blob(["test"], { type: "text/markdown" }), { contentType: "text/markdown" }));
    uploadedPaths.push(filePath);
    checked(await ai.rpc("mutate_workspace", { p_action: { type: "complete_attachment", id: attachmentId }, p_base_version: 2 }));
    checked(await ai.storage.from("work-attachments").download(filePath));
    const anonymous = createClient(api, settings.ANON_KEY, { auth: { persistSession: false } });
    assert.ok((await anonymous.storage.from("work-attachments").download(filePath)).error, "Anonymous users cannot read briefs.");
    const pendingProposal = proposed(kyle, "Pending brief");
    const pendingItemId = pendingProposal.commands.find(command => command.type === "create")!.item.id;
    const pendingRequestId = randomUUID();
    checked(await sessions.get(kyle.id)!.rpc("submit_schedule_request", { p_request: { id: pendingRequestId, proposal: pendingProposal, note: "Review this fixture" }, p_notifications: [] }));
    const pendingAttachmentId = randomUUID();
    const pendingPath = `${workspaceId}/${pendingItemId}/${pendingAttachmentId}/pending.md`;
    const pendingMetadata = { ...metadata, id: pendingAttachmentId, workItemId: pendingItemId, path: pendingPath, uploadedBy: kyle.id };
    assert.ok((await sessions.get(william.id)!.rpc("mutate_workspace", { p_action: { type: "attachment", attachment: { ...pendingMetadata, uploadedBy: william.id } }, p_base_version: 2 })).error, "Other requesters cannot attach files to private pending work.");
    checked(await sessions.get(kyle.id)!.rpc("mutate_workspace", { p_action: { type: "attachment", attachment: pendingMetadata }, p_base_version: 2 }));
    const pendingSigned = checked(await admin.storage.from("work-attachments").createSignedUploadUrl(pendingPath, { upsert: false }));
    checked(await sessions.get(kyle.id)!.storage.from("work-attachments").uploadToSignedUrl(pendingPath, pendingSigned.data!.token, new Blob(["test"], { type: "text/markdown" }), { contentType: "text/markdown" }));
    uploadedPaths.push(pendingPath);
    assert.ok((await sessions.get(kyle.id)!.storage.from("work-attachments").download(pendingPath)).error, "Unfinalized uploads are not readable.");
    checked(await sessions.get(kyle.id)!.rpc("mutate_workspace", { p_action: { type: "complete_attachment", id: pendingAttachmentId }, p_base_version: 2 }));
    checked(await sessions.get(kyle.id)!.storage.from("work-attachments").download(pendingPath));
    checked(await ai.storage.from("work-attachments").download(pendingPath));
    assert.equal(checked(await sessions.get(william.id)!.from("attachments").select("id").eq("id", pendingAttachmentId)).data!.length, 0, "Pending attachment metadata is author/owner private.");
    assert.ok((await sessions.get(william.id)!.storage.from("work-attachments").download(pendingPath)).error, "Other requesters cannot read a pending request's file.");
    assert.ok((await sessions.get(viewer.id)!.storage.from("work-attachments").download(pendingPath)).error, "Viewers cannot read pending files.");
    const jobs = checked(await admin.rpc("claim_notifications", { p_limit: 20 })).data as Array<{ id: string; workspace_id: string }>;
    const ourJobs = jobs.filter((job) => job.workspace_id === workspaceId);
    assert.equal(ourJobs.length, 6, "Both commits must have durable notifications for both requesters and Bryan.");
    const earlyProviderId = `local-early-${randomUUID()}`;
    webhookReceipts.push(randomUUID());
    checked(await admin.rpc("record_notification_webhook", { p_receipt: webhookReceipts[0], p_provider_id: earlyProviderId, p_status: "delivered" }));
    checked(await admin.rpc("finish_notification", { p_id: ourJobs[1].id, p_status: "sent", p_provider_id: earlyProviderId }));
    assert.equal(checked(await admin.from("notifications").select("status").eq("id", ourJobs[1].id).single()).data!.status, "delivered", "A webhook received before the provider id is saved must reconcile after send completion.");
    const concurrentProviderId = `local-concurrent-${randomUUID()}`;
    const concurrentReceipt = randomUUID(); webhookReceipts.push(concurrentReceipt);
    const callbackRace = await Promise.all([
      admin.rpc("record_notification_webhook", { p_receipt: concurrentReceipt, p_provider_id: concurrentProviderId, p_status: "delivered" }),
      admin.rpc("finish_notification", { p_id: ourJobs[2].id, p_status: "sent", p_provider_id: concurrentProviderId }),
    ]);
    callbackRace.forEach(checked);
    assert.equal(checked(await admin.from("notifications").select("status").eq("id", ourJobs[2].id).single()).data!.status, "delivered", "Concurrent callback and send completion cannot lose a delivery receipt.");
    for (const job of ourJobs) checked(await admin.rpc("finish_notification", { p_id: job.id, p_status: "captured" }));
    assert.equal(checked(await admin.rpc("claim_notifications", { p_limit: 20 })).data.length, 0, "Captured messages are acknowledged in pgmq.");
    const providerId = `local-test-${randomUUID()}`;
    checked(await admin.from("notifications").update({ provider_id: providerId, status: "sent" }).eq("id", ourJobs[0].id));
    webhookReceipts.push(randomUUID(), randomUUID(), randomUUID());
    checked(await admin.rpc("record_notification_webhook", { p_receipt: webhookReceipts[2], p_provider_id: providerId, p_status: "delivered" }));
    const receipt = webhookReceipts[3];
    checked(await admin.rpc("record_notification_webhook", { p_receipt: receipt, p_provider_id: providerId, p_status: "bounced" }));
    checked(await admin.rpc("record_notification_webhook", { p_receipt: receipt, p_provider_id: providerId, p_status: "sent" }));
    checked(await admin.rpc("record_notification_webhook", { p_receipt: webhookReceipts[4], p_provider_id: providerId, p_status: "delivered" }));
    assert.equal(checked(await admin.from("notifications").select("status").eq("id", ourJobs[0].id).single()).data!.status, "bounced", "Late/repeated callbacks cannot clear a bounce.");
    const protectedSession = { ...state.sessions[0], protected: true };
    state.sessions[0] = protectedSession;
    checked(await admin.from("work_sessions").update({ body: protectedSession }).eq("workspace_id", workspaceId).eq("id", protectedSession.id));
    const completeSession = planCommands(state, [{ type: "complete_session", sessionId: protectedSession.id, remainingMinutes: 0 }], owner, { now });
    assert.equal(completeSession.status, "ready");
    checked(await commit(owner, completeSession));
    state = { ...state, items: completeSession.items, sessions: completeSession.sessions, blocks: completeSession.blocks, version: 3 };
    const reuseCompletedTime = proposed(owner, "Reuse explicitly completed time");
    assert.equal(reuseCompletedTime.sessions.at(-1)!.start, protectedSession.start);
    checked(await commit(owner, reuseCompletedTime));
    state = { ...state, items: reuseCompletedTime.items, sessions: reuseCompletedTime.sessions, blocks: reuseCompletedTime.blocks, version: 4 };
    const requesterReserve = proposed(kyle, "Requester cannot consume reserve");
    Object.assign(requesterReserve.sessions.at(-1)!, { start: "2030-09-09T20:00:00.000Z", end: "2030-09-09T20:30:00.000Z", usesReserve: true });
    const reserveDenied = await commit(kyle, requesterReserve);
    assert.ok(reserveDenied.error?.message.includes("reserve interruption time"), "Only Bryan may consume unexpected-work reserve, including for non-IT work.");
    const nonItReserveItem = item("Owner web emergency in reserve");
    const ownerReserve = planCommands(state, [{ type: "create", item: nonItReserveItem, urgent: true, sessions: [{ id: randomUUID(), workItemId: nonItReserveItem.id, start: "2030-09-09T20:00:00.000Z", end: "2030-09-09T20:30:00.000Z", usesReserve: true, protected: false, status: "planned" }] }], owner, { now });
    assert.equal(ownerReserve.status, "ready", "Owner reserve use must not be restricted to the IT category.");
    checked(await commit(owner, ownerReserve));
    state = { ...state, items: ownerReserve.items, sessions: ownerReserve.sessions, blocks: ownerReserve.blocks, version: 5 };
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: state.settings.timeZone }).format(new Date()));
    checked(await admin.from("workspaces").update({ settings: { ...state.settings, weeklyDay: weekday, weeklyTime: "00:00" } }).eq("id", workspaceId));
    assert.equal(checked(await admin.rpc("enqueue_weekly_summaries", { p_app_url: "http://localhost:3000" })).data, 2);
    assert.equal(checked(await admin.rpc("enqueue_weekly_summaries", { p_app_url: "http://localhost:3000" })).data, 0, "Weekly summaries deduplicate by workspace/date/recipient.");
    if (process.env.ADA_WORKER_SMOKE === "true") {
      const expectedWorkerJobs = checked(await admin.from("notifications").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "queued")).count;
      const endpoint = `${api}/functions/v1/notification-worker`;
      assert.equal((await fetch(endpoint, { method: "POST" })).status, 401);
      const headers = { Authorization: "Bearer ada-local-fixture-only-worker-token" };
      assert.equal((await fetch(endpoint, { headers })).status, 405);
      const response = await fetch(endpoint, { method: "POST", headers });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.mode, "capture");
      assert.equal(result.processed, expectedWorkerJobs);
      assert.equal(checked(await admin.from("notifications").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("status", "queued")).count, 0);
      console.log("PASS: local Edge worker HTTP authentication, method restriction, captured queue delivery, and acknowledgment.");
    } else {
      for (const job of checked(await admin.rpc("claim_notifications", { p_limit: 20 })).data as Array<{ id: string }>) checked(await admin.rpc("finish_notification", { p_id: job.id, p_status: "captured" }));
    }
    const historicalRows = Array.from({ length: 1005 }, (_, index) => {
      const start = new Date(Date.UTC(2020, 0, 1 + index, 14)).toISOString();
      const end = new Date(Date.UTC(2020, 0, 1 + index, 14, 15)).toISOString();
      const body = { id: `history-${prefix}-${index}`, workItemId: state.items[0].id, start, end, protected: false, usesReserve: false, status: "completed" };
      return { workspace_id: workspaceId, id: body.id, work_item_id: body.workItemId, starts_at: start, ends_at: end, status: body.status, body };
    });
    checked(await admin.from("work_sessions").insert(historicalRows));
    const fullSnapshot = checked(await ai.rpc("read_schedule_snapshot")).data as ScheduleSnapshot;
    const fullCount = state.sessions.length + historicalRows.length;
    assert.equal(fullSnapshot.sessions.length, fullCount, "Atomic JSON snapshot must include more than the 1,000-row API cap.");
    assert.equal(fullSnapshot.version, state.version);
    const viewerSnapshot = checked(await sessions.get(viewer.id)!.rpc("read_schedule_snapshot")).data as ScheduleSnapshot;
    assert.equal(viewerSnapshot.workspaceId, workspaceId, "Viewer may read their own authorized workspace snapshot.");
    assert.ok((await anonymous.rpc("read_schedule_snapshot")).error, "Anonymous snapshot access is denied.");
    const unbound = checked(await admin.auth.admin.createUser({ email: `${prefix}-unbound@example.invalid`, password: `${prefix}-Fixture-Aa1!`, email_confirm: true }));
    const unboundClient = createClient(api, settings.ANON_KEY, { auth: { persistSession: false } });
    try {
      checked(await unboundClient.auth.signInWithPassword({ email: `${prefix}-unbound@example.invalid`, password: `${prefix}-Fixture-Aa1!` }));
      assert.equal(checked(await unboundClient.rpc("read_schedule_snapshot")).data, null, "An Auth account without membership cannot read a workspace.");
    } finally { await admin.auth.admin.deleteUser(unbound.data.user!.id); }
    state = { ...state, ...fullSnapshot };
    const coherent = proposed(owner, "Coherent version and sessions");
    const newItemId = coherent.commands.find(command => command.type === "create")!.item.id;
    const oldVersion = state.version;
    const observed = await Promise.all([
      commit(owner, coherent).then(checked),
      ...Array.from({ length: 12 }, () => ai.rpc("read_schedule_snapshot").then(checked)),
    ]);
    for (const result of observed.slice(1)) {
      const snapshot = result.data as ScheduleSnapshot;
      assert.ok(snapshot.version === oldVersion || snapshot.version === oldVersion + 1);
      const hasNewItem = snapshot.items.some(candidate => candidate.id === newItemId);
      const hasNewSession = snapshot.sessions.some(candidate => candidate.workItemId === newItemId);
      assert.equal(hasNewItem, snapshot.version === oldVersion + 1, "Snapshot items and version must come from one transaction state.");
      assert.equal(hasNewSession, hasNewItem, "Snapshot sessions and items must come from one transaction state.");
      assert.equal(snapshot.sessions.filter(session => session.id.startsWith(`history-${prefix}-`)).length, 1005);
    }
    assert.equal((checked(await ai.rpc("read_schedule_snapshot")).data as ScheduleSnapshot).sessions.length, fullCount + 1, "Committing after 1,000 history rows must preserve every row.");
    for (const job of checked(await admin.rpc("claim_notifications", { p_limit: 20 })).data as Array<{ id: string }>) checked(await admin.rpc("finish_notification", { p_id: job.id, p_status: "captured" }));
    console.log("PASS: real Auth/RLS; guarded requester permissions; clean-fit/atomic outbox/retries; concurrent stale and overlap rejection; AI privacy/budget; private ready/pending uploads; queue/webhook races; protected completion; owner-only reserve; weekly dedup; atomic coherent snapshot above 1,000 history rows with lossless subsequent commit. No external email sent.");
  } finally {
    // Scope every removal to the random workspace created by this script.
    if (uploadedPaths.length) await admin.storage.from("work-attachments").remove(uploadedPaths);
    if (webhookReceipts.length) await admin.from("webhook_receipts").delete().in("id", webhookReceipts);
    for (const table of ["ai_operations", "ai_usage", "email_drafts", "attachments", "notifications", "pending_requests", "work_events", "work_sessions", "workspace_members", "workspaces"]) {
      const result = await admin.from(table).delete().eq(table === "workspaces" ? "id" : "workspace_id", workspaceId);
      if (result.error) console.error(`Fixture cleanup ${table}: ${result.error.message}`);
    }
    for (const actor of actors) await admin.auth.admin.deleteUser(actor.id);
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Database smoke check failed"); process.exitCode = 1; });
