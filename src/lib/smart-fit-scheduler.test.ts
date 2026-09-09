import { describe, expect, it } from "vitest";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { planCommands, validateSchedule } from "./scheduler";
import { commandRequestSchema, commandSchema, smartFitRequestSchema } from "./schemas";
import { addDays, localDate, localDateTime, minutesBetween } from "./time";
import type { Actor, ScheduleSnapshot, SmartFitRequest, WorkCommand, WorkItem, WorkSession } from "./types";
import { newWorkItem } from "./work";

// All fixtures are fictional and isolated from saved user calendars.
const owner: Actor = { id: "smart-owner", name: "Test Owner", role: "owner", email: "owner@example.test" };
const requester: Actor = { ...owner, id: "requester", role: "requester" };
const day = "2026-09-14";
const at = (date: string, clock: string) => localDateTime(date, clock, DEFAULT_SETTINGS.timeZone);
const now = at("2026-09-09", "08:00");
function state(): ScheduleSnapshot {
  return { workspaceId: "fictional-smart-fit", version: 4, settings: { ...DEFAULT_SETTINGS, reserveMinutes: 0 }, clients: [{ id: "sample", name: "Sample Studio", aliases: [] }], priorities: structuredClone(DEFAULT_PRIORITIES), items: [], sessions: [], blocks: [] };
}
function item(patch: Partial<WorkItem> = {}) {
  return newWorkItem(owner, "2026-09-01", { id: "sample-work", clientId: "sample", title: "Sample software", category: "software", estimatedMinutes: null, remainingMinutes: null, windowEnd: "2026-12-31", minimumSessionMinutes: 60, status: "planned", ...patch });
}
function session(id: string, start: string, end: string, patch: Partial<WorkSession> = {}): WorkSession {
  return { id, workItemId: "sample-work", start: at(day, start), end: at(day, end), status: "planned", protected: false, usesReserve: false, ...patch };
}
function request(patch: Partial<SmartFitRequest> = {}): SmartFitRequest {
  return { startDate: day, endDate: day, minutes: 120, distribution: "total", ...patch };
}
function fit(snapshot: ScheduleSnapshot, patch: Partial<SmartFitRequest> = {}, clock = now) {
  return planCommands(snapshot, [{ type: "fit", itemId: "sample-work", request: request(patch) }], owner, { now: clock, approveDisplacement: true });
}
function existing(patch: Partial<WorkItem> = {}) { const snapshot = state(); snapshot.items = [item(patch)]; return snapshot; }
function ready(snapshot: ScheduleSnapshot, proposal: ReturnType<typeof planCommands>) {
  expect(proposal.status, JSON.stringify(proposal.conflicts)).toBe("ready");
  expect(validateSchedule({ ...snapshot, ...proposal }, now)).toEqual([]);
}

