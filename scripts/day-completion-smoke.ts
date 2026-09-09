/** Isolated local Auth/SQL fixtures for finishing one booked day. No mail queued or sent. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_SETTINGS, DEFAULT_PRIORITIES } from "../src/lib/defaults";
import { planCommands } from "../src/lib/scheduler";
import { localDateTime } from "../src/lib/time";
import { newWorkItem } from "../src/lib/work";
import type { Actor, ScheduleSnapshot, ScheduleProposal, WorkItem, WorkSession } from "../src/lib/types";

async function main() {
  const raw = execFileSync("node_modules/.bin/supabase", ["status", "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const env = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Record<string, string>;
  assert.equal(env.API_URL, "http://127.0.0.1:55421", "Refusing non-local/non-ADA endpoints.");
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(env.API_URL, env.SERVICE_ROLE_KEY, options), workspaceId = randomUUID();
  const actors: Actor[] = [], clients = new Map<string, typeof admin>();
  const settings = { ...DEFAULT_SETTINGS }, now = new Date().toISOString();
  const dates = ["2030-09-09", "2030-09-10", "2030-09-11"], at = (date: string, time: string) => localDateTime(date, time, settings.timeZone);
  assert.ok(now < at(dates[0], "09:00"), "Fictional future fixtures need refreshing.");
  const checked = <T extends { error: { message: string } | null }>(result: T): T => { assert.equal(result.error, null, result.error?.message ?? "Local database operation failed"); return result; };
  try {
    for (const role of ["owner", "requester", "viewer"] as const) {
      const email = `ada-finish-day-${randomUUID()}@example.invalid`, password = `${randomUUID()}Aa1!`;
      const user = checked(await admin.auth.admin.createUser({ email, password, email_confirm: true })).data.user!;
      const actor: Actor = { id: user.id, role, name: `Fixture ${role}`, email }; actors.push(actor);
      const client = createClient(env.API_URL, env.ANON_KEY, options);
      checked(await client.auth.signInWithPassword({ email, password })); clients.set(actor.id, client);
    }
    const [owner, requester, viewer] = actors;
    const work = (id: string, patch: Partial<WorkItem> = {}) => newWorkItem(owner, dates[0], { id, clientId: "fixture", title: `Fictional ${id}`, estimatedMinutes: 180, remainingMinutes: 180, timelineMode: "bookings", ...patch });
    const session = (id: string, workItemId: string, date: string, start: string, end: string, patch: Partial<WorkSession> = {}): WorkSession => ({ id, workItemId, start: at(date, start), end: at(date, end), status: "planned", protected: false, usesReserve: false, ...patch });
    let state: ScheduleSnapshot = { workspaceId, version: 0, clients: [{ id: "fixture", name: "Fictional client", aliases: [] }], settings, priorities: DEFAULT_PRIORITIES,
      items: [work("three-days", { dailyPlan: dates.map(date => ({ date, minutes: 60 })) }), work("ongoing", { estimatedMinutes: null, remainingMinutes: null, timelineMode: "span", windowEnd: null }), work("reserve", { estimatedMinutes: 60, remainingMinutes: 60 }), work("neighbor", { estimatedMinutes: 60, remainingMinutes: 60 }), work("clipped", { dailyPlan: [{ date: "2000-09-12", minutes: 120 }, { date: dates[2], minutes: 60 }] })],
      sessions: [session("first-a", "three-days", dates[0], "09:00", "09:30", { protected: true }), session("first-b", "three-days", dates[0], "10:00", "10:30"),
        session("second", "three-days", dates[1], "09:00", "10:00"), session("third", "three-days", dates[2], "09:00", "10:00"),
        session("ongoing", "ongoing", dates[1], "11:00", "12:00"), session("reserve", "reserve", dates[2], "13:00", "14:00", { usesReserve: true, protected: true }),
        session("neighbor", "neighbor", dates[2], "16:00", "17:00"), session("history", "three-days", "2000-09-11", "09:00", "10:00", { status: "completed" }),
        session("clipped", "clipped", "2000-09-12", "09:00", "10:07:45"), session("clipped-future", "clipped", dates[2], "11:00", "12:00")], blocks: [] };
    checked(await admin.from("workspaces").insert({ id: workspaceId, settings, priorities: state.priorities, clients: state.clients, items: state.items, blocks: state.blocks }));
    checked(await admin.from("workspace_members").insert(actors.map(actor => ({ workspace_id: workspaceId, user_id: actor.id, name: actor.name, email: actor.email, role: actor.role }))));
    checked(await admin.from("work_sessions").insert(state.sessions.map(body => ({ workspace_id: workspaceId, id: body.id, work_item_id: body.workItemId, starts_at: body.start, ends_at: body.end, status: body.status, body }))));
    const read = async () => checked(await clients.get(owner.id)!.rpc("read_schedule_snapshot")).data as ScheduleSnapshot;
    state = await read();
    const plan = (itemId: string, date: string) => {
      const proposal = planCommands(state, [{ type: "complete_day", itemId, date }], owner, { now, operationId: randomUUID() });
      assert.equal(proposal.status, "ready", JSON.stringify(proposal.conflicts)); return proposal;
    };
    const commit = (proposal: ScheduleProposal, actor = owner, undoId: string | null = null) => clients.get(actor.id)!.rpc("commit_schedule", { p_proposal: proposal,
      p_event: { id: randomUUID(), type: undoId ? "schedule_undone" : "schedule_changed", itemIds: proposal.affectedItemIds, summary: proposal.summary }, p_notifications: [], p_undo_id: undoId });
    const reject = async (proposal: ScheduleProposal, pattern: RegExp, actor = owner, undoId: string | null = null) => {
      const before = await read(), result = await commit(proposal, actor, undoId);
      assert.ok(result.error, "Forged completion committed."); assert.match(result.error.message, pattern); assert.deepEqual(await read(), before);
    };
    const verifyUndo = async (completed: ScheduleProposal, original: ScheduleSnapshot) => {
      const event = checked(await admin.from("work_events").select("id,body").eq("workspace_id", workspaceId).eq("operation_id", completed.operationId).single()).data!;
      const undo: ScheduleProposal = { ...completed, id: randomUUID(), operationId: `undo/${event.id}`, baseVersion: state.version,
        commands: [], ...event.body.before, summary: ["Undo the explicitly finished day"] };
      for (const actor of [requester, viewer]) await reject({ ...undo, actorId: actor.id }, /owner|authorized|cannot remove or change completed/i, actor, event.id);
      for (const id of ["history", completed.commands[0].type === "complete_day" && completed.commands[0].itemId === "clipped" ? "clipped" : "first-a"]) {
        const forged = structuredClone(undo); forged.operationId = randomUUID();
        forged.sessions.find(s => s.id === id)!.protected = !forged.sessions.find(s => s.id === id)!.protected;
        await reject(forged, /undo|history|completed|snapshot|original/i, owner, event.id);
      }
      checked(await commit(undo, owner, event.id)); state = await read();
      assert.deepEqual(state.items, original.items, "Undo must restore the exact prior estimate, daily hours and timeline.");
      assert.deepEqual(state.sessions, original.sessions, "Undo must restore the exact original selected hours and all unchanged history.");
      assert.deepEqual(state.blocks, original.blocks);
      checked(await commit(undo, owner, event.id)); assert.deepEqual(await read(), state, "Undo replay must not create a second event.");
    };
    const before = structuredClone(state), proposal = plan("three-days", dates[0]);
    for (const actor of [requester, viewer]) await reject({ ...proposal, actorId: actor.id }, /owner|authorized/i, actor);
    for (const change of ["hours", "other day", "estimate", "status", "metadata", "history", "timeline"] as const) {
      const forged = structuredClone(proposal); forged.operationId = randomUUID();
      if (change === "hours") forged.items[0].remainingMinutes = 60;
      if (change === "other day") forged.sessions.find(s => s.id === "second")!.status = "completed";
      if (change === "estimate") forged.items[0].estimatedMinutes = 120;
      if (change === "timeline") forged.items[0].timelineMode = "span";
      if (change === "status") forged.items[0].status = "completed";
      if (change === "metadata") forged.sessions.find(s => s.id === "first-a")!.protected = false;
      if (change === "history") forged.sessions = forged.sessions.filter(s => s.id !== "history");
      await reject(forged, /subtract|preserve|details|bookings|timeline/i);
    }
    checked(await commit(proposal)); state = await read();
    assert.equal(state.items.find(i => i.id === "three-days")!.remainingMinutes, 120);
    assert.equal(state.items.find(i => i.id === "three-days")!.estimatedMinutes, 180);
    assert.equal(state.items.find(i => i.id === "three-days")!.status, "planned");
    for (const id of ["first-a", "first-b"]) assert.deepEqual(state.sessions.find(s => s.id === id), { ...before.sessions.find(s => s.id === id), status: "completed" });
    assert.deepEqual(state.sessions.filter(s => !["first-a", "first-b"].includes(s.id)), before.sessions.filter(s => !["first-a", "first-b"].includes(s.id)));
    checked(await commit(proposal)); assert.deepEqual(await read(), state, "Exact retry must not subtract hours twice.");
    const noop = plan("three-days", dates[0]); assert.deepEqual(noop.items, state.items); assert.deepEqual(noop.sessions, state.sessions);
    await reject({ ...proposal, operationId: randomUUID() }, /changed|subtract|preserve/i);
    await verifyUndo(proposal, before);
    checked(await commit(plan("three-days", dates[0]))); state = await read();
    checked(await commit(plan("ongoing", dates[1]))); state = await read(); assert.equal(state.items.find(i => i.id === "ongoing")!.remainingMinutes, null);
    const neighbor = state.sessions.find(s => s.id === "neighbor");
    checked(await commit(plan("reserve", dates[2]))); state = await read(); assert.deepEqual(state.sessions.find(s => s.id === "neighbor"), neighbor);
    assert.equal(state.sessions.find(s => s.id === "reserve")!.usesReserve, true);
    const clippedFuture = state.sessions.find(s => s.id === "clipped-future");
    const beforeClipped = structuredClone(state), clippedProposal = plan("clipped", "2000-09-12");
    checked(await commit(clippedProposal)); state = await read();
    assert.equal(state.items.find(i => i.id === "clipped")!.remainingMinutes, 112);
    assert.deepEqual(state.items.find(i => i.id === "clipped")!.dailyPlan, [{ date: dates[2], minutes: 60 }]);
    assert.deepEqual(state.sessions.find(s => s.id === "clipped-future"), clippedFuture);
    assert.equal(state.sessions.find(s => s.id === "clipped")!.end, at("2000-09-12", "10:07:45"));
    await verifyUndo(clippedProposal, beforeClipped);
    checked(await commit(plan("clipped", "2000-09-12"))); state = await read();
    for (const date of dates.slice(1)) { checked(await commit(plan("three-days", date))); state = await read(); }
    assert.equal(state.items.find(i => i.id === "three-days")!.remainingMinutes, 0);
    assert.equal(state.items.find(i => i.id === "three-days")!.status, "planned", "Finishing days does not implicitly complete the project.");
    assert.equal(checked(await admin.from("notifications").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId)).count, 0);
    console.log("PASS: isolated Auth/SQL day completion; split/protected day done, 3h→2h, next days exact; unknown totals; last day/project distinction; reserve preservation; direct-RPC tampering and role rejection; retries/stale writes; exact Undo of split/protected and past clipped completion with replay/forgery checks; history unchanged. No mail queued or sent.");
  } finally {
    for (const table of ["notifications", "work_events", "work_sessions", "workspace_members", "workspaces"]) {
      const result = await admin.from(table).delete().eq(table === "workspaces" ? "id" : "workspace_id", workspaceId);
      if (result.error) console.error(`Fixture cleanup ${table}: ${result.error.message}`);
    }
    for (const actor of actors) checked(await admin.auth.admin.deleteUser(actor.id));
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Day completion database smoke failed"); process.exitCode = 1; });
