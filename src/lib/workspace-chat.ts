import { z } from "zod";
import { idSchema, reviewFingerprintSchema } from "./schemas";
import { isDate } from "./time";
import type { AppState, ScheduleProposal } from "./types";

/** Separate from Ask ADA: this surface never accepts task-creation commands. */
export const workspaceChatRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("message"), text: z.string().trim().min(1).max(6000), operationId: idSchema,
    replyToOperationId: idSchema.optional(), date: z.string().refine(isDate, "Choose a valid calendar day.").optional() }).strict(),
  z.object({ action: z.literal("confirm"), operationId: idSchema, baseVersion: z.number().int().nonnegative(),
    reviewFingerprint: reviewFingerprintSchema }).strict(),
]);
export type WorkspaceChatRequest = z.infer<typeof workspaceChatRequestSchema>;
export interface WorkspaceChatSource { kind: "work" | "note" | "request" | "schedule"; id: string; title: string }
export interface WorkspaceChatChange {
  sessionId: string; workItemId: string; title: string; clientName: string;
  beforeStart: string | null; beforeEnd: string | null; afterStart: string | null; afterEnd: string | null;
  kind?: "moved" | "resized" | "added" | "removed";
}
export interface WorkspaceChatDayImpact {
  date: string; beforePlannedMinutes: number; afterPlannedMinutes: number;
  afterAvailableMinutes: number; capacityMinutes: number;
}
export interface WorkspaceChatReply {
  kind: "answer" | "clarification" | "preview";
  message: string; sources: WorkspaceChatSource[];
  proposal?: ScheduleProposal; changes?: WorkspaceChatChange[];
  totals?: { beforeMinutes: number; afterMinutes: number; deltaMinutes: number };
  dayImpacts?: WorkspaceChatDayImpact[];
  details?: string[];
}
export interface WorkspaceChatResponse {
  reply: WorkspaceChatReply; operationId: string; stateVersion: number; asOf: string;
  contextDate?: string;
  state?: AppState; proposal?: ScheduleProposal;
  error?: string; resetNeeded?: boolean; retryWithNewOperation?: boolean;
}

/** Undo in this surface targets a saved helper change, never whichever unrelated
 * workspace event happens to be newest. Persistence makes it survive reloads. */
export function latestWorkspaceChatChange(state: AppState) {
  if (state.actor.role !== "owner") return undefined;
  return state.events.filter(event => event.actorId === state.actor.id &&
    /^chat-order-[a-f0-9]{40}$/.test(event.operationId) && event.type !== "schedule_undone")
    .sort((a, b) => b.version - a.version)[0];
}
