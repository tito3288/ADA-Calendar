// Deployed to Supabase's Deno runtime; the application itself remains Next.js/Node on Railway.
import { createClient } from "npm:@supabase/supabase-js@2";

type NotificationRow = {
  id: string; recipient: string; subject: string; body: string; idempotency_key: string;
  attempts: number; provider_id: string | null;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (request: Request) => {
  const workerSecret = Deno.env.get("WORKER_SECRET") ?? Deno.env.get("NOTIFICATION_WORKER_SECRET");
  if (!workerSecret || request.headers.get("authorization") !== `Bearer ${workerSecret}`) return json({ error: "Unauthorized" }, 401);
  if (request.method !== "POST") return json({ error: "POST required" }, 405);
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ error: "Worker database configuration is missing" }, 503);
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const mode = Deno.env.get("EMAIL_MODE") ?? "capture";
  const appUrl = Deno.env.get("APP_URL") ?? Deno.env.get("NEXT_PUBLIC_APP_URL");
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("EMAIL_FROM");
  const allowlist = new Set((Deno.env.get("EMAIL_TEST_ALLOWLIST") ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
  if (!["capture", "test", "live"].includes(mode)) return json({ error: "EMAIL_MODE must be capture, test or live" }, 503);
  if (mode !== "capture" && (!apiKey || !from)) return json({ error: "Live/test email delivery needs RESEND_API_KEY and EMAIL_FROM" }, 503);
  if (appUrl) {
    const { error } = await db.rpc("enqueue_weekly_summaries", { p_app_url: appUrl });
    if (error) return json({ error: `Weekly scheduler failed: ${error.message}` }, 500);
  }
  const { data, error } = await db.rpc("claim_notifications", { p_limit: 10 });
  if (error) return json({ error: error.message }, 500);
  let processed = 0;
  for (const n of (data ?? []) as NotificationRow[]) {
    let status = "captured";
    let providerId: string | null = null;
    let failure: string | null = null;
    let retrySeconds: number | null = null;
    if (mode === "capture" || mode === "test" && !allowlist.has(n.recipient.toLowerCase())) {
      failure = mode === "test" ? "Captured: recipient is not on the test allowlist." : "Captured: external email delivery is disabled.";
    } else {
      try {
        // Stable idempotency key belongs to this one event and recipient, including retries.
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": n.idempotency_key },
          body: JSON.stringify({ from, to: [n.recipient], subject: n.subject, text: n.body }),
          signal: AbortSignal.timeout(8000),
        });
        const payload = await response.json().catch(() => ({}));
        if (response.ok && typeof payload.id === "string") { status = "sent"; providerId = payload.id; }
        else {
          failure = `Resend ${response.status}: ${String(payload.message ?? "Unexpected response").slice(0,500)}`;
          if (response.status === 429 || response.status >= 500 || payload.name === "concurrent_idempotent_requests" || response.ok) {
            status = n.attempts >= 8 ? "uncertain" : "queued";
            retrySeconds = Math.min(3600, 30 * 2 ** Math.min(n.attempts, 7));
          } else status = "failed";
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : "Unknown provider connection failure";
        status = n.attempts >= 8 ? "uncertain" : "queued";
        retrySeconds = Math.min(3600, 30 * 2 ** Math.min(n.attempts, 7));
      }
    }
    const saved = await db.rpc("finish_notification", { p_id: n.id, p_status: status, p_provider_id: providerId, p_error: failure, p_retry_seconds: retrySeconds });
    if (saved.error) return json({ error: "Delivery result could not be saved; job remains leased for safe retry", processed }, 500);
    processed++;
  }
  return json({ processed, mode });
});
