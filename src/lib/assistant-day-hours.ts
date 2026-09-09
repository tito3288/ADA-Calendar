import { z } from "zod";
import { isDate } from "./time";

export const assistantDayHoursSchema = z.array(z.object({
  date: z.string(), minutes: z.number().int().min(0).max(480), sourceQuote: z.string(),
}).strict()).max(366);
export type AssistantDayHours = z.infer<typeof assistantDayHoursSchema>;
const words: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: .5, a: 1, an: 1 };

/** A date and its amount must come from the same short user excerpt. */
export function groundedDayHours(rows: AssistantDayHours, source: string, matchesDate: (date: string, quote: string) => boolean, allowZero = false) {
  if (!rows.length) return { days: undefined };
  if (new Set(rows.map(row => row.date)).size !== rows.length || rows.reduce((sum, row) => sum + row.minutes, 0) > 100_000)
    return { error: "Use each work day once and keep the total within 100,000 minutes." };
  for (const row of rows) {
    if (!isDate(row.date) || row.minutes % 15 || (!allowZero && !row.minutes) || !row.sourceQuote.trim()
      || !source.includes(row.sourceQuote) || !matchesDate(row.date, row.sourceQuote))
      return { error: "Please give each day's hours beside its date, using 15-minute increments. I could not verify the proposed daily hours." };
    const amounts = [...row.sourceQuote.matchAll(/\b(\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|half|an?|a)\s*(hours?|hrs?|h|minutes?|mins?)\b/gi)]
      .map(match => (words[match[1].toLowerCase()] ?? Number(match[1])) * (/^(?:h|hour)/i.test(match[2]) ? 60 : 1));
    const removal = allowZero && row.minutes === 0 && /\b(?:remove|clear)\b[^.!?\n]{0,80}\b(?:hours|bookings|sessions|booked time)\b/i.test(row.sourceQuote);
    if ((!removal && (amounts.length !== 1 || amounts[0] !== row.minutes)) || /\b(?:not|don't|do not|never|maybe|might|what if|said|wrote|quoted)\b/i.test(row.sourceQuote)
      || /\b(?:each|every|per)\s+(?:working\s+)?day\b|\bdaily\b/i.test(row.sourceQuote))
      return { error: "Please state one final hours amount for each date; I will not swap, repeat, or invent daily amounts." };
  }
  let unclaimed = source;
  for (const row of rows) unclaimed = unclaimed.replace(row.sourceQuote, "");
  const amount = "(?:\\d+(?:\\.\\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|half|an?)\\s*(?:hours?|hrs?|h|minutes?|mins?)\\b";
  unclaimed = unclaimed.replace(new RegExp(`\\b(?:total(?: effort| estimate)?(?: is| of)?\\s*:?\\s*)${amount}|\\b${amount}\\s+(?:in\\s+)?total\\b`, "gi"), "");
  if (new RegExp(`\\b${amount}`, "i").test(unclaimed))
    return { error: "Include every requested day's hours; the proposal left an hours amount unaccounted for." };
  return { days: rows.map(({ date, minutes }) => ({ date, minutes })).sort((a, b) => a.date.localeCompare(b.date)) };
}

export function dateConstraintEvidence(source: string, field: "earliestStart" | "allowedDates") {
  const pattern = field === "earliestStart"
    ? /\b(?:earliest (?:start|work date)|(?:cannot|can't|do not|must not) (?:start|begin|work) before|(?:start|begin) no earlier than|not before)\b/i
    : /\b(?:allowed (?:work )?(?:dates|days)|(?:can|may|must) only work on|work only on|only work on|restrict(?:ed)? (?:the |this )?(?:project|task|work) to)\b/i;
  return source.split(/[.!?\n]+/).filter(part => pattern.test(part)
    && !/\b(?:said|wrote|quoted|forwarded)\b|^\s*>|\b(?:do not|don't|never|not|no need to)\s+(?:add|set|use|enforce|apply|keep|restrict)\b/i.test(part)).join("\n");
}

export const openEndedProject = (source: string) => /\b(?:no end date|without an? end date|open[- ]ended|indefinitely|until (?:it is |it's )?(?:finished|complete[dt]?|cancelled)|ongoing)\b/i.test(source)
  && !/\b(?:not ongoing|not open[- ]ended)\b/i.test(source);
