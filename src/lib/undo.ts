import { instantMs, isInstant } from "./time";
import type { ScheduleSnapshot, WorkEvent } from "./types";

// Event snapshots come from both JSON files and PostgreSQL JSONB. Property order
// must not make an unchanged historical session appear to have been edited.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([,child])=>child!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>`${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** This UI-readable check is repeated by the server and the locked SQL commit.
 * It never grants authority or replaces full restored-schedule validation. */
export function undoUnavailableReason(
  state: ScheduleSnapshot & { events: WorkEvent[] },
  event: WorkEvent,
  now: string,
): string | null {
  if (!isInstant(now)) return "The scheduling clock is unavailable. Refresh before undoing a change.";
  if (!state.events.some(candidate=>candidate.id===event.id) || event.undoneBy || event.version!==state.version)
    return "Only the latest unchanged schedule change can be undone. A newer change was saved or this change was already undone.";
  const before=new Map(event.before.sessions.map(session=>[session.id,session]));
  const current=new Map(state.sessions.map(session=>[session.id,session]));
  const nowMs=instantMs(now);
  for (const session of state.sessions) {
    const restored=before.get(session.id);
    if (restored && canonical(restored)===canonical(session)) continue;
    if (!isInstant(session.start)) return "A changed work session has invalid dates. Refresh and review it before undoing.";
    // This includes newly added sessions that undo would remove, as well as
    // completed/cancelled history and metadata-only edits to started bookings.
    if (instantMs(session.start)<nowMs)
      return "A work session changed by this action has already started. Undo would change its history; use a new scheduling instruction instead.";
  }
  for (const session of event.before.sessions) {
    if (session.status!=="planned") continue;
    const existing=current.get(session.id);
    if (existing && canonical(existing)===canonical(session)) continue;
    if (!isInstant(session.start) || instantMs(session.start)<nowMs)
      return "Undo would restore work into the past. Choose new dates instead.";
  }
  return null;
}
