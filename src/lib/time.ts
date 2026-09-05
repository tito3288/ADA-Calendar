import { Temporal } from "temporal-polyfill";
import type { WorkspaceSettings } from "./types";

/** Calendar calculations always use the workspace timezone, never the server timezone. */
export function localDate(instant: string, timeZone: string): string {
  return Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone).toPlainDate().toString();
}

export function localDateTime(date: string, time: string, timeZone: string): string {
  return Temporal.PlainDateTime.from(`${date}T${time}`).toZonedDateTime(timeZone, { disambiguation: "compatible" }).toInstant().toString();
}

export function addDays(date: string, days: number): string {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}

export function dayOfWeek(date: string): number {
  return Temporal.PlainDate.from(date).dayOfWeek;
}

export function instantMs(instant: string): number {
  return Temporal.Instant.from(instant).epochMilliseconds;
}

export function instantFromMs(milliseconds: number): string {
  return Temporal.Instant.fromEpochMilliseconds(milliseconds).toString();
}

export function minutesBetween(start: string, end: string): number {
  return (instantMs(end) - instantMs(start)) / 60_000;
}

export function addMinutes(instant: string, minutes: number): string {
  return Temporal.Instant.fromEpochMilliseconds(instantMs(instant) + Math.round(minutes * 60_000)).toString();
}

export function compareInstants(a: string, b: string): number {
  return Temporal.Instant.compare(a, b);
}

export function maxDate(...dates: string[]): string {
  return dates.reduce((latest, date) => date > latest ? date : latest);
}

export function nextWorkDate(date: string, settings: WorkspaceSettings): string {
  if (!settings.weekdays.length) throw new RangeError("At least one working weekday is required.");
  let result = date;
  for (let i = 0; i < 8; i++, result = addDays(result, 1)) {
    if (settings.weekdays.includes(dayOfWeek(result))) return result;
  }
  throw new RangeError("Working weekdays must be ISO weekdays 1–7.");
}

export function isDate(value: string): boolean {
  try { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Temporal.PlainDate.from(value).toString() === value; }
  catch { return false; }
}

export function isInstant(value: string): boolean {
  try { Temporal.Instant.from(value); return true; } catch { return false; }
}

export function ceilToSlot(instant: string, date: string, settings: WorkspaceSettings): string {
  const origin = instantMs(localDateTime(date, settings.dayStart, settings.timeZone));
  const slot = settings.slotMinutes * 60_000;
  return Temporal.Instant.fromEpochMilliseconds(origin + Math.ceil((instantMs(instant) - origin) / slot) * slot).toString();
}
