import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "./types";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), admin: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./server/auth", () => ({ assertLiveActor: mocks.authenticate, requireOwner: vi.fn() }));
vi.mock("./server/supabase", () => ({ getSupabaseAdminClient: mocks.admin, getSupabaseServerClient: vi.fn() }));

import { beginLiveAIOperation, finishLiveAIOperation } from "./server/live-store";

const supplied: Actor = { id: "caller-supplied-id", name: "Caller", email: "caller@example.test", role: "owner" };
const authenticated: Actor = { id: "verified-auth-id", name: "William", email: "william@example.test", role: "requester" };
const operation = { id: "private-operation", kind: "transcribe" as const, inputHash: "a".repeat(64), reserveUsd: 0.01 };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue(authenticated);
  mocks.admin.mockReturnValue({ rpc: mocks.rpc });
  mocks.rpc.mockResolvedValue({ data: { status: "claimed", result: null }, error: null });
});

describe("trusted AI accounting boundary", () => {
  it("passes only the verified identity to the privileged reservation RPC after authentication", async () => {
    expect(await beginLiveAIOperation(supplied, operation)).toEqual({ status: "claimed", result: null });
    expect(mocks.authenticate).toHaveBeenCalledWith(supplied);
    expect(mocks.authenticate.mock.invocationCallOrder[0]).toBeLessThan(mocks.admin.mock.invocationCallOrder[0]);
    expect(mocks.rpc).toHaveBeenCalledWith("begin_ai_operation", {
      p_actor: authenticated.id, p_id: operation.id, p_kind: operation.kind, p_input_hash: operation.inputHash, p_reserve_usd: 0.01,
    });
  });

  it("authenticates settlement and preserves unknown cost instead of inventing a zero charge", async () => {
    await finishLiveAIOperation(supplied, operation.id, null, undefined, "Uncertain provider result");
    expect(mocks.authenticate.mock.invocationCallOrder[0]).toBeLessThan(mocks.admin.mock.invocationCallOrder[0]);
    expect(mocks.rpc).toHaveBeenCalledWith("finish_ai_operation", {
      p_actor: authenticated.id, p_id: operation.id, p_result: null, p_cost_usd: null, p_error: "Uncertain provider result",
    });
  });

  it("does not access privileged credentials when authentication or identity matching fails", async () => {
    mocks.authenticate.mockRejectedValue(new Error("Signed-in identity mismatch"));
    await expect(beginLiveAIOperation(supplied, operation)).rejects.toThrow(/identity mismatch/);
    await expect(finishLiveAIOperation(supplied, operation.id, {}, 0)).rejects.toThrow(/identity mismatch/);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("propagates ledger failures instead of presenting an unpersisted operation as successful", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "Monthly limit reached" } });
    await expect(beginLiveAIOperation(supplied, operation)).rejects.toThrow(/Monthly limit reached/);
    await expect(finishLiveAIOperation(supplied, operation.id, {}, 0.0045)).rejects.toThrow(/Monthly limit reached/);
  });
});
