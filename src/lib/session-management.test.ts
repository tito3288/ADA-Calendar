import { describe, expect, it } from "vitest";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { planCommands, validateSchedule } from "./scheduler";
import { commandSchema } from "./schemas";
import {
  draftSession,
  sessionDraft,
  sessionManagementCommands,
  splitSessionDraft,
} from "./session-management";
import { localDateTime, minutesBetween } from "./time";
import type { Actor, ScheduleSnapshot, WorkItem, WorkSession } from "./types";
import { newWorkItem } from "./work";

const zone = DEFAULT_SETTINGS.timeZone;
const owner: Actor = {
  id: "owner",
  name: "Demo owner",
  email: "owner@example.test",
  role: "owner",
};
const now = localDateTime("2026-09-08", "08:00", zone);
const item = (patch: Partial<WorkItem> = {}) =>
  newWorkItem(owner, "2026-09-14", {
    id: "cedar",
    title: "Cedar Studio website",
    clientId: "cedar",
    estimatedMinutes: 600,
    remainingMinutes: 600,
    minimumSessionMinutes: 15,
    windowEnd: "2026-09-18",
    ...patch,
  });
const session = (
  id: string,
  date: string,
  start = "09:00",
  end = "11:00",
  protectedTime = false,
): WorkSession => ({
  id,
  workItemId: "cedar",
  start: localDateTime(date, start, zone),
  end: localDateTime(date, end, zone),
  protected: protectedTime,
  status: "planned",
  usesReserve: false,
});
const week = () =>
  Array.from({ length: 5 }, (_, index) =>
    session(`s${index}`, `2026-09-${14 + index}`),
  );
const base = (work: WorkItem, sessions: WorkSession[]): ScheduleSnapshot => ({
  workspaceId: "demo",
  version: 1,
  settings: { ...DEFAULT_SETTINGS, reserveMinutes: 0 },
  priorities: DEFAULT_PRIORITIES,
  clients: [{ id: "cedar", name: "Cedar Studio", aliases: [] }],
  items: [work],
  sessions,
  blocks: [],
});

