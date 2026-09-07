/** Real Auth/HTTP verification against isolated local ADA Supabase and captured Mailpit only. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { chromium, expect, request, type APIRequestContext, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "../src/lib/defaults";
import { ensureAuthAccount, deliverAccountSetupEmail } from "../src/lib/account-invitations";

const origin = "http://127.0.0.1:3201";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function checked<T extends { error: { message: string } | null }>(result: T): T {
  assert.equal(result.error, null, "A local fixture provider operation failed.");
  return result;
}
type CapturedMessage = { ID: string; To?: { Address: string }[]; HTML?: string; Text?: string };

async function main() {
  const output = execFileSync("node_modules/.bin/supabase", ["status", "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const settings = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)) as Record<string, string>;
  assert.equal(settings.API_URL, "http://127.0.0.1:55421", "Refusing non-local/non-ADA Supabase.");
  const mailpitUrl = settings.MAILPIT_URL ?? settings.INBUCKET_URL;
  assert.equal(mailpitUrl, "http://127.0.0.1:55424", "Refusing non-local/non-ADA captured mail.");
  const authContainers = JSON.parse(execFileSync("docker", ["inspect", "supabase_auth_ada-calendar"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const smtpHost = authContainers[0].Config.Env.find((value: string) => value.startsWith("GOTRUE_SMTP_HOST="));
  assert.ok(typeof smtpHost === "string" && /^GOTRUE_SMTP_HOST=(supabase_inbucket_ada-calendar|supabase_mailpit_ada-calendar)$/.test(smtpHost), "Auth must send only to ADA's captured local SMTP.");
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(3201, "127.0.0.1", () => probe.close(error => error ? reject(error) : resolve()));
  });
  await mkdir(".data", { recursive: true });
  const temporary = await mkdtemp(path.resolve(".data/password-auth-smoke-"));
  const distDir = path.relative(process.cwd(), path.join(temporary, "next"));
  const originalNextEnv = await readFile("next-env.d.ts", "utf8");
  const originalTsConfig = await readFile("tsconfig.json", "utf8");
  const admin = createClient(settings.API_URL, settings.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const prefix = `ada-password-${randomUUID().slice(0, 8)}`;
  const email = `${prefix}@example.invalid`;
  const userIds: string[] = [];
  const mailIds = new Set<string>();
  const workspaceId = randomUUID();
  let workspaceCreated = false;
  const contexts: APIRequestContext[] = [];
  let browser: Browser | undefined;
  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "3201"], {
    cwd: process.cwd(), stdio: "ignore", detached: true,
    env: { ...process.env, NODE_ENV: "development", ADA_DEMO_MODE: "false", ADA_NEXT_DIST_DIR: distDir,
      APP_URL: origin, NEXT_PUBLIC_APP_URL: origin, NEXT_PUBLIC_SUPABASE_URL: settings.API_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: settings.ANON_KEY, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: settings.PUBLISHABLE_KEY || "",
      SUPABASE_SERVICE_ROLE_KEY: settings.SERVICE_ROLE_KEY, OPENAI_API_KEY: "", RESEND_API_KEY: "", RESEND_WEBHOOK_SECRET: "",
      EMAIL_MODE: "capture", EMAIL_TEST_ALLOWLIST: "", WORKER_SECRET: "" },
  });
  async function context() {
    const client = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin }, timeout: 60_000 });
    contexts.push(client);
    return client;
  }
  let client = await context();
  async function capturedLink(recipient: string, type: "invite" | "recovery") {
    for (let attempt = 0; attempt < 40; attempt++) {
      const list = await fetch(`${mailpitUrl}/api/v1/messages?limit=100`).then(response => response.json()) as { messages: CapturedMessage[] };
      for (const message of list.messages ?? []) {
        if (mailIds.has(message.ID) || !message.To?.some(to => to.Address === recipient)) continue;
        const detail = await fetch(`${mailpitUrl}/api/v1/message/${encodeURIComponent(message.ID)}`).then(response => response.json()) as CapturedMessage;
        mailIds.add(message.ID);
        const text = `${detail.HTML ?? ""}\n${detail.Text ?? ""}`.replaceAll("&amp;", "&");
        const links = text.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
        const link = links.map(value => new URL(value)).find(url => url.pathname === "/api/auth/callback" && url.searchParams.get("type") === type && url.searchParams.has("token_hash"));
        if (!link) continue;
        assert.equal(link.origin, "http://localhost:3000", "Local template must use its configured local Site URL.");
        // The existing port3000 developer server is user-owned and left untouched.
        // Verify the real token against this test's isolated server on port3201.
        return `${origin}${link.pathname}${link.search}`;
      }
      await sleep(250);
    }
    throw new Error(`No captured ${type} token-hash link found. Configure local Auth email templates before this test.`);
  }
  try {
    for (let attempt = 0; attempt < 90; attempt++) {
      assert.equal(server.exitCode, null, "Isolated test server exited unexpectedly.");
      const healthy = await fetch(`${origin}/api/health`).then(response => response.ok).catch(() => false);
      if (healthy) break;
      if (attempt === 89) throw new Error("Isolated test server did not start.");
      await sleep(500);
    }
    const user = await ensureAuthAccount(admin, email, "Synthetic Password Test");
    userIds.push(user.id);
    assert.ok(!user.email_confirmed_at);
    checked(await admin.from("workspaces").insert({ id: workspaceId, settings: DEFAULT_SETTINGS, priorities: DEFAULT_PRIORITIES, clients: [{ id: "internal", name: "Synthetic", aliases: [] }] }));
    workspaceCreated = true;
    checked(await admin.from("workspace_members").insert({ workspace_id: workspaceId, user_id: user.id, name: "Synthetic Password Test", email, role: "owner", receive_updates: false }));
    assert.equal(await deliverAccountSetupEmail(admin, user, "http://localhost:3000", settings.API_URL), "invitation");
    const inviteLink = await capturedLink(email, "invite");
    const accepted = await client.get(inviteLink, { maxRedirects: 0 });
    assert.equal(accepted.status(), 307);
    assert.equal(accepted.headers().location, `${origin}/auth/password?mode=invite`);
    assert.equal(accepted.headers()["referrer-policy"], "no-referrer");
    assert.ok((await client.storageState()).cookies.some(cookie => cookie.name.includes("auth-token") && cookie.httpOnly));
    browser = await chromium.launch({ headless: true });
    const visual = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin }, storageState: await client.storageState(), viewport: { width: 1440, height: 1000 } });
    const page = await visual.newPage();
    await page.goto(`${origin}/auth/password?mode=invite`);
    await expect(page.getByRole("heading", { name: "Create your password" })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    assert.equal((await new AxeBuilder({ page }).analyze()).violations.length, 0, "Desktop password setup accessibility scan.");
    await page.screenshot({ path: path.join(temporary, "password-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal((await new AxeBuilder({ page }).analyze()).violations.length, 0, "Mobile password setup accessibility scan.");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Mobile password setup has no horizontal overflow.");
    await page.screenshot({ path: path.join(temporary, "password-mobile.png"), fullPage: true });
    console.log(`Synthetic UI screenshots: ${temporary}`);
    const repeatedInvite = await (await context()).get(inviteLink, { maxRedirects: 0 });
    assert.equal(repeatedInvite.headers().location, `${origin}/auth/login?error=invalid_link`);
    const password = `${randomUUID()}Aa1!`;
    let passwordRequests = 0;
    page.on("request", request => { if (request.method() === "POST" && request.url() === `${origin}/api/auth/password`) passwordRequests++; });
    await page.getByLabel("New password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password", { exact: true }).fill(`${password}mismatch`);
    await page.getByRole("button", { name: "Save password", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "The passwords don’t match." })).toBeVisible();
    assert.equal(passwordRequests, 0, "Mismatched confirmation never submits a password update.");
    await page.getByLabel("Confirm password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Save password", exact: true }).click();
    await page.waitForURL(`${origin}/auth/login?password=updated`);
    assert.equal(passwordRequests, 1, "Browser sends one successful initial password update.");
    await expect(page.getByText("Your password is saved. Sign in with your email and new password.")).toBeVisible();
    await page.screenshot({ path: path.join(temporary, "login-mobile.png"), fullPage: true });
    // Continue with the actual browser's refreshed/cleared session cookies.
    client = visual.request;
    assert.equal((await client.get("/api/state")).status(), 401, "Setting a password clears the login session.");
    assert.equal((await client.post("/api/auth/login", { data: { email, password: "WrongFixturePassword1!" } })).status(), 401);
    await page.getByLabel("Work email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(`${origin}/`);
    assert.equal((await client.get("/api/state")).status(), 200);
    assert.ok((await client.storageState()).cookies.filter(cookie => cookie.name.includes("auth-token")).every(cookie => cookie.httpOnly));
    const tooLong = "a".repeat(73);
    assert.equal((await client.post("/api/auth/password", { data: { password: tooLong, confirmPassword: tooLong } })).status(), 400, "App rejects over-72-byte setup before provider.");
    const provider = createClient(settings.API_URL, settings.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    checked(await provider.auth.signInWithPassword({ email, password }));
    const providerLong = await provider.auth.updateUser({ password: tooLong });
    assert.ok(providerLong.error, "Current local Supabase rejects passwords beyond bcrypt's 72-byte input.");
    console.log("Local Auth rejects 73-byte passwords; app blocks these before provider calls.");
    assert.equal((await client.post("/api/auth/logout")).status(), 200);
    const reset = await client.post("/api/auth/forgot-password", { data: { email } });
    const unknownReset = await client.post("/api/auth/forgot-password", { data: { email: `${prefix}-unknown@example.invalid` } });
    assert.equal(reset.status(), 200);
    assert.equal(unknownReset.status(), 200);
    assert.deepEqual(await reset.json(), await unknownReset.json(), "Recovery cannot reveal registered membership in its response.");
    const recoveryLink = await capturedLink(email, "recovery");
    const recovery = await client.get(recoveryLink, { maxRedirects: 0 });
    assert.equal(recovery.headers().location, `${origin}/auth/password?mode=recovery`);
    const newPassword = `${randomUUID()}Bb2!`;
    assert.equal((await client.post("/api/auth/password", { data: { password: newPassword, confirmPassword: newPassword } })).status(), 200);
    assert.equal((await client.post("/api/auth/login", { data: { email, password } })).status(), 401, "Old password no longer works.");
    assert.equal((await client.post("/api/auth/login", { data: { email, password: newPassword } })).status(), 200);
    assert.equal((await client.get("/api/state")).status(), 200);
    const replayRecovery = await (await context()).get(recoveryLink, { maxRedirects: 0 });
    assert.equal(replayRecovery.headers().location, `${origin}/auth/login?error=invalid_link`);
    checked(await admin.from("workspace_members").update({ active: false }).eq("user_id", user.id));
    assert.equal((await client.get("/api/state")).status(), 401);
    assert.equal((await client.post("/api/auth/password", { data: { password, confirmPassword: password } })).status(), 401, "A revoked member cannot change a password through the app.");
    assert.equal((await client.post("/api/auth/logout")).status(), 200, "Revoked members can still clear sessions.");
    console.log("PASS: pre-created invitation, real token callback, first password, persistent protected cookies, sign-in, captured recovery, changed credentials, replay rejection and revoked-member isolation.");
  } finally {
    await Promise.all(contexts.map(client => client.dispose()));
    await browser?.close();
    if (server.pid) try { process.kill(-server.pid, "SIGTERM"); } catch { /* Owned process group already exited. */ }
    await Promise.race([new Promise(resolve => server.once("exit", resolve)), sleep(5000)]);
    if (server.pid) try { process.kill(-server.pid, "SIGKILL"); } catch { /* Owned process group already exited. */ }
    await rm(path.join(temporary, "next"), { recursive: true, force: true });
    // Restore generated Next files, without replacing a concurrent unrelated edit.
    const currentNextEnv = await readFile("next-env.d.ts", "utf8");
    if (currentNextEnv.includes(distDir)) await writeFile("next-env.d.ts", originalNextEnv);
    const currentTsConfig = JSON.parse(await readFile("tsconfig.json", "utf8"));
    if (Array.isArray(currentTsConfig.include) && currentTsConfig.include.some((entry: string) => entry.startsWith(`${distDir}/`))) {
      currentTsConfig.include = currentTsConfig.include.filter((entry: string) => !entry.startsWith(`${distDir}/`));
      const restored = JSON.stringify(currentTsConfig) === JSON.stringify(JSON.parse(originalTsConfig))
        ? originalTsConfig : `${JSON.stringify(currentTsConfig, null, 2)}\n`;
      await writeFile("tsconfig.json", restored);
    }
    if (workspaceCreated) checked(await admin.from("workspaces").delete().eq("id", workspaceId));
    for (const id of userIds) checked(await admin.auth.admin.deleteUser(id));
    // An empty IDs payload would delete all Mailpit mail: never issue that request.
    if (mailIds.size) {
      const removed = await fetch(`${mailpitUrl}/api/v1/messages`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ IDs: [...mailIds] }) });
      assert.ok(removed.ok, "Could not remove this run's captured messages.");
    }
    console.log("Removed only this run's synthetic users, workspace and captured messages; stopped its isolated Next server. ADA Supabase and other projects were left running.");
  }
}

main().catch(error => {
  // Test data and auth tokens never belong in logs, including assertion operands.
  console.error(error instanceof Error ? error.message : "Local password-auth verification failed.");
  process.exitCode = 1;
});
