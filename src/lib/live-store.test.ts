import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "./types";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), admin: vi.fn(), rpc: vi.fn(), server: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./server/auth", () => ({ assertLiveActor: mocks.authenticate, requireOwner: vi.fn() }));
vi.mock("./server/supabase", () => ({ getSupabaseAdminClient: mocks.admin, getSupabaseServerClient: mocks.server }));

import { beginLiveAIOperation, finishLiveAIOperation, getLiveAIOperation, hasCommittedLiveOperation } from "./server/live-store";

const supplied: Actor = { id: "caller-supplied-id", name: "Caller", email: "caller@example.test", role: "owner" };
const authenticated: Actor = { id: "verified-auth-id", name: "William", email: "william@example.test", role: "requester" };
const operation = { id: "private-operation", kind: "transcribe" as const, inputHash: "a".repeat(64), reserveUsd: 0.01 };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue(authenticated);
  mocks.admin.mockReturnValue({ rpc: mocks.rpc });
  mocks.rpc.mockResolvedValue({ data: { status: "claimed", result: null }, error: null });
  const query = { select: mocks.select, eq: mocks.eq, maybeSingle: mocks.maybeSingle };
  mocks.server.mockResolvedValue({ from: mocks.from });
  mocks.from.mockReturnValue(query);
  mocks.select.mockReturnValue(query);
  mocks.eq.mockReturnValue(query);
  mocks.maybeSingle.mockResolvedValue({ data: { kind: "assistant", status: "completed", result: { interpretation: { kind: "clarification", message: "How many hours?" }, continuation: { turns: [] } } }, error: null });
});

describe("authenticated committed-operation lookup", () => {
  const commands = [{ type: "status" as const, itemId: "fixture-work", status: "waiting" as const }];
  const membership = { data: { workspace_id: "verified-workspace" }, error: null };
  it("reads an exact event independently of history pagination and binds its actor and canonical commands", async () => {
    mocks.maybeSingle.mockResolvedValueOnce(membership).mockResolvedValueOnce({ data: { actor_id: authenticated.id, operation_payload: [{ status: "waiting", itemId: "fixture-work", type: "status" }] }, error: null });
    expect(await hasCommittedLiveOperation(supplied, "older-committed-operation", commands)).toBe(true);
    expect(mocks.authenticate).toHaveBeenCalledWith(supplied);
    expect(mocks.authenticate.mock.invocationCallOrder[0]).toBeLessThan(mocks.server.mock.invocationCallOrder[0]);
    expect(mocks.from.mock.calls).toEqual([["workspace_members"], ["work_events"]]);
    expect(mocks.eq).toHaveBeenCalledWith("workspace_id", "verified-workspace");
    expect(mocks.eq).toHaveBeenCalledWith("operation_id", "older-committed-operation");
    expect(mocks.admin).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("returns false only when the authenticated workspace has no matching committed operation", async () => {
    mocks.maybeSingle.mockResolvedValueOnce(membership).mockResolvedValueOnce({ data: null, error: null });
    expect(await hasCommittedLiveOperation(supplied, "uncommitted-operation", commands)).toBe(false);
  });
  it.each([
    { actor_id: "another-actor", operation_payload: commands },
    { actor_id: authenticated.id, operation_payload: [] },
  ])("rejects mismatched ledger identity or commands: %j", async entry => {
    mocks.maybeSingle.mockResolvedValueOnce(membership).mockResolvedValueOnce({ data: entry, error: null });
    await expect(hasCommittedLiveOperation(supplied, "reused-operation", commands)).rejects.toThrow(/saved commands/);
  });
  it("does not mistake auth or database failures for an uncommitted operation", async () => {
    mocks.authenticate.mockRejectedValueOnce(new Error("Sign in required"));
    await expect(hasCommittedLiveOperation(supplied, "old-operation", commands)).rejects.toThrow(/Sign in/);
    expect(mocks.server).not.toHaveBeenCalled();
    mocks.maybeSingle.mockResolvedValueOnce(membership).mockResolvedValueOnce({ data: null, error: { message: "Ledger unavailable" } });
    await expect(hasCommittedLiveOperation(supplied, "old-operation", commands)).rejects.toThrow(/Ledger unavailable/);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});

describe("trusted AI accounting boundary", () => {
  it("passes only the verified identity to the privileged reservation RPC after authentication", async () => {
    expect(await beginLiveAIOperation(supplied, operation)).toEqual({ status: "claimed", result: null });
    expect(mocks.authenticate).toHaveBeenCalledWith(supplied);
    expect(mocks.authenticate.mock.invocationCallOrder[0]).toBeLessThan(mocks.admin.mock.invocationCallOrder[0]);
    expect(mocks.rpc).toHaveBeenCalledWith("begin_ai_operation", {
      p_actor: authenticated.id, p_id: operation.id, p_kind: operation.kind, p_input_hash: operation.inputHash, p_reserve_usd: 0.01, p_parent_id: null,
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
    await expect(getLiveAIOperation(supplied, operation.id)).rejects.toThrow(/identity mismatch/);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.server).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("propagates ledger failures instead of presenting an unpersisted operation as successful", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "Monthly limit reached" } });
    await expect(beginLiveAIOperation(supplied, operation)).rejects.toThrow(/Monthly limit reached/);
    await expect(finishLiveAIOperation(supplied, operation.id, {}, 0.0045)).rejects.toThrow(/Monthly limit reached/);
  });

  it("passes the private parent reference to the atomic service-only reservation RPC", async () => {
    await beginLiveAIOperation(supplied, { ...operation, kind: "assistant", parentId: "previous-clarification" });
    expect(mocks.rpc).toHaveBeenCalledWith("begin_ai_operation", expect.objectContaining({ p_actor: authenticated.id, p_parent_id: "previous-clarification" }));
  });

  it("reads private clarification results through authenticated RLS after verifying identity", async () => {
    const result = await getLiveAIOperation(supplied, "previous-clarification");
    expect(result).toEqual({ kind: "assistant", status: "completed", result: { interpretation: { kind: "clarification", message: "How many hours?" }, continuation: { turns: [] } } });
    expect(mocks.authenticate.mock.invocationCallOrder[0]).toBeLessThan(mocks.server.mock.invocationCallOrder[0]);
    expect(mocks.from).toHaveBeenCalledWith("ai_operations");
    expect(mocks.select).toHaveBeenCalledWith("kind,status,result");
    expect(mocks.eq).toHaveBeenCalledWith("id", "previous-clarification");
    expect(mocks.eq).toHaveBeenCalledWith("actor_id", authenticated.id);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("rejects missing or inaccessible private operations without falling back to privileged reads", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(getLiveAIOperation(supplied, "another-members-operation")).rejects.toThrow(/unavailable to this account/);
    expect(mocks.admin).not.toHaveBeenCalled();
    mocks.maybeSingle.mockResolvedValue({ data: null, error: { message: "Database unavailable" } });
    await expect(getLiveAIOperation(supplied, "previous-clarification")).rejects.toThrow(/Database unavailable/);
  });
});
