import "server-only";
import { cookies } from "next/headers";
import { demoActor, demoEnabled, getDemoState, commitDemoProposal, submitDemoRequest, resolveDemoRequest, undoDemoEvent, mutateDemoAdmin, beginDemoAIOperation, finishDemoAIOperation } from "./demo-store";
import { getLiveActor } from "./auth";
import { getLiveState, commitLiveProposal, submitLiveRequest, resolveLiveRequest, undoLiveEvent, mutateLiveAdmin, beginLiveAIOperation, finishLiveAIOperation } from "./live-store";

export { demoEnabled };
export async function currentActor() {
  return demoEnabled() ? demoActor((await cookies()).get("ada-demo-actor")?.value) : getLiveActor();
}
export const store = {
  getState: async (...args: Parameters<typeof getLiveState>) => demoEnabled() ? getDemoState(demoActor(args[0])) : getLiveState(...args),
  commit: async (...args: Parameters<typeof commitLiveProposal>) => demoEnabled() ? commitDemoProposal(...args) : commitLiveProposal(...args),
  request: async (...args: Parameters<typeof submitLiveRequest>) => demoEnabled() ? submitDemoRequest(...args) : submitLiveRequest(...args),
  resolve: async (...args: Parameters<typeof resolveLiveRequest>) => demoEnabled() ? resolveDemoRequest(...args) : resolveLiveRequest(...args),
  undo: async (...args: Parameters<typeof undoLiveEvent>) => demoEnabled() ? undoDemoEvent(...args) : undoLiveEvent(...args),
  admin: async (...args: Parameters<typeof mutateLiveAdmin>) => demoEnabled() ? mutateDemoAdmin(...args) : mutateLiveAdmin(...args),
  beginAI: async (...args: Parameters<typeof beginDemoAIOperation>) => demoEnabled() ? beginDemoAIOperation(...args) : beginLiveAIOperation(...args),
  finishAI: async (...args: Parameters<typeof finishDemoAIOperation>) => demoEnabled() ? finishDemoAIOperation(...args) : finishLiveAIOperation(...args),
};
