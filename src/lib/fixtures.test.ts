import { describe, expect, it } from "vitest";
import { createDemoState } from "./fixtures";
import { validateSchedule } from "./scheduler";
import { addDays, dayOfWeek, localDate, localDateTime, nextWorkDate } from "./time";
import { DEFAULT_SETTINGS } from "./defaults";

// Fictional fixture generation only. No local store, hosted data, or mail.
describe("isolated demo workdays", () => {
  const dates = ["2026-09-07", "2026-09-28", "2026-12-28"].flatMap(start => Array.from({ length: 7 }, (_, offset) => addDays(start, offset)));
  it.each(dates)("seeds distinct, valid future working days from %s", today => {
    const now = localDateTime(today, "13:00", DEFAULT_SETTINGS.timeZone);
    const state = createDemoState(now);
    const days = Array.from({ length: 9 }, (_, offset) => {
      let date = nextWorkDate(addDays(today, 1), state.settings);
      for (let day = 0; day < offset; day++) date = nextWorkDate(addDays(date, 1), state.settings);
      return date;
    });
    const expectedOffsets = [0, 0, 1, 1, 2, 2, 3, 3, 4, 7, 7];
    expect(state.sessions.map(session => localDate(session.start, state.settings.timeZone))).toEqual(expectedOffsets.map(offset => days[offset]));
    expect(new Set(days).size).toBe(days.length);
    expect(days.every(date => state.settings.weekdays.includes(dayOfWeek(date)))).toBe(true);
    expect(state.sessions.every(session => Date.parse(session.start) > Date.parse(now))).toBe(true);
    expect(validateSchedule(state, now)).toEqual([]);
    for (const [index, session] of state.sessions.entries()) {
      expect(state.sessions.slice(index + 1).filter(other => Date.parse(session.start) < Date.parse(other.end) && Date.parse(other.start) < Date.parse(session.end))).toEqual([]);
    }
    expect(state.mode).toBe("demo");
    expect(state.members.every(member => member.email.endsWith("@example.test"))).toBe(true);
    expect(state.events).toEqual([]);
    expect(state.notifications).toEqual([]);
  });
});
