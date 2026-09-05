"use client";
import { useState } from "react";
import { ArrowUpRight, CalendarDays, LockKeyhole } from "lucide-react";
export function SignIn({ setup = false }: { setup?: boolean }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="signin">
      <div className="signin-card">
        <div className="brand-mark">
          a<span>.</span>
        </div>
        <p className="eyebrow">ADA CALENDAR</p>
        <h1>
          Room for
          <br />
          the work.
        </h1>
        <p className="muted">
          One clear picture of your time, priorities, and everything on your
          plate.
        </p>
        <div className="signin-rule" />
        {setup ? (
          <>
            <h2>Connect your private workspace</h2>
            <p className="muted">
              The app is ready for its Supabase configuration. Add the
              environment variables described in the project’s setup guide, run
              the migrations, and invite your team. Sample data and demo access
              are disabled in production.
            </p>
          </>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                const r = await fetch("/api/auth/login", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ email }),
                });
                const data = await r.json();
                setMessage(data.error || data.message);
              } catch {
                setMessage("Could not connect. Please try again.");
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Work email
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@youragency.com"
              />
            </label>
            <button className="primary wide" disabled={busy}>
              {busy ? "Sending…" : "Email me a sign-in link"}
              <ArrowUpRight size={17} />
            </button>
            <p role="status">{message}</p>
          </form>
        )}
        <p className="micro muted">
          <LockKeyhole size={13} /> Private, invite-only access
        </p>
      </div>
      <div className="signin-art" aria-hidden>
        <CalendarDays size={100} strokeWidth={0.7} />
        <div className="art-ribbon" />
        <div className="art-ribbon second" />
        <div className="art-ribbon third" />
        <p>
          Good work.
          <br />
          Healthy hours.
        </p>
        <span>MONDAY — FRIDAY / 9:00 — 5:00</span>
      </div>
    </main>
  );
}
