import { describe, expect, it } from "vitest";
import { DEMO_MEMBERS } from "./fixtures";
import { newWorkItem } from "./work";
import { effectiveTimelineMode, workTimeline } from "./work-timeline";
import { localDateTime } from "./time";
import type { WorkSession } from "./types";

const zone = "America/Indiana/Indianapolis";
const task = () => newWorkItem(DEMO_MEMBERS[0], "2026-09-09", { id: "test", clientId: "client", title: "Fictional work" });
const session = (date: string): WorkSession => ({ id: date, workItemId: "test", start: localDateTime(date, "09:00", zone), end: localDateTime(date, "10:00", zone), status: "planned", protected: false, usesReserve: false });

describe("display timelines without scheduling authority", () => {
  it("follows booked days instead of old display dates or forecasts", () => {
    const item = { ...task(), windowEnd: "2026-12-31", forecastDate: "2027-01-01" };
    expect(workTimeline(item, [session("2026-09-11")], zone)).toEqual({ mode: "bookings", start: "2026-09-11", end: "2026-09-11" });
    expect(workTimeline(item, [], zone)).toBeNull();
  });
  it("keeps ongoing work open with no bookings and after later estimating", () => {
    const item = { ...task(), timelineMode: "span" as const, estimatedMinutes: null, remainingMinutes: null, windowEnd: null };
    expect(workTimeline(item, [], zone)).toEqual({ mode: "span", start: "2026-09-09", end: null });
    expect(workTimeline({ ...item, estimatedMinutes: 180, remainingMinutes: 180 }, [session("2026-10-15")], zone)).toEqual(workTimeline(item, [], zone));
  });
  it("infers legacy ongoing and unbooked spans without changing their JSON", () => {
    const item = task(); delete item.timelineMode; delete item.dateConstraints;
    const before = JSON.stringify(item);
    expect(effectiveTimelineMode(item, [])).toBe("span");
    expect(effectiveTimelineMode(item, [session("2026-09-11")])).toBe("bookings");
    expect(effectiveTimelineMode({ ...item, estimatedMinutes: null, remainingMinutes: 0 }, [session("2026-09-11")])).toBe("span");
    expect(JSON.stringify(item)).toBe(before);
  });
  it("closes open spans only on explicit completion or cancellation", () => {
    const item = { ...task(), timelineMode: "span" as const, windowEnd: null, completedAt: "2026-09-11T16:00:00Z" };
    expect(workTimeline({ ...item, status: "completed" }, [], zone)?.end).toBe("2026-09-11");
    expect(workTimeline({ ...item, completedAt: null, status: "cancelled", updatedAt: "2026-09-12T16:00:00Z" }, [], zone)?.end).toBe("2026-09-12");
    expect(workTimeline({ ...item, completedAt: null }, [], zone)?.end).toBeNull();
  });
});
