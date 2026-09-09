import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import { newWorkItem } from "./work";
import { localDateTime, minutesBetween } from "./time";
import type { AppState, ScheduleProposal, WorkCommand } from "./types";

// Every transaction uses local fictional fixtures. Never call live providers.
vi.mock("server-only",()=>({}));
vi.mock("next/headers",()=>({cookies:async()=>({get:()=>({value:"bryan"}),set:vi.fn()})}));
vi.mock("./server/supabase",()=>({getSupabaseAdminClient:vi.fn(()=>{throw new Error("No live database in month drag tests");}),getSupabaseServerClient:vi.fn(()=>{throw new Error("No live database in month drag tests");}),clearSupabaseSessionCookies:vi.fn()}));
vi.mock("./server/assistant",()=>({interpretInput:vi.fn(()=>{throw new Error("No model in month drag tests");}),assistantReservationUsd:vi.fn(()=>0),inspectAudioRecording:vi.fn(),transcribeAudio:vi.fn()}));
vi.mock("./server/service",async()=>{
  const demo=await import("./server/demo-store");
  return {currentActor:vi.fn(async()=>DEMO_MEMBERS[0]),demoEnabled:()=>true,store:{getState:vi.fn(async(id:string)=>demo.getDemoState(demo.demoActor(id))),commit:vi.fn(demo.commitDemoProposal),undo:vi.fn(demo.undoDemoEvent),request:vi.fn(demo.submitDemoRequest)}};
});
import { POST } from "../app/api/[...path]/route";
import { currentActor } from "./server/service";
import { demoTransaction, getDemoState } from "./server/demo-store";
import { readWorkspaceChatRecord } from "./server/workspace-chat";

const origin="http://localhost:3000",owner=DEMO_MEMBERS[0],source="2026-09-09",destination="2026-09-10";
const at=(clock:string,date=source)=>localDateTime(date,clock,"America/Indiana/Indianapolis");
const move:Extract<WorkCommand,{type:"move_bookings"}>={type:"move_bookings",sessionIds:["first","second"],date:destination};
let filename:string;
async function send(route:string,body:unknown,requestOrigin=origin){return POST(new NextRequest(`${origin}/api/${route}`,{method:"POST",headers:{origin:requestOrigin,"content-type":"application/json"},body:JSON.stringify(body)}),{params:Promise.resolve({path:[route]})});}
async function preview(operationId:string,command:WorkCommand=move):Promise<ScheduleProposal>{
  const response=await send("commands",{commands:[command],operationId,action:"preview"});expect(response.status).toBe(200);const {proposal}=await response.json();expect(proposal.status,JSON.stringify(proposal.conflicts)).toBe("ready");return proposal;
}
async function commit(proposal:ScheduleProposal,commands=proposal.commands){return send("commands",{commands,operationId:proposal.operationId,action:"commit",baseVersion:proposal.baseVersion,reviewFingerprint:proposal.reviewFingerprint});}
async function notes(){return JSON.parse(await readFile(filename,"utf8")).personalNotes;}
beforeEach(async()=>{
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(at("08:00")));vi.stubEnv("ADA_DEMO_MODE","true");vi.stubEnv("APP_URL",origin);
  const directory=await mkdtemp(path.join(tmpdir(),"ada-month-drag-fixture-"));vi.stubEnv("ADA_DATA_DIR",directory);
  for(const key of ["OPENAI_API_KEY","RESEND_API_KEY","SUPABASE_SERVICE_ROLE_KEY","NEXT_PUBLIC_SUPABASE_URL","NEXT_PUBLIC_SUPABASE_ANON_KEY"])vi.stubEnv(key,"");
  const fixture=createDemoState();fixture.items=[newWorkItem(owner,source,{id:"site",clientId:"client",title:"Fictional website",estimatedMinutes:240,remainingMinutes:240,minimumSessionMinutes:60,windowEnd:"2026-10-31"}),newWorkItem(owner,source,{id:"other",clientId:"client",title:"Other fictional work",estimatedMinutes:60,remainingMinutes:60,minimumSessionMinutes:60})];
  fixture.clients=[{id:"client",name:"Fictional client",aliases:[]}];fixture.settings.reserveMinutes=0;fixture.blocks=[];fixture.events=[];fixture.notifications=[];fixture.requests=[];fixture.version=0;
  fixture.sessions=[{id:"first",workItemId:"site",start:at("09:00"),end:at("10:00"),status:"planned",protected:false,usesReserve:false},{id:"second",workItemId:"site",start:at("10:00"),end:at("11:00"),status:"planned",protected:false,usesReserve:false},{id:"other",workItemId:"other",start:at("09:00",destination),end:at("10:00",destination),status:"planned",protected:true,usesReserve:false}];
  const personalNotes=[{workspaceId:fixture.workspaceId,authorId:owner.id,note:{id:"private-note",title:"Fictional note",body:"Separate from calendar changes",version:1,createdAt:at("07:00"),updatedAt:at("07:00")}}];
  filename=path.join(directory,"ada-demo.json");await writeFile(filename,JSON.stringify({...fixture,personalNotes}),{mode:0o600});vi.mocked(currentActor).mockResolvedValue(owner);
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();vi.clearAllMocks();});

