import { DEFAULT_SETTINGS } from "./defaults";
import { addDays, dayOfWeek, localDate, minutesBetween } from "./time";
import type { PendingRequest, WorkCommand } from "./types";

/** Refresh legacy requests without turning their initial booking days into limits. */
export function pendingBookingCommands(request: PendingRequest, timeZone: string, weekdays: readonly number[] = DEFAULT_SETTINGS.weekdays): WorkCommand[] {
  return request.proposal.commands.map(command => {
    if (command.type !== "create") return command;
    const legacy = command.item.dateConstraints === undefined;
    const item = legacy ? { ...command.item, dateConstraints: { earliestStart: null, allowedDates: [] as string[] }, timelineMode: command.item.timelineMode ?? (command.item.estimatedMinutes === null ? "span" as const : "bookings" as const) } : command.item;
    // Review uses the ordinary scheduler so the owner can explicitly approve
    // displacement. Smart fit itself remains append-only everywhere else.
    if (command.smartFit) {
      const { startDate, endDate, dates, distribution, minutes } = command.smartFit;
      const dailyPlan = [];
      if (distribution === "per_day") for (let date = startDate; date <= endDate; date = addDays(date, 1))
        if (weekdays.includes(dayOfWeek(date)) && (!dates || dates.includes(date))) dailyPlan.push({ date, minutes });
      return { ...command, smartFit: undefined, bookingWindow: { startDate, endDate, ...(dates ? { dates: [...dates] } : {}) },
        item: distribution === "per_day" ? { ...item, dailyPlan } : item };
    }
    if (command.sessions !== undefined || command.bookingWindow || item.status === "waiting") return { ...command, item };
    if (item.dailyPlan?.length) {
      const dates = item.dailyPlan.map(day => day.date).sort();
      return { ...command, item, bookingWindow: { startDate: dates[0], endDate: dates.at(-1)!, dates } };
    }
    if (!legacy) return command;
    const days = new Map<string, number>();
    for (const session of request.proposal.sessions.filter(session => session.workItemId === item.id && session.status === "planned")) {
      const date = localDate(session.start, timeZone);
      days.set(date, (days.get(date) ?? 0) + minutesBetween(session.start, session.end));
    }
    if (days.size) {
      const dates = [...days.keys()].sort();
      return { ...command, item: { ...item, dailyPlan: dates.map(date => ({ date, minutes: days.get(date)! })) },
        bookingWindow: { startDate: dates[0], endDate: dates.at(-1)!, dates } };
    }
    // An unplaced request still retains its original requested range for this fit.
    const dates = [...new Set(item.allowedDates)].sort();
    return item.remainingMinutes ? { ...command, item, bookingWindow: { startDate: dates[0] ?? item.windowStart, endDate: dates.at(-1) ?? item.windowEnd ?? item.windowStart,
      ...(dates.length ? { dates } : {}) } } : { ...command, item };
  });
}
