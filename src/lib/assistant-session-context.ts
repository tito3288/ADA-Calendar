/** Session hours are not a total estimate when the owner explicitly says so. */
export function unknownProjectEffort(text: string): boolean {
  const source = text.replace(/[’‘]/g, "'");
  if (/\b(?:hours?|effort|estimate|total)\b[^.!?\n]{0,30}\b(?:not|no longer)\s+(?:unknown|tbd|undetermined)\b/i.test(source)) return false;
  if (/\bunknown\s+(?:(?:total|overall|remaining|project|work|working)\s+)*(?:hours?|effort|estimate)\b|\b(?:hours?|effort|estimate)\s+(?:(?:is|are|still|currently|as of now)\s+)*(?:unknown|not (?:yet )?known|tbd|undetermined)\b/i.test(source)) return true;
  return /\b(?:total|overall|remaining|estimated)\b[^.!?\n]{0,65}\b(?:unknown|not yet known|not known|tbd|undetermined)\b|\b(?:don't|do not) know\b[^.!?\n]{0,45}\b(?:total|overall|remaining)\b|\b(?:no estimate|without an? estimate|unknown (?:total|effort))\b/i.test(source);
}

const clock = "(?:\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)|noon|midnight)";
/** Clock-range connectors are not project date-range connectors. */
export function withoutClockRanges(text: string): string {
  const source = text.replace(/([ap])\.m\./gi, "$1m");
  return source.replace(new RegExp(`\\b(?:from\\s+)?${clock}\\s*(?:[-–—]|to|until)\\s*${clock}\\b`, "gi"), "");
}

function minutes(value: string) {
  if (value === "noon") return 720;
  if (value === "midnight") return 0;
  const parsed = value.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (!parsed || +parsed[1] < 1 || +parsed[1] > 12 || +(parsed[2] ?? 0) > 59) return -1;
  return (+parsed[1] % 12) * 60 + +(parsed[2] ?? 0) + (parsed[3] === "pm" ? 720 : 0);
}

/** Only explicit clock ranges can authorize unknown-total bookings. */
export function statedClockRanges(text: string): Array<{ start: number; end: number }> {
  const source = text.toLowerCase().replace(/([ap])\.m\./g, "$1m");
  return [...source.matchAll(new RegExp(`\\b(${clock})\\s*(?:[-–—]|to|until)\\s*(${clock})\\b`, "g"))]
    .map(match => ({ start: minutes(match[1]), end: minutes(match[2]) }))
    .filter(range => range.start >= 0 && range.end > range.start);
}

export function localClockMinutes(instant: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  return +(parts.find(part => part.type === "hour")?.value ?? 0) * 60 + +(parts.find(part => part.type === "minute")?.value ?? 0);
}
