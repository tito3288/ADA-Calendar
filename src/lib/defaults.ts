import type { Category, Priority, WorkspaceSettings } from "./types";
export const DEFAULT_SETTINGS: WorkspaceSettings = {
  name: "ADA Calendar", timeZone: "America/Indiana/Indianapolis", weekdays: [1, 2, 3, 4, 5],
  dayStart: "09:00", dayEnd: "17:00", lunchStart: "12:00", lunchEnd: "12:30",
  reserveStart: "16:00", reserveMinutes: 60, slotMinutes: 15, weeklyDay: 5, weeklyTime: "15:00",
  aiWarningUsd: 20, aiLimitUsd: 25,
};
export const DEFAULT_PRIORITIES: Priority[] = [
  { id: "urgent", label: "Urgent", rank: 0 }, { id: "high", label: "High", rank: 1 },
  { id: "normal", label: "Normal", rank: 2 }, { id: "low", label: "Low", rank: 3 },
];
export const CATEGORY_LABELS: Record<Category, string> = { web: "Web", it: "IT", landings: "Landings", software: "Software" };
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;
