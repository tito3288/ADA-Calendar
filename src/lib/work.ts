import type { Actor, WorkItem } from "./types";

export function newWorkItem(actor: Actor, date: string, patch: Partial<WorkItem> = {}): WorkItem {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), clientId: "", title: "", description: "", category: "web", webKind: "edit",
    requesterId: actor.id, requestedBy: actor.name, priorityId: "normal", requestedPriorityId: null,
    status: "planned", estimatedMinutes: 60, remainingMinutes: 60, windowStart: date,
    windowEnd: date, targetDate: null, deadline: null, forecastDate: null, completedAt: null,
    blockedReason: null, minimumSessionMinutes: 15, allowedDates: [], checklist: [],
    progressTotal: null, progressCompleted: 0, updateDate: null, references: [], createdAt: now, updatedAt: now,
    ...patch,
  };
}

export function formatHours(minutes: number) {
  return `${Number((minutes / 60).toFixed(2))}h`;
}
