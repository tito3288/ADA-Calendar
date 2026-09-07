"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { PasswordField } from "@/components/password-form";

export function SignIn({
  setup = false,
  notice,
  noticeIsError = false,
}: {
  setup?: boolean;
  notice?: string;
  noticeIsError?: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  return (
    <AuthShell>
      {setup ? (
        <>
          <h2>Connect your private workspace</h2>
          <p className="muted">
            The app is ready for its Supabase configuration. Add the environment
            variables described in the project’s setup guide, run the
            migrations, and invite your team. Sample data and demo access are
            disabled in production.
          </p>
        </>
      ) : (
        <>
          {notice && (
            <p
              className={noticeIsError ? "auth-message error" : "auth-message"}
              role={noticeIsError ? "alert" : "status"}
            >
              {notice}
            </p>
          )}
          <form
            className="auth-form"
            aria-busy={busy}
            onSubmit={async (event) => {
              event.preventDefault();
              if (submitting.current) return;
              submitting.current = true;
              setBusy(true);
              setError("");
              let navigating = false;
              try {
                const response = await fetch("/api/auth/login", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ email, password }),
                });
                const data = await response.json();
                if (response.ok && data.ok === true) {
                  setPassword("");
                  navigating = true;
                  router.replace("/");
                  router.refresh();
                  return;
                }
                setError(
                  response.status === 429
                    ? "Too many attempts. Please wait a few minutes before trying again."
                    : response.status === 503
                      ? "Sign-in is not ready yet. Please contact Bryan or try again later."
                      : "We couldn’t sign you in. Check your email and password, then try again.",
                );
              } catch {
                setError("Could not connect. Please try again.");
              } finally {
                if (!navigating) {
                  submitting.current = false;
                  setBusy(false);
                }
              }
            }}
          >
            <label htmlFor="login-email">
              Work email
              <input
                id="login-email"
                name="email"
                type="email"
                required
                maxLength={254}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setError("");
                }}
                placeholder="you@youragency.com"
              />
            </label>
            <PasswordField
              id="login-password"
              label="Password"
              name="password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={(value) => {
                setPassword(value);
                setError("");
              }}
            />
            <div className="auth-links auth-links-end">
              <Link href="/auth/forgot-password">Forgot password?</Link>
            </div>
            {error && (
              <p className="auth-message error" role="alert">
                {error}
              </p>
            )}
            <button className="primary wide" disabled={busy} type="submit">
              {busy ? "Signing in…" : "Sign in"}
              <ArrowUpRight size={17} aria-hidden="true" />
            </button>
            <p className="auth-help muted">
              Use the password you created from your invitation. You’ll stay
              signed in on this browser until you sign out or your session ends.
            </p>
          </form>
        </>
      )}
    </AuthShell>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  return (
    <AuthShell>
      <h2>Reset your password</h2>
      <p className="muted">
        Enter your invited email address. We’ll send a link to choose a new
        password, not a link you need for every sign-in.
      </p>
      <form
        className="auth-form"
        aria-busy={busy}
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current || message) return;
          submitting.current = true;
          setBusy(true);
          setError("");
          try {
            const response = await fetch("/api/auth/forgot-password", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email }),
            });
            if (response.ok) {
              setMessage(
                "If an invited account matches this email, you’ll receive a password reset link. Check your inbox and spam folder.",
              );
            } else {
              setError(
                response.status === 429
                  ? "Too many attempts. Please wait a few minutes before trying again."
                  : "We couldn’t request a reset link right now. Please try again later.",
              );
            }
          } catch {
            setError("Could not connect. Please try again.");
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        <label htmlFor="reset-email">
          Work email
          <input
            id="reset-email"
            name="email"
            type="email"
            required
            maxLength={254}
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            disabled={busy}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setMessage("");
              setError("");
            }}
            placeholder="you@youragency.com"
          />
        </label>
        {error && (
          <p className="auth-message error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="auth-message" role="status">
            {message}
          </p>
        )}
        <button
          className="primary wide"
          type="submit"
          disabled={busy || !!message}
        >
          {busy
            ? "Requesting link…"
            : message
              ? "Reset link requested"
              : "Send reset link"}
          <ArrowUpRight size={17} aria-hidden="true" />
        </button>
        <div className="auth-links">
          <Link href="/auth/login">Back to sign in</Link>
        </div>
      </form>
    </AuthShell>
  );
}
