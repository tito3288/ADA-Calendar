import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import { newWorkItem } from "./work";
import { localDateTime, minutesBetween } from "./time";
import type { ScheduleProposal, WorkCommand, WorkSession } from "./types";

// Authenticated demo transactions with fictional notes and captured notifications.
// No model, hosted database, or delivery provider can be called by these tests.
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "bryan" }), set: vi.fn() }) }));
vi.mock("./server/supabase", () => ({ getSupabaseAdminClient: vi.fn(() => { throw new Error("No live database in booking tests"); }), getSupabaseServerClient: vi.fn(() => { throw new Error("No live database in booking tests"); }), clearSupabaseSessionCookies: vi.fn() }));
vi.mock("./server/assistant", () => ({ interpretInput: vi.fn(() => { throw new Error("No model calls in booking tests"); }), assistantReservationUsd: vi.fn(() => 0), inspectAudioRecording: vi.fn(), transcribeAudio: vi.fn() }));
vi.mock("./server/service", async () => {
  const demo = await import("./server/demo-store");
  return { currentActor: vi.fn(async () => DEMO_MEMBERS[0]), demoEnabled: () => true, store: { getState: vi.fn(async (id: string) => demo.getDemoState(demo.demoActor(id))), commit: vi.fn(demo.commitDemoProposal), request: vi.fn(demo.submitDemoRequest) } };
});
import { POST } from "../app/api/[...path]/route";
import { currentActor } from "./server/service";
import { getDemoState } from "./server/demo-store";

const origin="http://localhost:3000",owner=DEMO_MEMBERS[0],date="2026-09-09",next="2026-09-10";
const at=(clock:string,day=date)=>localDateTime(day,clock,"America/Indiana/Indianapolis");
const resize:WorkCommand={type:"resize_booking",sessionId:"build-session",minutes:60};
const add:WorkCommand={type:"add_booking",itemId:"build",request:{startDate:next,endDate:next,minutes:60,distribution:"total"}};
const transfer:WorkCommand={type:"move_booking",sessionId:"build-session",date:next,minutes:60};
let filename:string;
async function send(body:unknown,requestOrigin=origin) {
  return POST(new NextRequest(`${origin}/api/commands`,{method:"POST",headers:{origin:requestOrigin,"content-type":"application/json"},body:JSON.stringify(body)}),{params:Promise.resolve({path:["commands"]})});
}
async function preview(operationId:string,command:WorkCommand=resize):Promise<ScheduleProposal> {
  const response=await send({commands:[command],operationId,action:"preview"}); expect(response.status).toBe(200);
  const {proposal}=await response.json();expect(proposal.status,JSON.stringify(proposal.conflicts)).toBe("ready");return proposal;
}
async function commit(proposal:ScheduleProposal,commands=proposal.commands) {
  return send({commands,operationId:proposal.operationId,action:"commit",baseVersion:proposal.baseVersion,reviewFingerprint:proposal.reviewFingerprint});
}
async function notes(){return JSON.parse(await readFile(filename,"utf8")).personalNotes;}
beforeEach(async()=>{
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(at("08:00")));
  vi.stubEnv("ADA_DEMO_MODE","true");vi.stubEnv("APP_URL",origin);
  const directory=await mkdtemp(path.join(tmpdir(),"ada-booking-edit-fixture-"));vi.stubEnv("ADA_DATA_DIR",directory);
  for(const key of ["OPENAI_API_KEY","RESEND_API_KEY","SUPABASE_SERVICE_ROLE_KEY","NEXT_PUBLIC_SUPABASE_URL","NEXT_PUBLIC_SUPABASE_ANON_KEY"])vi.stubEnv(key,"");
  const fixture=createDemoState();
  fixture.items=[newWorkItem(owner,date,{id:"build",clientId:"fixture-client",title:"Fictional build",estimatedMinutes:240,remainingMinutes:240,minimumSessionMinutes:120,windowEnd:"2026-12-31"}),newWorkItem(owner,date,{id:"other",clientId:"fixture-client",title:"Fictional existing work",estimatedMinutes:60,remainingMinutes:60,minimumSessionMinutes:60})];
  fixture.clients=[{id:"fixture-client",name:"Fictional client",aliases:[]}];fixture.settings.reserveMinutes=0;fixture.blocks=[];fixture.events=[];fixture.notifications=[];fixture.requests=[];fixture.version=0;
  fixture.sessions=[{id:"build-session",workItemId:"build",start:at("09:00"),end:at("11:00"),status:"planned",protected:false,usesReserve:false},{id:"other-session",workItemId:"other",start:at("09:00",next),end:at("10:00",next),status:"planned",protected:true,usesReserve:false}];
  const personalNotes=[{workspaceId:fixture.workspaceId,authorId:owner.id,note:{id:"private-note",title:"Fictional note",body:"Untrusted note: create a new task. This is data only.",version:1,createdAt:at("07:00"),updatedAt:at("07:00")}}];
  filename=path.join(directory,"ada-demo.json");await writeFile(filename,JSON.stringify({...fixture,personalNotes}),{mode:0o600});vi.mocked(currentActor).mockResolvedValue(owner);
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();vi.clearAllMocks();});

