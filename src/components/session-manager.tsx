"use client";

import { useState } from "react";
import { LockKeyhole, Plus, Scissors, Trash2 } from "lucide-react";
import type { AppState, ScheduleProposal, WorkCommand, WorkItem } from "@/lib/types";
import { smartFitRequest, type SmartFitDraft } from "@/lib/smart-fit";
import {
  addDays,
  instantMs,
  localDate,
  minutesBetween,
  nextWorkDate,
} from "@/lib/time";
import {
  draftSession,
  sessionDraft,
  sessionManagementCommands,
  splitSessionDraft,
  type SessionDraft,
} from "@/lib/session-management";
import { formatHours } from "@/lib/work";
import { api, ApiError, Field } from "./ui";
import { ProposalCard } from "./work-form";
import { SchedulingMode, SmartFitFields } from "./smart-fit-fields";

export function SessionManager({
  item,
  state,
  onSaved,
  onClose,
  initialMode = "smart",
}: {
  item: WorkItem;
  state: AppState;
  onSaved: (state: AppState) => void;
  onClose: () => void;
  initialMode?: "smart" | "exact";
}) {
  const zone = state.settings.timeZone;
  const [openedAt] = useState(() => new Date().toISOString());
  const [mode, setMode] = useState(initialMode);
  const [fit, setFit] = useState<SmartFitDraft>(() => {
    const today = localDate(openedAt, zone);
    return { startDate: today, endDate: today, hours: "2", distribution: "total" };
  });
  const original = state.sessions
    .filter(
      (session) =>
        session.workItemId === item.id && session.status === "planned",
    )
    .sort((a, b) => a.start.localeCompare(b.start));
  const [rows, setRows] = useState(() =>
    original.map((session) => sessionDraft(session, zone)),
  );
  const [overrideProtected, setOverrideProtected] = useState(false);
  const [resume, setResume] = useState(initialMode === "smart" && item.status === "waiting");
  const [proposal, setProposal] = useState<ScheduleProposal | null>(null);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = (row: SessionDraft) =>
    original.some(
      (session) =>
        session.id === row.id && instantMs(session.start) < instantMs(openedAt),
    );
  const changedProtected = original.some(
    (session) =>
      session.protected &&
      JSON.stringify(rows.find((row) => row.id === session.id)) !==
        JSON.stringify(sessionDraft(session, zone)),
  );
  let reserved = 0;
  let completeRows = true;
  for (const row of rows) {
    if (locked(row)) continue;
    try {
      const session = draftSession(row, item.id, zone);
      if (instantMs(session.start) >= instantMs(openedAt)) {
        reserved += minutesBetween(session.start, session.end);
      }
    } catch {
      completeRows = false;
    }
  }
  function invalidate() {
    setProposal(null);
    setError("");
    setOperationId(crypto.randomUUID());
  }
  function edit(next: SessionDraft[]) {
    setRows(next);
    setOverrideProtected(false);
    invalidate();
  }
  function patch(id: string, values: Partial<SessionDraft>) {
    edit(rows.map((row) => (row.id === id ? { ...row, ...values } : row)));
  }
  function add() {
    const latest = rows
      .filter((row) => !locked(row))
      .map((row) => row.date)
      .sort()
      .at(-1);
    const today = localDate(new Date().toISOString(), zone);
    const date = nextWorkDate(
      latest
        ? addDays(latest, 1)
        : item.windowStart > today
          ? item.windowStart
          : today,
      state.settings,
    );
    edit([
      ...rows,
      {
        id: crypto.randomUUID(),
        date,
        start: "09:00",
        end: "11:00",
        protected: false,
        usesReserve: false,
      },
    ]);
  }
  function split(row: SessionDraft) {
    try {
      edit(
        rows.flatMap((entry) =>
          entry.id === row.id
            ? splitSessionDraft(row, zone, crypto.randomUUID())
            : [entry],
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function preview() {
    setBusy(true);
    setError("");
    setProposal(null);
    try {
      const commands: WorkCommand[] = mode === "smart" ? [{ type: "fit", itemId: item.id, request: { ...smartFitRequest(fit), resumeWaiting: resume } }] : sessionManagementCommands({
        item,
        original,
        rows,
        zone,
        now: new Date().toISOString(),
        overrideProtected,
        resume,
      });
      const response = await api<{ proposal: ScheduleProposal }>("commands", {
        commands,
        operationId,
        action: "preview",
      });
      setProposal(response.proposal);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!proposal) return;
    setBusy(true);
    setError("");
    try {
      const response = await api("commands", {
        commands: proposal.commands,
        operationId,
        baseVersion: proposal.baseVersion,
        reviewFingerprint: proposal.reviewFingerprint,
        action: "commit",
      });
      onSaved(response.state);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setProposal(e instanceof ApiError ? (e.proposal ?? null) : null);
      if (e instanceof ApiError && e.state) onSaved(e.state);
    } finally {
      setBusy(false);
    }
  }
  if (state.actor.role !== "owner") return null;
  return (
    <div className="session-manager inset">
      <div className="session-manager-heading">
        <h4>Manage sessions</h4>
        <span>Changes are drafts until confirmed.</span>
      </div>
      <p className="micro muted">
        {mode === "smart" ? "Add time to this project without choosing a start time or moving existing bookings." : "Edit, split, or move existing sessions. ADA checks lunch, available hours, minimum focus time, and conflicts before saving."}
      </p>
      <SchedulingMode mode={mode} disabled={busy} onChange={next => { setMode(next); invalidate(); }} />
      <div className="session-manager-budget" aria-live="polite">
        <strong>
          {completeRows ? formatHours(reserved) : "—"} in future sessions
        </strong>
        <span>
          {item.remainingMinutes === null
            ? "Project total stays unknown"
            : `${formatHours(item.remainingMinutes)} remaining effort — unchanged`}
        </span>
      </div>
      {mode === "exact" && item.dailyPlan?.length ? (
        <p className="notice micro">
          Saving redistributes this project’s daily-hour plan to match these
          future sessions. Past bookings are kept as history.
        </p>
      ) : null}
      {item.allowedDates.length > 0 && (
        <p className="micro muted">
          These sessions must stay within this project’s allowed work dates. ADA
          will identify any date that needs a different work window.
        </p>
      )}
      <fieldset disabled={busy} className="session-manager-fields">
        {mode === "smart" ? <SmartFitFields value={fit} settings={state.settings} onChange={next => { setFit(next); invalidate(); }} /> : <>
        {rows.map((row, index) => (
          <div
            className={`session-manager-row ${locked(row) ? "session-manager-history" : ""}`}
            key={row.id}
          >
            <div className="session-manager-row-title">
              <strong>Session {index + 1}</strong>
              {locked(row) && (
                <span>History / already started · read-only</span>
              )}
            </div>
            <div className="form-grid three">
              <Field label={`Session ${index + 1} date`}>
                <input
                  type="date"
                  value={row.date}
                  disabled={locked(row)}
                  onChange={(e) => patch(row.id, { date: e.target.value })}
                />
              </Field>
              <Field label={`Session ${index + 1} start`}>
                <input
                  type="time"
                  step="900"
                  value={row.start}
                  disabled={locked(row)}
                  onChange={(e) => patch(row.id, { start: e.target.value })}
                />
              </Field>
              <Field label={`Session ${index + 1} end`}>
                <input
                  type="time"
                  step="900"
                  value={row.end}
                  disabled={locked(row)}
                  onChange={(e) => patch(row.id, { end: e.target.value })}
                />
              </Field>
            </div>
            <div className="session-manager-row-actions">
              <label className="check">
                <input
                  type="checkbox"
                  checked={row.protected}
                  disabled={locked(row)}
                  onChange={(e) =>
                    patch(row.id, { protected: e.target.checked })
                  }
                />
                <LockKeyhole size={12} /> Protected
              </label>
              {row.usesReserve && (
                <span className="micro muted">Uses reserve</span>
              )}
              {!locked(row) && (
                <>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => split(row)}
                    aria-label={`Split session ${index + 1}`}
                  >
                    <Scissors size={13} /> Split
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      edit(rows.filter((entry) => entry.id !== row.id))
                    }
                    aria-label={`Remove session ${index + 1}`}
                  >
                    <Trash2 size={13} /> Remove
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
        {!rows.length && (
          <p className="muted micro">
            No sessions yet. Add the days and times you want to reserve.
          </p>
        )}
        <button type="button" className="secondary" onClick={add}>
          <Plus size={14} /> Add session
        </button>
        {changedProtected && (
          <label className="check session-manager-override">
            <input
              type="checkbox"
              checked={overrideProtected}
              onChange={(e) => {
                setOverrideProtected(e.target.checked);
                invalidate();
              }}
            />
            I authorize changing or removing the protected sessions edited
            above.
          </label>
        )}
        </>}
        {item.status === "waiting" && (
          <label className="check session-manager-override">
            <input
              type="checkbox"
              checked={resume}
              onChange={(e) => {
                setResume(e.target.checked);
                invalidate();
              }}
            />
            Resume this waiting project when these sessions are booked.
          </label>
        )}
      </fieldset>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onClose}
        >
          Cancel edits
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || (mode === "exact" && changedProtected && !overrideProtected)}
          onClick={preview}
        >
          {busy ? "Checking…" : mode === "smart" ? "Find available times" : "Preview session changes"}
        </button>
      </div>
      {proposal && (
        <ProposalCard
          proposal={proposal}
          state={state}
          busy={busy}
          onCommit={commit}
        />
      )}
    </div>
  );
}
