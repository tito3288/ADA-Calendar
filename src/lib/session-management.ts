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
  return [
    { ...row, end: middle },
    { ...row, id: secondId, start: middle },
  ];
}

/** A manual replacement never changes effort or treats elapsed bookings as completed. */
export function sessionManagementCommands({
  item,
  original,
  rows,
  zone,
  now,
  overrideProtected = false,
  resume = false,
}: {
  item: WorkItem;
  original: WorkSession[];
  rows: SessionDraft[];
  zone: string;
  now: string;
  overrideProtected?: boolean;
  resume?: boolean;
}): WorkCommand[] {
  if (["completed", "cancelled"].includes(item.status))
    throw new Error("Reopen this project before changing its sessions.");
  const planned = original.filter(
    (session) => session.workItemId === item.id && session.status === "planned",
  );
  if (
    planned.some(
      (session) =>
        instantMs(session.start) < instantMs(now) &&
        instantMs(session.end) > instantMs(now),
    )
  ) {
    throw new Error(
      "A session is currently underway. Manage this project’s sessions after it ends so its remaining time stays exact.",
    );
  }
  const sessions = rows.map((row) => {
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
    if (changed && instantMs(old.start) < instantMs(now))
      throw new Error(
        "Past sessions are history and cannot be changed or removed here.",
      );
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
      throw new Error("New sessions must start in the future.");
    }
  }
  const future = sessions.filter(
    (session) => instantMs(session.start) >= instantMs(now),
  );
  const total = future.reduce(
    (sum, session) => sum + minutesBetween(session.start, session.end),
    0,
  );
  if (
    item.remainingMinutes !== null &&
    total !== Math.ceil(item.remainingMinutes / 15) * 15
  ) {
    throw new Error(
      `Reserve all ${Number((item.remainingMinutes / 60).toFixed(2))} remaining hours across future sessions. Removing a row does not reduce the estimate; redistribute its hours or update remaining effort separately.`,
    );
  }
  if (item.status === "waiting" && future.length && !resume)
    throw new Error(
      "Confirm that this waiting project should resume when its sessions are booked.",
    );
  const commands: WorkCommand[] = [];
  if (item.dailyPlan?.length) {
    const byDate = new Map<string, number>();
    for (const session of future) {
      const date = localDate(session.start, zone);
      byDate.set(
        date,
        (byDate.get(date) ?? 0) + minutesBetween(session.start, session.end),
      );
    }
    commands.push({
      type: "update",
      itemId: item.id,
      patch: {
        dailyPlan: [...byDate]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, minutes]) => ({ date, minutes })),
      },
      overrideProtected,
    });
  }
  if (item.status === "waiting" && future.length)
    commands.push({ type: "status", itemId: item.id, status: "planned" });
  commands.push({
    type: "schedule",
    itemId: item.id,
    sessions,
    overrideProtected,
  });
  return commands;
}
