import { expect, it } from "vitest";
import { pendingBookingCommands } from "./pending-bookings";
import { DEMO_MEMBERS } from "./fixtures";
import { newWorkItem } from "./work";
import { localDateTime } from "./time";
import { commandSchema } from "./schemas";
import type { PendingRequest } from "./types";

it("refreshes an old request from its proposed dated hours without restoring old locks", () => {
  const item = newWorkItem(DEMO_MEMBERS[0], "2026-09-10", { id: "pending", clientId: "client", title: "Fictional pending request", estimatedMinutes: 120, remainingMinutes: 120, allowedDates: ["2026-09-10"] });
  delete item.dateConstraints; delete item.timelineMode;
  const request = { proposal: { commands: [{ type: "create", item }], sessions: [{ id: "a", workItemId: item.id, start: localDateTime("2026-09-10", "09:00", "America/Indiana/Indianapolis"), end: localDateTime("2026-09-10", "11:00", "America/Indiana/Indianapolis"), status: "planned" }] } } as PendingRequest;
  const before = JSON.stringify(request);
  const command = pendingBookingCommands(request, "America/Indiana/Indianapolis")[0];
  expect(command).toMatchObject({ type: "create", item: { dateConstraints: { earliestStart: null, allowedDates: [] }, dailyPlan: [{ date: "2026-09-10", minutes: 120 }] }, bookingWindow: { startDate: "2026-09-10", endDate: "2026-09-10", dates: ["2026-09-10"] } });
  expect(JSON.stringify(request)).toBe(before);
});

it("keeps sparse unplaced request dates as transient placement input even outside the old display span", () => {
  const item = newWorkItem(DEMO_MEMBERS[0], "2026-09-10", { id: "pending", clientId: "client", title: "Fictional sparse request", estimatedMinutes: 120, remainingMinutes: 120, allowedDates: ["2026-09-14", "2026-09-16"] });
  delete item.dateConstraints; delete item.timelineMode;
  const request = { proposal: { commands: [{ type: "create", item }], sessions: [] } } as unknown as PendingRequest;
  const command = pendingBookingCommands(request, "America/Indiana/Indianapolis")[0];
  expect(command).toMatchObject({ bookingWindow: { startDate: "2026-09-14", endDate: "2026-09-16", dates: ["2026-09-14", "2026-09-16"] }, item: { dateConstraints: { earliestStart: null, allowedDates: [] } } });
  expect(commandSchema.safeParse(command).success).toBe(true);
});

it("prepares current per-day smart-fit requests for review using saved weekdays without changing private source data", () => {
  const item = newWorkItem(DEMO_MEMBERS[0], "2026-09-10", { clientId: "client", title: "Fictional daily request", estimatedMinutes: 120, remainingMinutes: 120 });
  const request = { proposal: { commands: [{ type: "create", item, smartFit: { startDate: "2026-09-10", endDate: "2026-09-14", minutes: 60, distribution: "per_day", dates: ["2026-09-10", "2026-09-12", "2026-09-14"] } }], sessions: [] } } as unknown as PendingRequest;
  const before = structuredClone(request);
  const command = pendingBookingCommands(request, "America/Indiana/Indianapolis", [4, 6])[0];
  expect(command).toMatchObject({ type: "create", item: { dailyPlan: [{ date: "2026-09-10", minutes: 60 }, { date: "2026-09-12", minutes: 60 }], dateConstraints: { earliestStart: null, allowedDates: [] } },
    bookingWindow: { startDate: "2026-09-10", endDate: "2026-09-14", dates: ["2026-09-10", "2026-09-12", "2026-09-14"] } });
  expect(command.type === "create" && command.smartFit).toBeUndefined();
  expect(commandSchema.safeParse(command).success).toBe(true);
  expect(request).toEqual(before);
});

it("keeps current total requests flexible within their original range and preserves explicit limits", () => {
  const item = newWorkItem(DEMO_MEMBERS[0], "2026-09-10", { clientId: "client", title: "Fictional total request", estimatedMinutes: 120, remainingMinutes: 120,
    dateConstraints: { earliestStart: "2026-09-10", allowedDates: [] } });
  const request = { proposal: { commands: [{ type: "create", item, smartFit: { startDate: "2026-09-10", endDate: "2026-09-14", minutes: 120, distribution: "total" } }], sessions: [] } } as unknown as PendingRequest;
  const command = pendingBookingCommands(request, "America/Indiana/Indianapolis")[0];
  expect(command).toMatchObject({ item: { dateConstraints: item.dateConstraints }, bookingWindow: { startDate: "2026-09-10", endDate: "2026-09-14" } });
  expect(command.type === "create" && command.item.dailyPlan).toBeUndefined();
  expect(command.type === "create" && command.smartFit).toBeUndefined();
});

it("does not turn an explicitly empty session plan into an automatic booking", () => {
  const item = newWorkItem(DEMO_MEMBERS[0], "2026-09-10", { clientId: "client", title: "Fictional explicit plan" });
  delete item.dateConstraints;
  const request = { proposal: { commands: [{ type: "create", item, sessions: [] }], sessions: [] } } as unknown as PendingRequest;
  const command = pendingBookingCommands(request, "America/Indiana/Indianapolis")[0];
  expect(command).toMatchObject({ sessions: [] });
  expect(command.type === "create" && command.bookingWindow).toBeUndefined();
});
