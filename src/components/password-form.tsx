"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@/lib/passwords";

export function PasswordField({
  id,
  label,
  name,
  autoComplete,
  value,
  disabled,
  minLength,
  describedBy,
  onChange,
}: {
  id: string;
  label: string;
  name: string;
  autoComplete: "current-password" | "new-password";
  value: string;
  disabled?: boolean;
  minLength?: number;
  describedBy?: string;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="auth-password-field">
      <label htmlFor={id}>{label}</label>
      <div className="auth-password-control">
        <input
          id={id}
          name={name}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          autoCapitalize="none"
          spellCheck={false}
          required
          minLength={minLength}
          maxLength={PASSWORD_MAX_LENGTH}
          aria-describedby={describedBy}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="auth-password-toggle"
          aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
          aria-pressed={visible}
          aria-controls={id}
          disabled={disabled}
          onClick={() => setVisible(!visible)}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

export function PasswordForm({ mode }: { mode: "invite" | "recovery" }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  return (
    <AuthShell>
      <h2>
        {mode === "invite" ? "Create your password" : "Choose a new password"}
      </h2>
      <p className="muted">
        {mode === "invite"
          ? "Welcome to your private workspace. Create a password to sign in with your email from now on."
          : "Save a new password, then sign in again with your email and password."}
      </p>
      <form
        className="auth-form"
        aria-busy={busy}
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting.current) return;
          setError("");
          if (password.length < PASSWORD_MIN_LENGTH) {
            setError("Use a password with at least 12 characters.");
            return;
          }
          if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) {
            setError(
              "This password exceeds 72 bytes. Shorten it while keeping at least 12 characters. Accented letters and emoji can use more than one byte each.",
            );
            return;
          }
          if (password !== confirmPassword) {
            setError(
              "The passwords don’t match. Please enter the same password in both fields.",
            );
            return;
          }
          submitting.current = true;
          setBusy(true);
          let navigating = false;
          try {
            const response = await fetch("/api/auth/password", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ password, confirmPassword }),
            });
            const data = await response.json();
            if (response.ok && data.ok === true) {
              setPassword("");
              setConfirmPassword("");
              navigating = true;
              router.replace("/auth/login?password=updated");
              router.refresh();
              return;
            }
            setError(
              response.status === 401 || response.status === 403
                ? "This link is no longer valid. Request a new reset link, or ask Bryan to resend your invitation."
                : response.status === 429
                  ? "Too many attempts. Please wait a few minutes before trying again."
                  : "We couldn’t save this password. Try a different password with at least 12 characters and no more than 72 bytes, or request a new reset link.",
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
        <PasswordField
          id="new-password"
          label="New password"
          name="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          describedBy="password-guidance"
          value={password}
          disabled={busy}
          onChange={(value) => {
            setPassword(value);
            setError("");
          }}
        />
        <p id="password-guidance" className="auth-help muted">
          Use at least 12 characters, up to 72 bytes. Plain English letters,
          numbers, and spaces use one byte each; emoji and some other characters
          use more. A unique passphrase or a password manager’s suggestion works
          well.
        </p>
        <PasswordField
          id="confirm-password"
          label="Confirm password"
          name="confirmPassword"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          value={confirmPassword}
          disabled={busy}
          onChange={(value) => {
            setConfirmPassword(value);
            setError("");
          }}
        />
        {error && (
          <p className="auth-message error" role="alert">
            {error}
          </p>
        )}
        <button className="primary wide" type="submit" disabled={busy}>
          {busy ? "Saving password…" : "Save password"}
          <ArrowUpRight size={17} aria-hidden="true" />
        </button>
        <div className="auth-links">
          <Link href="/auth/forgot-password">Request a new reset link</Link>
          <Link href="/auth/login">Back to sign in</Link>
        </div>
      </form>
    </AuthShell>
  );
}
