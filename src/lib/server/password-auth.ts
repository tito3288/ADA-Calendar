import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { passwordLoginSchema, passwordRecoverySchema, passwordUpdateSchema } from "../passwords";
import { assertAuthEmailAllowed } from "../auth-email-policy";
import { clearSupabaseSessionCookies, getSupabaseAdminClient, getSupabaseServerClient } from "./supabase";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
const LOGIN_ERROR = "Unable to sign in. Check your email and password, and make sure you have been invited.";
export const RECOVERY_MESSAGE = "If this email belongs to an invited account, you will receive a password-reset link. Check your inbox and spam folder.";

export function authResponse(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function appOrigin() {
  const configured = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!configured) throw new Error("Authentication is not configured.");
  const url = new URL(configured);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (process.env.NODE_ENV === "production" && url.protocol !== "https:")) {
    throw new Error("Authentication is not configured.");
  }
  return url.origin;
}

function redirectAuth(path: string) {
  return NextResponse.redirect(new URL(path, appOrigin()), { headers: PRIVATE_HEADERS });
}

async function hasMembership(db: SupabaseClient, userId: string) {
  const { data, error } = await db.from("workspace_members").select("user_id")
    .eq("user_id", userId).eq("active", true).maybeSingle();
  return !error && !!data;
}

async function signOutHere(db: SupabaseClient) {
  try { await db.auth.signOut({ scope: "local" }); }
  finally { await clearSupabaseSessionCookies(); }
}

export async function loginWithPassword(body: unknown) {
  const parsed = passwordLoginSchema.safeParse(body);
  if (!parsed.success) return authResponse({ error: "Enter a valid email and password." }, 400);
  let db: SupabaseClient | undefined;
  try {
    db = await getSupabaseServerClient();
    const { data, error } = await db.auth.signInWithPassword(parsed.data);
    if (error || !data.user || !data.session || !await hasMembership(db, data.user.id)) {
      await signOutHere(db);
      return authResponse({ error: LOGIN_ERROR }, 401);
    }
    // The SDK writes the persistent session cookies. Never return tokens/passwords in JSON.
    return authResponse({ ok: true });
  } catch {
    if (db) await signOutHere(db).catch(() => undefined);
    return authResponse({ error: LOGIN_ERROR }, 401);
  }
}

export async function requestPasswordRecovery(body: unknown) {
  const parsed = passwordRecoverySchema.safeParse(body);
  if (!parsed.success) return authResponse({ error: "Enter a valid email address." }, 400);
  const { email } = parsed.data;
  try {
    const origin = appOrigin();
    assertAuthEmailAllowed(email, process.env.NEXT_PUBLIC_SUPABASE_URL || "");
    const admin = getSupabaseAdminClient();
    const { data, error } = await admin.from("workspace_members").select("user_id")
      .eq("email", email).eq("active", true).maybeSingle();
    if (error) return authResponse({ error: "Password recovery is temporarily unavailable. Please try again later." }, 503);
    if (data) {
      const db = await getSupabaseServerClient();
      // Hosted Auth SMTP is separate from captured workload notifications.
      // Provider errors must not disclose whether a particular account exists.
      await db.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/api/auth/callback` })
        .catch(() => undefined);
    }
    return authResponse({ message: RECOVERY_MESSAGE });
  } catch {
    return authResponse({ error: "Password recovery is not available in this environment yet. Contact the workspace owner." }, 503);
  }
}

export async function updateOwnPassword(body: unknown) {
  const parsed = passwordUpdateSchema.safeParse(body);
  if (!parsed.success) return authResponse({ error: parsed.error.issues.map(issue => issue.message).join(" ") }, 400);
  try {
    const db = await getSupabaseServerClient();
    // getUser verifies the session with Auth. Query parameters and caller-supplied IDs
    // never authorize a password update; only an active member may update their own.
    const { data: { user }, error } = await db.auth.getUser();
    if (error || !user || !await hasMembership(db, user.id)) {
      return authResponse({ error: "Open a valid invitation or password-reset link first." }, 401);
    }
    const updated = await db.auth.updateUser({ password: parsed.data.password });
    if (updated.error) {
      const message = updated.error.code === "same_password"
        ? "Choose a password different from your current password."
        : updated.error.code === "weak_password"
          ? "This password does not meet account security requirements. Choose a longer, unique password."
          : "Your password could not be updated. Open a fresh password-reset link and try again.";
      return authResponse({ error: message }, 400);
    }
    // Reset/initial setup finishes at password sign-in. Revoke refresh sessions on
    // other devices too; existing access JWTs remain subject to Supabase expiry.
    try { await db.auth.signOut({ scope: "global" }); }
    finally { await clearSupabaseSessionCookies(); }
    return authResponse({ ok: true });
  } catch {
    return authResponse({ error: "The request could not be completed. Try signing in with your new password, or request a fresh reset link." }, 400);
  }
}

export async function handleAuthCallback(req: NextRequest) {
  // Error messages, arbitrary next URLs, and token strings are never reflected.
  // Each successful callback strips credentials immediately via a fixed redirect.
  try {
    if (req.nextUrl.searchParams.has("error")) return redirectAuth("/auth/login?error=invalid_link");
    const code = req.nextUrl.searchParams.get("code");
    const tokenHash = req.nextUrl.searchParams.get("token_hash");
    if ((!code && !tokenHash) || (code && tokenHash)) return redirectAuth("/auth/login?error=invalid_link");
    const token = z.string().min(1).max(2048).parse(code || tokenHash);
    const db = await getSupabaseServerClient();
    const type = tokenHash ? z.enum(["email", "invite", "recovery"]).parse(req.nextUrl.searchParams.get("type") || "email") : null;
    const result = code
      ? await db.auth.exchangeCodeForSession(token)
      : await db.auth.verifyOtp({ token_hash: token, type: type! });
    if (result.error || !result.data.user || !result.data.session) return redirectAuth("/auth/login?error=invalid_link");
    if (!await hasMembership(db, result.data.user.id)) {
      await signOutHere(db);
      return redirectAuth("/auth/login?error=access_denied");
    }
    return redirectAuth(type === "invite" || type === "recovery" ? `/auth/password?mode=${type}` : code ? "/auth/password?mode=recovery" : "/");
  } catch {
    return redirectAuth("/auth/login?error=invalid_link");
  }
}
