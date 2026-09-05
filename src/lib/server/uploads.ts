import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "../defaults";
import type { Actor, AppState, Attachment } from "../types";

export const ATTACHMENT_BUCKET = "work-attachments";
export const DOWNLOAD_URL_SECONDS = 60;
export const ALLOWED_ATTACHMENT_TYPES: Record<string, string[]> = {
  "image/png": ["png"], "image/jpeg": ["jpg", "jpeg"], "image/webp": ["webp"],
  "application/pdf": ["pdf"], "text/markdown": ["md", "markdown"], "text/plain": ["md", "markdown"],
};
export interface UploadInput { workItemId: string; name: string; contentType: string; size: number }

function validSegment(segment: string) { return /^[a-zA-Z0-9_-]{1,128}$/.test(segment); }
function memberOf(state: AppState, actor: Actor) { return state.members.some((member) => member.id === actor.id && member.role === actor.role); }
/** Pending files stay private to Bryan and the trusted request author until booked. */
export function canAccessAttachmentWork(workItemId: string, state: AppState, actor: Actor): boolean {
  if (!memberOf(state, actor)) return false;
  if (state.items.some(item => item.id === workItemId)) return true;
  return state.requests.some(request =>
    (request.status === "pending" || request.status === "needs_information") &&
    (actor.role === "owner" || request.requesterId === actor.id) &&
    request.proposal.commands.some(command => command.type === "create" && command.item.id === workItemId));
}
export function attachmentPath(workspaceId: string, itemId: string, attachmentId: string, fileName: string) {
  if (![workspaceId, itemId, attachmentId].every(validSegment)) throw new Error("Invalid attachment scope.");
  const file = fileName.normalize("NFKC").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(-140);
  if (!file || file === "." || file === "..") throw new Error("Invalid attachment filename.");
  return `${workspaceId}/${itemId}/${attachmentId}/${file}`;
}
export function validateUpload(input: UploadInput, state: AppState, actor: Actor): void {
  if (!memberOf(state, actor) || actor.role === "viewer") throw new Error("You cannot upload files to this workspace.");
  const item = state.items.find((item) => item.id === input.workItemId);
  const pending = state.requests.find(request =>
    (request.status === "pending" || request.status === "needs_information") &&
    request.proposal.commands.some(command => command.type === "create" && command.item.id === input.workItemId));
  if (!item && !pending) throw new Error("The task is unavailable.");
  if (actor.role !== "owner" && (item ? item.requesterId !== actor.id : pending?.requesterId !== actor.id)) throw new Error("You can attach files only to work you requested.");
  if (state.attachments.filter((attachment) => attachment.workItemId === input.workItemId && !attachment.removedAt).length >= MAX_ATTACHMENTS) throw new Error(`A task can have at most ${MAX_ATTACHMENTS} attachments.`);
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > MAX_ATTACHMENT_BYTES) throw new Error("Each attachment must be between 1 byte and 20 MB.");
  if (state.attachments.filter(attachment => attachment.workItemId === input.workItemId && !attachment.removedAt).reduce((total, attachment) => total + attachment.size, 0) + input.size > MAX_ATTACHMENT_BYTES) throw new Error("A work item allows 20 MB of attachments in total.");
  if (!input.name.trim() || input.name.length > 200 || /[\u0000-\u001f\u007f/\\]/.test(input.name)) throw new Error("Invalid filename.");
  const extension = input.name.split(".").at(-1)?.toLowerCase() ?? "";
  if (!ALLOWED_ATTACHMENT_TYPES[input.contentType]?.includes(extension)) throw new Error("Use Markdown, PDF, PNG, JPEG, or WebP with the matching extension.");
}
export function authorizeAttachmentAccess(attachment: Attachment, state: AppState, actor: Actor): void {
  if (attachment.removedAt || !canAccessAttachmentWork(attachment.workItemId, state, actor)) throw new Error("Attachment unavailable.");
  if (!state.attachments.some((existing) => existing.id === attachment.id && existing.path === attachment.path && !existing.removedAt)) throw new Error("Attachment unavailable.");
  const expectedPrefix = `${state.workspaceId}/${attachment.workItemId}/${attachment.id}/`;
  if (!attachment.path.startsWith(expectedPrefix) || attachment.path.split("/").some(segment => segment === "." || segment === "..") || attachment.path.slice(expectedPrefix.length).includes("/")) throw new Error("Invalid attachment scope.");
}
export function authorizeAttachmentRemoval(attachment: Attachment, state: AppState, actor: Actor): void {
  authorizeAttachmentAccess(attachment, state, actor);
  if (actor.role !== "owner" && !(actor.role === "requester" && attachment.uploadedBy === actor.id)) throw new Error("Only Bryan or the uploader can remove this attachment.");
}

/** Reserve metadata atomically before invoking this helper; bucket limits enforce size/MIME again. */
export async function createAttachmentUploadUrl(client: SupabaseClient, input: UploadInput, state: AppState, actor: Actor, id = randomUUID()) {
  validateUpload(input, state, actor);
  const path = attachmentPath(state.workspaceId, input.workItemId, id, input.name);
  const { data, error } = await client.storage.from(ATTACHMENT_BUCKET).createSignedUploadUrl(path, { upsert: false });
  if (error || !data) throw new Error("Could not prepare the file upload.");
  return { id, path, token: data.token, signedUrl: data.signedUrl };
}
export async function createAttachmentDownloadUrl(client: SupabaseClient, attachment: Attachment, state: AppState, actor: Actor) {
  authorizeAttachmentAccess(attachment, state, actor);
  const { data, error } = await client.storage.from(ATTACHMENT_BUCKET).createSignedUrl(attachment.path, DOWNLOAD_URL_SECONDS, { download: attachment.name });
  if (error || !data) throw new Error("Could not prepare a download link.");
  return { url: data.signedUrl, expiresIn: DOWNLOAD_URL_SECONDS };
}
