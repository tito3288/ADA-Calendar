import { DEFAULT_PRIORITIES } from "./defaults";
import type { Actor, Category, Priority, WorkItem } from "./types";

export function defaultWorkPriority(category: Category, priorities: readonly Priority[] = DEFAULT_PRIORITIES): string {
  return priorities.find(priority => priority.id === (category === "it" ? "urgent" : "normal"))?.id
    ?? priorities.find(priority => priority.id === "normal")?.id
    ?? priorities.find(priority => priority.rank === 2)?.id
    ?? priorities.at(-1)?.id
    ?? "normal";
}

export function newWorkItem(actor: Actor, date: string, patch: Partial<WorkItem> = {}): WorkItem {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), clientId: "", title: "", description: "", category: "web", webKind: "edit",
    requesterId: actor.id, requestedBy: actor.name,
    priorityId: actor.role === "owner" ? defaultWorkPriority(patch.category ?? "web") : "normal",
    requestedPriorityId: actor.role === "requester" && patch.category === "it" ? defaultWorkPriority("it") : null,
    status: "planned", estimatedMinutes: 60, remainingMinutes: 60, windowStart: date,
    windowEnd: date, targetDate: null, deadline: null, forecastDate: null, completedAt: null,
    dateConstraints: { earliestStart: null, allowedDates: [] }, timelineMode: patch.estimatedMinutes === null ? "span" : "bookings",
    blockedReason: null, minimumSessionMinutes: 15, allowedDates: [], checklist: [],
    progressTotal: null, progressCompleted: 0, updateDate: null, references: [], createdAt: now, updatedAt: now,
    ...patch,
  };
}

export function formatHours(minutes: number) {
  return `${Number((minutes / 60).toFixed(2))}h`;
}
