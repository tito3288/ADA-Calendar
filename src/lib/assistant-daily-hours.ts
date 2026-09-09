import { addDays, dayOfWeek, isDate } from "./time";
import type { WorkItem } from "./types";

const number = "(?:\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|an?|a)";
const amount = `(${number})\\s*(hours?|hrs?|h|minutes?|mins?)\\b`;
const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, half: .5 };
const minutes = (value: string, unit: string) => (words[value.toLowerCase()] ?? Number(value)) * (/^(?:h|hour)/i.test(unit) ? 60 : 1);
const dailyWords = /\b(?:each|every|per|a)\s+(?:(?:of\s+)?(?:the|those|these|selected|work|working)\s+)*(?:days?|dates?|weekdays?)\b|\bdaily\b|\/day\b/i;

/** Ground the daily budget in the user's own words, never in model-generated prose. */
export function dailyHoursPlan(source: string, start: string | null, end: string | null, allowedDates: string[], weekdays: number[]): { plan?: WorkItem["dailyPlan"]; total?: number; error?: string } {
  source = source.replace(/\b(one|two|three|four|five|six|seven) and a half\s+(hours?|hrs?)\b/gi, (_, value: string, unit: string) => `${words[value.toLowerCase()] + .5} ${unit}`)
    .replace(/\b(?:an?|one) hour and a half\b/gi, "1.5 hours");
  const daily = dailyWords.test(source);
  const even = /\b(?:evenly|equally)\b/i.test(source) && /\b(?:spread|split|divide|distribute|hours?|minutes?)\b/i.test(source);
  if (!daily && !even) return {};
  if (/\b(?:not|don't|do not)\b[^.!?\n]{0,35}(?:each|every|per day|a day|\/day|daily|evenly|equally)\b/i.test(source))
    return { error: "Should I use a fixed amount each day, or fit the total wherever there is room?" };
  const matches = [...source.matchAll(new RegExp(amount, "gi"))];
  const nearby = matches.filter(match => {
    const following = source.slice(match.index! + match[0].length, match.index! + match[0].length + 65).split(/[.!?\n]/)[0];
    const before = source.slice(Math.max(0, match.index! - 65), match.index!).split(/[.!?\n]/).at(-1) ?? "";
    return dailyWords.test(following) || (dailyWords.test(before) && !new RegExp(amount, "i").test(before));
  });
  const candidates = daily ? nearby : matches;
  const values = [...new Set(candidates.map(match => minutes(match[1], match[2])))];
  if (values.length !== 1) return { error: "How many hours should I book each day? For example, ‘two hours each selected day’, or ‘spread ten hours evenly’." };
  if (!start || !end || !isDate(start) || !isDate(end) || end < start) return { error: "Choose the days for this daily-hours plan, or give its start and end dates." };
  const dates: string[] = [];
  for (let date = start; date <= end && dates.length <= 366; date = addDays(date, 1)) dates.push(date);
  if (dates.length > 366) return { error: "Choose a daily-hours range of at most 366 days." };
  const workdaysOnly = /\b(?:weekdays?|workdays?|working days?|work days?)\b/i.test(source);
  const chosen = dates.filter(date => (!allowedDates.length || allowedDates.includes(date)) && (!workdaysOnly || weekdays.includes(dayOfWeek(date))));
  if (!chosen.length) return { error: "There are no eligible days in that range. Choose working dates for the daily hours." };
  const perDay = even && !daily ? values[0] / chosen.length : values[0];
  if (!Number.isInteger(perDay) || perDay < 15 || perDay > 480 || perDay % 15) return { error: "That split does not make a valid daily amount. Use 15-minute increments, or choose different hours or dates." };
  const total = perDay * chosen.length;
  const totals = [...source.matchAll(new RegExp(`${amount}\\s+(?:in\\s+)?total|total(?:\\s+(?:of|is|effort|hours))?\\s*:?\\s*${amount}`, "gi"))]
    .map(match => minutes(match[1] ?? match[3], match[2] ?? match[4]));
  for (const match of source.matchAll(new RegExp(`(?:equals?|add(?:s)? up to|total(?:s|ing)?)\\s+${amount}`, "gi"))) totals.push(minutes(match[1], match[2]));
  if (total > 100_000 || totals.some(value => value !== total)) return { error: `Those daily hours add up to ${total / 60} hours. Should I use that total, or change the hours per day?` };
  return { plan: chosen.map(date => ({ date, minutes: perDay })), total };
}
