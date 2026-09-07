/** Authentication SMTP is separate from the workload notification queue. */
export function assertAuthEmailAllowed(email: string, supabaseUrl: string): void {
  let target: URL;
  try { target = new URL(supabaseUrl); }
  catch { throw new Error("Authentication email is not configured."); }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
    throw new Error("Authentication email is not configured.");
  }
  // Hosted authentication mail is an explicit user action, including while
  // ordinary workload notifications remain in capture mode during onboarding.
  if (process.env.NODE_ENV === "production") return;
  if (["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) return;
  const allowlist = (process.env.EMAIL_TEST_ALLOWLIST ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  if (process.env.EMAIL_MODE === "test" && allowlist.includes(email.trim().toLowerCase())) return;
  throw new Error("Development authentication email requires local Supabase or an explicitly allowlisted test recipient.");
}
