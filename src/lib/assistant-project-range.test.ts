import { describe, expect, it } from "vitest";
import { projectDateSpan, projectMonthSpan } from "./assistant-project-span";

describe("project display date ranges", () => {
  it.each([
    [
      "today until the end of next month",
      "2026-09-09",
      "2026-09-09",
      "2026-10-31",
    ],
    [
      "From now through the end of this month",
      "2026-09-09",
      "2026-09-09",
      "2026-09-30",
    ],
    [
      "tomorrow to the end of October",
      "2026-09-09",
      "2026-09-10",
      "2026-10-31",
    ],
    [
      "today 2026-09-09 to the end of October 31st",
      "2026-09-09",
      "2026-09-09",
      "2026-10-31",
    ],
    [
      "today (2026-09-09) through October 31st, 2026",
      "2026-09-09",
      "2026-09-09",
      "2026-10-31",
    ],
    [
      "today, 2026-09-09 until the end of next month",
      "2026-09-09",
      "2026-09-09",
      "2026-10-31",
    ],
    [
      "2026-09-09 to the end of October",
      "2026-09-09",
      "2026-09-09",
      "2026-10-31",
    ],
    [
      "2026-09-09 through October 31st",
      "2026-09-09",
      "2026-09-09",
      "2026-10-31",
    ],
    [
      "September 9 through 2026-10-31",
      "2026-09-09",
      "2026-09-09",
      "2026-10-31",
    ],
    [
      "September 9th through October 31st",
      "2026-09-09",
      "2026-09-09",
      "2026-10-31",
    ],
    [
      "September 9, 2026 through October 31, 2026",
      "2026-09-09",
      "2026-09-09",
      "2026-10-31",
    ],
    [
      "9 September through the 31st of October 2026",
      "2026-09-09",
      "2026-09-09",
      "2026-10-31",
    ],
    [
      "September through October 31, 2026",
      "2026-09-09",
      "2026-09-01",
      "2026-10-31",
    ],
    [
      "the start of September until the end of October",
      "2026-09-09",
      "2026-09-01",
      "2026-10-31",
    ],
    ["2026-09-09 through 2026-10-31", "2026-09-09", "2026-09-09", "2026-10-31"],
    ["today through today", "2026-09-09", "2026-09-09", "2026-09-09"],
    [
      "today until the end of the year",
      "2026-09-09",
      "2026-09-09",
      "2026-12-31",
    ],
    ["now through year-end", "2026-09-09", "2026-09-09", "2026-12-31"],
    [
      "tomorrow through the end of next month",
      "2026-12-31",
      "2027-01-01",
      "2027-01-31",
    ],
    ["December 19 to January 14", "2026-12-09", "2026-12-19", "2027-01-14"],
    [
      "December 19 to January 14, 2027",
      "2026-09-09",
      "2026-12-19",
      "2027-01-14",
    ],
    ["2026-11-20 through February 9", "2026-09-09", "2026-11-20", "2027-02-09"],
    [
      "today through the end of February",
      "2027-12-09",
      "2027-12-09",
      "2028-02-29",
    ],
    [
      "February 9 through February 29, 2028",
      "2026-09-09",
      "2028-02-09",
      "2028-02-29",
    ],
    [
      "today through the end of next month",
      "2028-01-09",
      "2028-01-09",
      "2028-02-29",
    ],
    [
      "today through the end of next month",
      "2027-01-09",
      "2027-01-09",
      "2027-02-28",
    ],
    [
      "Project timeline from today until the end of next month, and as I get updates I will add work.",
      "2026-09-09",
      "2026-09-09",
      "2026-10-31",
    ],
    [
      "The rest of this month and next month and as I get updates I will add sessions.",
      "2026-09-09",
      "2026-09-09",
      "2026-10-31",
    ],
    [
      "the rest of September and October 2026 and I will provide hours later",
      "2026-09-09",
      "2026-09-09",
      "2026-10-31",
    ],
  ])("compiles date-only display boundaries: %s", (text, today, start, end) => {
    const result = projectDateSpan(text, today);
    expect(result).toEqual({ span: { start, end } });
    expect(Object.keys(result.span!)).toEqual(["start", "end"]);
  });

  it.each([
    "today 2026-09-08 to the end of October 31st",
    "tomorrow 2026-09-09 until the end of next month",
    "2026-09-09 through 2026-02-30",
    "September 31 through October 31",
    "2026-09-09 to November 31",
    "2027-02-01 through February 29, 2027",
    "today until the end of October 15th",
    "today until the end of April 31st",
    "2026-10-11 through October 10, 2026",
    "2026-10-11 through October 10",
    "2026-09-09 through 2027-09-09",
    "December 9, 2026 through January 9, 2026",
    "From November 30th until October 1st, 2026.",
    "September 9 through October 31, 0000",
    "today through October 31, 20260",
    "today until the end of next month 2027",
    "today through mid-October",
    "today through early October",
    "today through late October",
    "mid-September 9 through October 31",
    "not today through October 31",
    "do not show today through October 31",
    "don't use today through October 31",
    "I don't want the project timeline from today through October 31",
    "I don't want September through October 2026",
    "rather than today through October 31",
    "today through October 31, ending mid-month",
    "today through October 31, ending in the middle of the month",
    "today through October 31, but only until the 15th",
    "today through October 31, except October 10",
    "today through October 31 or November 30",
    "today through October 31 and November 9 through November 30",
    "today through October 31; another span through December 31",
    "today through October 31; invoice dated 2025-09-01",
    "invoice dated 2025-09-01; project timeline today through October 31",
    "today through October 31 and 2 hours on September 19",
    "today through October 31; deadline November 1",
    "today through October 31, but end on 10/15",
    "today through October 31, then through November",
    "today through October 31 and Octoberrr",
    "rest of this month and next month and mid-month",
    "September or October 2026",
    "September through mid-October 2026",
    "September through October 2026; next month too",
    "September through October 2026, ending mid-month",
    "September and October and November 2027; invoice 2025",
    "September 9 to 10/31",
    "09/09 through 10/31",
  ])(
    "requires clarification for conflicting or invalid range evidence: %s",
    (text) => {
      const result = projectDateSpan(text, "2026-09-09");
      expect(result.span).toBeUndefined();
      expect(result.error).toBeTruthy();
    },
  );

  it.each([
    "",
    "waiting for a brief",
    "Client May is waiting",
    "today",
    "tomorrow",
    "2026-09-09",
    "September 9",
  ])("does not claim a range from a name or isolated date: %s", (text) =>
    expect(projectDateSpan(text, "2026-09-09")).toEqual({}),
  );

  it.each([
    "invalid",
    "2026-02-30",
    "2026-2-01",
    "0000-01-01",
    "2026-09-09T13:00:00Z",
  ])("validates the injected workspace-local date: %s", (today) =>
    expect(
      projectDateSpan("today through October 31", today).error,
    ).toBeTruthy(),
  );

  it("rejects year overflow", () => {
    expect(
      projectDateSpan("today until the end of next month", "9999-12-09").error,
    ).toBeTruthy();
  });

  it("allows a normal prose conjunction after a whole-month display range", () => {
    expect(
      projectMonthSpan(
        "rest of this month and next month and as I get updates I will add hours",
        "2026-09-09",
      ),
    ).toEqual({ start: "2026-09-09", end: "2026-10-31" });
  });
});
