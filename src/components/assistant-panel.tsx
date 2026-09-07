"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Mic, Square, Sparkles, Undo2 } from "lucide-react";
import type { AppState, Interpretation, ScheduleProposal } from "@/lib/types";
import { api, ApiError } from "./ui";
import { ProposalCard } from "./work-form";

export function AssistantPanel({
  state,
  onState,
}: {
  state: AppState;
  onState: (s: AppState) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<{ author: string; text: string }[]>(
    [],
  );
  const [proposal, setProposal] = useState<ScheduleProposal | null>(null);
  const [undo, setUndo] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [replyToOperationId, setReplyToOperationId] = useState<string | null>(null);
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
      }>("assistant", { text, operationId, ...(replyToOperationId ? { replyToOperationId } : {}) });
      setMessages((m) => [
        ...m,
        { author: state.actor.name, text },
        { author: "ADA", text: r.interpretation.message },
      ]);
      onState(r.state);
      setProposal(r.proposal?.status !== "ready" ? (r.proposal ?? null) : null);
      setUndo(r.interpretation.kind === "undo");
      setReplyToOperationId(r.replyToOperationId);
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
        {replyToOperationId && (
          <div className="demo-note">
            <p>Your reply will continue the pending instruction above.</p>
            <button type="button" className="secondary" disabled={busy || recording} onClick={() => {
              setReplyToOperationId(null);
              setOperationId(crypto.randomUUID());
              setProposal(null);
              setUndo(false);
              setError("");
              setMessages([]);
            }}>Start a new instruction</button>
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
