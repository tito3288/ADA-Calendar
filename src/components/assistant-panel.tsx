"use client";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { ArrowUp, Mic, Square, Sparkles, Undo2 } from "lucide-react";
import type { AppState, Interpretation, ScheduleProposal } from "@/lib/types";
import { api, ApiError } from "./ui";
import { ProposalCard } from "./work-form";
import {
  dateSelectionSchema,
  type AssistantDateSelection,
} from "@/lib/assistant-date-selection";
import { dateLabel } from "./ui";

export type AssistantDraft = {
  text: string;
  busy: boolean;
  messages: { author: string; text: string }[];
  proposal: ScheduleProposal | null;
  undo: boolean;
  operationId: string;
  replyToOperationId: string | null;
};
export function emptyAssistantDraft(): AssistantDraft {
  return {
    text: "",
    busy: false,
    messages: [],
    proposal: null,
    undo: false,
    operationId: crypto.randomUUID(),
    replyToOperationId: null,
  };
}
export function selectedDatesLabel(selection: AssistantDateSelection) {
  const options = { month: "short", day: "numeric", year: "numeric" } as const;
  return selection.start === selection.end
    ? dateLabel(selection.start, options)
    : `${dateLabel(selection.start, options)} – ${dateLabel(selection.end, options)}`;
}

