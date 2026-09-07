import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { passwordLoginSchema, passwordUpdateSchema } from "./passwords";

const mocks = vi.hoisted(() => ({ caller: vi.fn(), admin: vi.fn(), clear: vi.fn(),
  member: vi.fn(), recoveryMember: vi.fn(), signIn: vi.fn(), getUser: vi.fn(), update: vi.fn(),
  reset: vi.fn(), signOut: vi.fn(), verify: vi.fn(), exchange: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./server/supabase", () => ({ getSupabaseServerClient: mocks.caller, getSupabaseAdminClient: mocks.admin, clearSupabaseSessionCookies: mocks.clear }));
import { handleAuthCallback, loginWithPassword, requestPasswordRecovery, updateOwnPassword, RECOVERY_MESSAGE } from "./server/password-auth";

const user = { id: "invited-user" };
const accepted = { data: { user, session: { access_token: "never-return-this" } }, error: null };
function table(single: typeof mocks.member) {
  const query = { select: vi.fn(() => query), eq: vi.fn(() => query), maybeSingle: single };
  return { from: vi.fn(() => query) };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:55421");
  vi.stubEnv("EMAIL_MODE", "capture");
  mocks.member.mockResolvedValue({ data: { user_id: user.id }, error: null });
  mocks.recoveryMember.mockResolvedValue({ data: { user_id: user.id }, error: null });
  mocks.signIn.mockResolvedValue(accepted); mocks.verify.mockResolvedValue(accepted); mocks.exchange.mockResolvedValue(accepted);
  mocks.getUser.mockResolvedValue({ data: { user }, error: null });
  mocks.update.mockResolvedValue({ data: { user }, error: null });
  mocks.signOut.mockResolvedValue({ error: null }); mocks.reset.mockResolvedValue({ error: null });
  mocks.clear.mockResolvedValue(undefined);
  mocks.caller.mockResolvedValue({ ...table(mocks.member), auth: {
    signInWithPassword: mocks.signIn, getUser: mocks.getUser, updateUser: mocks.update,
    resetPasswordForEmail: mocks.reset, signOut: mocks.signOut, verifyOtp: mocks.verify, exchangeCodeForSession: mocks.exchange,
  } });
  mocks.admin.mockReturnValue(table(mocks.recoveryMember));
});
afterEach(() => vi.unstubAllEnvs());

describe("password validation", () => {
  it("normalizes emails but preserves passwords exactly and permits existing short passwords at login", () => {
    expect(passwordLoginSchema.parse({ email: " PERSON@EXAMPLE.TEST ", password: " old " }))
      .toEqual({ email: "person@example.test", password: " old " });
  });
  it("requires matching 12-character minimum and rejects caller-supplied target IDs", () => {
    const valid = { password: "a".repeat(12), confirmPassword: "a".repeat(12) };
    expect(passwordUpdateSchema.safeParse(valid).success).toBe(true);
    expect(passwordUpdateSchema.safeParse({ password: "a".repeat(11), confirmPassword: "a".repeat(11) }).success).toBe(false);
    expect(passwordUpdateSchema.safeParse({ ...valid, confirmPassword: "b".repeat(12) }).success).toBe(false);
    expect(passwordUpdateSchema.safeParse({ ...valid, userId: "someone-else" }).success).toBe(false);
  });
  it.each([["a".repeat(72), true], ["a".repeat(73), false], ["é".repeat(36), true], ["é".repeat(37), false]])("limits new passwords to 72 UTF-8 bytes", (password, valid) => {
    expect(passwordUpdateSchema.safeParse({ password, confirmPassword: password }).success).toBe(valid);
  });
});

describe("password sign-in", () => {
  it("uses password authentication and only returns a private acknowledgment, not credentials", async () => {
    const response = await loginWithPassword({ email: "Person@example.test", password: " untrimmed-password " });
    expect(mocks.signIn).toHaveBeenCalledWith({ email: "person@example.test", password: " untrimmed-password " });
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("rejects malformed input before any auth call", async () => {
    expect((await loginWithPassword({ email: "bad", password: "x" })).status).toBe(400);
    expect(mocks.caller).not.toHaveBeenCalled();
  });
  it("uses the same error for a bad password and an authenticated nonmember, clearing the session", async () => {
    mocks.signIn.mockResolvedValueOnce({ data: { user: null, session: null }, error: { message: "sensitive provider data" } });
    const bad = await loginWithPassword({ email: "person@example.test", password: "wrong" });
    mocks.member.mockResolvedValueOnce({ data: null, error: null });
    const notMember = await loginWithPassword({ email: "person@example.test", password: "good" });
    expect(bad.status).toBe(401); expect(notMember.status).toBe(401);
    expect(await bad.json()).toEqual(await notMember.json());
    expect(mocks.clear).toHaveBeenCalledTimes(2);
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
  it("clears a newly issued session if the membership lookup throws", async () => {
    mocks.member.mockRejectedValueOnce(new Error("unavailable database"));
    expect((await loginWithPassword({ email: "person@example.test", password: "good" })).status).toBe(401);
    expect(mocks.clear).toHaveBeenCalledOnce();
  });
});

describe("password recovery", () => {
  it("does not reveal unknown/inactive accounts or SMTP failure", async () => {
    const known = await requestPasswordRecovery({ email: "person@example.test" });
    expect(mocks.reset).toHaveBeenCalledWith("person@example.test", { redirectTo: "http://localhost:3000/api/auth/callback" });
    mocks.recoveryMember.mockResolvedValueOnce({ data: null, error: null });
    const unknown = await requestPasswordRecovery({ email: "unknown@example.test" });
    expect(mocks.reset).toHaveBeenCalledTimes(1);
    mocks.reset.mockResolvedValueOnce({ error: { message: "SMTP password leaked by provider" } });
    const failure = await requestPasswordRecovery({ email: "person@example.test" });
    for (const response of [known, unknown, failure]) {
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ message: RECOVERY_MESSAGE });
    }
  });
  it("fails closed for nonlocal SMTP during development even in capture mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://real.supabase.co");
    expect((await requestPasswordRecovery({ email: "person@example.test" })).status).toBe(503);
    expect(mocks.admin).not.toHaveBeenCalled(); expect(mocks.reset).not.toHaveBeenCalled();
  });
  it("does not send when membership lookup is unavailable", async () => {
    mocks.recoveryMember.mockResolvedValueOnce({ data: null, error: { message: "private schema failure" } });
    const response = await requestPasswordRecovery({ email: "person@example.test" });
    expect(response.status).toBe(503); expect(mocks.reset).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain("private schema");
  });
});

describe("own password setup and recovery", () => {
  const body = { password: "new-unique-password", confirmPassword: "new-unique-password" };
  it("verifies the current user and active membership, updates only their password, then clears sessions", async () => {
    const response = await updateOwnPassword(body);
    expect(mocks.getUser).toHaveBeenCalledOnce(); expect(mocks.member).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledWith({ password: body.password });
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "global" }); expect(mocks.clear).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ ok: true });
  });
  it.each(["missing-session", "revoked-membership"])("rejects %s before updating", async reason => {
    if (reason === "missing-session") mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    else mocks.member.mockResolvedValueOnce({ data: null, error: null });
    expect((await updateOwnPassword(body)).status).toBe(401); expect(mocks.update).not.toHaveBeenCalled();
  });
  it("does not expose provider errors and permits correcting a weak password without signing out", async () => {
    mocks.update.mockResolvedValueOnce({ error: { code: "weak_password", message: "provider-internal-details" } });
    const response = await updateOwnPassword(body);
    expect(response.status).toBe(400); expect(JSON.stringify(await response.json())).not.toContain("provider-internal");
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});

