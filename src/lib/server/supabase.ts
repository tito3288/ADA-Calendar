import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

function publicConfiguration() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Live mode is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
  return { url, key };
}

export async function getSupabaseServerClient() {
  const { url, key } = publicConfiguration();
  const cookieStore = await cookies();
  const secure = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").startsWith("https://");
  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (values) => {
        try { values.forEach(({ name, value, options }) => cookieStore.set(name, value, {
          ...options, domain: undefined, path: "/", sameSite: "lax", secure, httpOnly: true,
        })); }
        catch { /* Server Components cannot set cookies; src/proxy.ts refreshes them first. */ }
      },
    },
  });
}

/** Auth is server-only in this app; clean up just this project's session cookies. */
export async function clearSupabaseSessionCookies() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return;
  const prefix = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
  const cookieStore = await cookies();
  for (const { name } of cookieStore.getAll()) {
    if (name === prefix || name.startsWith(`${prefix}.`) || name === `${prefix}-code-verifier`) {
      cookieStore.set(name, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax",
        secure: (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").startsWith("https://") });
    }
  }
}

export function getSupabaseAdminClient() {
  const { url } = publicConfiguration();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("This administrative operation needs SUPABASE_SERVICE_ROLE_KEY on the server.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
