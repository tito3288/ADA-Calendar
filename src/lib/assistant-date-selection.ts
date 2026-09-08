import { z } from "zod";
import { dateSchema } from "./schemas";

/** User-chosen context for one instruction, never a booking or permission grant. */
export const dateSelectionSchema = z.object({
  start: dateSchema,
  end: dateSchema,
  kind: z.enum(["work_window", "project_span"]),
}).strict().refine(selection => selection.end >= selection.start, {
  message: "The selected end date must be on or after the start date.",
  path: ["end"],
}).refine(selection => Date.parse(selection.end) - Date.parse(selection.start) < 366 * 86_400_000, {
  message: "Choose a date range of up to 366 days.",
  path: ["end"],
});

export type AssistantDateSelection = z.infer<typeof dateSelectionSchema>;
