import { dayCapacity } from "./scheduler";
import { dayOfWeek, instantMs, isDate, isInstant, localDate, minutesBetween } from "./time";
import type { AppState, ScheduleProposal } from "./types";

export interface CalendarBookingMoveSelection { sessionIds: string[]; date: string }
export const CALENDAR_MOVE_PREFIX = "calendar-move-";

/** Convenience checks for calendar controls. The server always validates again. */
export function calendarBookingMoveSourceUnavailableReason(state: AppState, sessionIds: string[], now: string): string | null {
  if (state.actor.role !== "owner") return "Only Bryan can move existing booked hours.";
  if (!isInstant(now)) return "Refresh the calendar to check the current time.";
  if (!sessionIds.length || sessionIds.length > 100 || new Set(sessionIds).size !== sessionIds.length) return "Choose the booked hours from one project on one day.";
  const sessions = sessionIds.map(id => state.sessions.find(session => session.id === id));
  if (sessions.some(session => !session)) return "These bookings changed. Refresh the calendar before moving them.";
  const booked = sessions.filter(session => session !== undefined);
  if (booked.some(session => session.status !== "planned" || !isInstant(session.start) || instantMs(session.start) < instantMs(now))) return "Only upcoming booked hours can be moved. Started or completed work stays unchanged.";
  if (booked.some(session => session.protected)) return "These booked hours are protected. Use Manage sessions for an explicit owner override.";
  if (booked.some(session => session.usesReserve)) return "These booked hours use interruption reserve. Use Manage sessions to keep its permissions explicit.";
  if (new Set(booked.map(session => session.workItemId)).size !== 1 || new Set(booked.map(session => localDate(session.start, state.settings.timeZone))).size !== 1) return "Move one project's booked hours from one day at a time.";
  const allOnDay = state.sessions.filter(session => session.workItemId === booked[0].workItemId && session.status === "planned" && localDate(session.start, state.settings.timeZone) === localDate(booked[0].start, state.settings.timeZone));
  if (allOnDay.length !== booked.length || allOnDay.some(session => !sessionIds.includes(session.id))) return "This project's booked hours changed. Select its day segment again to move all of those hours together.";
  const item = state.items.find(item => item.id === booked[0].workItemId);
  if (!item || !["planned", "in_progress"].includes(item.status)) return "Only an active project's booked hours can be moved.";
  return null;
}

/** Does not pretend to test smart-fit capacity, focus, deadline or allowed dates. */
export function calendarBookingMoveTargetUnavailableReason(state: AppState, sourceDate: string, date: string, now: string): string | null {
  if (!isDate(date) || !isDate(sourceDate) || !isInstant(now)) return "Choose a valid calendar day.";
  if (date === sourceDate) return "These booked hours are already on that day.";
  if (date < localDate(now, state.settings.timeZone)) return "Booked hours cannot be moved into the past.";
  if (!state.settings.weekdays.includes(dayOfWeek(date))) return "Choose one of your working days.";
  return null;
}

export function latestCalendarBookingMove(state: AppState) {
  if (state.actor.role !== "owner") return undefined;
  return state.events.filter(event => event.actorId === state.actor.id && /^calendar-move-[a-f0-9-]{36}$/i.test(event.operationId) && event.type !== "schedule_undone")
    .sort((a, b) => b.version - a.version)[0];
}

export function calendarBookingMovePreview(state: AppState, proposal: ScheduleProposal, selection: CalendarBookingMoveSelection) {
  const command = proposal.commands[0];
  if (proposal.actorId !== state.actor.id || proposal.baseVersion !== state.version || proposal.commands.length !== 1 || command?.type !== "move_bookings" || command.date !== selection.date ||
    [...command.sessionIds].sort().join("\n") !== [...selection.sessionIds].sort().join("\n")) return null;
  const rows = selection.sessionIds.map(id => {
    const before = state.sessions.find(session => session.id === id), after = proposal.sessions.find(session => session.id === id);
    if (!before || !after || before.workItemId !== after.workItemId || before.status !== "planned" || after.status !== "planned" ||
      minutesBetween(before.start, before.end) !== minutesBetween(after.start, after.end) || localDate(after.start, state.settings.timeZone) !== selection.date) return null;
    const item = state.items.find(item => item.id === before.workItemId);
    return { sessionId: id, title: item?.title ?? "Work session", clientName: state.clients.find(client => client.id === item?.clientId)?.name ?? "Client",
      beforeStart: before.start, beforeEnd: before.end, afterStart: after.start, afterEnd: after.end, minutes: minutesBetween(before.start, before.end) };
  });
  if (rows.some(row => !row)) return null;
  const changes = rows.filter(row => row !== null).sort((a, b) => instantMs(a.beforeStart) - instantMs(b.beforeStart));
  const dates = [...new Set(changes.flatMap(row => [localDate(row.beforeStart, state.settings.timeZone), selection.date]))].sort();
  return { changes, minutes: changes.reduce((sum, row) => sum + row.minutes, 0), days: dates.map(date => ({ date, before: dayCapacity(state, date), after: dayCapacity({ ...state, ...proposal }, date) })) };
}
