import { describe, expect, it } from "vitest";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { planCommands, validateSchedule } from "./scheduler";
import { commandSchema } from "./schemas";
import { localDateTime, minutesBetween } from "./time";
import type { Actor, ScheduleSnapshot, WorkCommand, WorkItem, WorkSession } from "./types";
import { newWorkItem } from "./work";

// Fictional records only. These tests never read a saved calendar or call providers.
const owner: Actor = { id: "test-owner", name: "Test Owner", email: "owner@example.test", role: "owner" };
const date = "2026-09-09";
const at = (clock: string, day = date) => localDateTime(day, clock, DEFAULT_SETTINGS.timeZone);
const now = at("08:00");
function item(id: string, minutes: number, patch: Partial<WorkItem> = {}) {
  return newWorkItem(owner, "2026-09-01", { id, clientId: "fixture-client", title: `Fictional ${id}`, estimatedMinutes: minutes, remainingMinutes: minutes, minimumSessionMinutes: 60,
    description: "Keep the saved project details.", windowEnd: "2026-12-31", references: ["https://example.test/reference"], ...patch });
}
function session(id: string, workItemId: string, start: string, end: string, patch: Partial<WorkSession> = {}): WorkSession {
  return { id, workItemId, start: at(start), end: at(end), status: "planned", protected: false, usesReserve: false, ...patch };
}
function state(): ScheduleSnapshot {
  return { workspaceId: "fictional-day-order", version: 4, settings: { ...DEFAULT_SETTINGS, reserveMinutes: 0 }, priorities: structuredClone(DEFAULT_PRIORITIES),
    clients: [{ id: "fixture-client", name: "Fictional client", aliases: [] }], blocks: [],
    items: [item("oral",60), item("tree",60), item("tyler",60), item("demo",120)],
    sessions: [session("oral-am","oral","09:00","10:00"), session("tree-am","tree","10:00","11:00"), session("tyler-am","tyler","11:00","12:00"), session("demo-pm","demo","12:30","14:30")],
  };
}
const order = ["tyler-am", "tree-am", "oral-am", "demo-pm"];
function reorder(snapshot = state(), sessionIds = order, extra: { overrideProtected?: boolean } = {}, clock = now) {
  return planCommands(snapshot, [{ type: "reorder_day", date, sessionIds, ...extra }], owner, { now: clock, approveDisplacement: true });
}
function ready(snapshot: ScheduleSnapshot, proposal: ReturnType<typeof reorder>) {
  expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
  expect(validateSchedule({ ...snapshot, ...proposal }, now)).toEqual([]);
  expect(proposal.items).toEqual(snapshot.items);
  expect(proposal.blocks).toEqual(snapshot.blocks);
  expect(proposal.sessions.map(s => s.id)).toEqual(snapshot.sessions.map(s => s.id));
  for (const s of proposal.sessions) {
    const old = snapshot.sessions.find(original => original.id === s.id)!;
    expect(minutesBetween(s.start,s.end)).toBe(minutesBetween(old.start,old.end));
    expect({ ...s, start: old.start, end: old.end }).toEqual(old);
  }
}

