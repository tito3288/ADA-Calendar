import { describe, expect, it } from "vitest";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { planCommands, validateSchedule } from "./scheduler";
import { commandSchema, sessionSchema } from "./schemas";
import { localDate, localDateTime, minutesBetween } from "./time";
import type { Actor, ScheduleSnapshot, WorkCommand, WorkItem, WorkSession } from "./types";
import { newWorkItem } from "./work";

// Fictional records, no database or model calls.
const owner:Actor={id:"fixture-owner",name:"Fixture owner",email:"owner@example.test",role:"owner"};
const date="2026-09-09", next="2026-09-10", now=localDateTime(date,"08:00",DEFAULT_SETTINGS.timeZone);
const at=(clock:string,day=date)=>localDateTime(day,clock,DEFAULT_SETTINGS.timeZone);
function work(patch:Partial<WorkItem>={}) {
  return newWorkItem(owner,"2026-09-01",{id:"build",clientId:"fixture-client",title:"Fictional build",category:"web",webKind:"build",estimatedMinutes:600,remainingMinutes:600,minimumSessionMinutes:120,
    windowEnd:"2026-12-31",description:"Saved project context",references:["https://example.test"],...patch});
}
function session(id="one",start="09:00",end="11:00",patch:Partial<WorkSession>={}):WorkSession {
  return {id,workItemId:"build",start:at(start),end:at(end),protected:false,status:"planned",usesReserve:false,...patch};
}
function state(patch:Partial<WorkItem>={}):ScheduleSnapshot {
  return {workspaceId:"booking-fixture",version:2,settings:{...DEFAULT_SETTINGS,reserveMinutes:0},clients:[{id:"fixture-client",name:"Fictional client",aliases:[]}],priorities:structuredClone(DEFAULT_PRIORITIES),items:[work(patch)],sessions:[session()],blocks:[]};
}
const resize=(minutes:number):WorkCommand=>({type:"resize_booking",sessionId:"one",minutes});
const move=(day=next,minutes?:number,startTime?:string):WorkCommand=>({type:"move_booking",sessionId:"one",date:day,...(minutes===undefined?{}:{minutes}),...(startTime?{startTime}:{})});
const add=(minutes=60,startDate=next,endDate=startDate,distribution:"total"|"per_day"="total"):WorkCommand=>({type:"add_booking",itemId:"build",request:{startDate,endDate,minutes,distribution}});
function plan(snapshot:ScheduleSnapshot,command:WorkCommand,clock=now,actor=owner,operationId="booking-operation") {
  return planCommands(snapshot,[command],actor,{now:clock,operationId,approveDisplacement:true});
}
function ready(snapshot:ScheduleSnapshot,proposal:ReturnType<typeof plan>) {
  expect(proposal.status,JSON.stringify(proposal.conflicts)).toBe("ready");
  expect(validateSchedule({...snapshot,...proposal},now)).toEqual([]);
  expect(proposal.blocks).toEqual(snapshot.blocks);
  expect(proposal.items[0]).toMatchObject({estimatedMinutes:snapshot.items[0].estimatedMinutes,remainingMinutes:snapshot.items[0].remainingMinutes,minimumSessionMinutes:snapshot.items[0].minimumSessionMinutes,
    windowStart:snapshot.items[0].windowStart,windowEnd:snapshot.items[0].windowEnd,description:snapshot.items[0].description,references:snapshot.items[0].references});
}
describe("explicit booking edits without project edits",()=>{
  it("reduces a 2h build to1h without claiming completion, refilling it, or rewriting legacy focus metadata",()=>{
    const snapshot=state(), before=structuredClone(snapshot), proposal=plan(snapshot,resize(60)); ready(snapshot,proposal);
    expect(snapshot).toEqual(before); expect(proposal.sessions).toHaveLength(1);
    expect(proposal.sessions[0]).toEqual({...snapshot.sessions[0],end:at("10:00")});
    expect(proposal.items[0]).toMatchObject({remainingMinutes:600,estimatedMinutes:600,status:"planned",minimumSessionMinutes:120,forecastDate:null});
    expect(proposal.summary.join(" ")).toContain("not completed work");
    expect(proposal.sessions[0].focusOverrideMinutes).toBeUndefined();
  });
  it("preserves all unrelated sessions and existing estimates on add",()=>{
    const snapshot=state(); snapshot.items.push(work({id:"other",title:"Other work",remainingMinutes:60,estimatedMinutes:60,minimumSessionMinutes:60}));
    snapshot.sessions.push(session("other","09:00","10:00",{workItemId:"other",start:at("09:00",next),end:at("10:00",next),protected:true}));
    const proposal=plan(snapshot,add()); ready(snapshot,proposal);
    expect(proposal.sessions.slice(0,2)).toEqual(snapshot.sessions); expect(proposal.items[1]).toEqual(snapshot.items[1]);
    expect(proposal.sessions[2]).toMatchObject({start:at("10:00",next),end:at("11:00",next)});
  });
  it("preserves a previously valid short final remainder when an earlier booking shrinks",()=>{
    const snapshot=state({estimatedMinutes:180,remainingMinutes:180}); snapshot.sessions.push(session("remainder","11:00","12:00"));
    expect(validateSchedule(snapshot,now)).toEqual([]);
    const proposal=plan(snapshot,resize(60)); ready(snapshot,proposal);
    expect(proposal.sessions[1]).toEqual({...snapshot.sessions[1]});
    expect(proposal.sessions[1].focusOverrideMinutes).toBeUndefined();
    expect(proposal.items[0].remainingMinutes).toBe(180);
  });
  it("keeps short protected reservations unchanged without manufacturing focus metadata",()=>{
    const snapshot=state({estimatedMinutes:180,remainingMinutes:180}); snapshot.sessions.push(session("remainder","11:00","12:00",{protected:true}));
    const proposal=plan(snapshot,resize(60)); ready(snapshot,proposal);
    expect(proposal.sessions[1]).toEqual(snapshot.sessions[1]);
    expect(proposal.sessions.every(session=>session.focusOverrideMinutes===undefined)).toBe(true);
    snapshot.sessions[0].protected=true;
    expect(plan(snapshot,resize(60)).conflicts[0].code).toBe("protected_session");
  });
  it("preserves unknown-total existing short bookings when adding a later booking on the same day",()=>{
    const snapshot=state({estimatedMinutes:null,remainingMinutes:null}); snapshot.sessions=[session("short","09:00","10:00")];
    expect(validateSchedule(snapshot,now)).toEqual([]);
    const proposal=plan(snapshot,add(120,date)); ready(snapshot,proposal);
    expect(proposal.sessions[0]).toEqual({...snapshot.sessions[0]});
    expect(proposal.items[0].remainingMinutes).toBeNull();
  });
  it("keeps a deliberate partial reservation when the existing manual move workflow is used later",()=>{
    const snapshot=state({estimatedMinutes:240,remainingMinutes:240}); snapshot.sessions.push(session("two","12:30","14:30"));
    const reduced=plan(snapshot,resize(60)); ready(snapshot,reduced);
    const after={...snapshot,items:reduced.items,sessions:reduced.sessions};
    const moved=plan(after,{type:"move",sessionId:"two",start:at("09:00",next),end:at("11:00",next)}); ready(after,moved);
    expect(moved.sessions).toHaveLength(2); expect(moved.sessions[0]).toEqual(reduced.sessions[0]);
    expect(moved.sessions[1]).toEqual({...reduced.sessions[1],start:at("09:00",next),end:at("11:00",next)});
    expect(moved.sessions.reduce((sum,s)=>sum+minutesBetween(s.start,s.end),0)).toBe(180);
    expect(moved.items[0]).toMatchObject({remainingMinutes:240,minimumSessionMinutes:120,forecastDate:null});
  });
  it("rejects invalid explicit manual destinations without deleting or refilling a partial reservation",()=>{
    const snapshot=state({dateConstraints:{earliestStart:null,allowedDates:[date]}});
    const failed=plan(snapshot,{type:"move",sessionId:"one",start:at("09:00",next),end:at("11:00",next)});
    expect(failed.status).toBe("infeasible"); expect(failed.sessions).toEqual(snapshot.sessions);
  });
  it("extends in place when the same start remains available",()=>{
    const snapshot=state(),proposal=plan(snapshot,resize(180)); ready(snapshot,proposal);
    expect(proposal.sessions[0]).toEqual({...snapshot.sessions[0],end:at("12:00")});
  });
  it("smart-fits a larger whole booking around a conflict rather than moving the other task",()=>{
    const snapshot=state(); snapshot.blocks=[{id:"meeting",title:"Meeting",start:at("11:00"),end:at("12:00"),kind:"meeting"}];
    const proposal=plan(snapshot,resize(180)); ready(snapshot,proposal);
    expect(proposal.sessions[0]).toMatchObject({id:"one",start:at("12:30"),end:at("15:30")});
  });
  it("keeps whole-session ID and total hours when moving to tomorrow",()=>{
    const snapshot=state(),proposal=plan(snapshot,move()); ready(snapshot,proposal);
    expect(proposal.sessions).toHaveLength(1); expect(proposal.sessions[0]).toEqual({...snapshot.sessions[0],start:at("09:00",next),end:at("11:00",next)});
  });
  it("splits only explicitly transferred hours and retains the original source ID",()=>{
    const snapshot=state(),proposal=plan(snapshot,move(next,60)); ready(snapshot,proposal);
    expect(proposal.sessions[0]).toMatchObject({id:"one",start:at("09:00"),end:at("10:00")});
    expect(proposal.sessions[1]).toMatchObject({workItemId:"build",start:at("09:00",next),end:at("10:00",next)});
    expect(proposal.sessions[1].id).not.toBe("one");
    expect(proposal.sessions.reduce((n,s)=>n+minutesBetween(s.start,s.end),0)).toBe(120);
    expect(plan(snapshot,move(next,60)).sessions).toEqual(proposal.sessions);
  });
  it("uses deterministic new identities across repeated previews and different identities for different operations",()=>{
    const snapshot=state(),first=plan(snapshot,add()),second=plan(snapshot,add());
    expect(first.sessions).toEqual(second.sessions);
    expect(plan(snapshot,add(),now,owner,"another-operation").sessions[1].id).not.toBe(first.sessions[1].id);
    expect(sessionSchema.safeParse(first.sessions[1]).success).toBe(true);
  });
  it("rejects an ID collision instead of replacing an existing booking",()=>{
    const snapshot=state(),first=plan(snapshot,add());
    snapshot.sessions.push({...first.sessions[1],start:at("13:00",next),end:at("14:00",next)});
    const failed=plan(snapshot,add()); expect(failed.status).toBe("infeasible"); expect(failed.sessions).toEqual(snapshot.sessions);
    expect(failed.conflicts[0].message).toContain("identifier already exists");
  });
  it("honors an explicit destination clock and never substitutes a different clock",()=>{
    const snapshot=state(),proposal=plan(snapshot,move(next,undefined,"10:00")); ready(snapshot,proposal);
    expect(proposal.sessions[0].start).toBe(at("10:00",next));
    snapshot.blocks=[{id:"busy",title:"Busy",start:at("10:00",next),end:at("11:00",next),kind:"meeting"}];
    const failed=plan(snapshot,move(next,undefined,"10:00")); expect(failed.conflicts[0].code).toBe("booking_capacity"); expect(failed.sessions).toEqual(snapshot.sessions);
  });
  it("supports same-day clock moves and validates exact slot alignment",()=>{
    const snapshot=state(),proposal=plan(snapshot,move(date,undefined,"13:00")); ready(snapshot,proposal); expect(proposal.sessions[0].start).toBe(at("13:00"));
    const failed=plan(snapshot,move(date,undefined,"13:07")); expect(failed.status).toBe("infeasible"); expect(failed.sessions).toEqual(snapshot.sessions);
  });
  it("never splits a moved whole session just because separated gaps sum to its duration",()=>{
    const snapshot=state(); snapshot.blocks=[{id:"am",title:"AM",start:at("09:00",next),end:at("11:00",next),kind:"meeting"},{id:"pm",title:"PM",start:at("13:30",next),end:at("17:00",next),kind:"meeting"}];
    const failed=plan(snapshot,move()); expect(failed.conflicts[0].code).toBe("booking_capacity"); expect(failed.sessions).toEqual(snapshot.sessions);
  });
  it("books a range total only once and daily hours separately on each working day",()=>{
    const snapshot=state({remainingMinutes:null,estimatedMinutes:null}); snapshot.sessions=[];
    const total=plan(snapshot,add(600,"2026-09-14","2026-09-18")); ready(snapshot,total);
    expect(total.sessions.reduce((n,s)=>n+minutesBetween(s.start,s.end),0)).toBe(600);
    const daily=plan(snapshot,add(60,"2026-09-14","2026-09-18","per_day")); ready(snapshot,daily);
    expect(daily.sessions.map(s=>[localDate(s.start,snapshot.settings.timeZone),minutesBetween(s.start,s.end)])).toEqual([14,15,16,17,18].map(day=>[`2026-09-${day}`,60]));
  });
  it("requires explicit waiting resume and keeps unknown estimates unknown",()=>{
    const snapshot=state({status:"waiting",estimatedMinutes:null,remainingMinutes:null,blockedReason:"Awaiting input"}); snapshot.sessions=[];
    expect(plan(snapshot,add()).conflicts[0].code).toBe("booking_waiting");
    const command=add(); if(command.type!=="add_booking") throw new Error(); command.request.resumeWaiting=true;
    const proposal=plan(snapshot,command); ready(snapshot,proposal);
    expect(proposal.items[0]).toMatchObject({status:"planned",blockedReason:null,estimatedMinutes:null,remainingMinutes:null});
    expect(proposal.summary[0]).toContain("Resume");
  });
  it.each(["completed","cancelled"] as const)("does not reopen %s projects",status=>{
    const snapshot=state({status}); snapshot.sessions=[]; const command=add(); if(command.type!=="add_booking") throw new Error(); command.request.resumeWaiting=true;
    expect(plan(snapshot,command).conflicts[0].code).toBe("inactive_work");
  });
  it("does not exceed a known remaining estimate for either additions or extensions",()=>{
    const snapshot=state({remainingMinutes:120,estimatedMinutes:120});
    for(const command of [add(),resize(180)]) {const failed=plan(snapshot,command); expect(failed.conflicts[0].code).toBe("booking_effort"); expect(failed.sessions).toEqual(snapshot.sessions); expect(failed.items).toEqual(snapshot.items);}
  });
  it("adjusts source/destination daily quotas explicitly while preserving other days",()=>{
    const snapshot=state({dailyPlan:[{date,minutes:120},{date:next,minutes:120},{date:"2026-09-11",minutes:120}]});
    snapshot.sessions.push(session("next","09:00","11:00",{start:at("09:00",next),end:at("11:00",next)}));
    const proposal=plan(snapshot,move(next,60)); ready(snapshot,proposal);
    expect(proposal.items[0].dailyPlan).toEqual([{date,minutes:60},{date:next,minutes:180},{date:"2026-09-11",minutes:120}]);
    expect(proposal.summary.join(" ")).toContain("Daily booking plan");
  });
  it("removes only an emptied source-day quota when moving the full booking",()=>{
    const snapshot=state({dailyPlan:[{date,minutes:120},{date:"2026-09-11",minutes:120}]});
    const proposal=plan(snapshot,move()); ready(snapshot,proposal);
    expect(proposal.items[0].dailyPlan).toEqual([{date:next,minutes:120},{date:"2026-09-11",minutes:120}]);
  });
  it("reduces a daily quota with a shortened booking without reducing project remaining hours",()=>{
    const snapshot=state({dailyPlan:[{date,minutes:120}]}); const proposal=plan(snapshot,resize(60)); ready(snapshot,proposal);
    expect(proposal.items[0].dailyPlan).toEqual([{date,minutes:60}]); expect(proposal.items[0].remainingMinutes).toBe(600);
  });
  it("fills an unused daily quota before increasing it",()=>{
    const snapshot=state({remainingMinutes:240,estimatedMinutes:240,dailyPlan:[{date,minutes:240}]});
    const proposal=plan(snapshot,add(60,date)); ready(snapshot,proposal); expect(proposal.items[0].dailyPlan).toEqual([{date,minutes:240}]);
  });
  it("does not silently exceed remaining effort through increased daily commitments",()=>{
    const snapshot=state({remainingMinutes:240,estimatedMinutes:240,dailyPlan:[{date,minutes:240}]});
    const proposal=plan(snapshot,add()); expect(proposal.conflicts[0].code).toBe("daily_hours_total"); expect(proposal.items).toEqual(snapshot.items);
  });
  it.each([{dateConstraints:{earliestStart:null,allowedDates:[date]}},{deadline:date},{dateConstraints:{earliestStart:"2026-09-11",allowedDates:[]}}])("keeps earliest/allowed/deadline boundaries unchanged",patch=>{
    const snapshot=state(patch); const failed=plan(snapshot,move()); expect(failed.conflicts[0].code).toBe("outside_allowed_dates"); expect(failed.sessions).toEqual(snapshot.sessions);
  });
  it("respects saved reserve capacity and never adopts reserve permission",()=>{
    const snapshot=state({estimatedMinutes:null,remainingMinutes:null}); snapshot.sessions=[]; snapshot.settings.reserveMinutes=60;
    expect(plan(snapshot,add(450,next)).conflicts[0].code).toBe("booking_capacity");
    const accepted=plan(snapshot,add(390,next)); ready(snapshot,accepted); expect(accepted.sessions.every(s=>!s.usesReserve)).toBe(true);
  });
  it("does not transfer existing reserve-use authority to another day",()=>{
    const snapshot=state(); snapshot.sessions[0].usesReserve=true;
    for(const command of [resize(60),move()]) expect(plan(snapshot,command).conflicts[0].code).toBe("booking_reserve");
  });
  it("respects protected sessions and explicit owner override",()=>{
    const snapshot=state(); snapshot.sessions[0].protected=true;
    expect(plan(snapshot,resize(60)).conflicts[0].code).toBe("protected_session");
    const proposal=plan(snapshot,{type:"resize_booking",sessionId:"one",minutes:60,overrideProtected:true}); ready(snapshot,proposal); expect(proposal.sessions[0].protected).toBe(true);
  });
  it("edits still-planned bookings after their start and never places new work into elapsed time",()=>{
    const snapshot=state(); ready(snapshot,plan(snapshot,resize(60),at("09:01")));
    ready(snapshot,plan(snapshot,move(),at("09:01")));
    const future=plan(snapshot,add(60,date),at("11:07")); ready(snapshot,future); expect(future.sessions[1].start).toBe(at("11:15")); expect(future.sessions[1].end).toBe(at("12:00")); expect(future.sessions[2].start).toBe(at("12:30"));
    snapshot.sessions[0].status="completed"; expect(plan(snapshot,resize(60)).conflicts[0].code).toBe("historical_session");
  });
  it.each(["requester","viewer"] as const)("rejects %s booking edits",role=>{
    for(const command of [resize(60),move(),add()]) expect(plan(state(),command,now,{...owner,role}).conflicts[0].code).toBe("forbidden");
  });
  it("rejects requester-forged short-focus metadata on new work",()=>{
    const snapshot=state(); snapshot.items=[];snapshot.sessions=[];
    const proposal=plan(snapshot,{type:"create",item:work({remainingMinutes:60,estimatedMinutes:60}),sessions:[session("forged","09:00","10:00",{focusOverrideMinutes:15})]},now,{...owner,role:"requester"});
    expect(proposal.conflicts[0].code).toBe("forbidden");
  });
  it("validates per-session focus overrides and keeps them effective on later reorders",()=>{
    const snapshot=state(); const resized=plan(snapshot,resize(60)); const updated={...snapshot,...resized};
    const proposal=planCommands(updated,[{type:"reorder_day",date,sessionIds:["one"]}],owner,{now}); expect(proposal.status).toBe("ready");
    for(const invalid of [-1,0,1.5,14,601]) {const broken=structuredClone(updated);broken.sessions[0].focusOverrideMinutes=invalid;expect(validateSchedule(broken,now).some(c=>c.code==="invalid_focus_override")).toBe(true);}
  });
  it("fails a whole daily range atomically if a later day cannot fit",()=>{
    const snapshot=state();snapshot.blocks=[{id:"closed",title:"Unavailable",start:at("09:00",next),end:at("17:00",next),kind:"time_off"}];
    const proposal=plan(snapshot,add(60,date,next,"per_day")); expect(proposal.status).toBe("infeasible");expect(proposal.sessions).toEqual(snapshot.sessions);expect(proposal.items).toEqual(snapshot.items);
  });
  it("rejects zero, excess transfer, and mixed batches without deletion or partial writes",()=>{
    const snapshot=state(); expect(commandSchema.safeParse(resize(0)).success).toBe(false); expect(commandSchema.safeParse(move(next,0)).success).toBe(false);
    expect(plan(snapshot,move(next,180)).conflicts[0].code).toBe("booking_transfer_hours");
    for(const other of [resize(60),{type:"status",itemId:"build",status:"completed"},{type:"reorder_day",date,sessionIds:["one"]}] as WorkCommand[]) {
      const proposal=planCommands(snapshot,[resize(60),other],owner,{now});expect(proposal.conflicts[0].code).toBe("booking_mixed_commands");expect(proposal.sessions).toEqual(snapshot.sessions);
    }
  });
});