export function AssistantPanel({
  state,
  onState,
  draft,
  onDraft,
  dateSelection,
  onDateSelection,
}: {
  state: AppState;
  onState: (s: AppState) => void;
  draft: AssistantDraft;
  onDraft: Dispatch<SetStateAction<AssistantDraft>>;
  dateSelection: AssistantDateSelection | null;
  onDateSelection: (selection: AssistantDateSelection | null) => void;
}) {
  const {
    text,
    busy,
    messages,
    proposal,
    undo,
    operationId,
    replyToOperationId,
  } = draft;
  function setField<K extends keyof AssistantDraft>(
    key: K,
    value: SetStateAction<AssistantDraft[K]>,
  ) {
    onDraft((current) => ({
      ...current,
      [key]:
        typeof value === "function"
          ? (value as (previous: AssistantDraft[K]) => AssistantDraft[K])(
              current[key],
            )
          : value,
    }));
  }
  const setText = (value: SetStateAction<string>) => setField("text", value);
  const setBusy = (value: boolean) => setField("busy", value);
  const setMessages = (value: SetStateAction<AssistantDraft["messages"]>) =>
    setField("messages", value);
  const setProposal = (value: ScheduleProposal | null) =>
    setField("proposal", value);
  const setUndo = (value: boolean) => setField("undo", value);
  const setOperationId = (value: string) => setField("operationId", value);
  const setReplyToOperationId = (value: string | null) =>
    setField("replyToOperationId", value);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [editingDates, setEditingDates] = useState(false);
  const [dateStart, setDateStart] = useState(dateSelection?.start ?? "");
  const [dateEnd, setDateEnd] = useState(dateSelection?.end ?? "");
  const [dateKind, setDateKind] = useState<AssistantDateSelection["kind"]>(
    dateSelection?.kind ?? "work_window",
  );
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      recorder.current?.stream.getTracks().forEach((t) => t.stop());
    };
  }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{
        interpretation: Interpretation;
        state: AppState;
        proposal?: ScheduleProposal;
        replyToOperationId: string | null;
        dateSelection?: AssistantDateSelection | null;
      }>("assistant", {
        text,
        operationId,
        dateSelection,
        ...(replyToOperationId ? { replyToOperationId } : {}),
      });
      setMessages((m) => [
        ...m,
        {
          author: state.actor.name,
          text: dateSelection
            ? `${text}\nSelected ${dateSelection.kind === "project_span" ? "project timeline" : "work dates"}: ${selectedDatesLabel(dateSelection)}`
            : text,
        },
        { author: "ADA", text: r.interpretation.message },
      ]);
      onState(r.state);
      setProposal(
        r.proposal &&
          (r.proposal.status !== "ready" || r.proposal.requiresApproval)
          ? r.proposal
          : null,
      );
      setUndo(r.interpretation.kind === "undo");
      setReplyToOperationId(r.replyToOperationId);
      const pending =
        r.replyToOperationId ||
        (r.proposal &&
          (r.proposal.status !== "ready" || r.proposal.requiresApproval));
      onDateSelection(
        r.dateSelection === undefined
          ? pending
            ? dateSelection
            : null
          : r.dateSelection,
      );
      setEditingDates(false);
      setText("");
      setOperationId(crypto.randomUUID());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function record() {
    setError("");
    if (recording) {
      recorder.current?.stop();
      return;
    }
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
        throw new Error(
          "This browser does not support recording. You can type the same instruction below.",
        );
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(
        (t) => MediaRecorder.isTypeSupported(t),
      );
      const media = new MediaRecorder(
        stream,
        mime ? { mimeType: mime } : undefined,
      );
      recorder.current = media;
      const chunks: BlobPart[] = [];
      media.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      media.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timer.current) clearTimeout(timer.current);
        if (!alive.current) return;
        setRecording(false);
        setBusy(true);
        try {
          const body = new FormData();
          const blob = new Blob(chunks, { type: media.mimeType });
          body.append(
            "audio",
            blob,
            media.mimeType.includes("mp4") ? "recording.mp4" : "recording.webm",
          );
          body.append("operationId", crypto.randomUUID());
          const response = await fetch("/api/transcribe", {
            method: "POST",
            body,
          });
          const result = await response.json();
          if (!response.ok)
            throw new Error(result.error || "Transcription failed.");
          setText((t) => [t, result.transcript].filter(Boolean).join(" "));
          setOperationId(crypto.randomUUID());
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      };
      media.start();
      setRecording(true);
      timer.current = setTimeout(() => {
        if (media.state === "recording") media.stop();
      }, 118_000);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="assistant-panel">
      <div className="assistant-intro">
        <span className="assistant-orb">
          <Sparkles size={22} />
        </span>
        <h3>Tell me what’s on your plate.</h3>
        <p className="muted">
          The client, the work, the effort, and when it needs to happen. I’ll
          work out the schedule.
        </p>
      </div>
      {state.mode === "demo" && (
        <p className="demo-note">
          Local preview: a limited, deterministic parser is available. Use an
          exact client name, ISO dates (YYYY-MM-DD), and hours. Live voice and
          flexible language require your OpenAI key.
        </p>
      )}
      <div className="assistant-messages" aria-live="polite">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`chat-message ${m.author === "ADA" ? "from-ada" : ""}`}
          >
            <strong>{m.author}</strong>
            <p>{m.text}</p>
          </div>
        ))}
      </div>
      {proposal && (
        <ProposalCard
          state={state}
          proposal={proposal}
          busy={busy}
          onCommit={async (request) => {
            setBusy(true);
            try {
              onState(
                (
                  await api("commands", {
                    commands: proposal.commands,
                    operationId: proposal.operationId,
                    baseVersion: proposal.baseVersion,
                    reviewFingerprint: proposal.reviewFingerprint,
                    action: request ? "request" : "commit",
                  })
                ).state,
              );
              setProposal(null);
              onDateSelection(null);
            } catch (e) {
              setError((e as Error).message);
              if (e instanceof ApiError && e.proposal) setProposal(e.proposal);
              if (e instanceof ApiError && e.state) onState(e.state);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {undo && (
        <button
          className="secondary"
          disabled={!state.events.length}
          onClick={async () => {
            try {
              onState((await api("undo", { id: state.events[0].id })).state);
              setUndo(false);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <Undo2 size={16} />
          Undo latest unchanged event
        </button>
      )}
      <form onSubmit={submit} className="assistant-composer">
        <div className="assistant-date-context">
          <div>
            <strong>
              {dateSelection
                ? `Selected ${dateSelection.kind === "project_span" ? "project timeline" : "work dates"}`
                : "Dates from your instruction"}
            </strong>
            <p aria-live="polite">
              {dateSelection
                ? selectedDatesLabel(dateSelection)
                : "You can still type or speak dates naturally."}
            </p>
            {dateSelection && (
              <small>
                {dateSelection.kind === "project_span"
                  ? "Timeline only. This range does not book work sessions."
                  : "Schedule within this range, not on every day. Nothing is reserved until you send."}
              </small>
            )}
          </div>
          <div className="date-context-actions">
            <button
              type="button"
              className="text-button"
              disabled={busy || recording || Boolean(proposal)}
              onClick={() => {
                setDateStart(dateSelection?.start ?? "");
                setDateEnd(dateSelection?.end ?? "");
                setDateKind(dateSelection?.kind ?? "work_window");
                setEditingDates(!editingDates);
              }}
            >
              {dateSelection ? "Change dates" : "Choose dates"}
            </button>
            {dateSelection && (
              <button
                type="button"
                className="text-button"
                disabled={busy || recording || Boolean(proposal)}
                onClick={() => {
                  onDateSelection(null);
                  setOperationId(crypto.randomUUID());
                  setEditingDates(false);
                }}
              >
                Clear dates
              </button>
            )}
          </div>
        </div>
        {editingDates && (
          <div className="assistant-date-editor">
            <label>
              Start date
              <input
                type="date"
                value={dateStart}
                onChange={(e) => setDateStart(e.target.value)}
                disabled={busy}
              />
            </label>
            <label>
              End date
              <input
                type="date"
                value={dateEnd}
                min={dateStart || undefined}
                onChange={(e) => setDateEnd(e.target.value)}
                disabled={busy}
              />
            </label>
            {state.actor.role === "owner" && (
              <label>
                Use dates as
                <select
                  value={dateKind}
                  onChange={(e) =>
                    setDateKind(
                      e.target.value as AssistantDateSelection["kind"],
                    )
                  }
                >
                  <option value="work_window">Work window</option>
                  <option value="project_span">Project timeline only</option>
                </select>
              </label>
            )}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                const selection = dateSelectionSchema.safeParse({
                  start: dateStart,
                  end: dateEnd || dateStart,
                  kind: state.actor.role === "owner" ? dateKind : "work_window",
                });
                if (!selection.success) {
                  setError(selection.error.issues[0].message);
                  return;
                }
                onDateSelection(selection.data);
                setOperationId(crypto.randomUUID());
                setEditingDates(false);
                setError("");
              }}
            >
              Use these dates
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setEditingDates(false)}
            >
              Cancel date changes
            </button>
          </div>
        )}
        {(replyToOperationId || messages.length > 0 || proposal) && (
          <div className="demo-note">
            {replyToOperationId && (
              <p>Your reply will continue the pending instruction above.</p>
            )}
            <button
              type="button"
              className="secondary"
              disabled={busy || recording}
              onClick={() => {
                onDraft(emptyAssistantDraft());
                onDateSelection(null);
                setEditingDates(false);
                setError("");
              }}
            >
              Start a new instruction
            </button>
          </div>
        )}
        <label className="sr-only" htmlFor="assistant-input">
          Instruction for ADA
        </label>
        <textarea
          id="assistant-input"
          rows={5}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOperationId(crypto.randomUUID());
          }}
          placeholder="Higher Ground Tree needs a thank-you page fix. It will take 2 hours. Schedule it for 2026-09-10, normal priority."
          maxLength={12000}
          disabled={busy}
        />
        <div className="composer-bottom">
          <button
            type="button"
            className={`record-button ${recording ? "recording" : ""}`}
            disabled={busy}
            onClick={record}
          >
            {recording ? <Square size={15} /> : <Mic size={17} />}
            {recording ? "Stop recording" : "Speak"}
          </button>
          <span>
            {recording
              ? "Recording · up to 2 minutes"
              : "Type or speak · review your transcript first"}
          </span>
          <button
            className="primary icon-button"
            disabled={busy || recording || !text.trim()}
            aria-label="Send instruction"
          >
            {busy ? "…" : <ArrowUp size={20} />}
          </button>
        </div>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="micro muted">
        Clear work commands save automatically and notify Kyle and William.
        Unclear instructions ask a question. Email suggestions stay drafts until
        you send them.
      </p>
    </div>
  );
}
