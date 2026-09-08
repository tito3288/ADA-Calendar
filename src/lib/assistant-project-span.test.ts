import { describe, expect, it } from "vitest";
import { projectMonthSpan } from "./assistant-project-span";

describe("whole-month project display spans", () => {
  it.each([
    [
      "rest of this month and next month",
      "2026-09-08",
      "2026-09-08",
      "2026-10-31",
    ],
    [
      "Project context is the rest of September and October 2026, but specific work dates and hours are awaiting client details.",
      "2026-09-08",
      "2026-09-08",
      "2026-10-31",
    ],
    [
      "rest of September and October 2026",
      "2026-09-08",
      "2026-09-08",
      "2026-10-31",
    ],
    [
      "September through October 2026",
      "2026-09-08",
      "2026-09-01",
      "2026-10-31",
    ],
    [
      "rest of September through October 2026",
      "2026-09-08",
      "2026-09-08",
      "2026-10-31",
    ],
    ["This month through next month", "2026-09-08", "2026-09-01", "2026-10-31"],
    ["the rest of this month", "2026-09-30", "2026-09-30", "2026-09-30"],
    ["next month", "2026-12-08", "2027-01-01", "2027-01-31"],
    [
      "rest of this month and next month",
      "2026-12-08",
      "2026-12-08",
      "2027-01-31",
    ],
    ["December through January 2027", "2026-12-08", "2026-12-01", "2027-01-31"],
    [
      "December 2026 through January 2027",
      "2026-12-08",
      "2026-12-01",
      "2027-01-31",
    ],
    ["December 2026 to January", "2026-12-08", "2026-12-01", "2027-01-31"],
    ["December through January", "2026-12-08", "2026-12-01", "2027-01-31"],
    ["rest of February 2028", "2028-02-11", "2028-02-11", "2028-02-29"],
    ["February 2027", "2027-01-01", "2027-02-01", "2027-02-28"],
    ["Project spans September", "2026-08-20", "2026-09-01", "2026-09-30"],
    ["rest of October", "2026-09-08", "2026-10-01", "2026-10-31"],
    [
      "Project for SEPTEMBER THROUGH OCTOBER 2026, awaiting a brief.",
      "2026-09-08",
      "2026-09-01",
      "2026-10-31",
    ],
  ])("infers only date-only boundaries: %s", (text, today, start, end) => {
    const span = projectMonthSpan(text, today);
    expect(span).toEqual({ start, end });
    expect(Object.keys(span!)).toEqual(["start", "end"]);
  });

  it.each([
    "",
    "Awaiting a brief; no dates yet.",
    "September through November 2026",
    "September and September 2026",
    "October through September 2026",
    "September 2026 through October 2027",
    "September and October and November 2026",
    "September or October 2026",
    "September / October 2026",
    "September through early October 2026",
    "September through mid-October 2026",
    "late September and October 2026",
    "first half of September 2026",
    "September 9 through October 11 2026",
    "9 September through October 2026",
    "September through October 31, 2026",
    "September and Octoberrr 2026",
    "Septembur and October 2026",
    "September 20260",
    "September 0000",
    "December through January 0001",
    "this month 2026",
    "this month and October 2026",
    "next month and this month",
    "next month and next month",
    "Not September through October 2026",
    "Not for September through October 2026",
    "Do not show September through October 2026",
    "September through October early",
    "September through October 2026, ending mid-month",
    "September through October 2026, except October",
    "September through October 2026; next month too",
    "September through October 2026, end 2026-10-12",
    "September through October 2026, earlier 2026-01-01",
    "September through October 2026; 09/17 is a separate day",
    "Client May is waiting for a brief",
    "The 2025 project spans September 2026",
  ])(
    "declines incomplete, conflicting, or unsupported language: %s",
    (text) => {
      expect(projectMonthSpan(text, "2026-09-08")).toBeNull();
    },
  );

  it("does not invent a remaining part of an already elapsed month", () => {
    expect(
      projectMonthSpan("rest of September and October 2026", "2026-10-08"),
    ).toBeNull();
  });

  it.each([
    "invalid",
    "2026-02-30",
    "2026-2-01",
    "0000-01-01",
    "2026-09-08T12:00:00Z",
  ])("requires a valid workspace-local date: %s", (today) =>
    expect(projectMonthSpan("this month", today)).toBeNull(),
  );

  it("declines a relative month beyond the supported four-digit year", () => {
    expect(projectMonthSpan("next month", "9999-12-08")).toBeNull();
  });
});
