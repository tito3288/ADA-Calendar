"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CalendarDays, Check, MessageCircle, Mic, RotateCcw, Sparkles, Square, Undo2, X } from "lucide-react";
import type { AppState } from "@/lib/types";
import type { WorkspaceChatRequest, WorkspaceChatResponse, WorkspaceChatSource } from "@/lib/workspace-chat";
import { latestWorkspaceChatChange } from "@/lib/workspace-chat";
import { undoUnavailableReason } from "@/lib/undo";
import { addDays, isDate, localDate, minutesBetween } from "@/lib/time";
import { api, dateLabel, timeLabel } from "./ui";

type ChatMessage = { id: string; role: "user" | "assistant"; text: string; sources?: WorkspaceChatSource[]; asOf?: string };
const hoursLabel = (minutes: number) => `${Number((minutes / 60).toFixed(2))}h`;
function bookingLabel(start: string | null, end: string | null, timeZone: string) {
  if (!start || !end) return "Not booked";
  return `${dateLabel(localDate(start, timeZone))} · ${timeLabel(start, timeZone)}–${timeLabel(end, timeZone)} · ${hoursLabel(minutesBetween(start, end))}`;
}

/** Recording is mounted only while the chat is open. Closing releases the mic,
 * cancels transcription, and never sends the transcript as an instruction. */
function ChatVoice({ disabled, onText, onError, onBusy }: {
  disabled: boolean; onText: (text: string) => void; onError: (error: string) => void; onBusy: (busy: boolean) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const callbacks = useRef({ onText, onError, onBusy });
  useEffect(() => { callbacks.current = { onText, onError, onBusy }; }, [onText, onError, onBusy]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      controller.current?.abort();
      if (recorder.current?.state === "recording") recorder.current.stop();
      recorder.current?.stream.getTracks().forEach(track => track.stop());
      callbacks.current.onBusy(false);
    };
  }, []);
  async function record() {
    if (recording) { recorder.current?.stop(); return; }
    callbacks.current.onError("");
    callbacks.current.onBusy(true);
    setRequesting(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("Recording is unavailable in this browser. You can type your question instead.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current) { stream.getTracks().forEach(track => track.stop()); return; }
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(type => MediaRecorder.isTypeSupported(type));
      let media: MediaRecorder;
      try { media = new MediaRecorder(stream, mimeType ? { mimeType } : undefined); }
      catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
      recorder.current = media;
      const chunks: BlobPart[] = [];
      media.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      media.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        if (timer.current) clearTimeout(timer.current);
        if (!alive.current) return;
        setRecording(false); setTranscribing(true);
        controller.current = new AbortController();
        try {
          const body = new FormData();
          body.append("audio", new Blob(chunks, { type: media.mimeType }), media.mimeType.includes("mp4") ? "chat.mp4" : "chat.webm");
          body.append("operationId", crypto.randomUUID());
          const response = await fetch("/api/transcribe", { method: "POST", body, signal: controller.current.signal });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "The recording could not be transcribed.");
          if (alive.current) callbacks.current.onText(result.transcript);
        } catch (error) {
          if (alive.current) callbacks.current.onError((error as Error).message);
        } finally {
          if (alive.current) { setTranscribing(false); callbacks.current.onBusy(false); }
        }
      };
      media.start(); setRecording(true);
      timer.current = setTimeout(() => { if (media.state === "recording") media.stop(); }, 118_000);
    } catch (error) {
      recorder.current?.stream.getTracks().forEach(track => track.stop());
      if (alive.current) { callbacks.current.onError((error as Error).message); callbacks.current.onBusy(false); }
    } finally { if (alive.current) setRequesting(false); }
  }
  return <button type="button" className={`workspace-chat-voice ${recording ? "recording" : ""}`} disabled={disabled || transcribing || requesting} onClick={record}>
    {recording ? <Square size={15} /> : <Mic size={16} />}{recording ? "Stop recording" : transcribing ? "Transcribing…" : "Speak"}
  </button>;
}