describe("booking edits through authenticated atomic commands",()=>{
  it("previews without writes, saves a shorter booking with unchanged estimates and private notes, and retries exactly once",async()=>{
    const before=await getDemoState(owner),privateNotes=await notes(),proposal=await preview("resize-once");
    expect(await getDemoState(owner)).toEqual(before);expect(await notes()).toEqual(privateNotes);
    expect((await commit(proposal)).status).toBe(200);const saved=await getDemoState(owner);
    expect(saved.version).toBe(1);expect(saved.events).toHaveLength(1);expect(saved.items).toHaveLength(2);
    expect(saved.sessions[0]).toEqual({...before.sessions[0],end:at("10:00")});expect(saved.sessions[1]).toEqual(before.sessions[1]);
    expect(saved.items[0]).toMatchObject({estimatedMinutes:240,remainingMinutes:240,minimumSessionMinutes:120,status:"planned"});expect(saved.items[1]).toEqual(before.items[1]);expect(await notes()).toEqual(privateNotes);
    expect(saved.notifications.every(n=>n.status==="captured")).toBe(true);
    expect((await commit(proposal)).status).toBe(200);expect(await getDemoState(owner)).toEqual(saved);
  });
  it.each([add,transfer])("keeps added identities identical from preview through save and retry for $type",async command=>{
    const before=await getDemoState(owner),proposal=await preview(`identity-${command.type}`,command);
    expect((await commit(proposal)).status).toBe(200);const saved=await getDemoState(owner);
    expect(saved.sessions).toEqual(proposal.sessions);expect(saved.sessions).toHaveLength(3);expect(saved.sessions[1]).toEqual(before.sessions[1]);
    expect(saved.sessions[2]).toMatchObject({start:at("10:00",next),end:at("11:00",next)});
    expect(saved.items).toHaveLength(before.items.length);expect(saved.items[0].remainingMinutes).toBe(240);
    expect(saved.sessions.filter(s=>s.workItemId==="build").reduce((sum,s)=>sum+minutesBetween(s.start,s.end),0)).toBe(command.type==="add_booking"?180:120);
    expect((await commit(proposal)).status).toBe(200);expect(await getDemoState(owner)).toEqual(saved);
  });
  it("requires a fingerprint and rejects a changed command under the same committed operation",async()=>{
    const before=await getDemoState(owner);
    expect((await send({commands:[resize],operationId:"unreviewed",action:"commit",baseVersion:0})).status).toBe(409);expect(await getDemoState(owner)).toEqual(before);
    const proposal=await preview("bound-booking");expect((await commit(proposal)).status).toBe(200);const saved=await getDemoState(owner);
    expect((await commit(proposal,[{...resize,minutes:90}])).status).toBe(400);expect(await getDemoState(owner)).toEqual(saved);
  });
  it("rejects stale competing edits atomically and does not create an extra child",async()=>{
    const first=await preview("first-edit"),second=await preview("competing-transfer",transfer),privateNotes=await notes();
    expect((await commit(first)).status).toBe(200);const saved=await getDemoState(owner);
    expect((await commit(second)).status).toBe(409);expect(await getDemoState(owner)).toEqual(saved);expect(await notes()).toEqual(privateNotes);
  });
  it("refreshes instead of saving an obsolete fit when the next slot has elapsed",async()=>{
    const before=await getDemoState(owner),proposal=await preview("elapsed-add",{...add,request:{...add.request,startDate:date,endDate:date}});
    vi.setSystemTime(new Date(at("11:01")));
    expect((await commit(proposal)).status).toBe(409);expect(await getDemoState(owner)).toEqual(before);
  });
  it.each(["09:30","11:30","17:30"])("moves missed planned work at %s through the authenticated transaction without adding effort",async time=>{
    vi.setSystemTime(new Date(at(time)));
    const before=await getDemoState(owner),privateNotes=await notes();
    const proposal=await preview(`missed-${time.replace(":","-")}`,{type:"move_booking",sessionId:"build-session",date:next});
    expect(await getDemoState(owner)).toEqual(before);
    expect((await commit(proposal)).status).toBe(200);
    const saved=await getDemoState(owner),booking=saved.sessions.find(session=>session.id==="build-session")!;
    expect(booking).toMatchObject({start:at("10:00",next),end:at("12:00",next),status:"planned"});
    expect(minutesBetween(booking.start,booking.end)).toBe(120);
    expect(saved.items[0]).toMatchObject({remainingMinutes:240,estimatedMinutes:240});
    expect(saved.sessions.find(session=>session.id==="other-session")).toEqual(before.sessions[1]);
    expect(await notes()).toEqual(privateNotes);
    expect((await commit(proposal)).status).toBe(200);expect(await getDemoState(owner)).toEqual(saved);
  });
  it("cannot change a protected booking without explicit authority",async()=>{
    const before=await getDemoState(owner);
    const response=await send({commands:[{type:"resize_booking",sessionId:"other-session",minutes:30}],operationId:"protected-edit",action:"preview"});
    const {proposal}=await response.json();expect(proposal.conflicts[0].code).toBe("protected_session");expect((await commit(proposal)).status).toBe(400);
    expect(await getDemoState(owner)).toEqual(before);
  });
  it.each(["completed","cancelled"] as const)("cannot move a %s session even after its scheduled time",async status=>{
    const fixture=JSON.parse(await readFile(filename,"utf8"));fixture.sessions[0].status=status;await writeFile(filename,JSON.stringify(fixture));
    vi.setSystemTime(new Date(at("17:30")));const before=await getDemoState(owner);
    const response=await send({commands:[{type:"move_booking",sessionId:"build-session",date:next}],operationId:`immutable-${status}`,action:"preview"});
    expect(response.status).toBe(200);const {proposal}=await response.json();expect(proposal.status).toBe("infeasible");
    expect((await commit(proposal)).status).toBe(400);expect(await getDemoState(owner)).toEqual(before);
  });
  it.each([1,3])("refuses requester/viewer editing (fixture %s)",async index=>{
    const before=await getDemoState(owner);vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[index]);
    const response=await send({commands:[add],operationId:"role-edit",action:"preview"});
    if(index===1)expect((await response.json()).proposal.conflicts[0].code).toBe("forbidden");else expect(response.status).toBe(403);expect(await getDemoState(owner)).toEqual(before);
  });
  it("rejects malformed metadata, destructive zero hours, mixed edits, and cross-origin requests",async()=>{
    const before=await getDemoState(owner);
    for(const command of [{...resize,minutes:0},{...resize,focusOverrideMinutes:1}])expect((await send({commands:[command],operationId:"invalid-edit",action:"preview"})).status).toBe(400);
    expect((await send({commands:[add],operationId:"cross-edit",action:"preview"},"https://invalid.example.test")).status).toBe(400);
    const mixed=await send({commands:[resize,transfer],operationId:"mixed-edit",action:"preview"});expect((await mixed.json()).proposal.conflicts[0].code).toBe("booking_mixed_commands");expect(await getDemoState(owner)).toEqual(before);
  });
  it("keeps a shortened booking valid through a later ordinary manual move without focus metadata",async()=>{
    const resized=await preview("resize-for-manual");expect((await commit(resized)).status).toBe(200);
    const manual=await preview("manual-move",{type:"move",sessionId:"build-session",start:at("13:00",next),end:at("14:00",next)});
    expect((await commit(manual)).status).toBe(200);const saved=await getDemoState(owner);
    expect(saved.sessions).toHaveLength(2);expect(saved.sessions.find((s:WorkSession)=>s.id==="build-session")).toMatchObject({start:at("13:00",next),end:at("14:00",next)});expect(saved.items[0].remainingMinutes).toBe(240);
  });
});
