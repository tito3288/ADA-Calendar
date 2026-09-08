import { z } from "zod";
import type { Interpretation } from "./types";

export const MAX_ASSISTANT_INPUT = 12_000;
export const MAX_CLARIFICATION_TURNS = 8;
const turnSchema = z.object({
  userText: z.string().min(1).max(MAX_ASSISTANT_INPUT),
  question: z.string().min(1).max(4_000),
}).strict();
const continuationSchema = z.object({
  turns: z.array(turnSchema).min(1).max(MAX_CLARIFICATION_TURNS),
  startedAt: z.iso.datetime(),
}).strict();
export type AssistantContinuation = z.infer<typeof continuationSchema>;

export function isConversationCancellation(text: string) {
  return /^(?:please\s+)?(?:cancel(?:\s+(?:that|this|the request))?|never\s*mind|forget (?:that|it)|start over)[.!]?$/i.test(text.trim());
}

/** Only pass a result read from this actor's private, server-written AI ledger. */
export function readContinuation(result: unknown, now: Date, timeZone: string, allowExpiredRetry = false): AssistantContinuation {
  const parsed = z.object({
    interpretation: z.object({ kind: z.literal("clarification") }),
    continuation: continuationSchema,
  }).safeParse(result);
  if (!parsed.success) throw new Error("That instruction is not awaiting a reply. Start a new instruction.");
  const continuation = parsed.data.continuation;
  const age = now.getTime() - Date.parse(continuation.startedAt);
  const day = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  if (!allowExpiredRetry && (age < 0 || age > 24 * 60 * 60 * 1000 || day(now) !== day(new Date(continuation.startedAt))))
    throw new Error("This pending instruction is from an earlier workday. Start a new instruction and confirm the dates.");
  return continuation;
}

function acceptsPendingBacklog(text: string, continuation: AssistantContinuation) {
  // This is a clarification answer, not permission to merge arbitrary new add commands.
  // Match the entire reply so hours, dates, overrides, or a second task cannot be
  // smuggled into the original pending work through this exception.
  const acceptance = text.trim().match(/^(?:please\s+)?(?:add|create)\s+(.+?)\s+for\s+(.+?)(?:\s+now)?\s+as\s+unscheduled\s+work\s+(?:with\s+no|without\s+an?)\s+estimate[.!]?$/i);
  if (!acceptance) return false;
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const title = normalize(acceptance[1]);
  const client = normalize(acceptance[2]);
  if (!title || !client) return false;
  // ADA's question may suggest a title or even the wrong client. It is never
  // authority: require both references together in an earlier user instruction.
  return continuation.turns.some(({ userText }) => {
    const prior = ` ${normalize(userText)} `;
    return prior.includes(` ${title} `) && prior.includes(` ${client} `);
  });
}

function refersToPendingWork(text: string) {
  const reply = text.trim();
  // "Add it for September ..." answers the pending question. Unlike a named
  // add command, the pronoun does not introduce a new work item. This only
  // retains conversation context; the compiler still validates every change.
  if (!/^(?:please\s+)?(?:add|create|book)\s+(?:it|this|that)(?=$|[.!?,]|\s+(?:for|on|from|starting|during|through|until|with|as|now|today|tomorrow|this|next|in|at)\b)/i.test(reply)) return false;
  if (/\b(?:new|another|separate|different|second|additional)\s+(?:(?:software|web|it|landings?)\s+)?(?:task|project|work(?:\s+item)?)\b/i.test(reply)) return false;
  // Do not attach a second named command to the pending instruction merely
  // because the reply starts with a pronoun referring to the first one.
  return !/(?:[.;]\s*|\b(?:and|also|then|plus)\s+)(?:please\s+)?(?:add|create|book|schedule)\s+(?!it\b|this\b|that\b|the\s+(?:same\s+)?(?:task|work)\b)/i.test(reply);
}

export function conversationText(text: string, continuation?: AssistantContinuation) {
  if (continuation && /^(?:(?:instead|actually|also|separately)[,\s]+)?(?:please\s+)?(?:add|create|book|schedule(?!\s+(?:it|that|this|the (?:same )?(?:task|work))\b))\b|^(?:never\s*mind|forget (?:that|it)|cancel that)[,;.]+/i.test(text.trim()) && !acceptsPendingBacklog(text, continuation) && !refersToPendingWork(text))
    throw new Error("That looks like a new task. Use Start a new instruction before sending it; the pending work has not been changed.");
  const combined = [...(continuation?.turns.map(turn => turn.userText) ?? []), text].join("\n");
  if (combined.length > MAX_ASSISTANT_INPUT || (continuation?.turns.length ?? 0) >= MAX_CLARIFICATION_TURNS)
    throw new Error("This clarification has reached its length limit. Start a new instruction with the details collected so far.");
  return combined;
}

export function nextContinuation(text: string, interpretation: Interpretation, now: Date, prior?: AssistantContinuation): AssistantContinuation | null {
  if (interpretation.kind !== "clarification") return null;
  return {
    turns: [...(prior?.turns ?? []), { userText: text, question: interpretation.message.slice(0, 4_000) }],
    startedAt: prior?.startedAt ?? now.toISOString(),
  };
}
