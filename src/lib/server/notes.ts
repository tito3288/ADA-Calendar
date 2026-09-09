import "server-only";
import type { Actor } from "../types";
import { noteSaveSchema, type NoteSaveInput, type PersonalNote } from "../notes";
import { assertDemoNotesOwner, demoEnabled, demoTransaction } from "./demo-store";
import { assertLiveActor } from "./auth";
import { getSupabaseServerClient } from "./supabase";

export class NoteConflictError extends Error {
  constructor() {
    super("This note changed in another window. Your draft is still here. Reload the saved note before editing it again.");
    this.name = "NoteConflictError";
  }
}

export class NoteAccessError extends Error {
  constructor() {
    super("Only the workspace owner can access personal notes.");
    this.name = "NoteAccessError";
  }
}

function requireNotesOwner(actor: Actor) {
  if (actor.role !== "owner") throw new NoteAccessError();
}

async function liveContext(actor: Actor) {
  const trusted = await assertLiveActor(actor);
  requireNotesOwner(trusted);
  const db = await getSupabaseServerClient();
  const membership = await db.from("workspace_members").select("workspace_id")
    .eq("user_id", trusted.id).eq("active", true).eq("role", "owner").single();
  if (membership.error || !membership.data) throw new NoteAccessError();
  return { db, workspaceId: membership.data.workspace_id as string, authorId: trusted.id };
}

type NoteRow = { id: string; title: string; body: string; version: number; created_at: string; updated_at: string };
function fromRow(row: NoteRow): PersonalNote {
  return { id: row.id, title: row.title, body: row.body, version: Number(row.version), createdAt: row.created_at, updatedAt: row.updated_at };
}

export async function listNotes(actor: Actor): Promise<PersonalNote[]> {
  requireNotesOwner(actor);
  if (demoEnabled()) return demoTransaction(state => {
    assertDemoNotesOwner(state, actor);
    return (state.personalNotes ?? []).filter(entry => entry.workspaceId === state.workspaceId && entry.authorId === actor.id)
      .map(entry => entry.note).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }, false);
  const { db, workspaceId, authorId } = await liveContext(actor);
  const notes: PersonalNote[] = [];
  const pageSize = 500;
  // Read every page instead of silently dropping older notes at the API row cap.
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db.from("personal_notes").select("id,title,body,version,created_at,updated_at")
      .eq("workspace_id", workspaceId).eq("author_id", authorId).order("id").range(offset, offset + pageSize - 1);
    if (error || !data) throw new Error("Your notes could not be loaded. Please try again.");
    notes.push(...(data as NoteRow[]).map(fromRow));
    if (data.length < pageSize) break;
  }
  return notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export async function saveNote(actor: Actor, rawInput: NoteSaveInput): Promise<PersonalNote> {
  requireNotesOwner(actor);
  const input = noteSaveSchema.parse(rawInput);
  if (demoEnabled()) return demoTransaction(state => {
    assertDemoNotesOwner(state, actor);
    state.personalNotes ??= [];
    const existing = state.personalNotes.find(entry => entry.workspaceId === state.workspaceId && entry.authorId === actor.id && entry.note.id === input.id);
    if (existing) {
      if (input.expectedVersion <= existing.note.version && existing.note.title === input.title && existing.note.body === input.body) return existing.note;
      if (existing.note.version !== input.expectedVersion) throw new NoteConflictError();
      existing.note = { ...existing.note, title: input.title, body: input.body, version: existing.note.version + 1, updatedAt: new Date().toISOString() };
      return existing.note;
    }
    if (input.expectedVersion !== 0) throw new NoteConflictError();
    const now = new Date().toISOString();
    const note: PersonalNote = { id: input.id, title: input.title, body: input.body, version: 1, createdAt: now, updatedAt: now };
    state.personalNotes.push({ workspaceId: state.workspaceId, authorId: actor.id, note });
    return note;
  });
  const { db } = await liveContext(actor);
  const { data, error } = await db.rpc("save_personal_note", {
    p_id: input.id, p_title: input.title, p_body: input.body, p_expected_version: input.expectedVersion,
  });
  if (error?.code === "40001") throw new NoteConflictError();
  if (error?.code === "42501") throw new NoteAccessError();
  if (error || !data) throw new Error("Your note could not be saved. Your draft is still here; please try again.");
  return data as PersonalNote;
}
