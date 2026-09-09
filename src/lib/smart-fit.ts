import type { SmartFitRequest, WorkspaceSettings } from "./types";
import { addDays, dayOfWeek, isDate } from "./time";

export interface SmartFitDraft {
  startDate: string;
  endDate: string;
  hours: string;
  distribution: "total" | "per_day";
}

export function smartFitRequest(draft: SmartFitDraft): SmartFitRequest {
  if (!isDate(draft.startDate) || !isDate(draft.endDate) || draft.endDate < draft.startDate || draft.endDate > addDays(draft.startDate, 365))
    throw new Error("Choose a day or a date range of up to one year.");
  const minutes = Number(draft.hours) * 60;
  if (!draft.hours.trim() || !Number.isInteger(minutes) || minutes < 15 || minutes > 100_000 || minutes % 15 !== 0)
    throw new Error("Enter hours in 15-minute steps, such as 0.5, 1, or 2.");
  if (draft.distribution === "per_day" && minutes > 480)
    throw new Error("Choose no more than 8 hours per day. ADA will also check your available working hours.");
  return { startDate: draft.startDate, endDate: draft.endDate, minutes, distribution: draft.distribution };
}

export function smartFitTotal(request: SmartFitRequest, settings: Pick<WorkspaceSettings, "weekdays">): number {
  if (request.distribution === "total") return request.minutes;
  return smartFitWorkingDays(request, settings) * request.minutes;
}

export function smartFitWorkingDays(request: Pick<SmartFitRequest, "startDate" | "endDate">, settings: Pick<WorkspaceSettings, "weekdays">): number {
  if (!isDate(request.startDate) || !isDate(request.endDate) || request.endDate < request.startDate || request.endDate > addDays(request.startDate, 365)) return 0;
  let days = 0;
  for (let date = request.startDate; date <= request.endDate; date = addDays(date, 1))
    if (settings.weekdays.includes(dayOfWeek(date))) days++;
  return days;
}
