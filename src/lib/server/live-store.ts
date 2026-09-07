import "server-only";
import { randomUUID } from "node:crypto";
import type { Actor, AppState, Attachment, Client, EmailDraft, PendingRequest, Priority, ScheduleProposal, ScheduleSnapshot, WorkEvent, WorkspaceSettings } from "../types";
import { planCommands, validateSchedule } from "../scheduler";
import { buildCommitNotifications, buildDraftNotifications, buildRequestNotifications } from "./email";
import { assertLiveActor, requireOwner } from "./auth";
import { getSupabaseAdminClient, getSupabaseServerClient } from "./supabase";
import { assertReviewedProposal } from "./preview";
import type { AIOperationInput, AIOperationResult, PrivateAIOperation } from "./demo-store";

function check(error: { message: string } | null, operation: string) {
  if (error) throw new Error(`${operation}: ${error.message}`);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

export async function getLiveState(actorId: string): Promise<AppState> {
  const actor = await assertLiveActor(actorId);
  const db = await getSupabaseServerClient();
  const memberResult = await db.from("workspace_members").select("workspace_id").eq("user_id", actor.id).eq("active", true).single();
  check(memberResult.error, "Read workspace membership");
  const workspaceId = memberResult.data!.workspace_id as string;
  const result = await Promise.all([
    db.rpc("read_schedule_snapshot"),
    db.from("workspace_members").select("user_id,name,email,role").eq("workspace_id", workspaceId).eq("active", true),
    db.from("work_events").select("body").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(200),
    db.from("pending_requests").select("body").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(200),
    db.from("notifications").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: false }).limit(300),
    db.from("attachments").select("*").eq("workspace_id", workspaceId).is("removed_at", null).eq("upload_status", "ready"),
    db.from("email_drafts").select("*").eq("workspace_id", workspaceId).eq("author_id", actor.id).order("created_at", { ascending: false }).limit(100),
    db.from("ai_usage").select("amount_usd").eq("workspace_id", workspaceId).gte("created_at", new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()),
  ]);
  for (const row of result) check(row.error, "Read live workspace");
  const snapshot = result[0].data as ScheduleSnapshot | null;
  if (!snapshot || snapshot.workspaceId !== workspaceId) throw new Error("Your workspace is no longer available. Sign in again.");
  return {
    ...snapshot,
    actor, members: result[1].data!.map((row) => ({ id: row.user_id, name: row.name, email: row.email, role: row.role })),
    events: result[2].data!.map((row) => row.body), requests: result[3].data!.map((row) => row.body),
    notifications: result[4].data!.map((n) => ({ id: n.id, eventId: n.event_id, recipient: n.recipient, recipientName: n.recipient_name, subject: n.subject, body: n.body, status: n.status, attempts: n.attempts, providerId: n.provider_id, createdAt: n.created_at, lastError: n.last_error })),
    attachments: result[5].data!.map((a) => ({ id: a.id, workItemId: a.work_item_id, name: a.name, contentType: a.content_type, size: Number(a.size), path: a.path, uploadedBy: a.uploaded_by, createdAt: a.created_at, removedAt: a.removed_at })),
    emailDrafts: result[6].data!.map((d) => ({ id: d.id, authorId: d.author_id, itemId: d.item_id, subject: d.subject, body: d.body, status: d.status, createdAt: d.created_at })),
    aiUsageUsd: result[7].data!.reduce((sum, row) => sum + Number(row.amount_usd), 0), mode: "live",
  };
}

function eventFor(state: AppState, proposal: ScheduleProposal, type = "schedule_changed"): WorkEvent {
  return { id: randomUUID(), operationId: proposal.operationId, actorId: state.actor.id, actorName: state.actor.name,
    type, summary: proposal.summary, itemIds: proposal.affectedItemIds, createdAt: new Date().toISOString(), version: state.version + 1,
    before: { items: state.items, sessions: state.sessions, blocks: state.blocks },
    after: { items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks }, undoneBy: null };
}

async function persist(state: AppState, proposal: ScheduleProposal, options: { requestId?: string; undoId?: string; type?: string } = {}) {
  const event = eventFor(state, proposal, options.type);
  const notifications = buildCommitNotifications(event, state);
  const db = await getSupabaseServerClient();
  const { error } = await db.rpc("commit_schedule", {
    p_proposal: proposal, p_event: event, p_notifications: notifications,
    p_request_id: options.requestId ?? null, p_undo_id: options.undoId ?? null,
  });
  check(error, "Save schedule");
  return getLiveState(state.actor.id);
}

