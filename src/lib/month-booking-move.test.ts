import { describe, expect, it } from "vitest";
import { DEFAULT_PRIORITIES, DEFAULT_SETTINGS } from "./defaults";
import { planCommands, validateSchedule } from "./scheduler";
import { commandSchema } from "./schemas";
import { localDateTime, minutesBetween } from "./time";
import type { Actor, ScheduleSnapshot, WorkCommand, WorkItem, WorkSession } from "./types";
import { newWorkItem } from "./work";

// Fictional isolated scheduler fixtures; no providers, DB, or real client data.
const owner:Actor={id:"owner",name:"Fixture owner",email:"owner@example.test",role:"owner"};
const source="2026-09-09",destination="2026-09-10",zone=DEFAULT_SETTINGS.timeZone;
const at=(clock:string,date=source)=>localDateTime(date,clock,zone),now=at("08:00");
const item=(patch:Partial<WorkItem>={})=>newWorkItem(owner,"2026-09-01",{id:"site",title:"Fictional website",clientId:"client",estimatedMinutes:600,remainingMinutes:600,minimumSessionMinutes:60,windowEnd:"2026-09-30",description:"Existing scope",references:["https://example.test"],...patch});
const booking=(id:string,start:string,end:string,patch:Partial<WorkSession>={}):WorkSession=>({id,workItemId:"site",start:at(start),end:at(end),status:"planned",protected:false,usesReserve:false,...patch});
const snapshot=(patch:Partial<WorkItem>={}):ScheduleSnapshot=>({workspaceId:"month-move-fixture",version:3,settings:{...DEFAULT_SETTINGS,reserveMinutes:0},clients:[{id:"client",name:"Fictional client",aliases:[]}],priorities:structuredClone(DEFAULT_PRIORITIES),items:[item(patch)],sessions:[booking("first","09:00","10:00"),booking("second","10:00","11:00")],blocks:[]});
const command=(ids=["first","second"],date=destination):Extract<WorkCommand,{type:"move_bookings"}>=>({type:"move_bookings",sessionIds:ids,date});
const plan=(state:ScheduleSnapshot,cmd:WorkCommand=command(),actor=owner,clock=now)=>planCommands(state,[cmd],actor,{now:clock,operationId:"month-move-op"});
function ready(state:ScheduleSnapshot,result:ReturnType<typeof plan>){
  expect(result.status,JSON.stringify(result.conflicts)).toBe("ready");expect(validateSchedule({...state,...result},now)).toEqual([]);
  expect(result.sessions.map(s=>s.id)).toEqual(expect.arrayContaining(state.sessions.map(s=>s.id)));
  expect(result.sessions.reduce((sum,s)=>sum+minutesBetween(s.start,s.end),0)).toEqual(state.sessions.reduce((sum,s)=>sum+minutesBetween(s.start,s.end),0));
  expect(result.items[0]).toMatchObject({estimatedMinutes:state.items[0].estimatedMinutes,remainingMinutes:state.items[0].remainingMinutes,windowStart:state.items[0].windowStart,windowEnd:state.items[0].windowEnd,deadline:state.items[0].deadline,allowedDates:state.items[0].allowedDates,minimumSessionMinutes:state.items[0].minimumSessionMinutes,description:state.items[0].description,references:state.items[0].references});
  expect(result.blocks).toEqual(state.blocks);
}
function failed(state:ScheduleSnapshot,result:ReturnType<typeof plan>,code?:string){expect(result.status).toBe("infeasible");expect(result.sessions).toEqual(state.sessions);expect(result.items).toEqual(state.items);expect(result.blocks).toEqual(state.blocks);if(code)expect(result.conflicts[0].code).toBe(code);}

