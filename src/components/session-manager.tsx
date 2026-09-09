"use client";

import { useEffect, useRef, useState } from "react";
import { LockKeyhole, Plus, Scissors, Trash2 } from "lucide-react";
import type { AppState, ScheduleProposal, WorkCommand, WorkItem, WorkSession } from "@/lib/types";
import { smartFitRequest, type SmartFitDraft } from "@/lib/smart-fit";
import {
  addDays,
  addMinutes,
  instantMs,
  localDate,
  localDateTime,
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
import { api, ApiError, dateLabel, Field, timeLabel } from "./ui";
import { ProposalCard } from "./work-form";
import { SchedulingMode, SmartFitFields } from "./smart-fit-fields";

export function SessionManager({
  item,
  state,
  onSaved,
  onClose,
  initialMode = "smart",
  initialRemainingMinutes,
  initialProgressCompleted,
  initialSessions,
}: {
  item: WorkItem;
  state: AppState;
  onSaved: (state: AppState) => void;
  onClose: () => void;
  initialMode?: "smart" | "exact";
  initialRemainingMinutes?: number;
  initialProgressCompleted?: number;
  initialSessions?: WorkSession[];
}) {
  const zone = state.settings.timeZone;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "start" });
  }, []);
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
    (initialSessions ?? original).map((session) => sessionDraft(session, zone)),
  );
  const [hoursDrafts, setHoursDrafts] = useState<Record<string, string>>({});
  const [updateRemaining, setUpdateRemaining] = useState(initialRemainingMinutes !== undefined);
  const [remainingHours, setRemainingHours] = useState(
    () => String((initialRemainingMinutes ?? item.remainingMinutes ?? 0) / 60),
  );
  const [overrideProtected, setOverrideProtected] = useState(false);
  const [requiresProtectedOverride, setRequiresProtectedOverride] = useState(false);
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
    setHoursDrafts({});
    setRequiresProtectedOverride(false);
    setOverrideProtected(false);
    invalidate();
  }
  function patch(id: string, values: Partial<SessionDraft>) {
    edit(rows.map((row) => (row.id === id ? { ...row, ...values } : row)));
  }
  function hoursFor(row: SessionDraft) {
    if (hoursDrafts[row.id] !== undefined) return hoursDrafts[row.id];
    try {
      const session = draftSession(row, item.id, zone);
      return String(minutesBetween(session.start, session.end) / 60);
    } catch { return ""; }
  }
  function changeHours(row: SessionDraft, value: string) {
    let end = "";
    const minutes = Number(value) * 60;
    try {
      if (value.trim() && Number.isInteger(minutes) && minutes > 0 && minutes <= 480 && minutes % 15 === 0) {
        const start = localDateTime(row.date, row.start, zone);
        const nextEnd = addMinutes(start, minutes);
        if (localDate(nextEnd, zone) === row.date) {
          end = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(nextEnd));
        }
      }
    } catch { /* Keep the incomplete hours draft for correction. */ }
    patch(row.id, { end });
    setHoursDrafts({ ...hoursDrafts, [row.id]: value });
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
      const remainingMinutes = Number(remainingHours) * 60;
      if (mode === "exact" && updateRemaining && (!remainingHours.trim() || !Number.isInteger(remainingMinutes) || remainingMinutes < 0 || remainingMinutes > 100_000)) {
        throw new Error("Enter a valid remaining effort in hours, or leave Update remaining effort too unchecked.");
      }
      const commands: WorkCommand[] = mode === "smart" ? [{ type: "fit", itemId: item.id, request: { ...smartFitRequest(fit), resumeWaiting: resume } }] : sessionManagementCommands({
        item,
        original,
        rows,
        zone,
        now: new Date().toISOString(),
        overrideProtected,
        resume,
        ...(updateRemaining ? { remainingMinutes } : {}),
      });
      if (mode === "exact" && initialProgressCompleted !== undefined && initialProgressCompleted !== item.progressCompleted) {
        commands.push({ type: "progress", itemId: item.id, progressCompleted: initialProgressCompleted });
      }
      const response = await api<{ proposal: ScheduleProposal }>("commands", {
        commands,
        operationId,
        action: "preview",
      });
      setProposal(response.proposal);
      setRequiresProtectedOverride(response.proposal.conflicts.some(conflict => conflict.code === "protected_session"));
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
        <h4 ref={heading} tabIndex={-1}>Manage sessions</h4>
        <span>Changes are drafts until confirmed.</span>
      </div>
      <p className="micro muted">
        {mode === "smart" ? "Add time to this project without choosing a start time or moving existing bookings." : "Change the hours on any day, or remove a session to free that time. Hours are measured from its start time. ADA checks availability before saving."}
      </p>
      <SchedulingMode mode={mode} disabled={busy} onChange={next => { setMode(next); invalidate(); }} />
      <div className="session-manager-budget" aria-live="polite">
        <strong>
          {completeRows ? formatHours(reserved) : "—"} in future sessions
        </strong>
        <span>
          {mode === "exact" && updateRemaining ? `${remainingHours || "—"}h remaining effort after this edit` : item.remainingMinutes === null
            ? "Project total stays unknown"
            : `${formatHours(item.remainingMinutes)} remaining effort — unchanged`}
        </span>
      </div>
      {mode === "exact" && item.dailyPlan?.length ? (
        <p className="notice micro">
          The daily-hour plan will match the sessions below. Removed hours will not be rebooked automatically. Past bookings stay as history.
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
        {initialRemainingMinutes !== undefined && <p className="notice micro">You entered {formatHours(initialRemainingMinutes)} remaining. Shorten or remove the sessions below to fit that amount, then preview everything together.</p>}
        <div className="session-manager-effort">
          <label className="check">
            <input type="checkbox" checked={updateRemaining} onChange={event => { setUpdateRemaining(event.target.checked); invalidate(); }} />
            Update remaining effort too
          </label>
          <p className="micro muted">If the work needs fewer hours, update the remaining effort here. Otherwise, removed hours stay unscheduled and can be booked later.</p>
          {updateRemaining && <>
            <Field label="Remaining effort after this edit">
              <input type="number" min="0" max={100_000 / 60} step="0.25" value={remainingHours} onChange={event => { setRemainingHours(event.target.value); invalidate(); }} />
            </Field>
            <button type="button" className="text-button" disabled={!completeRows} onClick={() => { setRemainingHours(String(reserved / 60)); invalidate(); }}>Use scheduled total</button>
          </>}
        </div>
        {rows.map((row, index) => (
          <div
            className={`session-manager-row ${locked(row) ? "session-manager-history" : ""}`}
            key={row.id}
          >
            <div className="session-manager-row-title">
              <strong>{row.date ? dateLabel(row.date, { weekday: "long", month: "short", day: "numeric" }) : `Session ${index + 1}`}</strong>
              {locked(row) && (
                <span>History / already started · read-only</span>
              )}
            </div>
            <div className="form-grid">
              <Field label={`Session ${index + 1} date`}>
                <input
                  type="date"
                  value={row.date}
                  disabled={locked(row)}
                  onChange={(e) => patch(row.id, { date: e.target.value })}
                />
              </Field>
              <Field label={`Session ${index + 1} hours`}>
                <input type="number" min="0.25" max="8" step="0.25" value={hoursFor(row)} disabled={locked(row)} onChange={event => changeHours(row, event.target.value)} />
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
            No sessions reserved. Any remaining effort stays unscheduled until you book it.
          </p>
        )}
        <button type="button" className="secondary" onClick={add}>
          <Plus size={14} /> Add session
        </button>
        {(changedProtected || requiresProtectedOverride) && (
          <label className="check session-manager-override">
            <input
              type="checkbox"
              checked={overrideProtected}
              onChange={(e) => {
                setOverrideProtected(e.target.checked);
                invalidate();
              }}
            />
            I authorize the protected session changes in this edit, including any required focus adjustment.
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
          disabled={busy || (mode === "exact" && (changedProtected || requiresProtectedOverride) && !overrideProtected)}
          onClick={preview}
        >
          {busy ? "Checking…" : mode === "smart" ? "Find available times" : "Preview session changes"}
        </button>
      </div>
      {proposal && (
        <>
        {mode === "exact" && proposal.status === "ready" && <div className="session-change-review">
          <h4>Hours and days to save</h4>
          <p className="micro">Remaining effort: {item.remainingMinutes === null ? "Not estimated" : formatHours(item.remainingMinutes)} → {proposal.items.find(work => work.id === item.id)?.remainingMinutes === null ? "Not estimated" : formatHours(proposal.items.find(work => work.id === item.id)?.remainingMinutes ?? 0)}</p>
          {[...new Set([...original.map(session => session.id), ...proposal.sessions.filter(session => session.workItemId === item.id && session.status === "planned").map(session => session.id)])].map(id => {
            const before = original.find(session => session.id === id);
            const after = proposal.sessions.find(session => session.id === id && session.status === "planned");
            if (JSON.stringify(before) === JSON.stringify(after)) return null;
            const describe = (session: NonNullable<typeof before>) => `${dateLabel(localDate(session.start, zone), { weekday: "short", month: "short", day: "numeric" })} · ${timeLabel(session.start, zone)}–${timeLabel(session.end, zone)} (${formatHours(minutesBetween(session.start, session.end))})`;
            return <div key={id} className="session-change-row"><span>{before ? describe(before) : "New session"}</span><strong>→ {after ? describe(after) : "Removed — time freed"}</strong></div>;
          })}
        </div>}
        <ProposalCard
          proposal={proposal}
          state={state}
          busy={busy}
          onCommit={commit}
        />
        </>
      )}
    </div>
  );
}
