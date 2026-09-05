import { createHash } from "node:crypto";
import { Resend } from "resend";
import type { Actor, AppState, EmailDraft, Notification, PendingRequest, WorkEvent, WorkItem, WorkSession } from "../types";

const emailPattern = /^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/;
const identity = (eventId: string, recipient: string) => createHash("sha256").update(`${eventId}\n${recipient.toLowerCase()}`).digest("hex");
const subjectText = (subject: string) => subject.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
function recipients(members: Actor[]) {
  const unique = new Map<string, Actor>();
  for (const member of members) if (emailPattern.test(member.email)) unique.set(member.email.toLowerCase(), member);
  return [...unique.values()];
}
function link(itemId?: string) {
  const configured = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (!configured) return "Open ADA Calendar to review the current plan.";
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return "Open ADA Calendar to review the current plan.";
    url.pathname = "/"; url.search = itemId ? `?work=${encodeURIComponent(itemId)}` : ""; url.hash = "";
    return `Open ADA Calendar: ${url.toString()}`;
  } catch { return "Open ADA Calendar to review the current plan."; }
}
function notification(eventId: string, member: Actor, subject: string, body: string, state: AppState, createdAt: string): Notification {
  return { id: identity(eventId, member.email), eventId, recipient: member.email.toLowerCase(), recipientName: member.name, subject: subjectText(subject), body,
    status: state.mode === "demo" ? "captured" : "queued", attempts: 0, providerId: null, createdAt, lastError: null };
}
function dateTime(iso: string, state: AppState) {
  const instant = new Date(iso);
  return Number.isNaN(instant.valueOf()) ? iso : new Intl.DateTimeFormat("en-US", { timeZone: state.settings.timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(instant);
}
function duration(minutes: number | null) { return minutes === null ? "not estimated" : `${Math.round(minutes / 60 * 10) / 10}h`; }
function plannedSessions(sessions: WorkSession[], itemId: string, state: AppState) {
  return sessions.filter((session) => session.workItemId === itemId && session.status === "planned")
    .sort((a, b) => a.start.localeCompare(b.start)).map((session) => `${dateTime(session.start, state)} – ${dateTime(session.end, state)}${session.protected ? " (protected)" : ""}`);
}
function itemSummary(item: WorkItem, state: AppState) {
  const client = state.clients.find((client) => client.id === item.clientId)?.name ?? "Client";
  const priority = state.priorities.find((priority) => priority.id === item.priorityId)?.label ?? item.priorityId;
  return `${client} — ${item.title}\nStatus: ${item.status.replaceAll("_", " ")} · Priority: ${priority}\nRemaining work: ${duration(item.remainingMinutes)} · Target: ${item.targetDate ?? "not set"} · Forecast: ${item.forecastDate ?? "not scheduled"}${item.deadline ? ` · Deadline: ${item.deadline}` : ""}${item.progressTotal !== null ? `\nLandings/progress: ${item.progressCompleted}/${item.progressTotal}` : ""}${item.updateDate ? `\nClient update due: ${item.updateDate}` : ""}`;
}

/** A deterministic outbox payload, built only after a committed transaction. */
export function buildCommitNotifications(event: WorkEvent, state: AppState, members: Actor[] = state.members): Notification[] {
  const owner = members.find((member) => member.role === "owner");
  const targets = recipients([...members.filter((member) => member.role === "requester"), ...(owner && owner.id !== event.actorId ? [owner] : [])]);
  const details = event.itemIds.map((itemId) => {
    const before = event.before.items.find((item) => item.id === itemId);
    const after = event.after.items.find((item) => item.id === itemId) ?? state.items.find((item) => item.id === itemId);
    if (!after) return before ? `${before.title}: removed from the current plan.` : null;
    const oldSessions = plannedSessions(event.before.sessions, itemId, state);
    const newSessions = plannedSessions(event.after.sessions, itemId, state);
    const timingChanged = oldSessions.join("|") !== newSessions.join("|");
    const changes = before ? [before.status !== after.status ? `Status changed: ${before.status.replaceAll("_", " ")} → ${after.status.replaceAll("_", " ")}` : null,
      before.forecastDate !== after.forecastDate ? `Forecast changed: ${before.forecastDate ?? "not scheduled"} → ${after.forecastDate ?? "not scheduled"}` : null,
      before.priorityId !== after.priorityId ? `Priority changed: ${before.priorityId} → ${after.priorityId}` : null].filter(Boolean) : ["New work added."];
    return [itemSummary(after, state), ...changes, ...(timingChanged ? [`Previous sessions: ${oldSessions.join("; ") || "none"}`, `Current sessions: ${newSessions.join("; ") || "none"}`] : []), link(itemId)].join("\n");
  }).filter(Boolean);
  const body = [`${event.actorName} updated Bryan's workload.`, ...event.summary, ...details,
    "Project date spans show the active window. Only scheduled work sessions reserve capacity.", `Times shown in ${state.settings.timeZone}.`, `Change reference: ${event.id}`, ...(event.itemIds.length ? [] : [link()])].join("\n\n");
  return targets.map((member) => notification(event.id, member, `ADA Calendar · ${event.type === "undo" || event.type === "schedule_undone" ? "Change undone" : "Workload updated"}`, body, state, event.createdAt));
}

export function buildRequestNotifications(request: PendingRequest, state: AppState): Notification[] {
  const owners = recipients(state.members.filter((member) => member.role === "owner"));
  const body = [`${request.requesterName} submitted work that needs your review.`, ...request.proposal.summary,
    ...request.proposal.conflicts.map((conflict) => conflict.message), ...(request.note ? [`Requester note: ${request.note}`] : []),
    "This request has not changed the calendar. Review its effects before approving it.", link(), `Request reference: ${request.id}`].join("\n\n");
  return owners.map((member) => notification(`request:${request.id}`, member, "ADA Calendar · Work request needs review", body, state, request.createdAt));
}

export function buildWeeklyNotifications(state: AppState, now = new Date()): Notification[] {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: state.settings.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const since = now.valueOf() - 7 * 24 * 60 * 60 * 1000;
  const completed = state.items.filter((item) => item.completedAt && Date.parse(item.completedAt) >= since && Date.parse(item.completedAt) <= now.valueOf());
  const active = state.items.filter((item) => item.status !== "completed" && item.status !== "cancelled");
  const body = [`Bryan's weekly workload update — ${day}`, `Completed this week: ${completed.length}`,
    ...(completed.length ? completed.map((item) => itemSummary(item, state)) : ["No tasks were marked complete this week."]),
    `Open work: ${active.length}`, ...active.map((item) => itemSummary(item, state)),
    "An update date requests a progress report; it does not mean all work in a landing batch is due that day.", link()].join("\n\n");
  return recipients(state.members.filter((member) => member.role === "requester")).map((member) => notification(`weekly:${state.workspaceId}:${day}`, member, "ADA Calendar · Weekly workload update", body, state, now.toISOString()));
}

/** Call only for an explicit Send action, never while interpreting or saving a draft. */
export function buildDraftNotifications(draft: EmailDraft, state: AppState, actor: Actor): Notification[] {
  if (draft.status !== "draft" || draft.authorId !== actor.id || actor.role === "viewer" || !state.members.some((member) => member.id === actor.id && member.role === actor.role)) throw new Error("Only the draft's author can send an unsent draft.");
  if (draft.itemId && !state.items.some((item) => item.id === draft.itemId)) throw new Error("The draft refers to an unavailable task.");
  if (!draft.subject.trim() || !draft.body.trim() || draft.body.length > 12_000) throw new Error("The email needs a subject and body of no more than 12,000 characters.");
  return recipients(state.members.filter((member) => member.role === "requester" || (member.role === "owner" && member.id !== actor.id)))
    .map((member) => notification(`draft:${draft.id}`, member, draft.subject, `${draft.body}\n\n${link(draft.itemId ?? undefined)}`, state, draft.createdAt));
}

export function buildSendPayload(message: Notification, from: string) {
  if (!emailPattern.test(message.recipient) || /[\r\n]/.test(from) || !from.trim()) throw new Error("Invalid email sender or recipient.");
  if (!message.body.trim() || message.body.length > 100_000) throw new Error("Invalid email body.");
  return { from, to: [message.recipient], subject: subjectText(message.subject), text: message.body };
}

/** Delivery is captured unless the server explicitly enables live/allowlisted sends. */
export async function sendNotification(message: Notification, options: { allowLive?: boolean; allowlist?: string[] } = {}): Promise<Notification> {
  if (["captured", "sent", "delivered", "bounced", "uncertain"].includes(message.status)) return message;
  const mode = process.env.EMAIL_MODE ?? "capture";
  if (!options.allowLive || mode === "capture") return { ...message, status: "captured" };
  const allowlist = (options.allowlist ?? (process.env.EMAIL_TEST_ALLOWLIST ?? "").split(",")).map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (mode !== "live" && !(mode === "test" && allowlist.includes(message.recipient.toLowerCase()))) return { ...message, status: "failed", lastError: "Recipient is not allowed by the email delivery mode." };
  if (process.env.NODE_ENV !== "production" && !allowlist.includes(message.recipient.toLowerCase())) return { ...message, status: "failed", lastError: "Development delivery requires an explicit test recipient allowlist." };
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return { ...message, status: "failed", lastError: "Email delivery is not configured." };
  try {
    const payload = buildSendPayload(message, process.env.EMAIL_FROM);
    const resend = new Resend(process.env.RESEND_API_KEY);
    const result = await resend.emails.send(payload, { idempotencyKey: `ada-${message.id}` });
    if (result.error) return { ...message, attempts: message.attempts + 1, status: "failed", lastError: "The email provider rejected delivery. Review delivery settings before retrying." };
    if (!result.data?.id) return { ...message, attempts: message.attempts + 1, status: "uncertain", lastError: "The provider did not return a delivery identifier. Reconcile before retrying." };
    return { ...message, attempts: message.attempts + 1, status: "sent", providerId: result.data.id, lastError: null };
  } catch {
    return { ...message, attempts: message.attempts + 1, status: "uncertain", lastError: "Delivery outcome is unknown. Reconcile with the provider before retrying." };
  }
}

/** Raw body is mandatory. Caller deduplicates svix-id and persists monotonic delivery status. */
export function verifyEmailWebhook(rawBody: string, headers: Record<string, string>, secret: string) {
  if (!secret || !headers["svix-id"] || !headers["svix-timestamp"] || !headers["svix-signature"] || rawBody.length > 1_000_000) throw new Error("Invalid webhook.");
  const resend = new Resend("re_local_signature_verification_only");
  return resend.webhooks.verify({ payload: rawBody, headers: { id: headers["svix-id"], timestamp: headers["svix-timestamp"], signature: headers["svix-signature"] }, webhookSecret: secret });
}

export function deliveryStatusForEvent(type: string): Notification["status"] | null {
  return type === "email.delivered" ? "delivered" : type === "email.bounced" ? "bounced" : type === "email.failed" || type === "email.complained" ? "failed" : null;
}
