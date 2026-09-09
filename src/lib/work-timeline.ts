import { localDate } from "./time";
import type { WorkItem, WorkSession } from "./types";

export function effectiveTimelineMode(item: WorkItem, sessions: readonly WorkSession[]): "bookings" | "span" {
  return item.timelineMode ?? (item.estimatedMinutes === null || !sessions.some(session => session.workItemId === item.id && session.status === "planned") ? "span" : "bookings");
}

/** Read-only display projection; never invents reservations or rewrites legacy JSON. */
export function workTimeline(item: WorkItem, sessions: readonly WorkSession[], timeZone: string): { mode: "bookings" | "span"; start: string; end: string | null } | null {
  const mode = effectiveTimelineMode(item, sessions);
  if (mode === "bookings") {
    const dates = sessions.filter(session => session.workItemId === item.id && session.status === "planned").map(session => localDate(session.start, timeZone)).sort();
    return dates.length ? { mode, start: dates[0], end: dates.at(-1)! } : null;
  }
  let end = item.windowEnd;
  if (item.status === "completed" || item.status === "cancelled") {
    const closed = localDate(item.completedAt ?? item.updatedAt, timeZone);
    end = end && end < closed ? end : closed;
  }
  return { mode, start: item.windowStart, end };
}
