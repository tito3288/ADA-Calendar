import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DEMO_MEMBERS } from "./fixtures";

vi.mock("server-only", () => ({}));
const notesMocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn() }));
vi.mock("./server/notes", async importOriginal => ({
  ...await importOriginal<typeof import("./server/notes")>(),
  listNotes: notesMocks.list, saveNote: notesMocks.save,
}));
vi.mock("./server/service", () => ({
  currentActor: vi.fn(), demoEnabled: vi.fn(() => true),
  store: { getState: vi.fn(), commit: vi.fn(), admin: vi.fn(), beginAI: vi.fn() },
}));

import { currentActor, store } from "./server/service";
import { NoteAccessError, NoteConflictError } from "./server/notes";
import { GET, POST } from "../app/api/[...path]/route";

const input = { id: "private-note-fixture", title: "  Websites to Build from Scratch  ", body: "First website\n\nSecond website  ", expectedVersion: 0 };
const note = { id: input.id, title: input.title, body: input.body, version: 1, createdAt: "2026-09-08T12:00:00Z", updatedAt: "2026-09-08T12:00:00Z" };
const context = () => ({ params: Promise.resolve({ path: ["notes"] }) });
function save(body: unknown = input, origin: string | null = "http://localhost:3000") {
  return POST(new NextRequest("http://localhost:3000/api/notes", {
    method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
  }), context());
}
function list() { return GET(new NextRequest("http://localhost:3000/api/notes"), context()); }

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(currentActor).mockResolvedValue(DEMO_MEMBERS[0]);
  notesMocks.list.mockResolvedValue([note]);
  notesMocks.save.mockResolvedValue(note);
});

describe("private notes route boundaries", () => {
  it("lists notes with private no-store caching and without loading shared calendar state", async () => {
    const result = await list();
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(await result.json()).toEqual({ notes: [note] });
    expect(notesMocks.list).toHaveBeenCalledExactlyOnceWith(DEMO_MEMBERS[0]);
    expect(store.getState).not.toHaveBeenCalled();
  });

  it("saves the exact text through the notes store only", async () => {
    const result = await save();
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(await result.json()).toEqual({ note });
    expect(notesMocks.save).toHaveBeenCalledExactlyOnceWith(DEMO_MEMBERS[0], input);
    expect(store.getState).not.toHaveBeenCalled();
    expect(store.commit).not.toHaveBeenCalled();
    expect(store.admin).not.toHaveBeenCalled();
    expect(store.beginAI).not.toHaveBeenCalled();
  });

  it.each(DEMO_MEMBERS.filter(actor => actor.role !== "owner"))("denies $name access before reading or writing notes", async actor => {
    vi.mocked(currentActor).mockResolvedValue(actor);
    expect((await list()).status).toBe(403);
    expect((await save()).status).toBe(403);
    expect(notesMocks.list).not.toHaveBeenCalled();
    expect(notesMocks.save).not.toHaveBeenCalled();
    expect(store.getState).not.toHaveBeenCalled();
  });

  it.each([null, "https://untrusted.example.test"])("rejects an unverified write origin %s", async origin => {
    expect((await save(input, origin)).status).toBe(400);
    expect(notesMocks.save).not.toHaveBeenCalled();
    expect(currentActor).not.toHaveBeenCalled();
  });

  it.each([
    { ...input, title: "  " }, { ...input, title: "x".repeat(201) },
    { ...input, body: "x".repeat(50001) }, { ...input, expectedVersion: -1 },
    { ...input, expectedVersion: 1.5 }, { ...input, authorId: "someone-else" },
    { ...input, workspaceId: "elsewhere" }, { ...input, id: "../note" },
  ])("validates payloads before storage", async invalid => {
    expect((await save(invalid)).status).toBe(400);
    expect(notesMocks.save).not.toHaveBeenCalled();
  });

  it("returns a stale-save conflict without falling through to calendar services", async () => {
    notesMocks.save.mockRejectedValue(new NoteConflictError());
    const result = await save();
    expect(result.status).toBe(409);
    expect((await result.json()).error).toContain("draft is still here");
    expect(store.commit).not.toHaveBeenCalled();
  });

  it("respects a storage-level authorization failure after initial authentication", async () => {
    notesMocks.list.mockRejectedValue(new NoteAccessError());
    notesMocks.save.mockRejectedValue(new NoteAccessError());
    expect((await list()).status).toBe(403);
    expect((await save()).status).toBe(403);
  });

  it("fails closed before reading notes when the session is unavailable", async () => {
    vi.mocked(currentActor).mockRejectedValue(new Error("Authentication required."));
    expect((await list()).status).toBe(401);
    expect(notesMocks.list).not.toHaveBeenCalled();
  });
});
