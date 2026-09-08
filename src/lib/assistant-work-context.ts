import type { Client } from "./types";

const normalized = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const mentions = (text: string, value: string) => Boolean(normalized(value)) && ` ${normalized(text)} `.includes(` ${normalized(value)} `);

/** Recognize unavailable effort/dependencies, not an invitation to guess hours. */
export function waitingWorkRequested(text: string): boolean {
  const source = text.replace(/[’‘]/g, "'");
  if (/\b(?:not|no longer|isn't|aren't|is not|are not)\s+(?:waiting|awaiting|pending|blocked|on hold|unscheduled)\b|\b(?:don't|do not)\s+(?:wait|pause|hold|keep .*?waiting)\b/i.test(source)) return false;
  if (/\b(?:unscheduled|no estimate|without an? estimate|unknown effort|on hold|blocked)\b/i.test(source)) return true;
  if (/\b(?:keep|leave|save|mark|put)\b[^.!?\n]{0,60}\bwaiting\b/i.test(source)) return true;
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
  const months = /\b(?:this month|next month|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
  const span = /\b(?:project\s+(?:context|span|timeline)|span|timeline|rest\s+of|throughout|ongoing)\b|\b(?:work(?:ing)?|project)\b[^.!?\n]{0,60}\b(?:runs?|spans?|continues?|through|during|for)\b/i;
  // Bind months to the same statement as the project span. An unrelated invoice
  // month elsewhere in the description must not become a calendar endpoint.
  const statements = text.split(/[.!?\n;]+/).filter(statement => months.test(statement) && span.test(statement));
  return statements.length ? statements.join(". ") : null;
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
  if (!title || !client || actionCount !== 1 || combined === latest || !combined.endsWith(`\n${latest}`) || latest.length > 400) return quote;
  const prior = combined.slice(0, -latest.length - 1);
  const aliases = [client.name, ...client.aliases];
  // No cross-client borrowing, even when the provider tries to combine identities.
  if (clients.some(candidate => candidate.id !== client.id && [candidate.name, ...candidate.aliases].some(alias => mentions(prior, alias)))) return quote;
  const generic = new Set(["software", "system", "project", "task", "work", "the", "a", "an", "for"]);
  const titleWords = normalized(title).split(" ").filter(word => !generic.has(word));
  const projectNarrative = prior.split(/\b(?:separate|different)\s+(?:task|project)\s+from\b/i)[0];
  if (!titleWords.length || !titleWords.every(word => mentions(projectNarrative, word))) return quote;
  // This fallback is only for one project narrative. A comparison ('separate
  // task from X') is fine, but don't borrow facts from a second project narrative.
  if (/\b(?:another|second|separate|different|other)\s+(?!task\s+from\b|project\s+from\b)[^.!?\n;]{0,80}\b(?:task|project|work item)\b/i.test(prior)) return quote;
  const replyWords = normalized(latest).split(" ");
  const identityWords = new Set([
    ...aliases.flatMap(alias => normalized(alias).split(" ")), ...normalized(title).split(" "),
    "yes", "correct", "right", "it", "s", "is", "its", "this", "that", "a", "an", "the", "new", "separate", "task", "project", "work", "software", "client", "name", "title", "called", "named", "for", "and",
  ]);
  if (!replyWords.every(word => identityWords.has(word))) return quote;
  return combined;
}