export async function commitLiveProposal(actor: Actor, proposal: ScheduleProposal): Promise<AppState> {
  const trusted = await assertLiveActor(actor);
  const state = await getLiveState(trusted.id);
  // Database idempotency remains authoritative even when recent history is truncated.
  const db = await getSupabaseServerClient();
  const previous = await db.from("work_events").select("id,actor_id,operation_payload").eq("workspace_id", state.workspaceId).eq("operation_id", proposal.operationId).maybeSingle();
  check(previous.error, "Check operation");
  if (previous.data) {
    if (previous.data.actor_id !== trusted.id || canonical(previous.data.operation_payload) !== canonical(proposal.commands)) throw new Error("That operation id belongs to a different command or account.");
    return state;
  }
  if (proposal.baseVersion !== state.version) throw new Error("Your calendar changed. Review a fresh proposal before saving.");
  // Never persist model/client supplied sessions directly. Recompute from commands and the latest trusted state.
  const fresh = planCommands(state, proposal.commands, trusted, { operationId: proposal.operationId, approveDisplacement: trusted.role === "owner" });
  assertReviewedProposal(proposal, fresh);
  if (fresh.status !== "ready" || fresh.requiresApproval) throw new Error(fresh.conflicts.map((c) => c.message).join(" ") || "This request needs owner approval or a different opening.");
  return persist(state, fresh);
}

export async function submitLiveRequest(actor: Actor, proposal: ScheduleProposal, note = ""): Promise<AppState> {
  const trusted = await assertLiveActor(actor);
  if (trusted.role !== "requester") throw new Error("Only requesters submit priority requests.");
  const state = await getLiveState(trusted.id);
  const db = await getSupabaseServerClient();
  const [priorEvent, priorRequest] = await Promise.all([
    db.from("work_events").select("actor_id,operation_payload").eq("workspace_id", state.workspaceId).eq("operation_id", proposal.operationId).maybeSingle(),
    db.from("pending_requests").select("requester_id,body").eq("workspace_id", state.workspaceId).eq("id", proposal.operationId).maybeSingle(),
  ]);
  check(priorEvent.error, "Check booking retry"); check(priorRequest.error, "Check request retry");
  if (priorEvent.data) {
    if (priorEvent.data.actor_id !== trusted.id || canonical(priorEvent.data.operation_payload) !== canonical(proposal.commands)) throw new Error("That operation id belongs to a different command or account.");
    return state;
  }
  if (priorRequest.data) {
    if (priorRequest.data.requester_id !== trusted.id || canonical(priorRequest.data.body.proposal.commands) !== canonical(proposal.commands)) throw new Error("That operation id belongs to a different request or account.");
    return state;
  }
  if (proposal.baseVersion !== state.version) throw new Error("The schedule changed. Check availability again.");
  const fresh = planCommands(state, proposal.commands, trusted, { operationId: proposal.operationId });
  assertReviewedProposal(proposal, fresh);
  if (fresh.status === "ready" && !fresh.requiresApproval) return persist(state, fresh);
  const request: PendingRequest = { id: proposal.operationId, requesterId: trusted.id, requesterName: trusted.name, proposal: fresh, status: "pending", note, createdAt: new Date().toISOString(), resolvedAt: null };
  const { error } = await db.rpc("submit_schedule_request", { p_request: request, p_notifications: buildRequestNotifications(request, state) });
  check(error, "Submit priority request");
  return getLiveState(trusted.id);
}

export async function resolveLiveRequest(actor: Actor, requestId: string, decision: "approved" | "declined" | "needs_information", note = "", freshProposal?: ScheduleProposal): Promise<AppState> {
  const trusted = await assertLiveActor(actor); requireOwner(trusted);
  const state = await getLiveState(trusted.id);
  const request = state.requests.find((r) => r.id === requestId);
  if (!request || !["pending", "needs_information"].includes(request.status)) throw new Error("That request is no longer pending.");
  if (decision === "approved") {
    if (!freshProposal || freshProposal.baseVersion !== state.version) throw new Error("The schedule changed or this approval has no current preview. Review the updated impact before approving.");
    const commands = freshProposal.commands.map((command) => command.type === "create" ? { ...command, item: { ...command.item, requesterId: request.requesterId, requestedBy: request.requesterName } } : command);
    const proposal = planCommands(state, commands, trusted, { operationId: `approve/${request.id}`, approveDisplacement: true });
    assertReviewedProposal(freshProposal, proposal);
    if (proposal.status !== "ready" || proposal.requiresApproval) throw new Error(proposal.conflicts.map((c) => c.message).join(" ") || "The request still cannot fit; revise its dates or effort.");
    return persist(state, proposal, { requestId: request.id, type: "request_approved" });
  }
  const db = await getSupabaseServerClient();
  const { error } = await db.rpc("resolve_schedule_request", { p_id: request.id, p_decision: decision, p_note: note });
  check(error, "Resolve priority request");
  return getLiveState(trusted.id);
}