describe("append-only smart fit", () => {
  it("fits an unknown-total project's hours around protected bookings without modifying them", () => {
    const snapshot = existing();
    snapshot.items.push(item({ id: "other", title: "Other project", estimatedMinutes: 120, remainingMinutes: 120 }));
    snapshot.sessions = [session("busy", "09:00", "11:00", { workItemId: "other", protected: true })];
    const before = structuredClone(snapshot);
    const proposal = fit(snapshot);
    ready(snapshot, proposal);
    expect(snapshot).toEqual(before);
    expect(proposal.sessions[0]).toEqual(before.sessions[0]);
    expect(proposal.sessions.slice(1).map(s => [s.start, s.end])).toEqual([[at(day,"11:00"),at(day,"12:00")], [at(day,"12:30"),at(day,"13:30")]]);
    expect(proposal.items[0]).toMatchObject({ estimatedMinutes: null, remainingMinutes: null, windowEnd: "2026-12-31", forecastDate: null });
    expect(proposal.affectedItemIds).toEqual(["sample-work"]);
  });
  it("preserves its own booked, protected, completed, and historical sessions", () => {
    const snapshot = existing();
    snapshot.sessions = [session("own", "09:00", "10:00", { protected: true }), session("history", "09:00", "10:00", { start: at("2026-09-08","09:00"), end: at("2026-09-08","10:00") }), session("done", "10:00", "11:00", { status: "completed" })];
    const proposal = fit(snapshot);
    ready(snapshot, proposal);
    expect(proposal.sessions.slice(0,3)).toEqual(snapshot.sessions);
    expect(proposal.sessions.at(-1)).toMatchObject({ start: at(day,"10:00"), end: at(day,"12:00") });
  });
  it("keeps an underway session intact and uses only future open time", () => {
    const snapshot = existing(); snapshot.sessions = [session("started", "09:00", "10:00", { protected: true })];
    const proposal = fit(snapshot, {}, at(day,"09:20"));
    expect(proposal.status,JSON.stringify(proposal.conflicts)).toBe("ready");
    expect(proposal.sessions[0]).toEqual(snapshot.sessions[0]);
    expect(proposal.sessions[1]).toMatchObject({ start: at(day,"10:00"), end: at(day,"12:00") });
  });
  it("requires explicit resume for waiting work and keeps its estimate unknown", () => {
    const snapshot = existing({ status: "waiting", blockedReason: "Awaiting details" });
    expect(fit(snapshot).conflicts[0].code).toBe("smart_fit_waiting");
    const proposal = fit(snapshot, { resumeWaiting: true });
    ready(snapshot, proposal);
    expect(proposal.items[0]).toMatchObject({ status: "planned", blockedReason: null, remainingMinutes: null, estimatedMinutes: null });
  });
  it.each(["completed", "cancelled"] as const)("does not reopen %s work", status => {
    expect(fit(existing({ status }), { resumeWaiting: true }).conflicts[0].code).toBe("inactive_work");
  });
  it("books only requested known effort, not unrelated remaining effort", () => {
    const snapshot = existing({ remainingMinutes: 600, estimatedMinutes: 600 });
    const proposal = fit(snapshot);
    ready(snapshot, proposal);
    expect(proposal.sessions.reduce((total,s) => total+minutesBetween(s.start,s.end),0)).toBe(120);
    expect(proposal.items[0]).toMatchObject({ remainingMinutes: 600, estimatedMinutes: 600, forecastDate: null });
  });
  it("rejects additions beyond unreserved effort without trimming existing bookings", () => {
    const snapshot = existing({ remainingMinutes: 180, estimatedMinutes: 180 }); snapshot.sessions = [session("old","09:00","11:00")];
    const proposal = fit(snapshot);
    expect(proposal.conflicts[0].code).toBe("smart_fit_effort");
    expect(proposal.sessions).toEqual(snapshot.sessions); expect(proposal.items).toEqual(snapshot.items);
    ready(snapshot, fit(snapshot, { minutes: 60 }));
  });
  it("rejects fitting an existing project for requesters or viewers", () => {
    for (const role of ["requester","viewer"] as const)
      expect(planCommands(existing(),[{ type: "fit", itemId: "sample-work", request: request() }],{ ...owner,role },{ now }).conflicts[0].code).toBe("forbidden");
  });
  it("cannot mix append-only smart fit with an ordinary mutation", () => {
    const snapshot = existing();
    const proposal = planCommands(snapshot,[{ type: "update", itemId: "sample-work", patch: { title: "Changed" } }, { type: "fit", itemId: "sample-work", request: request() }],owner,{ now });
    expect(proposal.conflicts[0].code).toBe("smart_fit_mixed_commands"); expect(proposal.items).toEqual(snapshot.items);
  });
  it("preserves explicit daily quotas and fits only remaining quota", () => {
    const snapshot = existing({ dailyPlan: [{ date: day, minutes: 120 }, { date: addDays(day,1), minutes:120 }] }); snapshot.sessions = [session("old","09:00","11:00")];
    const proposal = fit(snapshot,{ endDate:addDays(day,1) });
    ready(snapshot,proposal);
    expect(proposal.sessions[0]).toEqual(snapshot.sessions[0]);
    expect(localDate(proposal.sessions[1].start,DEFAULT_SETTINGS.timeZone)).toBe(addDays(day,1));
    expect(proposal.items[0].dailyPlan).toEqual(snapshot.items[0].dailyPlan);
    expect(fit(snapshot).conflicts[0].code).toBe("smart_fit_capacity");
  });
  it("adds same-day hours while retaining an existing short booking unchanged", () => {
    const snapshot = existing({ minimumSessionMinutes: 120 }); snapshot.sessions = [session("short-remainder","09:00","10:00")];
    expect(validateSchedule(snapshot,now)).toEqual([]);
    const proposal = fit(snapshot);
    ready(snapshot,proposal); expect(proposal.sessions[0]).toEqual(snapshot.sessions[0]); expect(proposal.sessions).toHaveLength(2);
  });
});