describe("month group move authenticated transaction",()=>{
  it("previews without writes, commits whole sessions once, retries idempotently, and can undo exactly",async()=>{
    const before=await getDemoState(owner),privateNotes=await notes(),proposal=await preview("month-move-once");
    expect(await getDemoState(owner)).toEqual(before);expect(await notes()).toEqual(privateNotes);
    expect((await commit(proposal)).status).toBe(200);const saved=await getDemoState(owner);
    expect(saved.sessions).toEqual(proposal.sessions);expect(saved.sessions.map(s=>s.id)).toEqual(before.sessions.map(s=>s.id));expect(saved.sessions[2]).toEqual(before.sessions[2]);expect(saved.items).toHaveLength(2);expect(saved.items[0]).toMatchObject({remainingMinutes:240,estimatedMinutes:240,windowEnd:"2026-10-31"});
    expect(saved.sessions[0].start).toBe(at("10:00",destination));expect(saved.sessions[1].start).toBe(at("11:00",destination));
    expect(saved.version).toBe(1);expect(saved.events).toHaveLength(1);expect(saved.notifications.every(n=>n.status==="captured")).toBe(true);expect(await notes()).toEqual(privateNotes);
    expect((await commit(proposal)).status).toBe(200);expect(await getDemoState(owner)).toEqual(saved);
    const response=await send("undo",{id:saved.events[0].id});expect(response.status).toBe(200);const undone:AppState=(await response.json()).state;
    expect(undone.sessions).toEqual(before.sessions);expect(undone.items).toEqual(before.items);expect(undone.events[0].type).toBe("schedule_undone");expect(await notes()).toEqual(privateNotes);
  });
  it("requires reviewed times, not only a drag command, to commit",async()=>{
    const before=await getDemoState(owner);expect((await send("commands",{commands:[move],operationId:"unreviewed-drag",action:"commit",baseVersion:0})).status).toBe(409);expect(await getDemoState(owner)).toEqual(before);
  });
  it("rejects stale competing previews and reused operation IDs with different destinations",async()=>{
    const first=await preview("first-drag"),second=await preview("second-drag",{...move,date:"2026-09-11"});expect((await commit(first)).status).toBe(200);const saved=await getDemoState(owner);
    expect((await commit(second)).status).toBe(409);expect((await commit(first,[{...move,date:"2026-09-11"}])).status).toBe(400);expect(await getDemoState(owner)).toEqual(saved);
  });
  it("detects a newly added same-day booking before preview instead of moving a stale subset",async()=>{
    const added=await preview("another-booking",{type:"add_booking",itemId:"site",request:{startDate:source,endDate:source,minutes:60,distribution:"total"}});expect((await commit(added)).status).toBe(200);const saved=await getDemoState(owner);
    const response=await send("commands",{commands:[move],operationId:"stale-aggregate",action:"preview"});expect((await response.json()).proposal.conflicts[0].code).toBe("booking_group_changed");expect(await getDemoState(owner)).toEqual(saved);
  });
  it.each(["09:01","11:01","17:01"])("commits the reviewed future destination when only the planned source clock advances (%s)",async clock=>{
    const before=await getDemoState(owner),proposal=await preview("started-drag");vi.setSystemTime(new Date(at(clock)));
    expect((await commit(proposal)).status).toBe(200);const saved=await getDemoState(owner);
    expect(saved.sessions).toEqual(proposal.sessions);expect(saved.sessions[2]).toEqual(before.sessions[2]);
    expect(saved.sessions.filter(session=>session.workItemId==="site").reduce((total,session)=>total+minutesBetween(session.start,session.end),0)).toBe(120);
    expect(saved.items[0]).toMatchObject({remainingMinutes:240,estimatedMinutes:240});
    expect((await commit(proposal)).status).toBe(200);expect(await getDemoState(owner)).toEqual(saved);
  });
  it("requires review again if usable target openings change as the clock advances",async()=>{
    await demoTransaction(state=>{state.sessions[0].start=at("09:00","2026-09-11");state.sessions[0].end=at("10:00","2026-09-11");state.sessions[1].start=at("10:00","2026-09-11");state.sessions[1].end=at("11:00","2026-09-11");});
    const before=await getDemoState(owner),proposal=await preview("elapsed-target",{...move,date:source});vi.setSystemTime(new Date(at("09:01")));
    const response=await commit(proposal);expect(response.status).toBe(409);const fresh=(await response.json()).proposal;expect(fresh.sessions[0].start).toBe(at("09:15"));expect(await getDemoState(owner)).toEqual(before);
  });
  it.each([1,3])("rejects requester/viewer mutation authority (fixture %s)",async index=>{
    const before=await getDemoState(owner);vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[index]);const response=await send("commands",{commands:[move],operationId:"role-drag",action:"preview"});
    if(index===1)expect((await response.json()).proposal.conflicts[0].code).toBe("forbidden");else expect(response.status).toBe(403);expect(await getDemoState(owner)).toEqual(before);
  });
  it("refuses protected groups, malformed commands, and cross-origin changes without events",async()=>{
    await demoTransaction(state=>{state.sessions[1].protected=true;});const before=await getDemoState(owner);
    const response=await send("commands",{commands:[move],operationId:"protected-group",action:"preview"});const {proposal}=await response.json();expect(proposal.conflicts[0].code).toBe("protected_session");expect((await commit(proposal)).status).toBe(400);
    for(const invalid of [{...move,overrideProtected:true},{...move,minutes:60},{...move,sessionIds:["first","first"]}])expect((await send("commands",{commands:[invalid],operationId:"invalid-group",action:"preview"})).status).toBe(400);
    expect((await send("commands",{commands:[move],operationId:"cross-origin-group",action:"preview"},"https://invalid.example.test")).status).toBe(400);expect(await getDemoState(owner)).toEqual(before);
  });
  it("refuses grouped moves from another actor's private chat ledger",async()=>{
    const state=await getDemoState(owner),record={namespace:"ada-workspace-chat-v1",actorId:owner.id,actorRole:owner.role,workspaceId:state.workspaceId,createdAt:at("08:00"),turns:[{user:"Move work",assistant:"Preview",date:source,intent:"edit",kind:"preview"}],response:{reply:{kind:"preview",message:"Untrusted group command"}},command:move};
    expect(()=>readWorkspaceChatRecord({...record,actorId:"another-owner"},owner,state,at("08:00"))).toThrow();
  });
});
