import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import { newWorkItem } from "./work";
import { minutesBetween } from "./time";
import type { ScheduleProposal, WorkCommand } from "./types";

// Real local demo transactions and captured notifications only. All hosted
// clients/model calls are disabled, and every test owns a fresh temp directory.
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value:"bryan" }),set:vi.fn() }) }));
vi.mock("./server/supabase", () => ({ getSupabaseAdminClient:vi.fn(() => { throw new Error("No live database in smart-fit tests"); }),getSupabaseServerClient:vi.fn(() => { throw new Error("No live database in smart-fit tests"); }),clearSupabaseSessionCookies:vi.fn() }));
vi.mock("./server/assistant", () => ({ interpretInput:vi.fn(() => { throw new Error("No model calls in smart-fit tests"); }),assistantReservationUsd:vi.fn(() => 0),inspectAudioRecording:vi.fn(),transcribeAudio:vi.fn() }));
vi.mock("./server/service", async () => {
  const demo=await import("./server/demo-store");
  return { currentActor:vi.fn(async()=>DEMO_MEMBERS[0]),demoEnabled:()=>true,store:{ getState:vi.fn(async(id:string)=>demo.getDemoState(demo.demoActor(id))),commit:vi.fn(demo.commitDemoProposal),request:vi.fn(demo.submitDemoRequest) } };
});
import { POST } from "../app/api/[...path]/route";
import { currentActor } from "./server/service";
import { getDemoState } from "./server/demo-store";

const origin="http://localhost:3000";
const owner=DEMO_MEMBERS[0];
const date="2026-09-14";
const smartFit={startDate:date,endDate:date,minutes:120,distribution:"total" as const};
const commands:WorkCommand[]=[{ type:"fit",itemId:"ongoing-fixture",request:smartFit }];
async function send(body:unknown,requestOrigin=origin) {
  return POST(new NextRequest(`${origin}/api/commands`,{method:"POST",headers:{origin:requestOrigin,"content-type":"application/json"},body:JSON.stringify(body)}),{params:Promise.resolve({path:["commands"]})});
}
async function preview(operationId:string, proposed=commands):Promise<ScheduleProposal> {
  const response=await send({commands:proposed,operationId,action:"preview"});
  expect(response.status).toBe(200);
  const {proposal}=await response.json(); expect(proposal.status,JSON.stringify(proposal.conflicts)).toBe("ready"); return proposal;
}
async function commit(proposal:ScheduleProposal, proposed=proposal.commands) {
  return send({commands:proposed,operationId:proposal.operationId,action:"commit",baseVersion:proposal.baseVersion,reviewFingerprint:proposal.reviewFingerprint});
}
beforeEach(async()=>{
  vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
  vi.stubEnv("ADA_DEMO_MODE","true"); vi.stubEnv("APP_URL",origin);
  const directory=await mkdtemp(path.join(tmpdir(),"ada-smart-fit-fixture-")); vi.stubEnv("ADA_DATA_DIR",directory);
  for (const key of ["OPENAI_API_KEY","RESEND_API_KEY","SUPABASE_SERVICE_ROLE_KEY","NEXT_PUBLIC_SUPABASE_URL","NEXT_PUBLIC_SUPABASE_ANON_KEY"]) vi.stubEnv(key,"");
  const fixture=createDemoState();
  fixture.items=[newWorkItem(owner,"2026-09-09",{id:"ongoing-fixture",clientId:"fixture-client",title:"Fictional ongoing project",estimatedMinutes:null,remainingMinutes:null,status:"planned",minimumSessionMinutes:60,windowEnd:"2026-12-31"})];
  fixture.clients=[{id:"fixture-client",name:"Fictional client",aliases:[]}];
  fixture.settings.reserveMinutes=0; fixture.sessions=[]; fixture.blocks=[]; fixture.events=[]; fixture.notifications=[]; fixture.requests=[]; fixture.version=0;
  await writeFile(path.join(directory,"ada-demo.json"),JSON.stringify(fixture),{mode:0o600});
  vi.mocked(currentActor).mockResolvedValue(owner);
});
afterEach(()=>{ vi.useRealTimers();vi.unstubAllEnvs();vi.clearAllMocks(); });

