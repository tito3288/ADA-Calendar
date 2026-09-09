import {
  addDays,
  instantMs,
  isDate,
  localDate,
  localDateTime,
  minutesBetween,
  nextWorkDate,
} from "./time";
import type { WorkSession, WorkspaceSettings } from "./types";

export interface DayHoursDraft {
  id: string;
  date: string;
  hours: string;
}
export interface DayHours {
  date: string;
  minutes: number;
}

export function usableWorkDate(
  date: string,
  settings: WorkspaceSettings,
  now: string,
): string {
  const today = localDate(now, settings.timeZone);
  let candidate = date < today ? today : date;
  if (
    candidate === today &&
    instantMs(now) >=
      instantMs(localDateTime(today, settings.dayEnd, settings.timeZone))
  )
    candidate = addDays(today, 1);
  return nextWorkDate(candidate, settings);
}

/** One editable row per day, even when lunch or other bookings split its time. */
export function bookedDayHours(
  sessions: readonly WorkSession[],
  timeZone: string,
  now: string,
): DayHours[] {
  const dates = new Map<string, number>();
  for (const session of sessions) {
    if (
      session.status !== "planned" ||
      instantMs(session.start) < instantMs(now)
    )
      continue;
    const date = localDate(session.start, timeZone);
    dates.set(
      date,
      (dates.get(date) ?? 0) + minutesBetween(session.start, session.end),
    );
  }
  return [...dates]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, minutes]) => ({ date, minutes }));
}

export function dayHoursDrafts(days: readonly DayHours[]): DayHoursDraft[] {
  return days.map((day) => ({
    id: crypto.randomUUID(),
    date: day.date,
    hours: String(day.minutes / 60),
  }));
}

export function parseDayHours(rows: readonly DayHoursDraft[]): DayHours[] {
  if (rows.length > 366) throw new Error("Choose no more than 366 work days.");
  const dates = new Set<string>();
  const days = rows.map((row) => {
    if (!isDate(row.date))
      throw new Error("Choose a valid work day for every row.");
    if (dates.has(row.date))
      throw new Error(
        "Use each work day once. Combine its hours into one row.",
      );
    dates.add(row.date);
    const minutes = Number(row.hours) * 60;
    if (
      !row.hours.trim() ||
      !Number.isInteger(minutes) ||
      minutes < 15 ||
      minutes > 480 ||
      minutes % 15
    )
      throw new Error(
        "Enter 0.25 to 8 hours for each day, in 15-minute steps. ADA also checks the available space.",
      );
    return { date: row.date, minutes };
  });
  if (days.reduce((sum, day) => sum + day.minutes, 0) > 100_000)
    throw new Error("These hours exceed the supported project total.");
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/** Unchanged days are omitted; removed days are an explicit zero-hour edit. */
export function changedDayHours(
  before: readonly DayHours[],
  after: readonly DayHours[],
): DayHours[] {
  const old = new Map(before.map((day) => [day.date, day.minutes]));
  const next = new Map(after.map((day) => [day.date, day.minutes]));
  return [...new Set([...old.keys(), ...next.keys()])]
    .sort()
    .filter((date) => (old.get(date) ?? 0) !== (next.get(date) ?? 0))
    .map((date) => ({ date, minutes: next.get(date) ?? 0 }));
}
