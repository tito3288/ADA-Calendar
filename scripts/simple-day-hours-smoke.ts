/** Isolated local Auth + SQL checks for flexible days/hours. No email is queued or sent. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "../src/lib/defaults";
import { planCommands } from "../src/lib/scheduler";
import { localDate, localDateTime, minutesBetween } from "../src/lib/time";
import { newWorkItem } from "../src/lib/work";
import type { Actor, ScheduleProposal, ScheduleSnapshot, WorkCommand, WorkEvent, WorkItem, WorkSession } from "../src/lib/types";

async function main() {
  const output = execFileSync("node_modules/.bin/supabase", ["status", "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const environment = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1)) as Record<string, string>;
  assert.equal(environment.API_URL, "http://127.0.0.1:55421", "Refusing every non-local/non-ADA endpoint.");
  const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(environment.API_URL, environment.SERVICE_ROLE_KEY, clientOptions);
  const workspaceId = randomUUID(), actors: Actor[] = [], clients = new Map<string, typeof admin>();
  const now = new Date().toISOString(), monday = "2030-09-09", tuesday = "2030-09-10", wednesday = "2030-09-11", thursday = "2030-09-12", friday = "2030-09-13";
  assert.ok(now < `${monday}T00:00:00Z`, "Fixtures must still be in the future.");
  const settings = { ...DEFAULT_SETTINGS, reserveMinutes: 0 }, at = (date: string, time: string) => localDateTime(date, time, settings.timeZone);
  const checked = <T extends { error: { message: string } | null }>(result: T): T => { assert.equal(result.error, null, result.error?.message ?? "Local provider operation failed"); return result; };
  try {
    for (const role of ["owner", "requester"] as const) {
      const email = `ada-day-hours-${randomUUID()}@example.invalid`, password = `${randomUUID()}Aa1!`;
      const user = checked(await admin.auth.admin.createUser({ email, password, email_confirm: true })).data.user!;
      const actor: Actor = { id: user.id, name: `Fixture ${role}`, email, role }; actors.push(actor);
      const client = createClient(environment.API_URL, environment.ANON_KEY, clientOptions);
      checked(await client.auth.signInWithPassword({ email, password })); clients.set(actor.id, client);
    }
    const [owner, requester] = actors, ownerClient = clients.get(owner.id)!;
    const work = (id: string, patch: Partial<WorkItem> = {}) => newWorkItem(owner, "2030-10-01", {
      id, clientId: "fixture-client", title: `Fictional ${id}`, description: "Isolated local database fixture", estimatedMinutes: 240, remainingMinutes: 240,
      minimumSessionMinutes: 480, allowedDates: ["2030-10-01"], dateConstraints: undefined, timelineMode: undefined, ...patch,
    });
    const session = (id: string, workItemId: string, date: string, start: string, end: string, patch: Partial<WorkSession> = {}): WorkSession => ({
      id, workItemId, start: at(date, start), end: at(date, end), status: "planned", protected: false, usesReserve: false, ...patch,
    });
    const historical = session("historical", "legacy", "2000-09-11", "09:00", "10:00", { focusOverrideMinutes: 60 });
    const completedHistory = session("completed-history", "legacy", "2000-09-12", "09:00", "10:00", { status: "completed", focusOverrideMinutes: 60 });
    let state: ScheduleSnapshot = { workspaceId, version: 0, settings, priorities: DEFAULT_PRIORITIES, clients: [{ id: "fixture-client", name: "Fictional client", aliases: [] }],
      items: [work("legacy"), work("destination", { estimatedMinutes: 120, remainingMinutes: 120 }), work("protected", { estimatedMinutes: 60, remainingMinutes: 60 }),
        work("missed", { estimatedMinutes: 120, remainingMinutes: 120, dailyPlan: [{ date: "2000-09-13", minutes: 120 }] }),
        work("ongoing", { estimatedMinutes: null, remainingMinutes: null, timelineMode: "span", windowEnd: null })],
      sessions: [session("monday", "legacy", monday, "09:00", "11:00"), session("tuesday", "legacy", tuesday, "09:00", "11:00"),
        session("destination", "destination", friday, "09:00", "11:00"), session("protected", "protected", thursday, "09:00", "10:00", { protected: true }), historical, completedHistory, session("missed", "missed", "2000-09-13", "09:00", "11:00")],
      blocks: [{ id: "friday-afternoon", title: "Fictional unavailable time", kind: "meeting", start: at(friday, "13:30"), end: at(friday, "17:00") }] };
    checked(await admin.from("workspaces").insert({ id: workspaceId, settings, priorities: state.priorities, clients: state.clients, items: state.items, blocks: state.blocks }));
    checked(await admin.from("workspace_members").insert(actors.map(actor => ({ workspace_id: workspaceId, user_id: actor.id, name: actor.name, email: actor.email, role: actor.role }))));
    checked(await admin.from("work_sessions").insert(state.sessions.map(body => ({ workspace_id: workspaceId, id: body.id, work_item_id: body.workItemId, starts_at: body.start, ends_at: body.end, status: body.status, body }))));
    const read = async () => checked(await ownerClient.rpc("read_schedule_snapshot")).data as ScheduleSnapshot;
    state = await read();
    const plan = (commands: WorkCommand[]) => {
      const proposal = planCommands(state, commands, owner, { now, operationId: randomUUID() });
      assert.equal(proposal.status, "ready", JSON.stringify(proposal.conflicts)); return proposal;
    };
    const commit = async (proposal: ScheduleProposal, actor = owner, undoId: string | null = null) => {
      const event: WorkEvent = { id: randomUUID(), operationId: proposal.operationId, actorId: actor.id, actorName: actor.name, type: "schedule_changed", summary: proposal.summary,
        itemIds: proposal.affectedItemIds, createdAt: now, version: state.version + 1, before: { items: state.items, sessions: state.sessions, blocks: state.blocks },
        after: { items: proposal.items, sessions: proposal.sessions, blocks: proposal.blocks }, undoneBy: null };
      return clients.get(actor.id)!.rpc("commit_schedule", { p_proposal: proposal, p_event: event, p_notifications: [], p_undo_id: undoId });
    };
    const save = async (proposal: ScheduleProposal) => { checked(await commit(proposal)); state = await read(); };
    const rejected = async (proposal: ScheduleProposal, pattern: RegExp, actor = owner, undoId: string | null = null) => {
      const before = await read(), result = await commit(proposal, actor, undoId);
      assert.ok(result.error, "Forged operation unexpectedly committed."); assert.match(result.error.message, pattern);
      assert.deepEqual(await read(), before, "A rejected SQL operation must leave the entire schedule unchanged.");
    };
    const freshCopy = (proposal: ScheduleProposal) => ({ ...structuredClone(proposal), operationId: randomUUID(), baseVersion: state.version });
    const count = async (table: string) => checked(await admin.from(table).select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId)).count;
    const booked = (itemId: string, date: string) => state.sessions.filter(s => s.workItemId === itemId && s.status === "planned" && localDate(s.start, settings.timeZone) === date).reduce((sum, s) => sum + minutesBetween(s.start, s.end), 0);

    const reduce = plan([{ type: "set_day_hours", itemId: "legacy", days: [{ date: tuesday, minutes: 60 }] }]);
    const stale = plan([{ type: "set_day_hours", itemId: "legacy", days: [{ date: wednesday, minutes: 15 }] }]);
    await rejected({ ...freshCopy(reduce), actorId: requester.id }, /owner|Requester/i, requester);
    await save(reduce);
    assert.equal(state.items.find(i => i.id === "legacy")!.remainingMinutes, 180);
    assert.equal(state.items.find(i => i.id === "legacy")!.estimatedMinutes, 240);
    assert.equal(booked("legacy", monday), 120); assert.equal(booked("legacy", tuesday), 60);
    const version = state.version, events = await count("work_events");
    checked(await commit(reduce)); assert.equal((await read()).version, version); assert.equal(await count("work_events"), events);
    const replayWithOldSnapshot = { ...structuredClone(reduce), sessions: reduce.sessions.filter(s => s.id !== historical.id) };
    checked(await commit(replayWithOldSnapshot));
    assert.deepEqual(await read(), state, "A verified duplicate operation stays idempotent even when its old snapshot differs from current history.");
    await rejected(stale, /changed|refresh|re.plan/i);
    assert.deepEqual(state.sessions.find(s => s.id === "historical"), historical);

    const destinationBefore = state.sessions.find(s => s.id === "destination");
    await save(plan([{ type: "move_bookings", sessionIds: ["monday"], date: friday }]));
    assert.equal(booked("legacy", monday), 0); assert.equal(booked("legacy", friday), 120);
    assert.equal(state.sessions.filter(s => s.workItemId === "legacy" && localDate(s.start, settings.timeZone) === friday).length, 2, "Day moves must split across the two free openings.");
    assert.deepEqual(state.sessions.find(s => s.id === "destination"), destinationBefore);
    assert.equal(state.items.find(i => i.id === "legacy")!.remainingMinutes, 180);

    const beforeShort = structuredClone(state);
    const short = plan([{ type: "set_day_hours", itemId: "legacy", days: [{ date: wednesday, minutes: 15 }] }]);
    await save(short); assert.equal(booked("legacy", wednesday), 15);
    const legacy = state.items.find(i => i.id === "legacy")!;
    assert.equal(legacy.windowStart, "2030-10-01"); assert.deepEqual(legacy.allowedDates, ["2030-10-01"]); assert.equal(legacy.minimumSessionMinutes, 480);
    const event = checked(await admin.from("work_events").select("id,body").eq("workspace_id", workspaceId).eq("operation_id", short.operationId).single()).data!;
    const undo = { ...freshCopy(short), commands: [], items: beforeShort.items, sessions: beforeShort.sessions, blocks: beforeShort.blocks };
    checked(await commit(undo, owner, event.id)); state = await read(); assert.equal(booked("legacy", wednesday), 0);
    await save(plan([{ type: "set_day_hours", itemId: "legacy", days: [{ date: wednesday, minutes: 15 }] }]));
    assert.equal(booked("legacy", wednesday), 15, "Undo cannot restore authority to old focus/date JSON.");

    await save(plan([{ type: "set_day_hours", itemId: "ongoing", days: [{ date: wednesday, minutes: 60 }] }]));
    assert.equal(state.items.find(i => i.id === "ongoing")!.remainingMinutes, null);
    await save(plan([{ type: "set_day_hours", itemId: "ongoing", days: [{ date: wednesday, minutes: 0 }] }]));
    assert.equal(booked("ongoing", wednesday), 0); assert.equal(state.items.find(i => i.id === "ongoing")!.estimatedMinutes, null);

    const basis = plan([{ type: "set_day_hours", itemId: "legacy", days: [{ date: wednesday, minutes: 30 }] }]);
    for (const dateConstraints of [{ earliestStart: "2030-10-01", allowedDates: [] }, { earliestStart: null, allowedDates: ["2030-10-01"] }]) {
      const forged = freshCopy(basis); forged.items.find(i => i.id === "legacy")!.dateConstraints = dateConstraints;
      await rejected(forged, /outside allowed/i);
    }
    const deadline = freshCopy(basis); deadline.items.find(i => i.id === "legacy")!.deadline = monday;
    await rejected(deadline, /firm deadline/i);
    const history = freshCopy(basis); const changedHistory = history.sessions.find(s => s.id === "historical")!;
    changedHistory.start = at("2000-09-11", "10:00"); changedHistory.end = at("2000-09-11", "11:00");
    await rejected(history, /already started|history|past/i);
    for (const type of ["set_day_hours", "move_bookings"] as const) {
      for (const historicalId of [completedHistory.id]) {
        const deletion = freshCopy(basis);
        deletion.commands = type === "set_day_hours"
          ? [{ type, itemId: "legacy", days: [{ date: wednesday, minutes: 30 }] }]
          : [{ type, sessionIds: [historicalId], date: wednesday }];
        deletion.sessions = deletion.sessions.filter(s => s.id !== historicalId);
        await rejected(deletion, /completed|cancelled|history/i);
        const movedHistory = freshCopy(basis);
        movedHistory.commands = deletion.commands;
        Object.assign(movedHistory.sessions.find(s => s.id === historicalId)!, { start: at(wednesday, "15:00"), end: at(wednesday, "16:00"), status: "planned" });
        await rejected(movedHistory, /completed|cancelled|history/i);
      }
    }
    const undoHistory = freshCopy(basis); undoHistory.sessions = undoHistory.sessions.filter(s => s.id !== "historical");
    await rejected(undoHistory, /latest|original state/i, owner, event.id);
    const protectedProposal = plan([{ type: "set_day_hours", itemId: "protected", days: [{ date: thursday, minutes: 30 }], overrideProtected: true }]);
    const unauthorizedProtected = freshCopy(protectedProposal); unauthorizedProtected.commands = [{ type: "set_day_hours", itemId: "protected", days: [{ date: thursday, minutes: 30 }] }];
    await rejected(unauthorizedProtected, /Protected work/i); await save(protectedProposal);
    assert.equal(booked("protected", thursday), 30); assert.equal(state.sessions.find(s => s.id === "protected")!.protected, true);
    // A missed planned booking can move without becoming extra work. Undo is
    // the exact latest snapshot, including the original elapsed planned time.
    const beforeMissed = structuredClone(state);
    const moveMissed = plan([{ type: "move_bookings", sessionIds: ["missed"], date: tuesday }]);
    await save(moveMissed);
    assert.equal(booked("missed", "2000-09-13"), 0); assert.equal(booked("missed", tuesday), 120);
    assert.equal(state.items.find(i => i.id === "missed")!.remainingMinutes, 120);
    assert.deepEqual(state.items.find(i => i.id === "missed")!.dailyPlan, [{ date: tuesday, minutes: 120 }]);
    const movedEvent = checked(await admin.from("work_events").select("id").eq("workspace_id", workspaceId).eq("operation_id", moveMissed.operationId).single()).data!;
    const undoMissed = { ...freshCopy(moveMissed), commands: [], items: beforeMissed.items, sessions: beforeMissed.sessions, blocks: beforeMissed.blocks };
    checked(await commit(undoMissed, owner, movedEvent.id)); state = await read();
    assert.deepEqual(state.sessions, beforeMissed.sessions); assert.deepEqual(state.items, beforeMissed.items);
    checked(await commit(undoMissed, owner, movedEvent.id)); assert.deepEqual(await read(), state, "Missed-booking Undo retries remain idempotent.");
    await save(plan([{ type: "set_day_hours", itemId: "missed", days: [{ date: "2000-09-13", minutes: 0 }, { date: tuesday, minutes: 120 }] }]));
    assert.equal(booked("missed", "2000-09-13"), 0); assert.equal(booked("missed", tuesday), 120);
    assert.equal(state.items.find(i => i.id === "missed")!.remainingMinutes, 120);
    assert.equal(await count("notifications"), 0, "This isolated test never queues email.");
    console.log("PASS: local Auth/SQL; legacy date/focus fields inert; known 4h→3h and unknown totals; atomic multi-gap move; zero-day removal; replay/stale/requester rejection; explicit date/deadline enforcement; protected override; completed-history mutation rejection; missed planned moves/day edits preserve effort and quotas; exact Undo restores elapsed bookings; replay and forged-Undo guards. No email queued or sent.");
  } finally {
    for (const table of ["ai_operations", "ai_usage", "email_drafts", "attachments", "notifications", "pending_requests", "work_events", "work_sessions", "workspace_members", "workspaces"]) {
      const result = await admin.from(table).delete().eq(table === "workspaces" ? "id" : "workspace_id", workspaceId);
      if (result.error) console.error(`Fixture cleanup ${table}: ${result.error.message}`);
    }
    for (const actor of actors) checked(await admin.auth.admin.deleteUser(actor.id));
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Simple day-hours database smoke failed"); process.exitCode = 1; });