describe("manual session drafts", () => {
  it("preserves booking-specific focus when opening, moving, and saving a draft", () => {
    const original = { ...session("short", "2026-09-14", "09:00", "10:00"), focusOverrideMinutes: 60 };
    const row = sessionDraft(original, zone);
    expect(row.focusOverrideMinutes).toBe(60);
    expect(draftSession({ ...row, start: "10:00", end: "11:00" }, "cedar", zone)).toMatchObject({ focusOverrideMinutes: 60 });
    const work = item({ estimatedMinutes: null, remainingMinutes: null, minimumSessionMinutes: 120 });
    const commands = sessionManagementCommands({ item: work, original: [original], rows: [row], zone, now });
    const proposal = planCommands(base(work,[original]), commands, owner, { now });
    expect(proposal.status,JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions).toEqual([original]); expect(proposal.items[0].minimumSessionMinutes).toBe(120);
  });

  it("keeps an explicit shorter-focus booking's split pieces valid without lowering project focus", () => {
    const original = { ...session("short", "2026-09-14", "09:00", "10:00"), focusOverrideMinutes: 60 };
    const rows = splitSessionDraft(sessionDraft(original, zone), zone, "second");
    expect(rows.map(row => row.focusOverrideMinutes)).toEqual([30,30]);
    const work = item({ estimatedMinutes: null, remainingMinutes: null, minimumSessionMinutes: 120 });
    const proposal = planCommands(base(work,[original]), sessionManagementCommands({item:work,original:[original],rows,zone,now}),owner,{now});
    expect(proposal.status,JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions.map(row => row.focusOverrideMinutes)).toEqual([30,30]); expect(proposal.items[0].minimumSessionMinutes).toBe(120);
  });
  it("splits a block without changing its minutes, identity, or protection", () => {
    const original = session("old", "2026-09-14", "13:00", "17:00", true);
    const rows = splitSessionDraft(sessionDraft(original, zone), zone, "new");
    expect(rows).toMatchObject([
      { id: "old", start: "13:00", end: "15:00", protected: true },
      { id: "new", start: "15:00", end: "17:00", protected: true },
    ]);
    expect(
      rows
        .map((row) => draftSession(row, "cedar", zone))
        .reduce((sum, row) => sum + minutesBetween(row.start, row.end), 0),
    ).toBe(240);
    expect(original.end).toBe(localDateTime("2026-09-14", "17:00", zone));
  });

  it("rejects malformed clocks, fractional slots, and undersized splits", () => {
    const row = sessionDraft(
      session("s", "2026-09-14", "09:00", "09:15"),
      zone,
    );
    expect(() => splitSessionDraft(row, zone, "new")).toThrow(
      "at least 30 minutes",
    );
    expect(() =>
      draftSession({ ...row, start: "25:00" }, "cedar", zone),
    ).toThrow("valid date");
    expect(() =>
      draftSession({ ...row, start: "09:01" }, "cedar", zone),
    ).toThrow("15-minute");
  });

  it("replaces three greedy blocks with five exact two-hour days atomically", () => {
    const work = item();
    const old = [
      session("old1", "2026-09-14", "12:30", "17:00"),
      session("old2", "2026-09-15", "09:00", "12:00"),
      session("old3", "2026-09-16", "12:30", "15:00"),
    ];
    const commands = sessionManagementCommands({
      item: work,
      original: old,
      rows: week().map((row) => sessionDraft(row, zone)),
      zone,
      now,
    });
    const proposal = planCommands(base(work, old), commands, owner, { now });
    expect(proposal.status).toBe("ready");
    expect(proposal.sessions).toHaveLength(5);
    expect(
      proposal.sessions.every(
        (row) => minutesBetween(row.start, row.end) === 120,
      ),
    ).toBe(true);
    expect(proposal.items[0].remainingMinutes).toBe(600);
    expect(old).toHaveLength(3);
  });

  it("allows deleting booked hours without refilling them or increasing an estimate", () => {
    const work = item();
    const rows = week().map((row) => sessionDraft(row, zone));
    const commands = sessionManagementCommands({ item: work, original: week(), rows: rows.slice(0, 4), zone, now });
    const proposal = planCommands(base(work, week()), commands, owner, { now });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions).toEqual(week().slice(0, 4));
    expect(proposal.items[0]).toMatchObject({ remainingMinutes: 600, estimatedMinutes: 600, forecastDate: null });
    expect(() =>
      sessionManagementCommands({
        item: work,
        original: week(),
        rows: [...rows, sessionDraft(session("extra", "2026-09-21"), zone)],
        zone,
        now,
      }),
    ).toThrow("exceed the remaining effort");
  });

  it("saves Monday at two hours and the other days at one with an explicit six-hour estimate", () => {
    const original = week();
    const work = item({ minimumSessionMinutes: 120, dailyPlan: original.map(row => ({ date: sessionDraft(row, zone).date, minutes: 120 })) });
    const rows = original.map((row, index) => ({ ...sessionDraft(row, zone), end: index ? "10:00" : "11:00" }));
    const commands = sessionManagementCommands({ item: work, original, rows, zone, now, remainingMinutes: 360 });
    expect(commands[0]).toMatchObject({ type: "update", patch: { remainingMinutes: 360, dailyPlan: rows.map((row, index) => ({ date: row.date, minutes: index ? 60 : 120 })) } });
    expect(commands.every(command => commandSchema.safeParse(command).success)).toBe(true);
    const proposal = planCommands(base(work, original), commands, owner, { now });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions.map(row => minutesBetween(row.start, row.end))).toEqual([120, 60, 60, 60, 60]);
    expect(proposal.sessions[0]).toEqual(original[0]);
    expect(proposal.items[0]).toMatchObject({ estimatedMinutes: 600, remainingMinutes: 360, minimumSessionMinutes: 120 });
    expect(validateSchedule({ ...base(work, original), items: proposal.items, sessions: proposal.sessions }, now)).toEqual([]);
    expect(work.remainingMinutes).toBe(600);
    expect(original).toEqual(week());
  });

  it.each([undefined, 480, 540])("removes a daily booking while setting remaining effort to %s only when explicit", remainingMinutes => {
    const original = week();
    const work = item({ dailyPlan: original.map(row => ({ date: sessionDraft(row, zone).date, minutes: 120 })) });
    const commands = sessionManagementCommands({ item: work, original, rows: original.slice(0, 4).map(row => sessionDraft(row, zone)), zone, now, remainingMinutes });
    const proposal = planCommands(base(work, original), commands, owner, { now });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions).toEqual(original.slice(0, 4));
    expect(proposal.items[0].dailyPlan).toHaveLength(4);
    expect(proposal.items[0]).toMatchObject({ remainingMinutes: remainingMinutes ?? 600, estimatedMinutes: 600 });
    if (remainingMinutes !== 480) expect(proposal.items[0].forecastDate).toBeNull();
  });

  it.each([false, true])("removes every future booking without completing or refilling work (daily plan: %s)", daily => {
    const original = week();
    const work = item({ ...(daily ? { dailyPlan: original.map(row => ({ date: sessionDraft(row, zone).date, minutes: 120 })) } : {}) });
    for (const remainingMinutes of [undefined, 0, 360]) {
      const commands = sessionManagementCommands({ item: work, original, rows: [], zone, now, remainingMinutes });
      const proposal = planCommands(base(work, original), commands, owner, { now });
      expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
      expect(proposal.sessions).toEqual([]);
      expect(proposal.items[0]).toMatchObject({ remainingMinutes: remainingMinutes ?? 600, estimatedMinutes: 600, status: "planned", completedAt: null, forecastDate: null });
      if (daily) expect(proposal.items[0].dailyPlan).toEqual([]);
    }
  });

  it("allows explicitly shortened and new one-hour sessions without changing the project's focus minimum", () => {
    const work = item({ estimatedMinutes: 240, remainingMinutes: 240, minimumSessionMinutes: 120 });
    const original = week().slice(0, 2);
    const rows = [sessionDraft({ ...original[0], end: localDateTime("2026-09-14", "10:00", zone) }, zone), sessionDraft(session("new", "2026-09-16", "09:00", "10:00"), zone)];
    const commands = sessionManagementCommands({ item: work, original, rows, zone, now });
    const proposal = planCommands(base(work, original), commands, owner, { now });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions.map(row => row.focusOverrideMinutes)).toEqual([60, 60]);
    expect(proposal.items[0]).toMatchObject({ remainingMinutes: 240, estimatedMinutes: 240, minimumSessionMinutes: 120, forecastDate: null });
  });

  it.each(["shorten", "remove"])("keeps an unchanged valid short remainder when an earlier session is %s", change => {
    const work = item({ estimatedMinutes: 180, remainingMinutes: 180, minimumSessionMinutes: 120 });
    const original = [session("first", "2026-09-14"), session("remainder", "2026-09-14", "11:00", "12:00")];
    expect(validateSchedule(base(work, original), now)).toEqual([]);
    const rows = original.map(row => sessionDraft(row, zone));
    if (change === "shorten") rows[0].end = "10:00"; else rows.shift();
    const commands = sessionManagementCommands({ item: work, original, rows, zone, now });
    const proposal = planCommands(base(work, original), commands, owner, { now });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions.find(session => session.id === "remainder")).toEqual({ ...original[1], focusOverrideMinutes: 60 });
    expect(proposal.sessions).toHaveLength(change === "shorten" ? 2 : 1);
    expect(proposal.items[0]).toMatchObject({ estimatedMinutes: 180, remainingMinutes: 180, minimumSessionMinutes: 120, forecastDate: null });
    expect(proposal.summary.some(message => message.includes("previously allowed shorter focus"))).toBe(true);
    expect(validateSchedule({ ...base(work, original), sessions: proposal.sessions, items: proposal.items }, now)).toEqual([]);
    expect(original[1].focusOverrideMinutes).toBeUndefined();
  });

  it("requires permission to preserve a protected remainder's shorter focus after releasing earlier time", () => {
    const work = item({ estimatedMinutes: 180, remainingMinutes: 180, minimumSessionMinutes: 120 });
    const original = [session("first", "2026-09-14"), session("remainder", "2026-09-14", "11:00", "12:00", true)];
    const rows = original.map(row => sessionDraft(row, zone));
    rows[0].end = "10:00";
    const commands = sessionManagementCommands({ item: work, original, rows, zone, now });
    const blocked = planCommands(base(work, original), commands, owner, { now });
    expect(blocked.conflicts[0].code).toBe("protected_session");
    expect(blocked.items).toEqual([work]);
    expect(blocked.sessions).toEqual(original);
    const authorized = sessionManagementCommands({ item: work, original, rows, zone, now, overrideProtected: true });
    const proposal = planCommands(base(work, original), authorized, owner, { now });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions.find(session => session.id === "remainder")).toEqual({ ...original[1], focusOverrideMinutes: 60 });
  });

  it("does not grandfather an already invalid short booking or change historical focus metadata", () => {
    const work = item({ windowStart: "2026-09-07", estimatedMinutes: 180, remainingMinutes: 180, minimumSessionMinutes: 120 });
    const past = session("past", "2026-09-07", "11:00", "12:00", true);
    const original = [past, session("first", "2026-09-14"), session("remainder", "2026-09-14", "11:00", "12:00")];
    const rows = original.map(row => sessionDraft(row, zone)); rows[1].end = "10:00";
    const proposal = planCommands(base(work, original), sessionManagementCommands({ item: work, original, rows, zone, now }), owner, { now });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions[0]).toEqual(past);
    const invalidOriginal = [original[2]];
    const invalid = planCommands(base(work, invalidOriginal), sessionManagementCommands({ item: work, original: invalidOriginal, rows: invalidOriginal.map(row => sessionDraft(row, zone)), zone, now }), owner, { now });
    expect(invalid.conflicts[0].code).toBe("focus_length");
    expect(invalid.sessions).toEqual(invalidOriginal);
  });

  it.each(["requester", "viewer"] as const)("rejects manual replacement from a %s at the shared scheduler", role => {
    const work = item();
    const commands = sessionManagementCommands({ item: work, original: week(), rows: [], zone, now, remainingMinutes: 0 });
    const proposal = planCommands(base(work, week()), commands, { ...owner, role }, { now });
    expect(proposal.conflicts[0].code).toBe("forbidden");
    expect(proposal.sessions).toEqual(week());
    expect(proposal.items).toEqual([work]);
  });

  it.each([-1, 100001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid remaining effort %s before proposing any sessions", remainingMinutes => {
    expect(() => sessionManagementCommands({ item: item(), original: week(), rows: [], zone, now, remainingMinutes })).toThrow("whole number of minutes");
  });

  it("keeps integer remaining effort exact while rounding reservation capacity to a slot", () => {
    const work = item();
    const original = [session("short", "2026-09-14", "09:00", "09:15")];
    const commands = sessionManagementCommands({ item: work, original, rows: original.map(row => sessionDraft(row, zone)), zone, now, remainingMinutes: 1 });
    const proposal = planCommands(base(work, original), commands, owner, { now });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.items[0]).toMatchObject({ estimatedMinutes: 600, remainingMinutes: 1 });
    expect(proposal.sessions).toEqual(original);
  });

  it("rejects reservations above an explicitly reduced estimate in the helper and scheduler", () => {
    const work = item();
    const original = week();
    expect(() => sessionManagementCommands({ item: work, original, rows: original.map(row => sessionDraft(row, zone)), zone, now, remainingMinutes: 360 })).toThrow("exceed the remaining effort");
    const proposal = planCommands(base(work, original), [{ type: "update", itemId: work.id, patch: { remainingMinutes: 360 } }, { type: "schedule", itemId: work.id, sessions: original }], owner, { now });
    expect(proposal.conflicts[0].code).toBe("booking_effort");
    expect(proposal.items).toEqual([work]);
    expect(proposal.sessions).toEqual(original);
  });

  it("preserves intentionally partial known-total bookings on unchanged save, move, and split", () => {
    const original = [{ ...session("short", "2026-09-14", "09:00", "10:00"), focusOverrideMinutes: 60 }];
    const work = item({ estimatedMinutes: 120, remainingMinutes: 120, minimumSessionMinutes: 120 });
    const row = sessionDraft(original[0], zone);
    for (const rows of [[row], [{...row,date:"2026-09-15"}], splitSessionDraft(row, zone, "piece")]) {
      const commands=sessionManagementCommands({item:work,original,rows,zone,now});
      const proposal=planCommands(base(work,original),commands,owner,{now});
      expect(proposal.status,JSON.stringify(proposal.conflicts)).toBe("ready");
      expect(proposal.sessions.reduce((sum,s)=>sum+minutesBetween(s.start,s.end),0)).toBe(60);
      expect(proposal.items[0]).toMatchObject({remainingMinutes:120,estimatedMinutes:120,minimumSessionMinutes:120,forecastDate:null});
    }
  });

  it("allows existing partial bookings to fill remaining effort but not exceed it", () => {
    const work=item({remainingMinutes:180,estimatedMinutes:180});
    const original=[session("old","2026-09-14")];
    const rows=[sessionDraft(original[0],zone),sessionDraft(session("new","2026-09-15","09:00","10:00"),zone)];
    const proposal=planCommands(base(work,original),sessionManagementCommands({item:work,original,rows,zone,now}),owner,{now});
    expect(proposal.status,JSON.stringify(proposal.conflicts)).toBe("ready"); expect(proposal.sessions).toHaveLength(2);
    expect(()=>sessionManagementCommands({item:work,original,rows:[...rows,sessionDraft(session("extra","2026-09-16"),zone)],zone,now})).toThrow("exceed the remaining effort");
  });

  it("explicitly rebuilds an existing daily plan from the replacement dates", () => {
    const work = item({
      dailyPlan: [
        { date: "2026-09-14", minutes: 300 },
        { date: "2026-09-15", minutes: 300 },
      ],
    });
    const commands = sessionManagementCommands({
      item: work,
      original: [],
      rows: week().map((row) => sessionDraft(row, zone)),
      zone,
      now,
    });
    expect(commands[0]).toMatchObject({
      type: "update",
      patch: {
        dailyPlan: Array.from({ length: 5 }, (_, index) => ({
          date: `2026-09-${14 + index}`,
          minutes: 120,
        })),
      },
    });
    expect(
      commands.some(
        (command) =>
          command.type === "update" && "remainingMinutes" in command.patch,
      ),
    ).toBe(false);
  });

  it("keeps protected rows unchanged without an override and requires one to move them", () => {
    const work = item({ remainingMinutes: 120, estimatedMinutes: 120 });
    const old = [session("protected", "2026-09-14", "09:00", "11:00", true)];
    const rows = old.map((row) => sessionDraft(row, zone));
    expect(() =>
      sessionManagementCommands({ item: work, original: old, rows, zone, now }),
    ).not.toThrow();
    const moved = rows.map((row) => ({ ...row, date: "2026-09-15" }));
    expect(() =>
      sessionManagementCommands({
        item: work,
        original: old,
        rows: moved,
        zone,
        now,
      }),
    ).toThrow("Authorize");
    expect(
      sessionManagementCommands({
        item: work,
        original: old,
        rows: moved,
        zone,
        now,
        overrideProtected: true,
      }).at(-1),
    ).toMatchObject({ overrideProtected: true });
  });

  it("preserves history without counting it as completed or as future effort", () => {
    const work = item({
      windowStart: "2026-09-07",
      remainingMinutes: 120,
      estimatedMinutes: 120,
      dailyPlan: [{ date: "2026-09-07", minutes: 120 }],
    });
    const past = session("past", "2026-09-07");
    const future = session("future", "2026-09-14");
    const commands = sessionManagementCommands({
      item: work,
      original: [past],
      rows: [past, future].map((row) => sessionDraft(row, zone)),
      zone,
      now,
    });
    expect(commands[0]).toMatchObject({
      patch: { dailyPlan: [{ date: "2026-09-14", minutes: 120 }] },
    });
    expect(commands.at(-1)).toMatchObject({ sessions: [past, future] });
    expect(() =>
      sessionManagementCommands({
        item: work,
        original: [past],
        rows: [sessionDraft(future, zone)],
        zone,
        now,
      }),
    ).toThrow("Past sessions are history");
    const unchanged = sessionManagementCommands({
        item: work,
        original: [past],
        rows: [sessionDraft(past, zone)],
        zone,
        now,
      });
    const proposal = planCommands(base(work, [past]), unchanged, owner, { now });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions).toEqual([past]);
    expect(proposal.items[0]).toMatchObject({remainingMinutes:120,estimatedMinutes:120,forecastDate:null});
  });

  it("preserves unknown totals when adding or removing all future sessions", () => {
    const work = item({ remainingMinutes: null, estimatedMinutes: null });
    expect(
      sessionManagementCommands({
        item: work,
        original: [],
        rows: [sessionDraft(week()[0], zone)],
        zone,
        now,
      }),
    ).toHaveLength(1);
    const commands = sessionManagementCommands({
      item: work,
      original: week(),
      rows: [],
      zone,
      now,
    });
    expect(commands).toEqual([
      {
        type: "schedule",
        itemId: work.id,
        sessions: [],
        overrideProtected: false,
      },
    ]);
    expect(work.remainingMinutes).toBeNull();
  });

  it("sets the first unknown estimate only when remaining effort is supplied explicitly", () => {
    const work = item({ estimatedMinutes: null, remainingMinutes: null });
    const original = week().slice(0, 2);
    const rows = [sessionDraft(original[0], zone)];
    for (const remainingMinutes of [undefined, 180]) {
      const proposal = planCommands(base(work, original), sessionManagementCommands({ item: work, original, rows, zone, now, remainingMinutes }), owner, { now });
      expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
      expect(proposal.sessions).toEqual([original[0]]);
      expect(proposal.items[0]).toMatchObject({ remainingMinutes: remainingMinutes ?? null, estimatedMinutes: remainingMinutes ?? null, forecastDate: null });
    }
  });

  it("preserves historical and unrelated work when releasing future hours and revising remaining effort", () => {
    const past = session("past", "2026-09-07");
    const work = item({ windowStart: "2026-09-07", dailyPlan: [{ date: "2026-09-07", minutes: 120 }, { date: "2026-09-14", minutes: 120 }] });
    const original = [past, week()[0]];
    const unrelated = { ...session("other-session", "2026-09-15"), workItemId: "other" };
    const snapshot = base(work, [...original, unrelated]);
    snapshot.items.push({ ...item(), id: "other" });
    const commands = sessionManagementCommands({ item: work, original, rows: [sessionDraft(past, zone)], zone, now, remainingMinutes: 360 });
    const proposal = planCommands(snapshot, commands, owner, { now });
    expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions).toEqual([past, unrelated]);
    expect(proposal.items[0]).toMatchObject({ remainingMinutes: 360, estimatedMinutes: 600, dailyPlan: [], forecastDate: null });
    expect(proposal.items[1]).toEqual(snapshot.items[1]);
  });

  it("requires protected-time authority at the scheduler even when releasing hours and reducing effort", () => {
    const work = item();
    const original = [{ ...week()[0], protected: true }, week()[1]];
    const rows = [sessionDraft(original[1], zone)];
    expect(() => sessionManagementCommands({ item: work, original, rows, zone, now, remainingMinutes: 120 })).toThrow("Authorize");
    const commands = sessionManagementCommands({ item: work, original, rows, zone, now, remainingMinutes: 120, overrideProtected: true });
    const unauthorized = commands.map(command => ({ ...command, overrideProtected: false }));
    const blocked = planCommands(base(work, original), unauthorized, owner, { now });
    expect(blocked.conflicts[0].code).toBe("protected_session");
    expect(blocked.items).toEqual([work]);
    expect(blocked.sessions).toEqual(original);
    const approved = planCommands(base(work, original), commands, owner, { now });
    expect(approved.status, JSON.stringify(approved.conflicts)).toBe("ready");
    expect(approved.sessions).toEqual([original[1]]);
  });

  it("requires explicit resume and does not change an underway session", () => {
    const work = item({
      remainingMinutes: null,
      estimatedMinutes: null,
      status: "waiting",
    });
    const rows = [sessionDraft(week()[0], zone)];
    expect(() =>
      sessionManagementCommands({ item: work, original: [], rows, zone, now }),
    ).toThrow("Confirm");
    expect(
      sessionManagementCommands({
        item: work,
        original: [],
        rows,
        zone,
        now,
        resume: true,
      })[0],
    ).toMatchObject({ type: "status", status: "planned" });
    const underway = session("current", "2026-09-08", "07:00", "09:00");
    expect(() =>
      sessionManagementCommands({
        item: item(),
        original: [underway],
        rows: [sessionDraft(underway, zone)],
        zone,
        now,
      }),
    ).toThrow("currently underway");
  });
});
