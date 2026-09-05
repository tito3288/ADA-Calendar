import { expect, type APIRequestContext } from "@playwright/test";
import { addDays, localDate, localDateTime, nextWorkDate } from "../../src/lib/time";
import { newWorkItem } from "../../src/lib/work";
import type { AppState, ScheduleProposal, WorkCommand, WorkItem, WorkSession } from "../../src/lib/types";

export const origin = "http://127.0.0.1:3100";
export const post = (request: APIRequestContext, route: string, data: unknown) => request.post(`/api/${route}`, { data, headers: { Origin: origin } });
export async function state(request: APIRequestContext): Promise<AppState> {
  const response = await request.get("/api/state");
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
export async function asActor(request: APIRequestContext, id: "bryan" | "kyle" | "william" | "viewer") {
  const response = await post(request, "demo/actor", { id });
  expect(response.ok(), await response.text()).toBe(true);
}
export function futureDate(snapshot: AppState, days = 28) {
  return nextWorkDate(addDays(localDate(new Date().toISOString(), snapshot.settings.timeZone), days), snapshot.settings);
}
export function makeItem(snapshot: AppState, title: string, patch: Partial<WorkItem> = {}) {
  const date = futureDate(snapshot);
  return newWorkItem(snapshot.actor, date, { title, clientId: "higher-ground", estimatedMinutes: 30, remainingMinutes: 30, ...patch });
}
export function exactSession(snapshot: AppState, workItem: WorkItem, start = "09:00", end = "09:30"): WorkSession {
  return { id: crypto.randomUUID(), workItemId: workItem.id, start: localDateTime(workItem.windowStart, start, snapshot.settings.timeZone), end: localDateTime(workItem.windowStart, end, snapshot.settings.timeZone), protected: false, status: "planned", usesReserve: false };
}
export async function preview(request: APIRequestContext, commands: WorkCommand[], operationId = crypto.randomUUID()): Promise<ScheduleProposal> {
  const response = await post(request, "commands", { commands, operationId, action: "preview" });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).proposal;
}
export async function commit(request: APIRequestContext, proposal: ScheduleProposal): Promise<AppState> {
  const response = await post(request, "commands", { commands: proposal.commands, operationId: proposal.operationId, baseVersion: proposal.baseVersion, reviewFingerprint: proposal.reviewFingerprint, action: "commit" });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).state;
}
