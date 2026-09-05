import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { currentActor, demoEnabled, store } from "@/lib/server/service";
import { demoDirectory, getDemoUploadReservation } from "@/lib/server/demo-store";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/server/supabase";
import { planCommands } from "@/lib/scheduler";
import { transcriptionEstimatedUsd, transcriptionReservationUsd } from "@/lib/ai-cost";
import { commandRequestSchema, commandSchema, clientSchema, settingsSchema, prioritySchema, idSchema, reviewFingerprintSchema } from "@/lib/schemas";
import { interpretInput, transcribeAudio, inspectAudioRecording, assistantReservationUsd } from "@/lib/server/assistant";
import { verifyEmailWebhook, deliveryStatusForEvent } from "@/lib/server/email";
import { attachmentPath, validateUpload, authorizeAttachmentAccess } from "@/lib/server/uploads";
import { PreviewChangedError, withReviewFingerprint } from "@/lib/server/preview";
import type { Attachment, EmailDraft, Interpretation, WorkCommand } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;
type RouteContext = { params: Promise<{ path: string[] }> };
const failure = (error: unknown, status = 400) => NextResponse.json({ error: error instanceof z.ZodError ? error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(" ") : error instanceof Error ? error.message : "The operation could not be completed." }, { status });
function checkOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  const expected = new URL(process.env.APP_URL || req.url).origin;
  if (!origin || (origin !== expected && !(demoEnabled() && origin === new URL(req.url).origin))) throw new Error("Request origin could not be verified.");
}
async function json(req: NextRequest) {
  const text = new TextDecoder().decode(await boundedBody(req, 200_000));
  return JSON.parse(text);
}
async function boundedBody(req: NextRequest, limit: number): Promise<Uint8Array> {
  if (Number(req.headers.get("content-length") || 0) > limit) throw new Error("This request is too large.");
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > limit) { await reader.cancel(); throw new Error("This request is too large."); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
function safeName(name: string) { return name.replace(/[\r\n"\\/]/g, "_"); }

export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    const segments = (await ctx.params).path;
    if (segments.join("/") === "auth/callback") {
      const code = req.nextUrl.searchParams.get("code");
      const tokenHash = req.nextUrl.searchParams.get("token_hash");
      const db = await getSupabaseServerClient();
      if (code) { const result = await db.auth.exchangeCodeForSession(code); if (result.error) throw result.error; }
      else if (tokenHash) { const type = z.enum(["email", "invite"]).parse(req.nextUrl.searchParams.get("type") || "email"); const result = await db.auth.verifyOtp({ token_hash: tokenHash, type }); if (result.error) throw result.error; }
      else throw new Error("Sign-in link is missing its verification code.");
      return NextResponse.redirect(new URL("/", process.env.APP_URL || req.url));
    }
    const actor = await currentActor();
    const state = await store.getState(actor.id);
    if (segments[0] === "state") return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
    if (segments[0] === "attachments" && segments[1]) {
      const attachment = state.attachments.find(a => a.id === segments[1] && !a.removedAt);
      if (!attachment) return failure(new Error("Attachment not found."), 404);
      authorizeAttachmentAccess(attachment, state, actor);
      if (!demoEnabled()) {
        const db = await getSupabaseServerClient();
        const { data, error } = await db.storage.from("work-attachments").createSignedUrl(attachment.path, 60, { download: req.nextUrl.searchParams.get("download") === "1" ? attachment.name : false });
        if (error) throw error;
        return NextResponse.redirect(data.signedUrl);
      }
      const buffer = await readFile(path.join(demoDirectory(), "files", attachment.id));
      return new NextResponse(buffer, { headers: {
        "Content-Type": attachment.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `${req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline"}; filename="${safeName(attachment.name)}"`,
        "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      } });
    }
    return failure(new Error("Not found."), 404);
  } catch (error) { return failure(error, 401); }
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    const route = (await ctx.params).path.join("/");
    if (route === "email/webhook") {
      const event = verifyEmailWebhook(new TextDecoder().decode(await boundedBody(req, 1_000_000)), Object.fromEntries(req.headers), process.env.RESEND_WEBHOOK_SECRET || "");
      const status = deliveryStatusForEvent(event.type);
      if (!status) return NextResponse.json({ ok: true });
      const providerId = "email_id" in event.data ? event.data.email_id : null;
      if (typeof providerId !== "string") throw new Error("Webhook is missing an email identifier.");
      const db = getSupabaseAdminClient();
      const { error } = await db.rpc("record_notification_webhook", { p_receipt: req.headers.get("svix-id"), p_provider_id: providerId, p_status: status, p_error: status === "failed" || status === "bounced" ? event.type : null });
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }
    checkOrigin(req);
    if (route === "demo/actor") {
      if (!demoEnabled()) return failure(new Error("Demo access is disabled."), 404);
      const input = z.object({ id: z.enum(["bryan", "kyle", "william", "viewer"]) }).parse(await json(req));
      (await cookies()).set("ada-demo-actor", input.id, { httpOnly: true, sameSite: "strict", path: "/" });
      return NextResponse.json({ ok: true });
    }
    if (route === "auth/login") {
      const input = z.object({ email: z.email() }).parse(await json(req));
      const db = await getSupabaseServerClient();
      const { error } = await db.auth.signInWithOtp({ email: input.email, options: { shouldCreateUser: false, emailRedirectTo: `${process.env.APP_URL}/api/auth/callback` } });
      if (error) throw new Error("Unable to send a sign-in link. Check that your account has been invited.");
      return NextResponse.json({ message: "Check your email for a private sign-in link." });
    }
    const actor = await currentActor();
    let state = await store.getState(actor.id);
    if (route === "auth/logout") { if (!demoEnabled()) await (await getSupabaseServerClient()).auth.signOut(); return NextResponse.json({ ok: true }); }
    if (actor.role === "viewer") return failure(new Error("Viewers have read-only access."), 403);
    if (route === "commands") {
      const input = commandRequestSchema.parse(await json(req));
      const proposal = withReviewFingerprint(planCommands(state, input.commands, actor, { operationId: input.operationId, approveDisplacement: actor.role === "owner" }));
      if (input.action === "preview") return NextResponse.json({ proposal });
      const prior = state.events.find(event => event.operationId === input.operationId);
      if (input.baseVersion !== undefined && input.baseVersion !== state.version && !prior) return NextResponse.json({ error: "The schedule changed. Review this updated preview.", state, proposal }, { status: 409 });
      const priorRequest = input.action === "request" && state.requests.some(request => request.id === input.operationId);
      if (!prior && !priorRequest && input.reviewFingerprint !== proposal.reviewFingerprint) return NextResponse.json({ error: "The reviewed plan changed or is missing. Review this fresh preview before saving.", state, proposal }, { status: 409 });
      state = input.action === "request" ? await store.request(actor, proposal, input.note) : await store.commit(actor, proposal);
      return NextResponse.json({ state, proposal });
    }
    if (route === "requests/resolve") {
      if (actor.role !== "owner") throw new Error("Only Bryan may approve changes to existing work.");
      const input = z.object({ id: idSchema, decision: z.enum(["approved", "declined", "needs_information"]), note: z.string().max(5000).optional(), commands: z.array(commandSchema).min(1).max(30).optional(), preview: z.boolean().optional(), baseVersion: z.number().int().nonnegative().optional(), reviewFingerprint: reviewFingerprintSchema.optional() }).strict().parse(await json(req));
      const request = state.requests.find(r => r.id === input.id);
      if (!request) throw new Error("Request not found.");
      const commands = (input.commands ?? request.proposal.commands).map(command => command.type === "create" ? { ...command, item: { ...command.item, requesterId: request.requesterId, requestedBy: request.requesterName } } : command);
      const proposal = withReviewFingerprint(planCommands(state, commands, actor, { operationId: `approve-${input.id}`, approveDisplacement: true }));
      if (input.preview) return NextResponse.json({ state, proposal });
      if (input.decision === "approved" && input.baseVersion !== state.version) return NextResponse.json({ error: "The schedule changed. Review a fresh preview before approving.", state, proposal }, { status: 409 });
      if (input.decision === "approved" && input.reviewFingerprint !== proposal.reviewFingerprint) return NextResponse.json({ error: "The reviewed plan changed or is missing. Review this fresh preview before approving.", state, proposal }, { status: 409 });
      // Retain the version the owner actually reviewed; the store checks it again inside its transaction.
      if (input.decision === "approved") proposal.baseVersion = input.baseVersion!;
      return NextResponse.json({ state: await store.resolve(actor, input.id, input.decision, input.note, proposal) });
    }
    if (route === "undo") {
      const input = z.object({ id: idSchema }).parse(await json(req));
      return NextResponse.json({ state: await store.undo(actor, input.id) });
    }
    if (route === "admin") {
      if (actor.role !== "owner") throw new Error("Only Bryan can manage this workspace.");
      const input = z.discriminatedUnion("type", [
        z.object({ type: z.literal("clients"), clients: z.array(clientSchema).min(1).max(500) }).strict(),
        z.object({ type: z.literal("settings"), settings: settingsSchema }).strict(),
        z.object({ type: z.literal("priorities"), priorities: z.array(prioritySchema).min(1).max(30) }).strict(),
        z.object({ type: z.literal("edit_draft"), id: idSchema, subject: z.string().trim().min(1).max(200).refine(value => !/[\r\n]/.test(value)), body: z.string().trim().min(1).max(12_000) }).strict(),
        z.object({ type: z.literal("send_draft"), id: idSchema, expectedSubject: z.string().min(1).max(200), expectedBody: z.string().min(1).max(12_000) }).strict(),
        z.object({ type: z.enum(["dismiss_draft", "remove_attachment"]), id: idSchema }).strict(),
      ]).parse(await json(req));
      if (input.type === "clients" && state.items.some(i => !input.clients.some(c => c.id === i.clientId))) throw new Error("Keep clients referenced by existing work.");
      if (input.type === "priorities" && state.items.some(i => !input.priorities.some(p => p.id === i.priorityId))) throw new Error("Keep priorities used by existing work.");
      return NextResponse.json({ state: await store.admin(actor, input) });
    }
    if (route === "members/invite") {
      if (actor.role !== "owner") throw new Error("Only Bryan can invite teammates.");
      const input = z.object({ name: z.string().min(1).max(100), email: z.email(), role: z.enum(["requester", "viewer"]) }).strict().parse(await json(req));
      let id: string = randomUUID();
      if (!demoEnabled()) {
        const { data, error } = await getSupabaseAdminClient().auth.admin.inviteUserByEmail(input.email, { redirectTo: `${process.env.APP_URL}/api/auth/callback`, data: { name: input.name } });
        if (error) throw error;
        id = data.user.id;
      }
      return NextResponse.json({ state: await store.admin(actor, { type: "member", member: { id, ...input } }) });
    }
    if (route === "assistant") {
      const input = z.object({ text: z.string().trim().min(1).max(12_000), operationId: idSchema }).strict().parse(await json(req));
      if (!demoEnabled() && !process.env.OPENAI_API_KEY) return failure(new Error("The AI assistant is not connected. Use the manual form."), 503);
      const operation = await store.beginAI(actor, { id: input.operationId, kind: "assistant", inputHash: createHash("sha256").update(input.text).digest("hex"), reserveUsd: demoEnabled() ? 0 : assistantReservationUsd(input.text, state) });
      if (operation.status === "processing") return failure(new Error("This instruction is still processing. Retry with the same operation ID."), 409);
      if (operation.status === "failed") return failure(new Error("The prior attempt did not complete. No new AI call was made. Start a new instruction if you want to try again."), 409);
      let interpretation: Interpretation;
      if (operation.status === "completed") interpretation = (operation.result as { interpretation: Interpretation }).interpretation;
      else {
        try {
          interpretation = await interpretInput(input.text, state, actor, { demo: demoEnabled() });
          await store.finishAI(actor, input.operationId, { interpretation }, demoEnabled() ? undefined : interpretation.usage?.costUsd);
        } catch (error) {
          await store.finishAI(actor, input.operationId, null, undefined, "The AI request did not complete. Its budget reservation was retained.");
          throw error;
        }
      }
      // Extraction is durably cached before effects; retries reuse generated IDs.
      state = await store.getState(actor.id);
      let proposal;
      if (interpretation.kind === "commands") {
        const commands = z.array(commandSchema).min(1).max(30).parse(interpretation.commands) as WorkCommand[];
        proposal = planCommands(state, commands, actor, { operationId: input.operationId, approveDisplacement: actor.role === "owner" });
        if (state.events.some(event => event.operationId === input.operationId) || (proposal.status === "ready" && !proposal.requiresApproval)) state = await store.commit(actor, proposal);
      } else if (interpretation.kind === "email_draft" && interpretation.emailDraft) {
        if (actor.role !== "owner") throw new Error("Only Bryan can draft team update emails.");
        const draftId = `assistant-${createHash("sha256").update(`${actor.id}:${input.operationId}`).digest("hex")}`;
        if (!state.emailDrafts.some(draft => draft.id === draftId)) {
          const draft: EmailDraft = { ...interpretation.emailDraft, subject: interpretation.emailDraft.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 200), id: draftId, authorId: actor.id, status: "draft", createdAt: new Date().toISOString() };
          state = await store.admin(actor, { type: "draft", draft });
        }
      }
      return NextResponse.json({ interpretation, proposal: proposal ? withReviewFingerprint(proposal) : undefined, state });
    }
    if (route === "transcribe") {
      const body = await boundedBody(req, 25 * 1024 * 1024 + 64_000);
      const form = await new Response(body as Uint8Array<ArrayBuffer>, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
      const file = form.get("audio");
      if (!(file instanceof File) || file.size > 25 * 1024 * 1024) throw new Error("Choose a recording under 25 MB.");
      const operationId = idSchema.parse(form.get("operationId"));
      if (demoEnabled()) return failure(new Error("Recorded transcription needs the connected AI service. Type a demo instruction instead."), 503);
      if (!process.env.OPENAI_API_KEY) return failure(new Error("Recorded transcription is not connected. Type your request instead."), 503);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const verified = await inspectAudioRecording(bytes, file.type);
      const operation = await store.beginAI(actor, { id: operationId, kind: "transcribe", inputHash: createHash("sha256").update(file.type).update(bytes).digest("hex"), reserveUsd: transcriptionReservationUsd(verified.durationSeconds) });
      if (operation.status === "completed") return NextResponse.json(operation.result);
      if (operation.status !== "claimed") return failure(new Error("This recording was already submitted. No additional transcription was started."), 409);
      try {
        let costUsd: number | undefined;
        const transcript = await transcribeAudio(bytes, file.type, { clientNames: state.clients.map(c => c.name), onUsage: usage => { if (usage) costUsd = usage.costUsd; } });
        const result = { transcript, durationSeconds: verified.durationSeconds };
        await store.finishAI(actor, operationId, result, costUsd ?? transcriptionEstimatedUsd(verified.durationSeconds));
        return NextResponse.json(result);
      } catch (error) {
        await store.finishAI(actor, operationId, null, undefined, "Transcription did not complete. Its budget reservation was retained.");
        throw error;
      }
    }
    if (route === "attachments/prepare") {
      const input = z.object({ workItemId: idSchema, name: z.string().min(1).max(200), contentType: z.string().min(1).max(100), size: z.number().int().positive().max(20 * 1024 * 1024) }).strict().parse(await json(req));
      validateUpload(input, state, actor);
      const id = randomUUID();
      const attachment: Attachment = { ...input, id, path: attachmentPath(state.workspaceId, input.workItemId, id, input.name), uploadedBy: actor.id, createdAt: new Date().toISOString(), removedAt: null };
      await store.admin(actor, { type: "attachment", attachment });
      if (demoEnabled()) return NextResponse.json({ attachment, uploadUrl: `/api/attachments/upload/${id}` });
      // Signing needs Storage INSERT authority; trusted reservation/limits have already succeeded.
      const { data, error } = await getSupabaseAdminClient().storage.from("work-attachments").createSignedUploadUrl(attachment.path, { upsert: false });
      if (error) { await store.admin(actor, { type: "abort_attachment", id }); throw error; }
      return NextResponse.json({ attachment, uploadUrl: data.signedUrl });
    }
    if (route.startsWith("attachments/upload/")) {
      if (!demoEnabled()) throw new Error("Upload directly to private storage.");
      const id = idSchema.parse(route.split("/")[2]);
      const attachment = await getDemoUploadReservation(actor, id);
      const bytes = await boundedBody(req, 20 * 1024 * 1024);
      if (bytes.byteLength !== attachment.size) throw new Error("The file size does not match its reservation.");
      await mkdir(path.join(demoDirectory(), "files"), { recursive: true });
      await writeFile(path.join(demoDirectory(), "files", id), bytes, { flag: "wx", mode: 0o600 });
      return NextResponse.json({ ok: true });
    }
    if (route === "attachments/complete" || route === "attachments/abort") {
      const input = z.object({ id: idSchema }).parse(await json(req));
      return NextResponse.json({ state: await store.admin(actor, { type: route === "attachments/complete" ? "complete_attachment" : "abort_attachment", id: input.id }) });
    }
    return failure(new Error("Not found."), 404);
  } catch (error) {
    if (error instanceof PreviewChangedError) return NextResponse.json({ error: error.message, proposal: error.proposal }, { status: 409 });
    return failure(error);
  }
}