describe("atomic month-segment booking moves",()=>{
  it("moves a project's two bookings into the next open times and preserves other work",()=>{
    const state=snapshot(),before=structuredClone(state);state.items.push(item({id:"other",title:"Other project",remainingMinutes:60,estimatedMinutes:60}));
    state.sessions.push(booking("other","09:00","10:00",{workItemId:"other",start:at("09:00",destination),end:at("10:00",destination),protected:true}));
    const result=plan(state);ready(state,result);
    expect(result.sessions[0]).toEqual({...before.sessions[0],start:at("10:00",destination),end:at("11:00",destination)});
    expect(result.sessions[1]).toEqual({...before.sessions[1],start:at("11:00",destination),end:at("12:00",destination)});
    expect(result.sessions[2]).toEqual(state.sessions[2]);expect(result.items[1]).toEqual(state.items[1]);expect(result.affectedItemIds).toEqual(["site"]);
    expect(state.sessions.slice(0,2)).toEqual(before.sessions);
  });
  it("keeps a single two-hour session whole and behaves like move_booking",()=>{
    const state=snapshot();state.sessions=[booking("first","09:00","11:00")];
    const result=plan(state,command(["first"])),single=plan(state,{type:"move_booking",sessionId:"first",date:destination});ready(state,result);
    expect(result.sessions).toEqual(single.sessions);expect(result.items).toEqual(single.items);
  });
  it("splits a booked day around lunch even when its source was one session",()=>{
    const state=snapshot();state.blocks=[{id:"morning",title:"Morning meeting",kind:"meeting",start:at("09:00",destination),end:at("11:00",destination)}];
    const result=plan(state);ready(state,result);
    expect(result.sessions.map(s=>[s.start,s.end])).toEqual([[at("11:00",destination),at("12:00",destination)],[at("12:30",destination),at("13:30",destination)]]);
    state.sessions=[booking("first","09:00","11:00")];state.blocks.push({id:"afternoon",title:"Afternoon meeting",kind:"meeting",start:at("13:30",destination),end:at("17:00",destination)});
    const split=plan(state,command(["first"]));ready(state,split);
    expect(split.sessions.map(s=>[s.start,s.end])).toEqual([[at("11:00",destination),at("12:00",destination)],[at("12:30",destination),at("13:30",destination)]]);
  });
  it("preserves order while splitting a longer booking between remaining gaps",()=>{
    const state=snapshot();state.sessions=[booking("short","09:00","10:00"),booking("long","10:00","12:00")];
    state.blocks=[{id:"late-am",title:"Meeting",kind:"meeting",start:at("11:00",destination),end:at("12:00",destination)},{id:"afternoon",title:"Meeting",kind:"meeting",start:at("13:30",destination),end:at("17:00",destination)}];
    const result=plan(state,command(["short","long"]));ready(state,result);
    expect(result.sessions.map(s=>[s.start,s.end])).toEqual([[at("09:00",destination),at("10:00",destination)],[at("10:00",destination),at("11:00",destination)],[at("12:30",destination),at("13:30",destination)]]);
  });
  it("fills fragmented gaps in original order with stable fragment IDs",()=>{
    const state=snapshot({minimumSessionMinutes:15});state.sessions=[booking("75","09:00","10:15"),booking("60","10:15","11:15"),booking("30","11:15","11:45")];
    state.blocks=[{id:"late-am",title:"Meeting",kind:"meeting",start:at("10:30",destination),end:at("12:00",destination)},{id:"afternoon",title:"Meeting",kind:"meeting",start:at("13:45",destination),end:at("17:00",destination)}];
    const result=plan(state,command(["75","60","30"]));ready(state,result);
    expect(result.sessions.slice(0,3).map(s=>[s.id,s.start,s.end])).toEqual([["75",at("09:00",destination),at("10:15",destination)],["60",at("10:15",destination),at("10:30",destination)],["30",at("13:15",destination),at("13:45",destination)]]);
    expect(result.sessions[3]).toMatchObject({start:at("12:30",destination),end:at("13:15",destination)});
    expect(plan(state,command(["30","75","60"])).sessions).toEqual(result.sessions);
  });
  it("returns the complete original snapshot if only some bookings could fit",()=>{
    const state=snapshot();state.blocks=[{id:"busy-am",title:"Meeting",kind:"meeting",start:at("10:00",destination),end:at("12:00",destination)},{id:"busy-pm",title:"Meeting",kind:"meeting",start:at("12:30",destination),end:at("17:00",destination)}];
    failed(state,plan(state),"booking_capacity");
  });
  it("adjusts only source/destination daily quotas and leaves other project days unchanged",()=>{
    const later="2026-09-11",state=snapshot({dailyPlan:[{date:source,minutes:120},{date:destination,minutes:60},{date:later,minutes:120}]});
    state.sessions.push(booking("later","09:00","11:00",{start:at("09:00",later),end:at("11:00",later)}));
    const result=plan(state);ready(state,result);
    expect(result.items[0].dailyPlan).toEqual([{date:destination,minutes:120},{date:later,minutes:120}]);expect(result.sessions[2]).toEqual(state.sessions[2]);
    expect(result.summary.join(" ")).toContain("Daily booking plan");
  });
  it("supports unknown totals without setting estimates, and keeps booking-specific focus exceptions",()=>{
    const state=snapshot({estimatedMinutes:null,remainingMinutes:null,minimumSessionMinutes:120});state.sessions=state.sessions.map(s=>({...s,focusOverrideMinutes:60}));
    const result=plan(state);ready(state,result);expect(result.sessions.every(s=>s.focusOverrideMinutes===60)).toBe(true);expect(result.items[0].forecastDate).toBeNull();
  });
  it("does not move a display-only ribbon or invent sessions",()=>{
    const state=snapshot({estimatedMinutes:null,remainingMinutes:null,status:"waiting",blockedReason:"Waiting for details"});state.sessions=[];
    failed(state,plan(state),"unknown_session");expect(commandSchema.safeParse(command([])).success).toBe(false);
  });
  it.each(["protected","usesReserve"] as const)("refuses the whole move if any selected booking uses %s",field=>{
    const state=snapshot();state.sessions[1][field]=true;failed(state,plan(state),field==="protected"?"protected_session":"booking_reserve");
  });
  it.each(["completed","cancelled"] as const)("refuses %s sessions",status=>{
    const state=snapshot();state.sessions[1].status=status;failed(state,plan(state),"historical_session");
  });
  it("moves still-planned bookings after their start time and refuses past destinations",()=>{
    const state=snapshot();ready(state,plan(state,command(),owner,at("09:01")));
    failed(state,plan(state,command(undefined,"2026-09-08")),"historical_session");
  });
  it.each(["waiting","completed","cancelled"] as const)("refuses inactive %s projects without resuming them",status=>{
    const state=snapshot({status});failed(state,plan(state),status==="waiting"?"booking_waiting":"inactive_work");
  });
  it("checks earliest start, allowed dates and firm deadline without altering the display span",()=>{
    for(const patch of [{dateConstraints:{earliestStart:null,allowedDates:[source]}},{deadline:source}]){const state=snapshot(patch);failed(state,plan(state),"outside_allowed_dates");}
    const state=snapshot({dateConstraints:{earliestStart:destination,allowedDates:[]}});state.sessions=state.sessions.map(s=>({...s,start:at("09:00","2026-09-11"),end:at("10:00","2026-09-11")}));
    failed(state,plan(state,command(undefined,source)),"outside_allowed_dates");
    const flexible=snapshot({windowEnd:source});const result=plan(flexible);ready(flexible,result);expect(result.items[0].windowEnd).toBe(source);
  });
  it("honors the persisted interruption reserve and unavailable workdays",()=>{
    const state=snapshot();state.settings.reserveMinutes=60;state.sessions=[booking("first","09:00","12:00"),booking("second","12:30","14:30"),booking("third","14:30","15:30")];
    state.blocks=[{id:"meeting",title:"Meeting",kind:"meeting",start:at("09:00",destination),end:at("10:00",destination)}];
    const move=command(["first","second","third"]);
    failed(state,plan(state,move),"booking_capacity");
    state.settings.reserveMinutes=0;ready(state,plan(state,move));failed(state,plan(state,{...move,date:"2026-09-12"}),"booking_capacity");
  });
  it("treats a drop on the original date as a nonmutating no-op after safety checks",()=>{
    const state=snapshot(),result=plan(state,command(undefined,source));expect(result.status).toBe("ready");expect(result.affectedItemIds).toEqual([]);expect(result.sessions).toEqual(state.sessions);expect(result.items).toEqual(state.items);
    state.sessions[1].protected=true;failed(state,plan(state,command(undefined,source)),"protected_session");
  });
  it("requires one project/source day, existing unique IDs, and a bounded strict command",()=>{
    const state=snapshot();state.items.push(item({id:"other"}));state.sessions[1].workItemId="other";failed(state,plan(state),"booking_group");
    state.sessions[1].workItemId="site";state.sessions[1].start=at("10:00",destination);state.sessions[1].end=at("11:00",destination);failed(state,plan(state),"booking_group");
    failed(state,plan(state,command(["first","missing"])),"unknown_session");
    for(const invalid of [command([]),command(["first","first"]),command(Array.from({length:101},(_,i)=>`s${i}`)),command(undefined,"2026-02-30"),{...command(),overrideProtected:true},{...command(),minutes:60},{...command(),startTime:"09:00"}])expect(commandSchema.safeParse(invalid).success).toBe(false);
  });
  it("refuses a stale subset if another planned booking was added to the same day before preview",()=>{
    const state=snapshot();state.sessions.push(booking("new-on-source","13:00","14:00"));
    failed(state,plan(state),"booking_group_changed");
    const result=plan(state,command(["first","second","new-on-source"]));ready(state,result);expect(result.sessions).toHaveLength(3);
  });
  it.each(["requester","viewer"] as const)("does not allow the %s role to move existing bookings",role=>{
    const state=snapshot();failed(state,plan(state,command(),{...owner,role}),"forbidden");
  });
  it("rejects mixed commands instead of partially moving a day",()=>{
    const state=snapshot(),result=planCommands(state,[command(),{type:"update",itemId:"site",patch:{title:"Changed"}}],owner,{now});failed(state,result,"booking_mixed_commands");
  });
});