describe("smart-fit dates and capacity", () => {
  it.each(["create", "fit", "add_booking"] as const)("keeps sparse requested dates and their shared total without saving a date lock for %s", type => {
    const snapshot = type === "create" ? state() : existing();
    snapshot.blocks = [{ id: "monday-closed", title: "Fictional closure", start: at(day, "09:00"), end: at(day, "17:00"), kind: "time_off" }];
    const bookingRequest = request({ endDate: addDays(day, 2), dates: [day, addDays(day, 2)], minutes: 120 });
    const command: WorkCommand = type === "create"
      ? { type, item: item({ estimatedMinutes: 120, remainingMinutes: 120 }), smartFit: bookingRequest }
      : { type, itemId: "sample-work", request: bookingRequest };
    const proposal = planCommands(snapshot, [command], owner, { now });
    ready(snapshot, proposal);
    expect(proposal.sessions.map(s => [localDate(s.start, DEFAULT_SETTINGS.timeZone), minutesBetween(s.start, s.end)]))
      .toEqual([[addDays(day, 2), 120]]);
    expect(proposal.items[0].allowedDates).toEqual([]);
    expect(proposal.items[0].dateConstraints?.allowedDates ?? []).toEqual([]);
    expect(proposal.items[0].remainingMinutes).toBe(type === "create" ? 120 : null);
    const moved = planCommands({ ...snapshot, items: proposal.items, sessions: proposal.sessions }, [{ type: "move_bookings", sessionIds: proposal.sessions.map(s => s.id), date: addDays(day, 1) }], owner, { now });
    ready(snapshot, moved);
    expect(moved.sessions.map(s => localDate(s.start, DEFAULT_SETTINGS.timeZone))).toEqual([addDays(day, 1)]);
  });
  it("spreads a total across the selected window, rather than repeating it", () => {
    const snapshot = existing();
    const proposal = fit(snapshot,{ minutes:600,endDate:addDays(day,1) });
    ready(snapshot,proposal);
    const daily = proposal.sessions.reduce<Record<string,number>>((out,s) => { const date=localDate(s.start,DEFAULT_SETTINGS.timeZone); out[date]=(out[date]??0)+minutesBetween(s.start,s.end); return out; },{});
    expect(daily).toEqual({ [day]:450,[addDays(day,1)]:150 });
  });
  it("books each configured workday only, skipping weekends without extending the range", () => {
    const snapshot=existing();
    const proposal=fit(snapshot,{ startDate:"2026-09-18",endDate:"2026-09-21",distribution:"per_day",minutes:120 });
    ready(snapshot,proposal);
    expect(proposal.sessions.map(s=>localDate(s.start,DEFAULT_SETTINGS.timeZone))).toEqual(["2026-09-18","2026-09-21"]);
    expect(proposal.items[0].dailyPlan).toBeUndefined();
  });
  it("uses configured weekdays rather than hard-coding Monday to Friday", () => {
    const snapshot=existing(); snapshot.settings.weekdays=[2,4];
    const proposal=fit(snapshot,{ endDate:"2026-09-18",distribution:"per_day" });
    ready(snapshot,proposal);
    expect(proposal.sessions.map(s=>localDate(s.start,DEFAULT_SETTINGS.timeZone))).toEqual(["2026-09-15","2026-09-17"]);
  });
  it("fails all days if one requested daily booking cannot fit", () => {
    const snapshot=existing(); snapshot.blocks=[{ id:"closed",title:"Fictional closure",start:at(addDays(day,1),"09:00"),end:at(addDays(day,1),"17:00"),kind:"time_off" }];
    const proposal=fit(snapshot,{ endDate:addDays(day,2),distribution:"per_day" });
    expect(proposal.conflicts[0]).toMatchObject({ code:"smart_fit_capacity",message:expect.stringContaining(addDays(day,1)) });
    expect(proposal.sessions).toEqual([]); expect(proposal.items).toEqual(snapshot.items);
  });
  it("does not borrow lower-priority bookings or extend beyond the selected day", () => {
    const snapshot=existing({priorityId:"urgent"});
    snapshot.items.push(item({id:"other",priorityId:"low",estimatedMinutes:450,remainingMinutes:450}));
    snapshot.sessions=[session("morning","09:00","12:00",{workItemId:"other"}),session("afternoon","12:30","17:00",{workItemId:"other"})];
    const proposal=fit(snapshot);
    expect(proposal.conflicts[0].code).toBe("smart_fit_capacity"); expect(proposal.sessions).toEqual(snapshot.sessions);
  });
  it("splits hours between free openings despite legacy focus metadata", () => {
    const snapshot=existing({minimumSessionMinutes:120});
    snapshot.blocks=[{id:"am",title:"Morning meeting",start:at(day,"09:00"),end:at(day,"11:00"),kind:"meeting"},{id:"pm",title:"Afternoon meeting",start:at(day,"13:30"),end:at(day,"17:00"),kind:"meeting"}];
    const proposal=fit(snapshot); ready(snapshot,proposal);
    expect(proposal.sessions.map(session=>minutesBetween(session.start,session.end))).toEqual([60,60]);
  });
  it("respects persisted reserve settings", () => {
    const snapshot=existing(); snapshot.settings.reserveMinutes=60;
    expect(fit(snapshot,{minutes:450}).conflicts[0].code).toBe("smart_fit_capacity");
    ready(snapshot,fit(snapshot,{minutes:390}));
  });
  it("skips elapsed time today and never creates past sessions", () => {
    const snapshot=existing(); const proposal=fit(snapshot,{minutes:60},at(day,"14:07"));
    expect(proposal.status).toBe("ready"); expect(proposal.sessions[0].start).toBe(at(day,"14:15"));
    expect(fit(snapshot,{minutes:60},at(day,"16:30")).status).toBe("infeasible");
    expect(fit(snapshot,{distribution:"per_day",startDate:"2026-09-08"},now).status).toBe("infeasible");
  });
  it("enforces allowed dates, earliest start, and firm deadline without editing them", () => {
    for (const patch of [{dateConstraints:{earliestStart:null,allowedDates:[addDays(day,1)]}},{dateConstraints:{earliestStart:addDays(day,1),allowedDates:[]}},{deadline:addDays(day,-1)}]) {
      const snapshot=existing(patch); const proposal=fit(snapshot);
      expect(proposal.conflicts[0].code).toBe("outside_allowed_dates"); expect(proposal.items).toEqual(snapshot.items);
    }
  });
  it("does not book outside a narrow allowed date within a wider chosen range", () => {
    const snapshot=existing({dateConstraints:{earliestStart:null,allowedDates:[addDays(day,1)]}});
    const proposal=fit(snapshot,{endDate:addDays(day,2)}); ready(snapshot,proposal);
    expect(localDate(proposal.sessions[0].start,DEFAULT_SETTINGS.timeZone)).toBe(addDays(day,1));
    expect(fit(snapshot,{endDate:addDays(day,2),distribution:"per_day"}).conflicts[0].code).toBe("outside_allowed_dates");
  });
  it("fails a weekend-only range instead of moving it to Monday", () => {
    expect(fit(existing(),{startDate:"2026-09-19",endDate:"2026-09-20"}).conflicts[0].code).toBe("smart_fit_dates");
  });
});

