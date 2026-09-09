import { describe, expect, it } from "vitest";
import {
  bookedDayHours,
  changedDayHours,
  parseDayHours,
  usableWorkDate,
} from "./day-hours";
import { DEFAULT_SETTINGS } from "./defaults";
import type { WorkSession } from "./types";

describe("day-hour editing", () => {
  it("starts a fresh booking on the next working day after closing time", () => {
    expect(
      usableWorkDate("2026-09-11", DEFAULT_SETTINGS, "2026-09-11T21:00:00Z"),
    ).toBe("2026-09-14");
    expect(
      usableWorkDate("2026-09-11", DEFAULT_SETTINGS, "2026-09-11T20:30:00Z"),
    ).toBe("2026-09-11");
  });
  it("groups separated future sessions by local work day without treating history as editable", () => {
    const session = (
      id: string,
      start: string,
      end: string,
      status: WorkSession["status"] = "planned",
    ): WorkSession => ({
      id,
      workItemId: "work",
      start,
      end,
      status,
      protected: false,
      usesReserve: false,
    });
    expect(
      bookedDayHours(
        [
          session("history", "2026-09-09T13:00:00Z", "2026-09-09T14:00:00Z"),
          session("morning", "2026-09-10T13:00:00Z", "2026-09-10T16:00:00Z"),
          session("afternoon", "2026-09-10T16:30:00Z", "2026-09-10T17:30:00Z"),
          session(
            "completed",
            "2026-09-11T13:00:00Z",
            "2026-09-11T14:00:00Z",
            "completed",
          ),
        ],
        "America/Indiana/Indianapolis",
        "2026-09-09T15:00:00Z",
      ),
    ).toEqual([{ date: "2026-09-10", minutes: 240 }]);
  });
  it("moves just the edited day's total while omitting unchanged days", () => {
    expect(
      changedDayHours(
        [
          { date: "2026-09-10", minutes: 120 },
          { date: "2026-09-11", minutes: 180 },
        ],
        [
          { date: "2026-09-11", minutes: 180 },
          { date: "2026-09-14", minutes: 120 },
        ],
      ),
    ).toEqual([
      { date: "2026-09-10", minutes: 0 },
      { date: "2026-09-14", minutes: 120 },
    ]);
  });
  it("requires one valid row per date and keeps quarter-hour precision", () => {
    const row = { id: "one", date: "2026-09-10", hours: "1.25" };
    expect(parseDayHours([row])).toEqual([{ date: row.date, minutes: 75 }]);
    expect(() => parseDayHours([row, { ...row, id: "two" }])).toThrow(
      "Use each work day once",
    );
    expect(() => parseDayHours([{ ...row, hours: "" }])).toThrow(
      "Enter 0.25 to 8 hours",
    );
    expect(() => parseDayHours([{ ...row, hours: "1.1" }])).toThrow(
      "15-minute steps",
    );
  });
});
