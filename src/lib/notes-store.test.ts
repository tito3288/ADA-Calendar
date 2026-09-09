import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_MEMBERS } from "./fixtures";
import { noteSaveSchema, type NoteSaveInput, type PersonalNote } from "./notes";

const live = vi.hoisted(() => ({ actor: vi.fn(), client: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./server/auth", () => ({ assertLiveActor: live.actor }));
vi.mock("./server/supabase", () => ({ getSupabaseServerClient: live.client }));

import { demoTransaction, getDemoState } from "./server/demo-store";
import { listNotes, NoteAccessError, NoteConflictError, saveNote } from "./server/notes";

const owner = DEMO_MEMBERS[0];
const input = (patch: Partial<NoteSaveInput> = {}): NoteSaveInput => ({ id: "note-one", title: "Websites to Build from Scratch", body: "Cedar Studio\nMaple Books", expectedVersion: 0, ...patch });

beforeEach(async () => {
  vi.stubEnv("ADA_DEMO_MODE", "true");
  vi.stubEnv("ADA_DATA_DIR", await mkdtemp(path.join(tmpdir(), "ada-notes-test-")));
  live.actor.mockReset(); live.client.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("personal note validation", () => {
  it("preserves the exact title, line breaks, spacing, and empty bodies", () => {
    const note = input({ title: "  Websites to Build  ", body: "  First\n\nSecond  \n" });
    expect(noteSaveSchema.parse(note)).toEqual(note);
    expect(noteSaveSchema.parse(input({ body: "" })).body).toBe("");
  });

  it.each([
    { title: " \t\n " }, { title: "x".repeat(201) }, { body: "x".repeat(50_001) },
    { id: "../wrong" }, { expectedVersion: -1 }, { expectedVersion: 1.5 },
    { title: "a\0b" }, { body: "a\0b" }, { authorId: "another-account" },
  ])("rejects invalid or authority-bearing input: %j", patch => {
    expect(noteSaveSchema.safeParse({ ...input(), ...patch }).success).toBe(false);
  });
});

describe("private demo note persistence", () => {
  it("saves, reopens, renames, and independently updates separate notes", async () => {
    const first = await saveNote(owner, input({ title: "  Websites to Build  ", body: "Cedar Studio\n\nMaple Books  \n" }));
    const second = await saveNote(owner, input({ id: "note-two", title: "Websites to Build from Scratch", body: "A separate list" }));
    const third = await saveNote(owner, input({ id: "note-three", title: second.title, body: "A third note" }));
    expect(await listNotes(owner)).toEqual(expect.arrayContaining([first, second, third]));
    const edited = await saveNote(owner, input({ id: first.id, title: "New exact title", body: "Updated\n\nlist", expectedVersion: first.version }));
    expect(edited).toMatchObject({ title: "New exact title", body: "Updated\n\nlist", version: 2, createdAt: first.createdAt });
    expect(await listNotes(owner)).toEqual(expect.arrayContaining([edited, second, third]));
    expect(await listNotes(owner)).toHaveLength(3);
  });

  it("makes retries and unchanged saves no-ops", async () => {
    const original = await saveNote(owner, input());
    expect(await saveNote(owner, input())).toEqual(original);
    expect(await saveNote(owner, input({ expectedVersion: original.version }))).toEqual(original);
    expect(await listNotes(owner)).toEqual([original]);
    await expect(saveNote(owner, input({ expectedVersion: 10 }))).rejects.toBeInstanceOf(NoteConflictError);
  });

  it("never overwrites a newer note with a stale or reused create request", async () => {
    await saveNote(owner, input());
    const saved = await saveNote(owner, input({ body: "Newer text", expectedVersion: 1 }));
    await expect(saveNote(owner, input({ body: "Stale text", expectedVersion: 1 }))).rejects.toBeInstanceOf(NoteConflictError);
    await expect(saveNote(owner, input({ body: "Different creation", expectedVersion: 0 }))).rejects.toBeInstanceOf(NoteConflictError);
    await expect(saveNote(owner, input({ id: "missing-note", expectedVersion: 1 }))).rejects.toBeInstanceOf(NoteConflictError);
    expect(await listNotes(owner)).toEqual([saved]);
  });

  it("serializes concurrent saves so only one changed revision wins", async () => {
    await saveNote(owner, input());
    const results = await Promise.allSettled([
      saveNote(owner, input({ body: "First editor", expectedVersion: 1 })),
      saveNote(owner, input({ body: "Second editor", expectedVersion: 1 })),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: expect.any(NoteConflictError) });
    expect((await listNotes(owner))[0].version).toBe(2);
  });

  it("does not alter capacity, work, schedule version, events, or mail and never exposes notes in shared state", async () => {
    const before = await getDemoState(owner);
    await saveNote(owner, input({ body: "Private note content" }));
    const after = await getDemoState(owner);
    expect(after).toEqual(before);
    for (const member of DEMO_MEMBERS) {
      const visible = await getDemoState(member);
      expect(visible).not.toHaveProperty("personalNotes");
      expect(JSON.stringify(visible)).not.toContain("Private note content");
    }
  });

  it("rejects requesters, viewers, and forged or removed owner membership", async () => {
    for (const member of DEMO_MEMBERS.filter(member => member.role !== "owner")) {
      await expect(listNotes(member)).rejects.toBeInstanceOf(NoteAccessError);
      await expect(saveNote(member, input())).rejects.toBeInstanceOf(NoteAccessError);
    }
    await expect(saveNote({ ...DEMO_MEMBERS[1], role: "owner" }, input())).rejects.toThrow("membership");
    await expect(listNotes({ ...owner, email: "forged@example.test" })).rejects.toThrow("membership");
    await demoTransaction(state => { state.members = state.members.filter(member => member.id !== owner.id); });
    await expect(listNotes(owner)).rejects.toThrow("membership");
    expect(live.client).not.toHaveBeenCalled();
  });

  it("keeps another author or workspace's records private", async () => {
    const own = await saveNote(owner, input());
    await demoTransaction(state => {
      state.personalNotes!.push({ workspaceId: "another-workspace", authorId: owner.id, note: { ...own, id: "foreign-workspace" } });
      state.personalNotes!.push({ workspaceId: state.workspaceId, authorId: "another-owner", note: { ...own, id: "foreign-author" } });
    });
    expect(await listNotes(owner)).toEqual([own]);
  });
});

function mockLiveContext() {
  vi.stubEnv("ADA_DEMO_MODE", "false");
  live.actor.mockResolvedValue(owner);
  const membership = { select: vi.fn(), eq: vi.fn(), single: vi.fn().mockResolvedValue({ data: { workspace_id: "private-workspace" }, error: null }) };
  membership.select.mockReturnValue(membership); membership.eq.mockReturnValue(membership);
  const rpc = vi.fn();
  const db = { from: vi.fn().mockReturnValue(membership), rpc };
  live.client.mockResolvedValue(db);
  return { db, rpc, membership };
}

describe("live note boundaries without providers", () => {
  it("lists only the owner's workspace and author, mapping private rows without exposing ownership fields", async () => {
    const { db, membership } = mockLiveContext();
    const row = { id: "note-one", title: "Exact title", body: "Private\ntext", version: 2, created_at: "2026-09-08T12:00:00Z", updated_at: "2026-09-08T12:05:00Z" };
    const rows = { select: vi.fn(), eq: vi.fn(), order: vi.fn(), range: vi.fn().mockResolvedValue({ data: [row], error: null }) };
    rows.select.mockReturnValue(rows); rows.eq.mockReturnValue(rows); rows.order.mockReturnValue(rows);
    db.from.mockImplementation(table => table === "workspace_members" ? membership : rows);
    expect(await listNotes(owner)).toEqual([{ id: row.id, title: row.title, body: row.body, version: 2, createdAt: row.created_at, updatedAt: row.updated_at }]);
    expect(rows.eq).toHaveBeenCalledWith("workspace_id", "private-workspace");
    expect(rows.eq).toHaveBeenCalledWith("author_id", owner.id);
    expect(rows.range).toHaveBeenCalledWith(0, 499);
  });

  it("uses the authenticated RPC and never accepts supplied author or workspace authority", async () => {
    const { rpc } = mockLiveContext();
    const saved: PersonalNote = { id: input().id, title: input().title, body: input().body, version: 1, createdAt: "2026-09-08T12:00:00Z", updatedAt: "2026-09-08T12:00:00Z" };
    rpc.mockResolvedValue({ data: saved, error: null });
    expect(await saveNote(owner, input())).toEqual(saved);
    expect(live.actor).toHaveBeenCalledWith(owner);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("save_personal_note", {
      p_id: "note-one", p_title: input().title, p_body: input().body, p_expected_version: 0,
    });
  });

  it("maps compare-and-swap conflicts without disclosing database internals", async () => {
    const { rpc } = mockLiveContext();
    rpc.mockResolvedValue({ data: null, error: { code: "40001", message: "database implementation detail" } });
    await expect(saveNote(owner, input())).rejects.toBeInstanceOf(NoteConflictError);
    rpc.mockResolvedValue({ data: null, error: { code: "42P01", message: "private schema detail" } });
    await expect(saveNote(owner, input())).rejects.toThrow("Your note could not be saved");
  });

  it("rechecks the signed-in role and fails closed without a trusted owner", async () => {
    const { rpc } = mockLiveContext();
    live.actor.mockResolvedValue(DEMO_MEMBERS[1]);
    await expect(saveNote(owner, input())).rejects.toBeInstanceOf(NoteAccessError);
    live.actor.mockRejectedValue(new Error("Sign in to access this private workspace."));
    await expect(listNotes(owner)).rejects.toThrow("Sign in");
    expect(rpc).not.toHaveBeenCalled();
  });
});
