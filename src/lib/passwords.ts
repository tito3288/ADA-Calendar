import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_MAX_BYTES = 72;
const emailSchema = z.string().trim().toLowerCase().pipe(z.email());
export const passwordLoginSchema = z.object({
  email: emailSchema,
  // Never trim a password. Accept existing passwords; enforce the new policy on creation.
  password: z.string().min(1, "Enter your password.").max(PASSWORD_MAX_LENGTH),
}).strict();
export const passwordRecoverySchema = z.object({ email: emailSchema }).strict();
export const passwordUpdateSchema = z.object({
  password: z.string().min(PASSWORD_MIN_LENGTH, "Use at least 12 characters.").max(PASSWORD_MAX_LENGTH)
    .refine(value => new TextEncoder().encode(value).length <= PASSWORD_MAX_BYTES, "Use no more than 72 bytes; accented characters and emoji can use more than one byte."),
  confirmPassword: z.string().max(PASSWORD_MAX_LENGTH),
}).strict().refine(input => input.password === input.confirmPassword, {
  message: "Your passwords do not match.", path: ["confirmPassword"],
});
