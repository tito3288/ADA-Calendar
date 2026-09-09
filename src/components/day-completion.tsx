"use client";

import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import type { AppState, ScheduleProposal, WorkCommand, WorkItem } from "@/lib/types";
import { localDate, minutesBetween } from "@/lib/time";
import { formatHours } from "@/lib/work";
import { api, ApiError, dateLabel, timeLabel } from "./ui";

/** Completing a work day always gets an explicit review before the atomic save. */
export function DayCompletion({ item, date, state, onSaved, onClose }: {
  item: WorkItem; date: string; state: AppState; onSaved: (state: AppState) => void; onClose: () => void;
}) {
  const [operationId] = useState(() => crypto.randomUUID());
  const [proposal, setProposal] = useState<ScheduleProposal | null>(null);
  const [reviewState, setReviewState] = useState<AppState | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const label = dateLabel(date, { weekday: "short", month: "short", day: "numeric" });
  const command: WorkCommand = { type: "complete_day", itemId: item.id, date };
  useEffect(() => {
    let active = true;
    api<{ proposal: ScheduleProposal; state: AppState }>("commands", { commands: [{ type: "complete_day", itemId: item.id, date }], operationId, action: "preview" })
      .then(result => {
        if (!result.state || result.state.version !== result.proposal.baseVersion) throw new Error("The calendar changed. Close this review and try again to see the current hours.");
        if (active) { setReviewState(result.state); setProposal(result.proposal); }
      })
      .catch(reason => { if (active) setError((reason as Error).message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [date, item.id, operationId]);
  const reviewItem = reviewState?.items.find(work => work.id === item.id);
  const timeZone = reviewState?.settings.timeZone ?? state.settings.timeZone;
  const sessions = (reviewState?.sessions ?? []).filter(session => session.workItemId === item.id && session.status === "planned"
    && localDate(session.start, timeZone) === date).sort((a, b) => a.start.localeCompare(b.start));
  const minutes = sessions.reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0);
  const after = proposal?.items.find(work => work.id === item.id);
  const ready = proposal?.status === "ready" && !proposal.requiresApproval && reviewState?.version === proposal.baseVersion && !!reviewItem && minutes > 0;
  async function confirm() {
    if (!proposal || !ready) return;
    setBusy(true); setError("");
    try {
      const result = await api("commands", { commands: [command], operationId, action: "commit", baseVersion: proposal.baseVersion, reviewFingerprint: proposal.reviewFingerprint });
      onSaved(result.state); onClose();
    } catch (reason) {
      if (reason instanceof ApiError) {
        if (reason.proposal) setProposal(reason.proposal);
        if (reason.state) setReviewState(reason.state);
      }
      setError((reason as Error).message);
    } finally { setBusy(false); }
  }
  return <div className="completion-review" role="region" aria-label={`Finish work on ${label}`}>
    <h4><CheckCircle2 size={17} /> Finish {label}</h4>
    {proposal && <>
      {reviewState?.version !== state.version && <p role="status">The calendar changed since you opened this task. Review the current hours below.</p>}
      <p>Mark <strong>{formatHours(minutes)}</strong> of booked work on this day as done.</p>
      <ul>{sessions.map(session => <li key={session.id}>{timeLabel(session.start, timeZone)}–{timeLabel(session.end, timeZone)}</li>)}</ul>
      {reviewItem && <p className="completion-effort">{reviewItem.remainingMinutes === null ? "Remaining effort stays unknown." : `Remaining effort: ${formatHours(reviewItem.remainingMinutes)} → ${formatHours(after?.remainingMinutes ?? reviewItem.remainingMinutes)}`}</p>}
      <p className="micro muted">Other days keep their booked hours. The project stays open until you mark the whole project complete.</p>
      {proposal.conflicts.length > 0 && <p role="alert">{proposal.conflicts.map(conflict => conflict.message).join(" ")}</p>}
    </>}
    {busy && !proposal && <p role="status">Checking this day…</p>}
    {error && <p role="alert">{error}</p>}
    <div className="completion-review-actions">
      <button className="secondary" disabled={busy} onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy || !ready} onClick={confirm}>{busy && proposal ? "Saving…" : "Confirm day finished"}</button>
    </div>
  </div>;
}