describe("same-day existing-session ordering", () => {
  it("rearranges the user's four-session example and changes only the intended clocks", () => {
    const snapshot = state(), before = structuredClone(snapshot), proposal = reorder(snapshot);
    ready(snapshot, proposal);
    expect(snapshot).toEqual(before);
    expect(order.map(id => proposal.sessions.find(s => s.id === id)).map(s => [s!.start,s!.end])).toEqual([
      [at("09:00"),at("10:00")], [at("10:00"),at("11:00")], [at("11:00"),at("12:00")], [at("12:30"),at("14:30")],
    ]);
    expect(proposal.affectedItemIds.sort()).toEqual(["oral","tyler"]);
    expect(proposal.sessions.find(s => s.id === "tree-am")).toEqual(snapshot.sessions.find(s => s.id === "tree-am"));
  });
  it("preserves unselected sessions, sessions on other dates, and recorded history", () => {
    const snapshot = state(); snapshot.items.push(item("other",120));
    snapshot.sessions.push(session("other-next","other","09:00","11:00",{start:at("09:00","2026-09-10"),end:at("11:00","2026-09-10"),protected:true}),
      session("history","oral","09:00","10:00",{start:at("09:00","2026-09-08"),end:at("10:00","2026-09-08"),status:"completed"}));
    const proposal = reorder(snapshot,["tyler-am","oral-am"]);
    ready(snapshot,proposal);
    expect(proposal.sessions.filter(s => !["tyler-am","oral-am"].includes(s.id))).toEqual(snapshot.sessions.filter(s => !["tyler-am","oral-am"].includes(s.id)));
    expect(proposal.sessions.find(s => s.id === "oral-am")!.start).toBe(at("11:00"));
  });
  it("keeps unknown project totals, quotas, allowed dates, status, and details unchanged", () => {
    const snapshot = state(); snapshot.items[2] = item("tyler",60,{remainingMinutes:null,estimatedMinutes:null,allowedDates:[date],dailyPlan:[{date,minutes:60}],status:"in_progress",deadline:date});
    ready(snapshot,reorder(snapshot));
  });
  it("returns an unchanged ready result when already in the earliest requested order", () => {
    const snapshot = state(), proposal = reorder(snapshot,snapshot.sessions.map(s => s.id));
    ready(snapshot,proposal); expect(proposal.affectedItemIds).toEqual([]); expect(proposal.sessions).toEqual(snapshot.sessions);
    expect(proposal.summary[0]).toContain("Nothing changed");
  });
  it("allows protected selected work as a fixed anchor without an override", () => {
    const snapshot = state(); snapshot.sessions[1].protected = true;
    const proposal = reorder(snapshot); ready(snapshot,proposal);
    expect(proposal.sessions[1]).toEqual(snapshot.sessions[1]);
  });
  it("rejects moving a protected anchor but accepts a separately explicit owner override", () => {
    const snapshot = state(); snapshot.sessions[0].protected = true;
    const denied = reorder(snapshot);
    expect(denied.conflicts[0].code).toBe("protected_session"); expect(denied.sessions).toEqual(snapshot.sessions);
    const accepted = reorder(snapshot,order,{overrideProtected:true}); ready(snapshot,accepted);
    expect(accepted.sessions[0]).toMatchObject({protected:true,start:at("11:00"),end:at("12:00")});
  });
  it("never uses an unrelated protected booking even with a selected-work override", () => {
    const snapshot=state(); snapshot.sessions[1].protected=true;
    const proposal=reorder(snapshot,["tyler-am","oral-am"],{overrideProtected:true}); ready(snapshot,proposal);
    expect(proposal.sessions[1]).toEqual(snapshot.sessions[1]);
  });
  it("skips unavailable time and never changes the unavailable block", () => {
    const snapshot=state(); snapshot.blocks=[{id:"meeting",title:"Fictional meeting",start:at("09:00"),end:at("09:30"),kind:"meeting"}];
    // Move the original morning sessions so the source remains valid.
    snapshot.sessions[0].start=at("09:30"); snapshot.sessions[0].end=at("10:30");
    snapshot.sessions[1].start=at("10:30"); snapshot.sessions[1].end=at("11:30");
    snapshot.sessions[2].start=at("14:30"); snapshot.sessions[2].end=at("15:30");
    const proposal=reorder(snapshot); ready(snapshot,proposal);
    expect(proposal.sessions[2].start).toBe(at("09:30"));
    expect(proposal.sessions[0].start).toBe(at("12:30"));
    expect(proposal.sessions[3].start).toBe(at("13:30"));
  });
  it("refuses a requested order that needs splitting or spill despite enough total daily minutes", () => {
    const snapshot=state(); snapshot.items=[item("short",180),item("long",240)];
    snapshot.sessions=[session("short","short","09:00","12:00"),session("long","long","12:30","16:30")];
    expect(validateSchedule(snapshot,now)).toEqual([]);
    const proposal=reorder(snapshot,["long","short"]);
    expect(proposal.conflicts[0].code).toBe("reorder_capacity"); expect(proposal.sessions).toEqual(snapshot.sessions); expect(proposal.items).toEqual(snapshot.items);
  });
  it("does not change the saved reserve setting or grant new reserve use", () => {
    const snapshot=state(); snapshot.settings.reserveMinutes=60;
    const proposal=reorder(snapshot); ready(snapshot,proposal);
    expect(snapshot.settings.reserveMinutes).toBe(60); expect(proposal.sessions.every(s => !s.usesReserve)).toBe(true);
    expect(validateSchedule({...snapshot,...proposal},now)).toEqual([]);
  });
  it("keeps already-started unselected work fixed and starts at the next available slot", () => {
    const snapshot=state(), clock=at("09:07");
    const proposal=reorder(snapshot,["tyler-am","tree-am","demo-pm"],{},clock);
    ready(snapshot,proposal); expect(proposal.sessions[0]).toEqual(snapshot.sessions[0]); expect(proposal.sessions[2].start).toBe(at("10:00"));
  });
  it.each(["planned","completed","cancelled"] as const)("refuses selected %s history or already-started work", status => {
    const snapshot=state(); snapshot.sessions[0].status=status;
    const proposal=reorder(snapshot,order,{},at("09:01"));
    expect(proposal.conflicts[0].code).toBe("historical_session"); expect(proposal.sessions).toEqual(snapshot.sessions);
  });
  it("does not backdate work that had not yet started", () => {
    const snapshot=state(); snapshot.sessions=snapshot.sessions.filter(s=>s.id!=="oral-am");
    const proposal=reorder(snapshot,["tyler-am","tree-am","demo-pm"],{},at("09:07")); ready(snapshot,proposal);
    expect(proposal.sessions.find(s=>s.id==="tyler-am")!.start).toBe(at("09:15"));
  });
  it.each(["requester","viewer"] as const)("does not allow the %s role to reorder", role => {
    const snapshot=state(); const proposal=planCommands(snapshot,[{type:"reorder_day",date,sessionIds:order,overrideProtected:true}],{...owner,role},{now});
    expect(proposal.conflicts[0].code).toBe("forbidden"); expect(proposal.sessions).toEqual(snapshot.sessions);
  });
  it.each([
    {allowedDates:["2026-09-10"]}, {deadline:"2026-09-08"}, {windowStart:"2026-09-10"}, {dailyPlan:[{date,minutes:30}]},
  ])("revalidates project scheduling constraints without silently repairing them", patch => {
    const snapshot=state(); Object.assign(snapshot.items[0],patch);
    const proposal=reorder(snapshot); expect(proposal.status).toBe("infeasible"); expect(proposal.items).toEqual(snapshot.items); expect(proposal.sessions).toEqual(snapshot.sessions);
  });
  it("does not invalidate a short final focus remainder by moving it before its larger session", () => {
    const snapshot=state(); snapshot.items=[item("focus",180,{minimumSessionMinutes:120})];
    snapshot.sessions=[session("long","focus","09:00","11:00"),session("short","focus","11:00","12:00")];
    expect(validateSchedule(snapshot,now)).toEqual([]);
    const proposal=reorder(snapshot,["short","long"]);
    expect(proposal.conflicts.some(c=>c.code==="focus_length")).toBe(true); expect(proposal.sessions).toEqual(snapshot.sessions);
  });
  it("rejects other dates, missing records, malformed identifiers, duplicate IDs, and overrides outside this capability", () => {
    const snapshot=state(); snapshot.sessions[0].start=at("09:00","2026-09-10"); snapshot.sessions[0].end=at("10:00","2026-09-10");
    expect(reorder(snapshot).conflicts[0].code).toBe("reorder_day_mismatch");
    expect(reorder(state(),["missing"]).conflicts[0].code).toBe("unknown_session");
    for (const command of [
      {type:"reorder_day",date,sessionIds:[]}, {type:"reorder_day",date,sessionIds:["oral-am","oral-am"]},
      {type:"reorder_day",date:"2026-02-30",sessionIds:order}, {type:"reorder_day",date,sessionIds:["invalid/id"]},
      {type:"reorder_day",date,sessionIds:order,overrideDeadline:true}, {type:"reorder_day",date,sessionIds:order,sessions:[]},
    ]) expect(commandSchema.safeParse(command).success).toBe(false);
    expect(reorder(state(),["oral-am","oral-am"]).conflicts[0].code).toBe("invalid_reorder");
  });
  it("rejects mixed or multiple day-order commands atomically", () => {
    const snapshot=state(); const command:WorkCommand={type:"reorder_day",date,sessionIds:order};
    for (const other of [command,{type:"update",itemId:"oral",patch:{title:"Changed"}},{type:"fit",itemId:"oral",request:{startDate:date,endDate:date,minutes:60,distribution:"total"}}] as WorkCommand[]) {
      const proposal=planCommands(snapshot,[command,other],owner,{now});
      expect(proposal.conflicts[0].code).toBe("reorder_mixed_commands"); expect(proposal.items).toEqual(snapshot.items); expect(proposal.sessions).toEqual(snapshot.sessions);
    }
  });
});