describe("new smart-fit work and validation", () => {
  it("does not turn a new task's initial chosen dates into a permanent restriction", () => {
    const snapshot=state();
    const created=planCommands(snapshot,[{type:"create",item:item({estimatedMinutes:120,remainingMinutes:120}),smartFit:request({endDate:addDays(day,1)})}],owner,{now});
    ready(snapshot,created);
    expect(created.items[0].allowedDates).toEqual([]); expect(created.items[0].dateConstraints?.allowedDates ?? []).toEqual([]);
    const replanned=planCommands({...snapshot,items:created.items,sessions:created.sessions},[{type:"block",block:{id:"closed-range",title:"Fictional two-day closure",start:at(day,"09:00"),end:at(addDays(day,1),"17:00"),kind:"time_off"}}],owner,{now,approveDisplacement:true});
    ready(snapshot,replanned);
    expect(replanned.sessions.every(session=>localDate(session.start,DEFAULT_SETTINGS.timeZone)<day||localDate(session.start,DEFAULT_SETTINGS.timeZone)>addDays(day,1))).toBe(true);
  });
  it("respects deliberate allowed dates during placement without narrowing the saved restriction", () => {
    const snapshot=state();
    const proposal=planCommands(snapshot,[{type:"create",item:item({estimatedMinutes:120,remainingMinutes:120,dateConstraints:{earliestStart:null,allowedDates:[day,addDays(day,2),addDays(day,7)]}}),smartFit:request({endDate:addDays(day,3)})}],owner,{now});
    ready(snapshot,proposal);
    expect(proposal.items[0].dateConstraints?.allowedDates).toEqual([day,addDays(day,2),addDays(day,7)]);
  });
  it.each([{estimatedMinutes:null,remainingMinutes:null},{estimatedMinutes:600,remainingMinutes:600}])("does not turn an ongoing project's initial chunk into a permanent date restriction: %j", effort => {
    const snapshot=state();
    const created=planCommands(snapshot,[{type:"create",item:item(effort),smartFit:request()}],owner,{now});
    ready(snapshot,created);
    expect(created.items[0].allowedDates).toEqual([]);
    const appended=fit({...snapshot,items:created.items,sessions:created.sessions},{startDate:addDays(day,1),endDate:addDays(day,1)});
    ready(snapshot,appended);
    expect(appended.items[0].allowedDates).toEqual([]);
    expect(localDate(appended.sessions.at(-1)!.start,DEFAULT_SETTINGS.timeZone)).toBe(addDays(day,1));
  });
  it.each([owner,requester])("creates only the requested clean-fit sessions for $role", actor => {
    const snapshot=state(); const work=item({estimatedMinutes:600,remainingMinutes:600});
    const proposal=planCommands(snapshot,[{type:"create",item:work,smartFit:request()}],actor,{now});
    ready(snapshot,proposal); expect(proposal.sessions.reduce((total,s)=>total+minutesBetween(s.start,s.end),0)).toBe(120);
    expect(proposal.items[0].requesterId).toBe(actor.id);
  });
  it("retains per-day amounts for new work without inventing an unknown estimate", () => {
    const snapshot=state(); const proposal=planCommands(snapshot,[{type:"create",item:item({minimumSessionMinutes:120}),smartFit:request({endDate:addDays(day,4),distribution:"per_day",minutes:60})}],owner,{now});
    ready(snapshot,proposal);
    expect(proposal.items[0].dailyPlan).toEqual(Array.from({length:5},(_,i)=>({date:addDays(day,i),minutes:60})));
    expect(proposal.items[0].remainingMinutes).toBeNull(); expect(proposal.sessions).toHaveLength(5);
  });
  it("does not permit requester unknown estimates", () => {
    expect(planCommands(state(),[{type:"create",item:item(),smartFit:request()}],requester,{now}).conflicts[0].code).toBe("missing_estimate");
  });
  it("rejects override permissions and exact sessions in smart create", () => {
    for (const extra of [{urgent:true},{overrideProtected:true},{overrideDeadline:true},{sessions:[]}])
      expect(planCommands(state(),[{type:"create",item:item(),smartFit:request(),...extra}],owner,{now}).conflicts[0].code).toBe("smart_fit_override");
  });
  it("processes multiple smart additions atomically and checks their combined capacity", () => {
    const commands:WorkCommand[]=[{type:"create",item:item(),smartFit:request({minutes:300})},{type:"create",item:item({id:"second"}),smartFit:request({minutes:300})}];
    const proposal=planCommands(state(),commands,owner,{now}); expect(proposal.status).toBe("infeasible"); expect(proposal.items).toEqual([]); expect(proposal.sessions).toEqual([]);
  });
  it.each([{minutes:0},{minutes:-15},{minutes:17},{minutes:100_005},{startDate:"2026-02-30"},{endDate:"2026-09-13"},{endDate:addDays(day,366)},{distribution:"other"},{distribution:"per_day",minutes:495},{resumeWaiting:"yes"},{overrideProtected:true}])("rejects invalid or unsupported smart-fit input %j", patch => {
    const invalid={...request(),...patch};
    expect(smartFitRequestSchema.safeParse(invalid).success).toBe(false);
    const proposal=planCommands(existing(),[{type:"fit",itemId:"sample-work",request:invalid} as WorkCommand],owner,{now});
    expect(proposal.conflicts[0].code).toBe("invalid_smart_fit");
  });
  it("enforces the cumulative limit for daily budgets", () => {
    const proposal=fit(existing(),{endDate:addDays(day,365),distribution:"per_day",minutes:480});
    expect(proposal.conflicts[0].code).toBe("invalid_smart_fit");
  });
  it("validates new commands at the normal server request boundary", () => {
    const command={type:"fit",itemId:"sample-work",request:request()};
    expect(commandSchema.safeParse(command).success).toBe(true);
    expect(commandRequestSchema.safeParse({commands:[command],operationId:"test-fit",baseVersion:4,action:"preview"}).success).toBe(true);
    expect(commandSchema.safeParse({...command,overrideProtected:true}).success).toBe(false);
  });
});
