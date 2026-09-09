import { describe, expect, it } from "vitest";
import { smartFitRequest, smartFitTotal } from "./smart-fit";

describe("smart-fit form drafts", () => {
  const draft = { startDate: "2026-09-14", endDate: "2026-09-18", hours: "2", distribution: "total" as const };
  it("keeps total hours distinct from daily hours", () => {
    expect(smartFitTotal(smartFitRequest(draft), { weekdays: [1, 2, 3, 4, 5] })).toBe(120);
    expect(smartFitTotal(smartFitRequest({ ...draft, distribution: "per_day" }), { weekdays: [1, 2, 3, 4, 5] })).toBe(600);
  });
  it("counts only the workspace's working days, including custom weeks", () => {
    const request = smartFitRequest({ ...draft, endDate: "2026-09-20", distribution: "per_day" });
    expect(smartFitTotal(request, { weekdays: [1, 2, 3, 4, 5] })).toBe(600);
    expect(smartFitTotal(request, { weekdays: [6, 7] })).toBe(240);
  });
  for (const patch of [{ hours: "" }, { hours: "0" }, { hours: "1.1" }, { hours: "Infinity" }, { startDate: "2026-02-30" }, { endDate: "2026-09-13" }, { endDate: "2028-09-18" }])
    it(`rejects incomplete or invalid input ${JSON.stringify(patch)}`, () => expect(() => smartFitRequest({ ...draft, ...patch })).toThrow());
});