export async function undoLiveEvent(actor: Actor, eventId: string): Promise<AppState> {
  const trusted = await assertLiveActor(actor); requireOwner(trusted);
  const state = await getLiveState(trusted.id);
  const event = state.events.find((e) => e.id === eventId);
  if (!event || event.undoneBy || event.version !== state.version) throw new Error("Only the latest unchanged schedule event can be undone. Older changes need a new scheduling instruction.");
  const invalid = validateSchedule({ ...state, ...event.before });
  if (invalid.length) throw new Error("The original schedule is no longer valid. Use a new scheduling instruction instead of undo.");
  const now = new Date().toISOString();
  if (event.before.sessions.some((s) => s.status === "planned" && s.start < now && !state.sessions.some((current) => current.id === s.id && current.start === s.start && current.end === s.end))) throw new Error("Undo would restore work in the past. Choose a new opening instead.");
  const proposal: ScheduleProposal = { id: randomUUID(), operationId: `undo/${event.id}`, actorId: trusted.id, baseVersion: state.version, commands: [], status: "ready", requiresApproval: false, ...event.before, affectedItemIds: event.itemIds, summary: [`Undid: ${event.summary.join(" ")}`], conflicts: [], alternatives: [], createdAt: new Date().toISOString() };
  return persist(state, proposal, { undoId: event.id, type: "schedule_undone" });
}

export type LiveAdminAction =
  | { type: "clients"; clients: Client[] }
  | { type: "priorities"; priorities: Priority[] }
  | { type: "settings"; settings: WorkspaceSettings }
  | { type: "member"; member: Actor; active?: boolean }
  | { type: "attachment"; attachment: Attachment }
  | { type: "remove_attachment"; id: string }
  | { type: "complete_attachment"; id: string }
  | { type: "abort_attachment"; id: string }
  | { type: "draft"; draft: EmailDraft }
  | { type: "edit_draft"; id: string; subject: string; body: string }
  | { type: "send_draft"; id: string; expectedSubject: string; expectedBody: string }
  | { type: "dismiss_draft"; id: string }
  | { type: "reserve_ai"; reservationId: string; amountUsd: number }
  | { type: "settle_ai"; reservationId: string; costUsd: number };

export async function mutateLiveAdmin(actor: Actor, action: LiveAdminAction): Promise<AppState> {
  const trusted = await assertLiveActor(actor);
  const state = await getLiveState(trusted.id);
  if (!["attachment", "complete_attachment", "abort_attachment", "reserve_ai", "settle_ai"].includes(action.type)) requireOwner(trusted);
  let notifications: AppState["notifications"] = [];
  if (action.type === "settings") {
    const conflicts = validateSchedule({ ...state, settings: action.settings });
    if (conflicts.length) throw new Error("These settings would invalidate existing sessions. Reschedule that work first.");
  }
  if (action.type === "send_draft") {
    const draft = state.emailDrafts.find((d) => d.id === action.id && d.authorId === trusted.id);
    if (draft && (draft.subject !== action.expectedSubject || draft.body !== action.expectedBody)) throw new Error("The email draft changed. Review its current text before sending.");
    if (draft?.status === "sent") return state;
    if (draft?.status !== "draft") throw new Error("Email draft is not available to send.");
    if (!draft) throw new Error("Email draft is not available to send.");
    notifications = buildDraftNotifications(draft, state, trusted);
  }
  const db = await getSupabaseServerClient();
  const { error } = await db.rpc("mutate_workspace", { p_action: action, p_base_version: state.version, p_notifications: notifications });
  check(error, "Update workspace");
  return getLiveState(trusted.id);
}

export async function getLiveAIOperation(actor: Actor, id: string): Promise<PrivateAIOperation> {
  const trusted = await assertLiveActor(actor);
  // Use the signed-in client: RLS also binds the private result to active workspace membership.
  const db = await getSupabaseServerClient();
  const { data, error } = await db.from("ai_operations").select("kind,status,result").eq("id", id).eq("actor_id", trusted.id).maybeSingle();
  check(error, "Read assistant operation");
  if (!data) throw new Error("AI operation is unavailable to this account.");
  return data as PrivateAIOperation;
}

export async function beginLiveAIOperation(actor: Actor, input: AIOperationInput): Promise<AIOperationResult> {
  const trusted = await assertLiveActor(actor);
  const db = getSupabaseAdminClient();
  const { data, error } = await db.rpc("begin_ai_operation", { p_actor: trusted.id, p_id: input.id, p_kind: input.kind, p_input_hash: input.inputHash, p_reserve_usd: input.reserveUsd, p_parent_id: input.parentId ?? null });
  check(error, "Begin assistant operation");
  return data;
}

export async function finishLiveAIOperation(actor: Actor, id: string, result: unknown, costUsd?: number | null, error?: string | null): Promise<void> {
  const trusted = await assertLiveActor(actor);
  const db = getSupabaseAdminClient();
  const response = await db.rpc("finish_ai_operation", { p_actor: trusted.id, p_id: id, p_result: result, p_cost_usd: costUsd ?? null, p_error: error ?? null });
  check(response.error, "Finish assistant operation");
}
