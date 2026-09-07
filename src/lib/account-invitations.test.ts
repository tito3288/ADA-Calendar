import type { SupabaseClient, User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAuthAccount, deliverAccountSetupEmail } from "./account-invitations";
import { assertAuthEmailAllowed } from "./auth-email-policy";

const pendingUser = { id: "invited-user", email: "teammate@example.test", email_confirmed_at: undefined } as User;
function fixture() {
  const listUsers = vi.fn().mockResolvedValue({ data: { users: [] }, error: null });
  const createUser = vi.fn().mockResolvedValue({ data: { user: pendingUser }, error: null });
  const inviteUserByEmail = vi.fn().mockResolvedValue({ data: { user: pendingUser }, error: null });
  const resetPasswordForEmail = vi.fn().mockResolvedValue({ data: {}, error: null });
  const db = { auth: { admin: { listUsers, createUser, inviteUserByEmail }, resetPasswordForEmail } } as unknown as Pick<SupabaseClient, "auth">;
  return { db, listUsers, createUser, inviteUserByEmail, resetPasswordForEmail };
}
beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("EMAIL_MODE", "capture");
  vi.stubEnv("EMAIL_TEST_ALLOWLIST", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("account creation before invitation delivery", () => {
  it("creates an unconfirmed passwordless account without sending any email", async () => {
    const mock = fixture();
    expect(await ensureAuthAccount(mock.db, " Teammate@EXAMPLE.test ", "Teammate")).toEqual(pendingUser);
    expect(mock.createUser).toHaveBeenCalledWith({ email: pendingUser.email, email_confirm: false, user_metadata: { name: "Teammate" } });
    expect(mock.inviteUserByEmail).not.toHaveBeenCalled();
    expect(mock.resetPasswordForEmail).not.toHaveBeenCalled();
  });
  it("reuses an existing account without changing its credentials or sending", async () => {
    const mock = fixture();
    mock.listUsers.mockResolvedValue({ data: { users: [pendingUser] }, error: null });
    expect(await ensureAuthAccount(mock.db, pendingUser.email!, "Teammate")).toEqual(pendingUser);
    expect(mock.createUser).not.toHaveBeenCalled();
    expect(mock.inviteUserByEmail).not.toHaveBeenCalled();
  });
  it("looks beyond the first page without accidentally creating a duplicate", async () => {
    const mock = fixture();
    mock.listUsers.mockResolvedValueOnce({ data: { users: Array.from({ length: 1000 }, (_, index) => ({ id: `other-${index}`, email: `other-${index}@example.test` })) }, error: null });
    mock.listUsers.mockResolvedValueOnce({ data: { users: [pendingUser] }, error: null });
    expect(await ensureAuthAccount(mock.db, pendingUser.email!, "Teammate")).toEqual(pendingUser);
    expect(mock.listUsers).toHaveBeenNthCalledWith(2, { page: 2, perPage: 1000 });
    expect(mock.createUser).not.toHaveBeenCalled();
  });
  it("does not leak provider details or send when account creation fails", async () => {
    const mock = fixture();
    mock.createUser.mockResolvedValue({ data: { user: null }, error: new Error("sensitive-provider-details") });
    await expect(ensureAuthAccount(mock.db, pendingUser.email!, "Teammate")).rejects.toThrow("No invitation was sent");
    expect(mock.inviteUserByEmail).not.toHaveBeenCalled();
  });
  it("explicitly sends an invitation to a pre-created unconfirmed account", async () => {
    const mock = fixture();
    expect(await deliverAccountSetupEmail(mock.db, pendingUser, "http://localhost:3000/", "http://127.0.0.1:55421")).toBe("invitation");
    expect(mock.inviteUserByEmail).toHaveBeenCalledWith(pendingUser.email, { redirectTo: "http://localhost:3000/api/auth/callback" });
    expect(mock.resetPasswordForEmail).not.toHaveBeenCalled();
  });
  it("explicitly sends password setup for an existing confirmed account instead of silently skipping", async () => {
    const mock = fixture();
    const confirmed = { ...pendingUser, email_confirmed_at: "2026-09-07T12:00:00Z" };
    expect(await deliverAccountSetupEmail(mock.db, confirmed, "http://localhost:3000/", "http://localhost:55421")).toBe("recovery");
    expect(mock.resetPasswordForEmail).toHaveBeenCalledWith(pendingUser.email, { redirectTo: "http://localhost:3000/api/auth/callback" });
    expect(mock.inviteUserByEmail).not.toHaveBeenCalled();
  });
  it("reports a saved account with failed delivery without leaking tokens", async () => {
    const mock = fixture();
    mock.inviteUserByEmail.mockResolvedValue({ data: { user: null }, error: new Error("token=secret") });
    await expect(deliverAccountSetupEmail(mock.db, pendingUser, "http://localhost:3000", "http://localhost:55421")).rejects.toThrow("account is ready");
    expect(mock.createUser).not.toHaveBeenCalled();
  });
  it("blocks unauthorized development mail before any provider send", async () => {
    const mock = fixture();
    await expect(deliverAccountSetupEmail(mock.db, pendingUser, "https://ada.example.test", "https://real.supabase.co")).rejects.toThrow("Development authentication email");
    expect(mock.inviteUserByEmail).not.toHaveBeenCalled();
    expect(mock.resetPasswordForEmail).not.toHaveBeenCalled();
  });
  it("rejects unsafe application redirects before sending", async () => {
    const mock = fixture();
    vi.stubEnv("NODE_ENV", "production");
    for (const appUrl of ["javascript:alert(1)", "https://user:pass@example.test", "http://ada.example.test", "not-a-url"]) {
      await expect(deliverAccountSetupEmail(mock.db, pendingUser, appUrl, "https://real.supabase.co")).rejects.toThrow();
    }
    expect(mock.inviteUserByEmail).not.toHaveBeenCalled();
  });
});

describe("authentication email isolation", () => {
  it("allows production auth SMTP independently of workload capture mode", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => assertAuthEmailAllowed(pendingUser.email!, "https://real.supabase.co")).not.toThrow();
  });
  it.each(["http://localhost:55421", "http://127.0.0.1:55421", "http://[::1]:55421"])("allows captured local Supabase at %s", url => {
    expect(() => assertAuthEmailAllowed(pendingUser.email!, url)).not.toThrow();
  });
  it.each(["https://localhost.evil.test", "https://127.0.0.1.evil.test", "https://localhost@real.supabase.co", "file:///tmp/email", "not-a-url"])("does not mistake %s for local Supabase", url => {
    expect(() => assertAuthEmailAllowed(pendingUser.email!, url)).toThrow();
  });
  it("requires both test mode and exact case-insensitive recipient allowlisting", () => {
    vi.stubEnv("EMAIL_TEST_ALLOWLIST", " Teammate@EXAMPLE.test, someoneelse@example.test ");
    expect(() => assertAuthEmailAllowed(pendingUser.email!, "https://real.supabase.co")).toThrow();
    vi.stubEnv("EMAIL_MODE", "test");
    expect(() => assertAuthEmailAllowed(pendingUser.email!, "https://real.supabase.co")).not.toThrow();
    expect(() => assertAuthEmailAllowed("teammate+extra@example.test", "https://real.supabase.co")).toThrow();
    vi.stubEnv("EMAIL_MODE", "live");
    expect(() => assertAuthEmailAllowed(pendingUser.email!, "https://real.supabase.co")).toThrow();
  });
});
