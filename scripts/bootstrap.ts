/** Explicit administration only. Dry run by default; never invoked by application startup. */
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "../src/lib/defaults";
import { ensureAuthAccount, deliverAccountSetupEmail } from "../src/lib/account-invitations";
import { assertAuthEmailAllowed } from "../src/lib/auth-email-policy";

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const ownerEmail = option("owner-email")?.trim().toLowerCase();
  const ownerName = option("owner-name") ?? "Bryan";
  const inviteEmail = option("invite-email")?.trim().toLowerCase();
  const inviteName = option("invite-name");
  const inviteRole = option("invite-role") ?? "requester";
  if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new Error("Provide --owner-email with Bryan's real address.");
  if (inviteEmail && (!inviteName || !["requester", "viewer"].includes(inviteRole))) throw new Error("Invites require --invite-name and --invite-role requester|viewer.");
  const apply = process.argv.includes("--apply");
  const sendInvites = process.argv.includes("--send-invites");
  const setupEmailRecipient = inviteEmail ?? ownerEmail;
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ownerEmail, ownerName, inviteEmail: inviteEmail ?? null, inviteRole, sendsAccountSetupEmail: apply && sendInvites, setupEmailRecipient: sendInvites ? setupEmailRecipient : null }, null, 2));
  if (!apply) { console.log("No changes made. Add --apply to create records; --send-invites explicitly authorizes invitation emails."); return; }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  const appUrl = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL;
  if (sendInvites && !appUrl) throw new Error("APP_URL is required to build invitation redirects.");
  if (sendInvites) assertAuthEmailAllowed(setupEmailRecipient, url);
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const owner = await ensureAuthAccount(db, ownerEmail, ownerName);
  let setupAccount = owner;
  const membership = await db.from("workspace_members").select("workspace_id,role,active").eq("user_id", owner.id).maybeSingle();
  if (membership.error) throw membership.error;
  if (membership.data && membership.data.role !== "owner") throw new Error("This account already belongs to a workspace as a non-owner.");
  if (membership.data && !membership.data.active) throw new Error("The owner's workspace membership is inactive. Restore that membership explicitly before sending account setup.");
  let workspaceId = membership.data?.workspace_id as string | undefined;
  if (!workspaceId) {
    const { data, error } = await db.from("workspaces").insert({ settings: DEFAULT_SETTINGS, priorities: DEFAULT_PRIORITIES, clients: [{ id: "internal", name: "Internal / Other", aliases: ["internal", "agency", "favor"] }] }).select("id").single();
    if (error) throw error;
    workspaceId = data.id;
    const saved = await db.from("workspace_members").insert({ workspace_id: workspaceId, user_id: owner.id, email: ownerEmail, name: ownerName, role: "owner", receive_updates: false });
    if (saved.error) throw saved.error;
  }
  if (inviteEmail && inviteName) {
    const user = await ensureAuthAccount(db, inviteEmail, inviteName);
    if (user.id === owner.id) throw new Error("The owner must not be invited as a requester/viewer.");
    const previous = await db.from("workspace_members").select("workspace_id,role").eq("user_id", user.id).maybeSingle();
    if (previous.error) throw previous.error;
    if (previous.data && (previous.data.workspace_id !== workspaceId || previous.data.role === "owner")) throw new Error("This user already belongs to another workspace or owns one.");
    const saved = await db.from("workspace_members").upsert({ workspace_id: workspaceId, user_id: user.id, email: inviteEmail, name: inviteName, role: inviteRole, active: true, receive_updates: true }, { onConflict: "user_id" });
    if (saved.error) throw saved.error;
    setupAccount = user;
  }
  console.log(`Workspace ready: ${workspaceId}. Public signup remains disabled.`);
  if (sendInvites) {
    const kind = await deliverAccountSetupEmail(db, setupAccount, appUrl!, url);
    console.log(kind === "invitation" ? "Account invitation sent after membership was saved." : "Password setup email sent after membership was saved.");
  } else console.log("No invitation emails were sent. After SMTP is configured, rerun with --send-invites to deliver account setup to the displayed target.");
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Bootstrap failed"); process.exitCode = 1; });
