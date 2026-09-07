import type { ReactNode } from "react";
import { CalendarDays, LockKeyhole } from "lucide-react";
import { BrandLogo } from "./brand-logo";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="signin">
      <div className="signin-card">
        <BrandLogo variant="auth" />
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
        {children}
        <p className="micro muted">
          <LockKeyhole size={13} /> Private, invite-only access
        </p>
      </div>
      <div className="signin-art" aria-hidden="true">
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
