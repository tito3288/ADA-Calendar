"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import {
  Check,
  FileText,
  LockKeyhole,
  Plus,
  RefreshCw,
  Save,
} from "lucide-react";
import {
  NOTE_BODY_MAX_LENGTH,
  NOTE_TITLE_MAX_LENGTH,
  type PersonalNote,
} from "@/lib/notes";
import { Modal } from "./ui";

type NoteDraft = Pick<PersonalNote, "id" | "title" | "body" | "version">;
type PendingChange =
  { type: "new" } | { type: "open"; note: PersonalNote } | { type: "reload" };

function updatedLabel(instant: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(instant));
}

async function readResponse<T>(response: Response): Promise<T> {
  let value: T & { error?: string };
  try {
    value = await response.json();
  } catch {
    throw new Error(
      "Notes could not be reached. Your edits are still here. Please try again.",
    );
  }
  if (!response.ok)
    throw new Error(
      value.error || "This note could not be saved. Please try again.",
    );
  return value;
}

function NotesContent() {
  const fieldId = useId();
  const [notes, setNotes] = useState<PersonalNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(
    null,
  );
  const titleInput = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const original = draft
    ? notes.find((note) => note.id === draft.id)
    : undefined;
  const dirty = Boolean(
    draft &&
    (original
      ? draft.title !== original.title || draft.body !== original.body
      : draft.title !== "" || draft.body !== ""),
  );

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/notes", { cache: "no-store", signal: controller.signal })
      .then((response) => readResponse<{ notes: PersonalNote[] }>(response))
      .then((result) => {
        if (controller.signal.aborted) return;
        setNotes(result.notes);
        setLoadError("");
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setLoadError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  useEffect(() => {
    if (!dirty && !busy) return;
    function warnBeforeLeaving(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [dirty, busy]);

  useLayoutEffect(() => {
    // Focus as the note opens, before another field can receive typing.
    // A deferred animation-frame callback can steal focus from the body.
    titleInput.current?.focus();
  }, [draft?.id]);

  function openDraft(next: NoteDraft) {
    setDraft(next);
    setSaveError("");
    setConflict(false);
    setSaved(false);
  }

  async function changeNote(change: PendingChange) {
    setPendingChange(null);
    if (change.type === "new") {
      openDraft({ id: crypto.randomUUID(), title: "", body: "", version: 0 });
      return;
    }
    if (change.type === "open") {
      openDraft(change.note);
      return;
    }
    if (!draft) return;
    setBusy(true);
    setSaveError("");
    try {
      const result = await readResponse<{ notes: PersonalNote[] }>(
        await fetch("/api/notes", { cache: "no-store" }),
      );
      if (!active.current) return;
      const latest = result.notes.find((note) => note.id === draft.id);
      if (!latest) {
        setSaveError(
          "The saved note could not be found. Your edits are still here; you can keep them as a new note.",
        );
        return;
      }
      setNotes(result.notes);
      openDraft(latest);
    } catch (error) {
      if (active.current) setSaveError((error as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  }

  function requestChange(change: PendingChange) {
    if (busy) return;
    if (change.type === "open" && change.note.id === draft?.id) return;
    if (dirty) setPendingChange(change);
    else void changeNote(change);
  }

  async function saveNote(event: FormEvent) {
    event.preventDefault();
    if (!draft || busy || conflict || !draft.title.trim()) return;
    setBusy(true);
    setSaveError("");
    setSaved(false);
    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: draft.id,
          title: draft.title,
          body: draft.body,
          expectedVersion: draft.version,
        }),
      });
      if (!active.current) return;
      if (response.status === 409) setConflict(true);
      const { note } = await readResponse<{ note: PersonalNote }>(response);
      if (!active.current) return;
      setNotes((current) =>
        [note, ...current.filter((entry) => entry.id !== note.id)].sort(
          (a, b) => b.updatedAt.localeCompare(a.updatedAt),
        ),
      );
      setDraft(note);
      setSaved(true);
    } catch (error) {
      if (active.current) setSaveError((error as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  }

  function editDraft(field: "title" | "body", value: string) {
    setDraft((current) => (current ? { ...current, [field]: value } : current));
    setSaved(false);
  }

  return (
    <section className="notes-panel" aria-label="Personal notes">
      <div className="notes-toolbar">
        <p className="notes-privacy">
          <LockKeyhole size={14} aria-hidden="true" /> Private to you · separate
          from your calendar
        </p>
        <button
          className="primary"
          disabled={loading || Boolean(loadError) || busy}
          onClick={() => requestChange({ type: "new" })}
        >
          <Plus size={16} aria-hidden="true" /> New note
        </button>
      </div>

      {loading ? (
        <div className="notes-loading" role="status">
          Opening your notes…
        </div>
      ) : loadError ? (
        <div className="notes-load-error">
          <p className="error" role="alert">
            {loadError}
          </p>
          <button
            className="secondary"
            onClick={() => {
              setLoading(true);
              setLoadError("");
              setReloadKey((key) => key + 1);
            }}
          >
            <RefreshCw size={15} aria-hidden="true" /> Retry loading notes
          </button>
        </div>
      ) : (
        <div className="notes-layout">
          <aside className="notes-directory" aria-label="Saved notes">
            <div className="notes-directory-heading">
              <h2>Your notes</h2>
              <span>{notes.length}</span>
            </div>
            {notes.length === 0 ? (
              <p className="notes-directory-empty">
                Your saved notes will appear here, each with its own title.
              </p>
            ) : (
              <ul className="notes-list">
                {notes.map((note) => (
                  <li key={note.id}>
                    <button
                      className={`notes-list-item ${draft?.id === note.id ? "is-selected" : ""}`}
                      aria-current={draft?.id === note.id ? "true" : undefined}
                      disabled={busy}
                      onClick={() => requestChange({ type: "open", note })}
                    >
                      <span className="notes-list-title">{note.title}</span>
                      <span className="notes-list-preview">
                        {note.body.trim() ? note.body : "No text yet"}
                      </span>
                      <span className="notes-list-date">
                        Updated {updatedLabel(note.updatedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          {draft ? (
            <form
              className="notes-editor"
              onSubmit={saveNote}
              aria-label="Note editor"
            >
              <div className="notes-editor-heading">
                <p className="eyebrow">
                  {draft.version === 0 ? "NEW NOTE" : "PERSONAL NOTE"}
                </p>
                <span
                  className={`notes-save-status ${saved ? "is-saved" : ""}`}
                  role="status"
                  aria-live="polite"
                >
                  {busy ? (
                    "Saving or loading…"
                  ) : saved ? (
                    <>
                      <Check size={14} aria-hidden="true" /> Saved
                    </>
                  ) : dirty ? (
                    "Unsaved changes"
                  ) : draft.version ? (
                    "Saved note"
                  ) : (
                    "Not saved yet"
                  )}
                </span>
              </div>
              <div className="notes-title-field">
                <label
                  htmlFor={`${fieldId}-title`}
                  style={{ marginBottom: 10 }}
                >
                  Title
                </label>
                <input
                  id={`${fieldId}-title`}
                  ref={titleInput}
                  value={draft.title}
                  onChange={(event) => editDraft("title", event.target.value)}
                  placeholder="e.g. Websites to build from scratch"
                  maxLength={NOTE_TITLE_MAX_LENGTH}
                  required
                  disabled={busy}
                  autoComplete="off"
                />
              </div>
              <div className="notes-body-field">
                <label htmlFor={`${fieldId}-body`} style={{ marginBottom: 10 }}>
                  Note
                </label>
                <textarea
                  id={`${fieldId}-body`}
                  value={draft.body}
                  onChange={(event) => editDraft("body", event.target.value)}
                  placeholder="Write your list, ideas, or anything you want to keep here…"
                  maxLength={NOTE_BODY_MAX_LENGTH}
                  rows={13}
                  disabled={busy}
                />
              </div>
              <div className="notes-editor-footer">
                <p>Saved only when you choose Save note.</p>
                <button
                  type="submit"
                  className="primary"
                  disabled={
                    busy ||
                    conflict ||
                    !draft.title.trim() ||
                    (draft.version > 0 && !dirty)
                  }
                >
                  <Save size={15} aria-hidden="true" />{" "}
                  {busy ? "Please wait…" : "Save note"}
                </button>
              </div>
              {saveError && (
                <div className="notes-save-error">
                  <p className="error" role="alert">
                    {saveError}
                    {conflict &&
                      " Your edits are still here and have not overwritten the saved note."}
                  </p>
                  {conflict && (
                    <div className="notes-conflict-actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => requestChange({ type: "reload" })}
                      >
                        <RefreshCw size={15} aria-hidden="true" /> Reload saved
                        note
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          openDraft({
                            ...draft,
                            id: crypto.randomUUID(),
                            version: 0,
                          })
                        }
                      >
                        <Plus size={15} aria-hidden="true" /> Keep edits as a
                        new note
                      </button>
                    </div>
                  )}
                </div>
              )}
            </form>
          ) : (
            <div className="notes-welcome">
              <span className="notes-welcome-icon">
                <FileText size={28} aria-hidden="true" />
              </span>
              <p className="eyebrow">A LITTLE SPACE TO THINK</p>
              <h2>
                {notes.length
                  ? "Pick up where you left off."
                  : "Make room for your ideas."}
              </h2>
              <p>
                {notes.length
                  ? "Open a saved note to read or edit it, or start a separate note for something new."
                  : "Keep website lists, reminders, and rough ideas together. Give each note a title, then save it here."}
              </p>
              <button
                className="primary"
                onClick={() => requestChange({ type: "new" })}
              >
                <Plus size={16} aria-hidden="true" /> Create a note
              </button>
            </div>
          )}
        </div>
      )}

      <Modal
        open={pendingChange !== null}
        onClose={() => setPendingChange(null)}
        title="Keep your unsaved edits?"
        description="This note has changes you have not saved. Keep editing to save them, or discard those edits to continue."
      >
        <div className="form-actions notes-discard-actions">
          <button className="primary" onClick={() => setPendingChange(null)}>
            Keep editing
          </button>
          <button
            className="secondary"
            onClick={() => {
              if (pendingChange) void changeNote(pendingChange);
            }}
          >
            Discard edits
          </button>
        </div>
      </Modal>
    </section>
  );
}

export function NotesPanel({ actorId }: { actorId: string }) {
  return <NotesContent key={actorId} />;
}
