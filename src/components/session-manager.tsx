"use client";

import { useEffect, useRef, useState } from "react";
import { LockKeyhole, Plus, Scissors, Trash2 } from "lucide-react";
import type {
  AppState,
  ScheduleProposal,
  WorkCommand,
  WorkItem,
  WorkSession,
} from "@/lib/types";
import { addDays, instantMs, localDate, minutesBetween } from "@/lib/time";
import {
  bookedDayHours,
  changedDayHours,
  dayHoursDrafts,
  parseDayHours,
  usableWorkDate,
  type DayHoursDraft,
} from "@/lib/day-hours";
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
import { DayHoursFields } from "./day-hours-fields";

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
  const today = localDate(openedAt, zone);
  const [mode, setMode] = useState(initialMode);
  const reconcilingProgress =
    initialRemainingMinutes !== undefined ||
    initialProgressCompleted !== undefined;
  const startsWithExactTimes =
    reconcilingProgress || initialSessions !== undefined;
  const [exactTimes, setExactTimes] = useState(startsWithExactTimes);
  const original = state.sessions
    .filter(
      (session) =>
        session.workItemId === item.id && session.status === "planned",
    )
    .sort((a, b) => a.start.localeCompare(b.start));
  const originalDays = bookedDayHours(original, zone);
  const [days, setDays] = useState<DayHoursDraft[]>(() =>
    dayHoursDrafts(bookedDayHours(initialSessions ?? original, zone)),
  );
  const [addDaysDraft, setAddDaysDraft] = useState<DayHoursDraft[]>(() => [
    {
      id: crypto.randomUUID(),
      date: usableWorkDate(today, state.settings, openedAt),
      hours: "",
    },
  ]);
  const [rows, setRows] = useState(() =>
    (initialSessions ?? original).map((session) => sessionDraft(session, zone)),
  );
  const [overrideProtected, setOverrideProtected] = useState(false);
  const [requiresProtectedOverride, setRequiresProtectedOverride] =
    useState(false);
  const [proposal, setProposal] = useState<ScheduleProposal | null>(null);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const elapsedBookings = original.filter(
    (session) => instantMs(session.start) < instantMs(openedAt),
  );
  function invalidate() {
    setProposal(null);
    setError("");
    setOperationId(crypto.randomUUID());
  }
  function editDays(next: DayHoursDraft[]) {
    if (mode === "smart") setAddDaysDraft(next);
    else setDays(next);
    setOverrideProtected(false);
    setRequiresProtectedOverride(false);
    invalidate();
  }
  function editExact(next: SessionDraft[]) {
    setRows(next);
    setOverrideProtected(false);
    setRequiresProtectedOverride(false);
    invalidate();
  }
  function patchExact(id: string, values: Partial<SessionDraft>) {
    editExact(rows.map((row) => (row.id === id ? { ...row, ...values } : row)));
  }
  function addExact() {
    const last = rows
      .map((row) => row.date)
      .sort()
      .at(-1);
    editExact([
      ...rows,
      {
        id: crypto.randomUUID(),
        date: usableWorkDate(
          last ? addDays(last, 1) : today,
          state.settings,
          new Date().toISOString(),
        ),
        start: "09:00",
        end: "10:00",
        protected: false,
        usesReserve: false,
      },
    ]);
  }
  function split(row: SessionDraft) {
    try {
      editExact(
        rows.flatMap((entry) =>
          entry.id === row.id
            ? splitSessionDraft(row, zone, crypto.randomUUID())
            : [entry],
        ),
      );
    } catch (reason) {
      setError((reason as Error).message);
    }
  }
  function desiredDays() {
    const requested = parseDayHours(mode === "smart" ? addDaysDraft : days);
    if (mode === "exact") return requested;
    if (!requested.length)
      throw new Error("Add at least one day and its hours.");
    const totals = new Map(originalDays.map((day) => [day.date, day.minutes]));
    for (const day of requested)
      totals.set(day.date, (totals.get(day.date) ?? 0) + day.minutes);
    return [...totals]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, minutes]) => ({ date, minutes }));
  }
  const changedProtected = exactTimes
    ? original.some(
        (session) =>
          session.protected &&
          JSON.stringify(rows.find((row) => row.id === session.id)) !==
            JSON.stringify(sessionDraft(session, zone)),
      )
    : false;
  const needsOverride = changedProtected || requiresProtectedOverride;
  let bookingTotal: number | null = null;
  try {
    bookingTotal = exactTimes
      ? rows
          .map((row) => draftSession(row, item.id, zone))
          .reduce(
            (sum, session) => sum + minutesBetween(session.start, session.end),
            0,
          )
      : desiredDays().reduce((sum, day) => sum + day.minutes, 0);
  } catch {
    /* Summary waits for complete input. */
  }
  const oldTotal = originalDays.reduce((sum, day) => sum + day.minutes, 0);
  const nextRemaining =
    item.remainingMinutes === null || bookingTotal === null
      ? null
      : Math.max(0, item.remainingMinutes + bookingTotal - oldTotal);
  async function preview() {
    setBusy(true);
    setError("");
    setProposal(null);
    try {
      let commands: WorkCommand[];
      if (exactTimes) {
        if (bookingTotal === null)
          throw new Error(
            "Give every session a valid date, start time, and end time.",
          );
        commands = sessionManagementCommands({
          item,
          original,
          rows,
          zone,
          now: new Date().toISOString(),
          overrideProtected,
          resume: true,
          ...(initialRemainingMinutes !== undefined
            ? { remainingMinutes: initialRemainingMinutes }
            : item.remainingMinutes === null
              ? {}
              : { remainingMinutes: nextRemaining! }),
        });
      } else {
        const changed = changedDayHours(originalDays, desiredDays());
        if (!changed.length)
          throw new Error("Change a day or its hours before reviewing.");
        commands = [
          {
            type: "set_day_hours",
            itemId: item.id,
            days: changed,
            ...(overrideProtected ? { overrideProtected: true } : {}),
          },
        ];
      }
      if (
        initialProgressCompleted !== undefined &&
        initialProgressCompleted !== item.progressCompleted
      ) {
        commands.push({
          type: "progress",
          itemId: item.id,
          progressCompleted: initialProgressCompleted,
        });
      }
      const response = await api<{ proposal: ScheduleProposal }>("commands", {
        commands,
        operationId,
        action: "preview",
      });
      setProposal(response.proposal);
      setRequiresProtectedOverride(
        response.proposal.conflicts.some(
          (conflict) => conflict.code === "protected_session",
        ),
      );
    } catch (reason) {
      setError((reason as Error).message);
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
    } catch (reason) {
      setError((reason as Error).message);
      setProposal(
        reason instanceof ApiError ? (reason.proposal ?? null) : null,
      );
      if (reason instanceof ApiError && reason.state) onSaved(reason.state);
    } finally {
      setBusy(false);
    }
  }
  if (state.actor.role !== "owner") return null;
  return (
    <div className="session-manager inset">
      <div className="session-manager-heading">
        <h4 ref={heading} tabIndex={-1}>
          {mode === "smart" ? "Add hours" : "Edit hours"}
        </h4>
        <span>Changes are drafts until confirmed.</span>
      </div>
      <p className="micro muted">
        {mode === "smart"
          ? "Choose the days and additional hours. ADA finds openings and keeps other work in place."
          : "Change a day, change its hours, or remove it. ADA finds times for the changed days."}
      </p>
      {!reconcilingProgress && (
        <div
          className="scheduling-mode"
          role="group"
          aria-label="Change booked hours"
        >
          <button
            type="button"
            aria-pressed={mode === "smart"}
            disabled={busy}
            onClick={() => {
              setMode("smart");
              setExactTimes(false);
              setOverrideProtected(false);
              setRequiresProtectedOverride(false);
              invalidate();
            }}
          >
            <span>
              <strong>Add hours</strong>
              <small>Book additional hours on chosen days.</small>
            </span>
          </button>
          <button
            type="button"
            aria-pressed={mode === "exact"}
            disabled={busy}
            onClick={() => {
              setMode("exact");
              setExactTimes(false);
              setOverrideProtected(false);
              setRequiresProtectedOverride(false);
              invalidate();
            }}
          >
            <span>
              <strong>Edit hours</strong>
              <small>Change or remove existing booked days.</small>
            </span>
          </button>
        </div>
      )}
      <div className="session-manager-budget" aria-live="polite">
        <strong>
          {bookingTotal === null ? "—" : formatHours(bookingTotal)} planned
          hours after this edit
        </strong>
        <span>
          {initialRemainingMinutes !== undefined
            ? `${formatHours(initialRemainingMinutes)} remaining after this edit`
            : item.remainingMinutes === null
              ? "Project total stays unknown"
              : nextRemaining === null
                ? "Enter the hours for each day"
                : `${formatHours(nextRemaining)} remaining after this edit`}
        </span>
      </div>
      <fieldset disabled={busy} className="session-manager-fields">
        {!exactTimes && (
          <DayHoursFields
            rows={mode === "smart" ? addDaysDraft : days}
            onChange={editDays}
            settings={state.settings}
            defaultDate={today}
            emptyText="No days booked. Add a day to reserve time."
          />
        )}
        {elapsedBookings.length > 0 && (
          <p className="micro muted">
            Past scheduled times do not mark work complete. These hours are
            still planned, so you can move them to another day without adding
            work.
          </p>
        )}
        {initialRemainingMinutes !== undefined && (
          <p className="notice micro">
            You entered {formatHours(initialRemainingMinutes)} remaining. Adjust
            the days below, then review the new hours together.
          </p>
        )}
        <details
          className="work-advanced"
          open={startsWithExactTimes || undefined}
        >
          <summary>Advanced</summary>
          <label className="check">
            <input
              type="checkbox"
              checked={exactTimes}
              disabled={reconcilingProgress}
              onChange={(event) => {
                setExactTimes(event.target.checked);
                setOverrideProtected(false);
                setRequiresProtectedOverride(false);
                invalidate();
              }}
            />
            Set exact times
          </label>
          {exactTimes && (
            <>
              <p className="micro muted">
                Exact times reserve these specific openings. Use the
                day-and-hours editor above to let ADA fit around lunch and other
                work.
              </p>
              {rows.map((row, index) => (
                <div className="session-manager-row" key={row.id}>
                  <div className="session-manager-row-title">
                    <strong>
                      {row.date
                        ? dateLabel(row.date, {
                            weekday: "long",
                            month: "short",
                            day: "numeric",
                          })
                        : `Session ${index + 1}`}
                    </strong>
                  </div>
                  <div className="form-grid">
                    <Field label={`Session ${index + 1} date`}>
                      <input
                        type="date"
                        value={row.date}
                        onChange={(event) =>
                          patchExact(row.id, { date: event.target.value })
                        }
                      />
                    </Field>
                    <Field label={`Session ${index + 1} start`}>
                      <input
                        type="time"
                        step="900"
                        value={row.start}
                        onChange={(event) =>
                          patchExact(row.id, { start: event.target.value })
                        }
                      />
                    </Field>
                    <Field label={`Session ${index + 1} end`}>
                      <input
                        type="time"
                        step="900"
                        value={row.end}
                        onChange={(event) =>
                          patchExact(row.id, { end: event.target.value })
                        }
                      />
                    </Field>
                  </div>
                  <div className="session-manager-row-actions">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={row.protected}
                        onChange={(event) =>
                          patchExact(row.id, {
                            protected: event.target.checked,
                          })
                        }
                      />
                      <LockKeyhole size={12} />
                      Protected
                    </label>
                    {row.usesReserve && (
                      <span className="micro muted">Uses reserve</span>
                    )}
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => split(row)}
                      aria-label={`Split session ${index + 1}`}
                    >
                      <Scissors size={13} />
                      Split
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        editExact(rows.filter((entry) => entry.id !== row.id))
                      }
                      aria-label={`Remove session ${index + 1}`}
                    >
                      <Trash2 size={13} />
                      Remove
                    </button>
                  </div>
                </div>
              ))}
              <button type="button" className="secondary" onClick={addExact}>
                <Plus size={14} />
                Add session
              </button>
            </>
          )}
        </details>
        {needsOverride && (
          <label className="check session-manager-override">
            <input
              type="checkbox"
              checked={overrideProtected}
              onChange={(event) => {
                setOverrideProtected(event.target.checked);
                invalidate();
              }}
            />
            I authorize changing the protected hours shown in this edit.
          </label>
        )}
        {item.status === "waiting" && (
          <p className="micro muted">
            Booking hours changes Waiting to Planned and clears the waiting
            reason. The project total{" "}
            {item.remainingMinutes === null
              ? "stays unknown"
              : "follows the booked-hours change"}
            .
          </p>
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
          disabled={busy || (needsOverride && !overrideProtected)}
          onClick={preview}
        >
          {busy ? "Checking…" : "Review changes"}
        </button>
      </div>
      {proposal && (
        <>
          <div className="session-change-review">
            <h4>Hours and days to save</h4>
            {proposal.commands.some(
              (command) => command.type === "set_day_hours",
            ) && (
              <div className="day-change-review">
                {proposal.commands
                  .flatMap((command) =>
                    command.type === "set_day_hours" ? command.days : [],
                  )
                  .map((day) => (
                    <p key={day.date}>
                      <strong>
                        {dateLabel(day.date, {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                        })}
                      </strong>
                      <span>
                        {formatHours(
                          originalDays.find((old) => old.date === day.date)
                            ?.minutes ?? 0,
                        )}{" "}
                        →{" "}
                        {day.minutes
                          ? formatHours(day.minutes)
                          : "Removed — time freed"}
                      </span>
                    </p>
                  ))}
              </div>
            )}
            {exactTimes &&
              [
                ...new Set([
                  ...original.map((session) => session.id),
                  ...proposal.sessions
                    .filter(
                      (session) =>
                        session.workItemId === item.id &&
                        session.status === "planned",
                    )
                    .map((session) => session.id),
                ]),
              ].map((id) => {
                const before = original.find((session) => session.id === id),
                  after = proposal.sessions.find(
                    (session) =>
                      session.id === id && session.status === "planned",
                  );
                if (JSON.stringify(before) === JSON.stringify(after))
                  return null;
                const describe = (session: WorkSession) =>
                  `${dateLabel(localDate(session.start, zone))} · ${timeLabel(session.start, zone)}–${timeLabel(session.end, zone)} (${formatHours(minutesBetween(session.start, session.end))})`;
                return (
                  <div className="session-change-row" key={id}>
                    <span>{before ? describe(before) : "New session"}</span>
                    <strong>
                      → {after ? describe(after) : "Removed — time freed"}
                    </strong>
                  </div>
                );
              })}
          </div>
          <ProposalCard
            proposal={proposal}
            state={state}
            onCommit={commit}
            busy={busy}
          />
        </>
      )}
    </div>
  );
}
