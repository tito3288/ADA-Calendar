import { describe, expect, it } from "vitest";
import { createDemoState, DEMO_MEMBERS } from "./fixtures";
import type { AppState, WorkEvent } from "./types";
import { latestWorkspaceChatChange } from "./workspace-chat";

function fixture(): AppState {
  return { ...createDemoState("2026-09-09T12:00:00.000Z"), actor: DEMO_MEMBERS[0] };
}

function event(state: AppState, version: number, overrides: Partial<WorkEvent> = {}): WorkEvent {
  return {
    id: `event-${version}`, operationId: `chat-order-${version.toString(16).padStart(40, "0")}`,
    actorId: state.actor.id, actorName: state.actor.name, type: "schedule_changed", version,
    createdAt: "2026-09-09T12:00:00.000Z", summary: ["Fictional helper change"], itemIds: [], undoneBy: null,
    before: { items: state.items, sessions: state.sessions, blocks: state.blocks },
    after: { items: state.items, sessions: state.sessions, blocks: state.blocks },
    ...overrides,
  };
}

describe("the persistent helper undo target", () => {
  it("finds the owner's newest helper event even when history is unordered", () => {
    const state = fixture();
    state.events = [event(state, 2), event(state, 7), event(state, 1)];
    expect(latestWorkspaceChatChange(state)?.id).toBe("event-7");
  });

  it("never retargets a newer manual change, another actor, or malformed operation ID", () => {
    const state = fixture();
    state.events = [event(state, 1), event(state, 2, { operationId: "manual-booking" }),
      event(state, 3, { actorId: "another-owner" }), event(state, 4, { operationId: "chat-order-short" })];
    expect(latestWorkspaceChatChange(state)?.id).toBe("event-1");
  });

  it("keeps the already-undone event for a restored confirmation instead of rolling back older work", () => {
    const state = fixture();
    state.events = [event(state, 1), event(state, 2, { undoneBy: "undo-event" }),
      event(state, 3, { type: "schedule_undone" })];
    expect(latestWorkspaceChatChange(state)?.undoneBy).toBe("undo-event");
  });

  it("does not expose an undo target to requesters or viewers", () => {
    const state = fixture();
    state.events = [event(state, 1)];
    for (const role of ["requester", "viewer"] as const) {
      state.actor = { ...state.actor, role };
      expect(latestWorkspaceChatChange(state)).toBeUndefined();
    }
  });
});
