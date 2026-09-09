import {
  addMinutes,
  instantMs,
  isDate,
  localDate,
  localDateTime,
  minutesBetween,
} from "./time";
import type { WorkCommand, WorkItem, WorkSession } from "./types";

export interface SessionDraft {
  id: string;
  date: string;
  start: string;
  end: string;
  protected: boolean;
  usesReserve: boolean;
  focusOverrideMinutes?: number;
}

export function sessionDraft(session: WorkSession, zone: string): SessionDraft {
  const clock = (instant: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(instant));
  return {
    id: session.id,
    date: localDate(session.start, zone),
    start: clock(session.start),
    end: clock(session.end),
    protected: session.protected,
    usesReserve: session.usesReserve,
    ...(session.focusOverrideMinutes !== undefined ? { focusOverrideMinutes: session.focusOverrideMinutes } : {}),
  };
}

export function draftSession(
  row: SessionDraft,
  itemId: string,
  zone: string,
): WorkSession {
  if (
    !isDate(row.date) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.start) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.end)
  ) {
    throw new Error(
      "Give every session a valid date, start time, and end time.",
    );
  }
  const start = localDateTime(row.date, row.start, zone);
  const end = localDateTime(row.date, row.end, zone);
  const minutes = minutesBetween(start, end);
  if (
    minutes <= 0 ||
    minutes % 15 ||
    Number(row.start.slice(-2)) % 15 ||
    Number(row.end.slice(-2)) % 15
  ) {
    throw new Error(
      "Sessions must end after they start and use 15-minute increments.",
    );
  }
  return {
    id: row.id,
    workItemId: itemId,
    start,
    end,
    protected: row.protected,
    status: "planned",
    usesReserve: row.usesReserve,
    ...(row.focusOverrideMinutes !== undefined ? { focusOverrideMinutes: row.focusOverrideMinutes } : {}),
  };
}

export function splitSessionDraft(
  row: SessionDraft,
  zone: string,
  secondId: string,
): SessionDraft[] {
  const session = draftSession(row, "draft", zone);
  const minutes = minutesBetween(session.start, session.end);
  if (minutes < 30)
    throw new Error(
      "A session needs at least 30 minutes to split into two 15-minute pieces.",
    );
  const middle = sessionDraft(
    {
      ...session,
      end: addMinutes(session.start, Math.floor(minutes / 30) * 15),
    },
    zone,
  ).end;
  const second = { ...row, id: secondId, start: middle };
  delete second.focusOverrideMinutes;
  return [{ ...row, end: middle }, second];
}

/** Replacement reservations and an optional explicit effort edit are one atomic proposal. */
export function sessionManagementCommands({
  item,
  original,
  rows,
  zone,
  now,
  overrideProtected = false,
  resume = false,
  remainingMinutes,
}: {
  item: WorkItem;
  original: WorkSession[];
  rows: SessionDraft[];
  zone: string;
  now: string;
  overrideProtected?: boolean;
  resume?: boolean;
  remainingMinutes?: number;
}): WorkCommand[] {
  if (["completed", "cancelled"].includes(item.status))
    throw new Error("Reopen this project before changing its sessions.");
  if (remainingMinutes !== undefined && (!Number.isInteger(remainingMinutes) || remainingMinutes < 0 || remainingMinutes > 100_000))
    throw new Error("Remaining effort must be a whole number of minutes from 0 to 100,000.");
  const planned = original.filter(
    (session) => session.workItemId === item.id && session.status === "planned",
  );
  const sessions = rows.map((row) => {
    if (original.some((session) => session.id === row.id && session.status !== "planned"))
      throw new Error("Completed or cancelled sessions cannot be edited here.");
    const old = planned.find((session) => session.id === row.id);
    if (old && JSON.stringify(sessionDraft(old, zone)) === JSON.stringify(row))
      return { ...old };
    return draftSession(row, item.id, zone);
  });
  if (new Set(sessions.map((session) => session.id)).size !== sessions.length)
    throw new Error("Each session must have its own row.");
  for (const old of planned) {
    const next = sessions.find((session) => session.id === old.id);
    const changed = JSON.stringify(next) !== JSON.stringify(old);
    if (changed && old.protected && !overrideProtected)
      throw new Error(
        "Authorize the change to protected sessions before previewing.",
      );
  }
  for (const next of sessions) {
    if (
      instantMs(next.start) < instantMs(now) &&
      !planned.some((old) => JSON.stringify(old) === JSON.stringify(next))
    ) {
      throw new Error("New or moved sessions must start in the future.");
    }
  }
  const total = sessions.reduce(
    (sum, session) => sum + minutesBetween(session.start, session.end),
    0,
  );
  const effort = remainingMinutes ?? item.remainingMinutes;
  const remaining = effort === null ? null : Math.ceil(effort / 15) * 15;
  const originalTotal = planned.reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0);
  const priorExcess = item.remainingMinutes === null ? 0 : Math.max(0, originalTotal - Math.ceil(item.remainingMinutes / 15) * 15);
  if (remaining !== null && total > remaining + priorExcess)
    throw new Error("These sessions exceed the remaining effort. Reduce the booked hours or update remaining effort before previewing.");
  if (item.status === "waiting" && sessions.length && !resume)
    throw new Error(
      "Confirm that this waiting project should resume when its sessions are booked.",
    );
  const commands: WorkCommand[] = [];
  const patch: Partial<WorkItem> = {};
  if (remainingMinutes !== undefined) patch.remainingMinutes = remainingMinutes;
  if (item.dailyPlan?.length) {
    const byDate = new Map<string, number>();
    for (const session of sessions) {
      const date = localDate(session.start, zone);
      byDate.set(
        date,
        (byDate.get(date) ?? 0) + minutesBetween(session.start, session.end),
      );
    }
    patch.dailyPlan = [...byDate]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, minutes]) => ({ date, minutes }));
  }
  if (Object.keys(patch).length)
    commands.push({ type: "update", itemId: item.id, patch, overrideProtected });
  if (item.status === "waiting" && sessions.length)
    commands.push({ type: "status", itemId: item.id, status: "planned" });
  commands.push({
    type: "schedule",
    itemId: item.id,
    sessions,
    overrideProtected,
  });
  return commands;
}
