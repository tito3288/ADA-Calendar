import { z } from "zod";
import { idSchema } from "./schemas";

export const NOTE_TITLE_MAX_LENGTH = 200;
export const NOTE_BODY_MAX_LENGTH = 50_000;

export interface PersonalNote {
  id: string;
  title: string;
  body: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const noteSaveSchema = z.object({
  id: idSchema,
  // Validation must not trim or otherwise rewrite the owner's saved text.
  title: z.string().max(NOTE_TITLE_MAX_LENGTH).refine(value => value.trim().length > 0, "Give your note a title.")
    .refine(value => !value.includes("\0"), "The title contains an unsupported character."),
  body: z.string().max(NOTE_BODY_MAX_LENGTH).refine(value => !value.includes("\0"), "The note contains an unsupported character."),
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
}).strict();

export type NoteSaveInput = z.infer<typeof noteSaveSchema>;
