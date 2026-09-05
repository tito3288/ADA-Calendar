import "server-only";
import type { Actor } from "../types";
import { getSupabaseServerClient } from "./supabase";

export async function getLiveActor(): Promise<Actor> {
  const supabase = await getSupabaseServerClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error("Sign in to access this private workspace.");
  const { data, error: membershipError } = await supabase.from("workspace_members")
    .select("user_id,name,email,role").eq("user_id", user.id).eq("active", true).maybeSingle();
  if (membershipError) throw new Error(`Could not verify workspace membership: ${membershipError.message}`);
  if (!data) throw new Error("This account has not been invited to ADA Calendar.");
  return { id: data.user_id, name: data.name, email: data.email, role: data.role as Actor["role"] };
}

export function requireOwner(actor: Actor) {
  if (actor.role !== "owner") throw new Error("Only Bryan can change existing work or workspace settings.");
}

export async function assertLiveActor(actorOrId: Actor | string): Promise<Actor> {
  const actor = await getLiveActor();
  const expected = typeof actorOrId === "string" ? actorOrId : actorOrId.id;
  if (actor.id !== expected) throw new Error("The signed-in account does not match this operation.");
  return actor;
}