describe("smart fit through the authenticated command route",()=>{
  it("previews without writes, commits via real local transactions, and retries idempotently",async()=>{
    const before=await getDemoState(owner); const proposal=await preview("fit-once");
    expect(await getDemoState(owner)).toEqual(before);
    const first=await commit(proposal); expect(first.status).toBe(200);
    const saved=(await first.json()).state;
    expect(saved.version).toBe(1); expect(saved.events).toHaveLength(1); expect(saved.sessions).toHaveLength(1);
    expect(saved.items[0]).toMatchObject({estimatedMinutes:null,remainingMinutes:null,windowEnd:"2026-12-31"});
    expect(saved.notifications.length).toBeGreaterThan(0);
    expect(saved.notifications.every((notification:{status:string})=>notification.status==="captured")).toBe(true);
    const retry=await commit(proposal); expect(retry.status).toBe(200);
    expect((await retry.json()).state).toEqual(saved);
  });
  it("requires a reviewed preview before committing hours",async()=>{
    const response=await send({commands,operationId:"unreviewed",action:"commit",baseVersion:0});
    expect(response.status).toBe(409); expect((await getDemoState(owner)).sessions).toEqual([]);
  });
  it("rejects stale and competing previews without a second booking",async()=>{
    const first=await preview("first"); const second=await preview("second");
    expect((await commit(first)).status).toBe(200);
    const stale=await commit(second); expect(stale.status).toBe(409);
    expect((await getDemoState(owner)).events).toHaveLength(1);
    const fresh=await preview("second"); expect((await commit(fresh)).status).toBe(200);
    const saved = await getDemoState(owner);
    expect(saved.sessions.reduce((minutes,session) => minutes + minutesBetween(session.start,session.end),0)).toBe(240);
    expect(saved.events).toHaveLength(2);
  });
  it("does not reuse a completed operation id with changed hours",async()=>{
    const first=await preview("bound-operation"); expect((await commit(first)).status).toBe(200);
    const response=await commit(first,[{type:"fit",itemId:"ongoing-fixture",request:{...smartFit,minutes:60}}]);
    expect(response.status).toBe(400); expect((await getDemoState(owner)).events).toHaveLength(1);
  });
  it("keeps failed capacity checks free of persisted sessions and notifications",async()=>{
    const response=await send({commands:[{type:"fit",itemId:"ongoing-fixture",request:{...smartFit,minutes:480}}],operationId:"too-full",action:"preview"});
    expect(response.status).toBe(200); const {proposal}=await response.json(); expect(proposal.status).toBe("infeasible");
    expect((await commit(proposal)).status).toBe(400);
    const state=await getDemoState(owner); expect(state.sessions).toEqual([]);expect(state.events).toEqual([]);expect(state.notifications).toEqual([]);
  });
  it("allows requester smart creation but not edits or extra sessions on existing work",async()=>{
    vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[1]);
    const denied=await send({commands,operationId:"requester-fit",action:"preview"});
    expect((await denied.json()).proposal.conflicts[0].code).toBe("forbidden");
    const created=newWorkItem(DEMO_MEMBERS[1],date,{id:"new-request",clientId:"fixture-client",title:"Fictional new request",estimatedMinutes:120,remainingMinutes:120,minimumSessionMinutes:60});
    const proposal=await preview("requester-create",[{type:"create",item:created,smartFit}]);
    expect((await commit(proposal)).status).toBe(200);
    const state=await getDemoState(owner);expect(state.items[1].requesterId).toBe(DEMO_MEMBERS[1].id);expect(state.items[0].remainingMinutes).toBeNull();
    vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[3]);
    expect((await send({commands,operationId:"viewer-fit",action:"preview"})).status).toBe(403);
  });
  it("rejects cross-origin and malformed smart-fit requests before any work writes",async()=>{
    expect((await send({commands,operationId:"cross-origin",action:"preview"},"https://invalid.example.test")).status).toBe(400);
    expect((await send({commands:[{type:"fit",itemId:"ongoing-fixture",request:{...smartFit,overrideProtected:true}}],operationId:"forged",action:"preview"})).status).toBe(400);
    expect((await getDemoState(owner)).version).toBe(0);
  });
});
