import { isInstant } from "./time";
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
  for (const session of state.sessions) {
    const restored=before.get(session.id);
    if (restored && canonical(restored)===canonical(session)) continue;
    if (!isInstant(session.start)) return "A changed work session has invalid dates. Refresh and review it before undoing.";
    // Scheduled clock time is not evidence of actual work. Only recorded
    // completion/cancellation makes a changed session immutable to Undo.
    if (session.status!=="planned")
      return "Undo would change completed or cancelled work. Use a new scheduling instruction instead.";
  }
  // The server and SQL require the latest event's exact before snapshot.
  // Restoring that existing planned booking is not a new booking in the past.
  return null;
}