describe("invitation and recovery callbacks", () => {
  function callback(query: string) { return handleAuthCallback(new NextRequest(`http://localhost:3000/api/auth/callback?${query}`)); }
  it.each(["invite", "recovery"])("verifies %s tokens and redirects to password setup without reflecting credentials", async type => {
    const response = await callback(`token_hash=fixture-token&type=${type}&next=https://evil.example`);
    expect(mocks.verify).toHaveBeenCalledWith({ token_hash: "fixture-token", type });
    expect(response.headers.get("location")).toBe(`http://localhost:3000/auth/password?mode=${type}`);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("supports same-browser PKCE recovery and legacy verified email links", async () => {
    expect((await callback("code=fixture-code")).headers.get("location")).toBe("http://localhost:3000/auth/password?mode=recovery");
    expect(mocks.exchange).toHaveBeenCalledWith("fixture-code");
    expect((await callback("token_hash=fixture-token&type=email")).headers.get("location")).toBe("http://localhost:3000/");
  });
  it.each(["", "code=x&token_hash=y", "token_hash=x&type=admin", "error=secret-provider-message", "token_hash=x&type=signup"])("rejects malformed or unapproved callback %s", async query => {
    const response = await callback(query);
    expect(response.headers.get("location")).toBe("http://localhost:3000/auth/login?error=invalid_link");
    expect(mocks.verify).not.toHaveBeenCalled(); expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it("rejects expired or replayed links with a fixed notice", async () => {
    mocks.verify.mockResolvedValueOnce({ data: { user: null, session: null }, error: { message: "expired secret token" } });
    expect((await callback("token_hash=old&type=invite")).headers.get("location")).toBe("http://localhost:3000/auth/login?error=invalid_link");
  });
  it("clears a valid auth session if the invitation has no active membership", async () => {
    mocks.member.mockResolvedValueOnce({ data: null, error: null });
    expect((await callback("token_hash=x&type=invite")).headers.get("location")).toBe("http://localhost:3000/auth/login?error=access_denied");
    expect(mocks.clear).toHaveBeenCalledOnce();
  });
});