export function WorkspaceChat({ state, hidden, onState }: { state: AppState; hidden?: boolean; onState: (next: AppState) => void }) {
  const today = localDate(new Date().toISOString(), state.settings.timeZone);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today);
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<WorkspaceChatResponse | null>(null);
  const [replyToOperationId, setReplyToOperationId] = useState<string | undefined>();
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastRequest, setLastRequest] = useState<{ text: string; date: string; parent?: string } | null>(null);
  const [undoCheckId, setUndoCheckId] = useState<string | null>(null);
  const [, refreshUndoClock] = useState(0);
  const transcript = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stale = Boolean(pending && state.version > pending.stateVersion);
  const reorderOnly = pending?.reply.proposal?.commands.every(command => command.type === "reorder_day") ?? true;
  const owner = state.actor.role === "owner";
  const unresolvedUndoId = undoCheckId && !state.events.some(event => event.id === undoCheckId && event.undoneBy) ? undoCheckId : null;
  const lastChange = (unresolvedUndoId ? state.events.find(event => event.id === unresolvedUndoId) : undefined) ?? latestWorkspaceChatChange(state);
  const undoReason = lastChange ? undoUnavailableReason(state, lastChange, new Date().toISOString()) : null;
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => refreshUndoClock(value => value + 1), 15_000);
    return () => clearInterval(timer);
  }, [open]);
  useEffect(() => {
    const container = transcript.current;
    if (!open || !container) return;
    // Start a new preview at its heading and hour summary, not at Confirm.
    // Long booking changes remain scrollable without hiding what will change.
    const top = pending && preview.current
      ? container.scrollTop + preview.current.getBoundingClientRect().top - container.getBoundingClientRect().top - 12
      : container.scrollHeight;
    container.scrollTo({ top });
  }, [open, messages.length, pending, busy]);
  function changeText(value: string) {
    setText(value); setOperationId(crypto.randomUUID());
  }
  function acceptReply(result: WorkspaceChatResponse) {
    setMessages(current => [...current, { id: crypto.randomUUID(), role: "assistant" as const, text: result.reply.message, sources: result.reply.sources, asOf: result.asOf }].slice(-40));
    setPending(result.reply.kind === "preview" && result.reply.proposal ? result : null);
    setReplyToOperationId(result.operationId);
    if (result.contextDate && isDate(result.contextDate)) setDate(result.contextDate);
    if (result.state) onState(result.state);
  }
  async function post(body: WorkspaceChatRequest) {
    const response = await fetch("/api/workspace-chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json() as WorkspaceChatResponse;
    return { response, result };
  }
  async function send(value = text, refreshing = false) {
    if (!value.trim() || busy || voiceBusy || unresolvedUndoId) return;
    const request = refreshing && lastRequest ? lastRequest : { text: value, date, parent: replyToOperationId };
    setBusy(true); setError("");
    try {
      const { response, result } = await post({ action: "message", text: request.text, date: request.date,
        operationId: refreshing ? crypto.randomUUID() : operationId,
        ...(request.parent ? { replyToOperationId: request.parent } : {}) });
      if (!response.ok) {
        if (result.retryWithNewOperation) setOperationId(crypto.randomUUID());
        if (result.resetNeeded) { setReplyToOperationId(undefined); setPending(null); setOperationId(crypto.randomUUID()); }
        throw new Error(result.error || "ADA could not check your workspace. Please try again.");
      }
      if (!refreshing) setMessages(current => [...current, { id: crypto.randomUUID(), role: "user" as const, text: request.text }].slice(-39));
      acceptReply(result);
      setLastRequest(request); setText(""); setOperationId(crypto.randomUUID());
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function confirm() {
    const proposal = pending?.reply.proposal;
    if (!pending || !proposal?.reviewFingerprint || stale || busy || voiceBusy || text.trim() || unresolvedUndoId) return;
    setBusy(true); setError("");
    try {
      const { response, result } = await post({ action: "confirm", operationId: pending.operationId, baseVersion: proposal.baseVersion, reviewFingerprint: proposal.reviewFingerprint });
      if (!response.ok) {
        if (result.reply) acceptReply(result);
        if (result.resetNeeded) { setPending(null); setReplyToOperationId(undefined); }
        throw new Error(result.error || "The schedule changed. Review the latest times before confirming again.");
      }
      if (result.state) onState(result.state);
      setPending(null);
      setMessages(current => [...current, { id: crypto.randomUUID(), role: "assistant" as const, text: `Your schedule is updated. ${result.reply.message}` }].slice(-40));
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  function sameIdentity(next: AppState) {
    return next.workspaceId === state.workspaceId && next.actor.id === state.actor.id && next.actor.role === state.actor.role;
  }
  function undoSucceeded(next: AppState) {
    onState(next); setPending(null); setUndoCheckId(null); setReplyToOperationId(undefined);
    setLastRequest(null); setOperationId(crypto.randomUUID()); setError("");
    setMessages(current => [...current, { id: crypto.randomUUID(), role: "assistant" as const,
      text: "That ADA change was undone. The previous bookings and project details were restored. No new projects were created." }].slice(-40));
  }
  async function checkUndo(id: string, originalError?: string) {
    const next = await api<AppState>("state");
    if (!sameIdentity(next)) throw new Error("The signed-in workspace changed. Refresh the page before continuing.");
    onState(next);
    const event = next.events.find(entry => entry.id === id);
    if (event?.undoneBy) undoSucceeded(next);
    else {
      setUndoCheckId(null);
      setError(event ? undoUnavailableReason(next, event, new Date().toISOString()) || originalError || "Undo has not been applied. You can try again while this change is still eligible." : "This change is no longer available. Check Activity & email before continuing.");
    }
  }
  async function undoLastChange() {
    if (busy || voiceBusy || pending || text.trim()) return;
    const event = lastChange;
    if (!unresolvedUndoId && (!event || undoReason)) return;
    setBusy(true); setError("");
    const id = unresolvedUndoId ?? event!.id;
    try {
      if (unresolvedUndoId) await checkUndo(id);
      else {
        const result = await api("undo", { id });
        if (!sameIdentity(result.state)) throw new Error("The signed-in workspace changed. Refresh the page before continuing.");
        undoSucceeded(result.state);
      }
    } catch (error) {
      // A lost HTTP response may follow a successful transaction. Read the
      // bound event before offering a retry; never undo a newer event instead.
      try { await checkUndo(id, (error as Error).message); }
      catch {
        setUndoCheckId(id);
        setError("I could not confirm whether Undo finished. Check undo status before making another change; this only reads the saved schedule.");
      }
    } finally { setBusy(false); }
  }
  function reset() {
    setMessages([]); setPending(null); setReplyToOperationId(undefined); setText(""); setError(""); setLastRequest(null); setOperationId(crypto.randomUUID());
    input.current?.focus();
  }
  if (state.actor.role === "viewer") return null;
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild>
      <button type="button" className="workspace-chat-launcher" hidden={hidden && !open} aria-label="Open ADA helper" title="Chat about your workload">
        <MessageCircle size={21} /><span>ADA</span>{busy && <i aria-label="ADA is working" />}
      </button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="workspace-chat-overlay" />
      <Dialog.Content className="workspace-chat-dialog" onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); }}>
        <header className="workspace-chat-header">
          <span className="workspace-chat-mark"><Sparkles size={22} /></span>
          <div><Dialog.Title>ADA helper</Dialog.Title><Dialog.Description>Your workload, in conversation.</Dialog.Description></div>
          <Dialog.Close className="icon-button" aria-label="Close ADA helper"><X size={19} /></Dialog.Close>
        </header>
        <div className="workspace-chat-context">
          <label><CalendarDays size={14} />Day to discuss<input aria-label="Day to discuss" type="date" value={date} disabled={busy || voiceBusy} onChange={event => { setDate(event.target.value); setPending(null); setOperationId(crypto.randomUUID()); }} /></label>
          <div><button type="button" disabled={busy || voiceBusy} onClick={() => { setDate(today); setPending(null); setOperationId(crypto.randomUUID()); }}>Today</button><button type="button" disabled={busy || voiceBusy} onClick={() => { setDate(addDays(today, 1)); setPending(null); setOperationId(crypto.randomUUID()); }}>Tomorrow</button></div>
        </div>
        <div className="workspace-chat-transcript" ref={transcript}>
          {!messages.length && <div className="workspace-chat-welcome">
            <h3>A little clarity for your day.</h3>
            <p>Ask about saved work{owner ? ", requests, or your private notes" : " or requests"}.{owner ? " I can also add or adjust booked hours and move existing work." : " Your chat is read-only."} No new tasks are created here.</p>
            <div className="workspace-chat-suggestions">
              {["What is on my schedule today?", "How busy am I this week?", "Which websites do I need to build from scratch?"].map(question => <button type="button" key={question} disabled={busy || voiceBusy} onClick={() => { changeText(question); input.current?.focus(); }}>{question}<ArrowUp size={13} /></button>)}
            </div>
          </div>}
          <div role="log" aria-label="Conversation with ADA" aria-live="polite" aria-relevant="additions">
            {messages.map(message => <article className={`workspace-chat-message ${message.role}`} key={message.id}>
              <strong>{message.role === "user" ? "You" : "ADA"}</strong><p>{message.text}</p>
              {!!message.sources?.length && <div className="workspace-chat-sources" aria-label="Sources">{message.sources.slice(0, 12).map(source => <span key={`${source.kind}-${source.id}`}>{source.kind === "note" ? "Private note" : source.kind === "work" ? "Work" : source.kind === "request" ? "Request" : "Schedule"}: {source.title}</span>)}</div>}
              {message.asOf && <small>Checked {dateLabel(localDate(message.asOf, state.settings.timeZone))} at {timeLabel(message.asOf, state.settings.timeZone)}</small>}
            </article>)}
          </div>
          {pending && owner && <section ref={preview} className="workspace-chat-preview" aria-label={reorderOnly ? "Proposed schedule order" : "Proposed schedule changes"}>
            <p className="eyebrow">PREVIEW · NOT SAVED</p><h3>{reorderOnly ? "Review the new order" : "Review your booking changes"}</h3>
            <p>{reorderOnly ? "Only these session times change. Tasks, hours, and other bookings stay intact." : "Only the changes shown here will be saved. Your project estimate stays separate from booked hours."}</p>
            {pending.reply.totals && <div className="workspace-chat-hour-impact" role="status">
              <strong>{pending.reply.totals.deltaMinutes < 0 ? `${hoursLabel(-pending.reply.totals.deltaMinutes)} freed` : pending.reply.totals.deltaMinutes > 0 ? `${hoursLabel(pending.reply.totals.deltaMinutes)} added` : "Same hours · new times"}</strong>
              <span>{hoursLabel(pending.reply.totals.beforeMinutes)} → {hoursLabel(pending.reply.totals.afterMinutes)} across these bookings</span>
            </div>}
            <ol>{pending.reply.changes?.map(change => <li key={change.sessionId}><strong>{change.clientName} · {change.title}</strong>
              <span>{bookingLabel(change.beforeStart, change.beforeEnd, state.settings.timeZone)}<ArrowDown size={13} aria-label="changes to" /><b>{bookingLabel(change.afterStart, change.afterEnd, state.settings.timeZone)}</b></span>
            </li>)}</ol>
            {!!pending.reply.dayImpacts?.length && <div className="workspace-chat-day-impacts" aria-label="Daily availability after these changes">{pending.reply.dayImpacts.map(day => <p key={day.date}><span>{dateLabel(day.date)}</span><strong>{hoursLabel(day.afterAvailableMinutes)} left</strong><small>{hoursLabel(day.afterPlannedMinutes)} planned · {hoursLabel(day.capacityMinutes)} daily capacity</small></p>)}</div>}
            {!!pending.reply.details?.length && <ul className="workspace-chat-details">{pending.reply.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul>}
            {stale && <p className="workspace-chat-warning" role="status">Your calendar changed since this preview. Check the latest times before saving.</p>}
            {text.trim() && <p className="micro muted">Send your follow-up or clear the message before confirming this preview.</p>}
            <div className="workspace-chat-preview-actions">
              <button type="button" className="secondary" disabled={busy || voiceBusy} onClick={() => setPending(null)}>Discard preview</button>
              {stale ? <button type="button" className="primary" disabled={busy || voiceBusy || !!text.trim() || !lastRequest} onClick={() => send(lastRequest?.text, true)}>Refresh preview</button>
                : <button type="button" className="primary" disabled={busy || voiceBusy || !!text.trim() || !pending.reply.proposal?.reviewFingerprint || !pending.reply.changes?.length} onClick={confirm}><Check size={15} />{reorderOnly ? "Confirm new order" : "Confirm schedule changes"}</button>}
            </div>
          </section>}
          {owner && lastChange && <section className="workspace-chat-undo" aria-label="Last ADA schedule change">
            <p className="eyebrow">{lastChange.undoneBy ? "CHANGE UNDONE" : "SAVED ADA CHANGE"}</p>
            <h3>{lastChange.undoneBy ? "Your previous schedule is restored." : "A way back, if you need it."}</h3>
            <p className="workspace-chat-undo-summary">{lastChange.summary.join(" ")}</p>
            <small>{dateLabel(localDate(lastChange.createdAt, state.settings.timeZone))} at {timeLabel(lastChange.createdAt, state.settings.timeZone)}</small>
            {!lastChange.undoneBy && <>
              <p>{unresolvedUndoId ? "Check whether the last undo finished before continuing." : undoReason || "Restore the bookings and project details from before this change. Newer changes or already-started work can prevent undo."}</p>
              {(pending || text.trim()) && <p>Finish or discard your preview, and send or clear your draft before undoing.</p>}
              <button type="button" className="secondary" onClick={undoLastChange} disabled={busy || voiceBusy || !!pending || !!text.trim() || (!unresolvedUndoId && !!undoReason)}>
                <Undo2 size={16} />{unresolvedUndoId ? "Check undo status" : "Undo last change"}
              </button>
            </>}
          </section>}
          {busy && <p className="workspace-chat-working" role="status">ADA is checking your current workspace…</p>}
        </div>
        <form className="workspace-chat-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
          {error && <p className="error" role="alert">{error}</p>}
          <label className="sr-only" htmlFor="workspace-chat-input">Message ADA helper</label>
          <textarea id="workspace-chat-input" ref={input} rows={3} maxLength={6000} value={text} disabled={busy || voiceBusy} onChange={event => changeText(event.target.value)} placeholder={owner ? "Ask about work, change its hours, or move a booking…" : "Ask about scheduled work or requests…"} />
          <div className="workspace-chat-composer-actions">
            <ChatVoice disabled={busy} onBusy={setVoiceBusy} onText={value => changeText([text, value].filter(Boolean).join(" ").slice(0, 6000))} onError={setError} />
            <button type="button" className="workspace-chat-reset" disabled={busy || voiceBusy} onClick={reset}><RotateCcw size={14} />New chat</button>
            <button type="submit" className="primary icon-button" aria-label="Send to ADA helper" disabled={busy || voiceBusy || !!unresolvedUndoId || !text.trim() || !date}><ArrowUp size={19} /></button>
          </div>
          <p className="workspace-chat-footnote">{voiceBusy ? "Speak, then review the transcript before sending." : owner ? "Questions are read-only. Schedule changes need your confirmation." : "Read-only access. Only Bryan can edit existing work."}</p>
          {state.mode === "demo" && <p className="workspace-chat-demo">Local demo · limited sample replies; no live AI or email.</p>}
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
