import type { Client } from "./types";
import { unknownProjectEffort, withoutClockRanges } from "./assistant-session-context";

const normalized = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const mentions = (text: string, value: string) => Boolean(normalized(value)) && ` ${normalized(text)} `.includes(` ${normalized(value)} `);
const monthWords = "january|february|march|april|may|june|july|august|september|october|november|december";
const contextStatements = (text: string) => text.split(/[.!?\n;]+|\b(?:and |but )?for now\b|\bwith \d+ hours? (?:of )?work\b/i);
const indirectSpan = (text: string) => /^\s*[>"“”‘’']|\b(?:said|says|wrote|quoted|forwarded|if|maybe|could|would)\b|^\s*(?:should\b|can\s+(?:i|we)\b)/i.test(text);

/** Recognize unavailable effort/dependencies, not an invitation to guess hours. */
export function waitingWorkRequested(text: string): boolean {
  const source = text.replace(/[’‘]/g, "'");
  if (/\b(?:not|no longer|isn't|aren't|is not|are not)\s+(?:waiting|awaiting|pending|blocked|on hold|unscheduled)\b|\b(?:don't|do not)\s+(?:wait|pause|hold|keep .*?waiting)\b/i.test(source)) return false;
  if (unknownProjectEffort(source)) return true;
  if (/\b(?:unscheduled|no estimate|without an? estimate|unknown effort|on hold|blocked)\b/i.test(source)) return true;
  if (/\b(?:keep|leave|save|mark|put)\b[^.!?\n]{0,60}\bwaiting\b|\b(?:add|create|book)\s+(?:it|this|that|the project|the task)\s+as\s+waiting\b/i.test(source)) return true;
  if (/\b(?:awaiting|waiting\s+(?:on|for)|pending)\s+(?:(?:the|their|our|some|more|final|specific)\s+){0,3}(?:client|customer|details|input|approval|access|confirmation|information|them|a dependency)\b/i.test(source)) return true;
  if (/\b(?:dates?|days?|hours?|effort|estimates?|timing|schedule)\b[^.!?\n]{0,65}\b(?:unknown|not yet known|tbd|to be confirmed|not confirmed|undecided|awaiting|pending)\b/i.test(source)) return true;
  return /\b(?:don't|do not|doesn't|does not)\s+know\b[^.!?\n]{0,45}\b(?:dates?|days?|hours?|effort|estimates?)\b/i.test(source);
}

/** A comparison with existing work is not permission to edit that work. */
export function separateWorkRequested(text: string): boolean {
  const source = text.replace(/[’‘]/g, "'");
  if (/\b(?:not|isn't|is not)\s+(?:a\s+)?(?:new|separate|different)\s+(?:task|project)\b/i.test(source)) return false;
  return /\b(?:new|separate|different)\s+(?:(?:software|web|it|landings)\s+)?(?:task|project|work item)\b|\bseparate\s+from\b|\bnot\s+(?:the\s+)?same\s+(?:task|project)\b/i.test(source);
}

/** An incidental month on an invoice or in a quoted note is not a project span. */
export function projectMonthEvidence(text: string): string | null {
  const months = /\b(?:\d{4}-\d{2}-\d{2}|today|tomorrow|this month|next month|january|february|march|april|may|june|july|august|september|october|november|december|end of (?:the |this )?year|year[- ]end)\b/i;
  const span = /\b(?:project\s+(?:context|span|timeline)|span|timeline|rest\s+of|throughout|ongoing|months of|end of (?:the |this )?year|year[- ]end)\b|\b(?:work(?:ing)?|project|(?:add|keep|show|leave|book|create|set) (?:it|this|that))\b[^.!?\n]{0,60}\b(?:runs?|spans?|continues?|through|during|for|from|until|to)\b/i;
  // Bind months to the same statement as the project span. An unrelated invoice
  // month elsewhere in the description must not become a calendar endpoint.
  const statements = contextStatements(withoutClockRanges(text)).filter(statement => months.test(statement) && span.test(statement.replace(/\bfrom start to finish\b/gi, ""))
    && !/^\s*[>"“]|\b(?:said|wrote|quoted|forwarded|invoice|receipt)\b/i.test(statement));
  return statements.length ? statements.join(". ") : null;
}

/** A date/status-only answer can fill the pending project, not introduce work. */
export function projectSpanReplyEvidence(text: string): string | null {
  if (indirectSpan(text) || /\b(?:not|don't|never|another|separate|different|instead of)\b/i.test(text)) return null;
  // Explanatory prose after a completed field answer does not introduce a new
  // subject. Keep it in the evidence so the date parser still rejects any
  // competing dates; it never authorizes sessions through this helper.
  const words = normalized(text.split(/\b(?:and|but)\s+(?:(?:as|when|once)\s+)?(?:i|we)\b/i)[0]).split(" ");
  const allowed = new Set(("please add create book keep leave show set mark it this that the same task project work as waiting unscheduled with no estimate unknown hours total effort from to until till through thru starting start starts ending end ends of on for and between today tomorrow now current next month months year january february march april may june july august september october november december rest remainder beginning first last day date dates is are should be sorry actually correction meant i instead only just use change make span spans timeline display by can you runs run continues continue").split(" "));
  if (!words.length || !words.every(word => allowed.has(word) || /^\d+(?:st|nd|rd|th)?$/.test(word))) return null;
  if (!/\b(?:from|through|thru|until|till|to|between|rest|remainder|end|ending|span|timeline)\b/i.test(text)) return null;
  if (!/\b(?:today|tomorrow|month|year|january|february|march|april|may|june|july|august|september|october|november|december|\d{4}-\d{2}-\d{2})\b/i.test(text)) return null;
  return text;
}

/** Prove that a field-only answer belongs to this one unfinished project. */
function pendingProjectMatches(prior: string, title: string | null, client: Client | null, clients: Client[]): boolean {
  if (!title || !client) return false;
  if (clients.some(candidate => candidate.id !== client.id && [candidate.name, ...candidate.aliases].some(alias => mentions(prior, alias)))) return false;
  const generic = new Set(["software", "system", "project", "task", "work", "the", "a", "an", "for"]);
  const titleWords = normalized(title).split(" ").filter(word => !generic.has(word));
  const projectNarrative = prior.split(/\b(?:separate|different)\s+(?:task|project)\s+from\b/i)[0];
  if (!titleWords.length || !titleWords.every(word => mentions(projectNarrative, word))) return false;
  return !/\b(?:another|second|separate|different|other)\s+(?!task\s+from\b|project\s+from\b)[^.!?\n;]{0,80}\b(?:task|project|work item)\b/i.test(prior);
}

/**
 * A direct, same-project date answer supersedes old display dates. Longer
 * replies can also correct effort/session details, but their timeline clause
 * must still refer to the pending project, not a different named project.
 */
export function projectSpanCorrectionEvidence(reply: string, prior: string, title: string | null, client: Client | null, clients: Client[]): string | null {
  if (!pendingProjectMatches(prior, title, client, clients) || indirectSpan(reply)) return null;
  if (clients.some(candidate => candidate.id !== client!.id && [candidate.name, ...candidate.aliases].some(alias => mentions(reply, alias)))) return null;
  // Repeating this exact client's or project's name is still a field answer.
  // Remove only grounded identity strings, never arbitrary nouns supplied by
  // extraction (which could describe a different project).
  const identities = [client!.name, ...client!.aliases, title!].filter(Boolean).sort((a, b) => b.length - a.length);
  const scopedReply = identities.reduce((source, identity) => {
    const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return source.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "giu"), "$1it");
  }, reply);
  const evidence = projectSpanReplyEvidence(scopedReply) ?? projectMonthEvidence(scopedReply);
  if (!evidence) return null;
  const statements = contextStatements(evidence).filter(statement => statement.trim());
  // Do not fall back from a rejected bounded answer to arbitrary month prose.
  // Every date-bearing clause must be a direct field answer. Other names or
  // subjects cannot be laundered into the pending action by sourceQuote.
  return statements.length && statements.every(statement => projectSpanReplyEvidence(statement)) ? evidence : null;
}

/** Dates for other fields must have their own purpose, not just appear in a span. */
export function projectDateFieldEvidence(text: string, field: "deadline" | "targetDate" | "updateDate" | "allowedDates"): string {
  const cue = {
    deadline: /\b(?:deadline|due(?: date)?|must (?:be )?(?:done|finished|complete[dt]?) by)\b/i,
    targetDate: /\b(?:target(?: date| finish)?|aim(?:ing)? (?:for|to finish)|hope to finish)\b/i,
    updateDate: /\b(?:checkpoint|update(?: date)?|follow[- ]up|check[- ]in)\b/i,
    allowedDates: /\b(?:workdays|working days|allowed (?:dates|days)|only (?:work|book)|(?:work|book) only|sessions?|schedule|reserve)\b/i,
  }[field];
  return contextStatements(text).flatMap(statement => {
    if (indirectSpan(statement)) return [];
    const match = cue.exec(statement);
    if (!match) return [];
    const source = statement.slice(match.index);
    // 'Updates from the client' and timeline prose do not set a checkpoint or
    // workday. Keep the date bound to its field even within a longer sentence.
    const end = source.search(/\b(?:and |but )?(?:show|keep|leave|display|set)\s+(?:it|this|that|the project|the timeline)\b/i);
    const bounded = end < 0 ? source : source.slice(0, end);
    if (projectMonthEvidence(bounded) || projectSpanReplyEvidence(bounded)) return [];
    return new RegExp(`\\b(?:\\d{4}-\\d{2}-\\d{2}|today|tomorrow|${monthWords}|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b`, "i").test(bounded) ? [bounded] : [];
  }).join(". ");
}

/**
 * A model may quote only a short client/title answer. Recover waiting/span facts
 * from the one unfinished instruction, never arbitrary history or ADA's question.
 * This evidence is NOT used to authorize hours, sessions, or protected overrides.
 */
export function retainedCreateEvidence(
  quote: string, combined: string, latest: string, title: string | null,
  client: Client | null, clients: Client[], actionCount: number,
): string {
  if (!title || !client || actionCount !== 1 || combined === latest || !combined.endsWith(`\n${latest}`)) return quote;
  const prior = combined.slice(0, -latest.length - 1);
  if (!pendingProjectMatches(prior, title, client, clients)) return quote;
  if (projectSpanCorrectionEvidence(latest, prior, title, client, clients)) return combined;
  if (latest.length > 400) return quote;
  const aliases = [client.name, ...client.aliases];
  const replyWords = normalized(latest).split(" ");
  const identityWords = new Set([
    ...aliases.flatMap(alias => normalized(alias).split(" ")), ...normalized(title).split(" "),
    "yes", "correct", "right", "it", "s", "is", "its", "this", "that", "a", "an", "the", "new", "separate", "task", "project", "work", "software", "client", "name", "title", "called", "named", "for", "and",
  ]);
  if (!replyWords.every(word => identityWords.has(word))) return quote;
  return combined;
}
