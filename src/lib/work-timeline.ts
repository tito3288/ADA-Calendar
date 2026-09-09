import { localDate, minutesBetween } from "./time";
import type { WorkItem, WorkSession } from "./types";

export function effectiveTimelineMode(item: WorkItem, sessions: readonly WorkSession[]): "bookings" | "span" {
  return item.timelineMode ?? (item.estimatedMinutes === null || !sessions.some(session => session.workItemId === item.id && session.status === "planned") ? "span" : "bookings");
}

/** Read-only display projection; never invents reservations or rewrites legacy JSON. */
export function workTimeline(item: WorkItem, sessions: readonly WorkSession[], timeZone: string): { mode: "bookings" | "span"; start: string; end: string | null } | null {
  const mode = effectiveTimelineMode(item, sessions);
  if (mode === "bookings") {
    const dates = sessions.filter(session => session.workItemId === item.id && session.status !== "cancelled").map(session => localDate(session.start, timeZone)).sort();
    return dates.length ? { mode, start: dates[0], end: dates.at(-1)! } : null;
  }
  let end = item.windowEnd;
  if (item.status === "completed" || item.status === "cancelled") {
    const closed = localDate(item.completedAt ?? item.updatedAt, timeZone);
    end = end && end < closed ? end : closed;
  }
  return { mode, start: item.windowStart, end };
}

/** Completed hours are display history; only planned sessions can reserve or move. */
export function workDaySummary(itemId: string, sessions: readonly WorkSession[], date: string, timeZone: string) {
  const onDay = sessions.filter(session => session.workItemId === itemId && localDate(session.start, timeZone) === date);
  const plannedSessions = onDay.filter(session => session.status === "planned");
  const completedSessions = onDay.filter(session => session.status === "completed");
  const total = (entries: WorkSession[]) => entries.reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0);
  return { plannedSessions, completedSessions, plannedMinutes: total(plannedSessions), completedMinutes: total(completedSessions) };
}
