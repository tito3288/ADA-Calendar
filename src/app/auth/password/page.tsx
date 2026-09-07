import { redirect } from "next/navigation";
import { PasswordForm } from "@/components/password-form";
import { getLiveActor } from "@/lib/server/auth";

export const dynamic = "force-dynamic";
export default async function PasswordPage({ searchParams }: {
  searchParams: Promise<{ mode?: string | string[] }>;
}) {
  let authorized = false;
  try { await getLiveActor(); authorized = true; } catch { /* No session/membership: show a safe sign-in notice. */ }
  if (!authorized) redirect("/auth/login?error=invalid_link");
  const query = await searchParams;
  // This selects copy only, never permissions. The POST rechecks live identity.
  return <PasswordForm mode={query.mode === "invite" ? "invite" : "recovery"} />;
}
