import type { SupabaseClient, User } from "@supabase/supabase-js";
import { z } from "zod";
import { assertAuthEmailAllowed } from "./auth-email-policy";

type AuthClient = Pick<SupabaseClient, "auth">;

/** Server/administrative use only. No email is sent until membership is bound. */
export async function ensureAuthAccount(db: AuthClient, email: string, name: string): Promise<User> {
  const address = z.email().parse(email.trim().toLowerCase());
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error("Could not look up the authentication account.");
    const existing = data.users.find(user => user.email?.toLowerCase() === address);
    if (existing) return existing;
    if (data.users.length < 1000) break;
  }
  const { data, error } = await db.auth.admin.createUser({ email: address, email_confirm: false, user_metadata: { name } });
  if (error || !data.user) throw new Error("Could not create the authentication account. No invitation was sent; retry after checking account setup.");
  return data.user;
}

/** Call only after active membership has been saved and email delivery authorized. */
export async function deliverAccountSetupEmail(db: AuthClient, user: User, appUrl: string, supabaseUrl: string): Promise<"invitation" | "recovery"> {
  const email = z.email().parse(user.email);
  assertAuthEmailAllowed(email, supabaseUrl);
  let target: URL;
  try { target = new URL(appUrl); }
  catch { throw new Error("APP_URL is required for account setup email."); }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password ||
    (process.env.NODE_ENV === "production" && target.protocol !== "https:")) {
    throw new Error("APP_URL must be a valid application origin; production requires HTTPS.");
  }
  const redirectTo = new URL("/api/auth/callback", target.origin).toString();
  if (user.email_confirmed_at) {
    const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw new Error("The account is ready, but its password setup email could not be sent. Check SMTP settings and retry explicitly.");
    return "recovery";
  }
  // Supabase permits inviting a pre-created, unconfirmed user. Creating first
  // lets the caller finish membership before a recipient can accept the link.
  const { error } = await db.auth.admin.inviteUserByEmail(email, { redirectTo });
  if (error) throw new Error("The account is ready, but its invitation could not be sent. Check SMTP settings and retry explicitly.");
  return "invitation";
}
