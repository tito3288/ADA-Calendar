"use client";
import { useState } from "react";
import { ArrowRight, Clock3, LockKeyhole, TriangleAlert } from "lucide-react";
import type {
  AppState,
  ScheduleProposal,
  WorkCommand,
  WorkItem,
} from "@/lib/types";
import { localDate, localDateTime, minutesBetween } from "@/lib/time";
import { newWorkItem, formatHours } from "@/lib/work";
import { CATEGORY_LABELS } from "@/lib/defaults";
import { api, ApiError, Field, dateLabel, timeLabel } from "./ui";

export function ProposalCard({
  proposal,
  state,
  onCommit,
  busy,
}: {
  proposal: ScheduleProposal;
  state: AppState;
  onCommit: (request: boolean) => void;
  busy?: boolean;
}) {
  const ready = proposal.status === "ready" && !proposal.requiresApproval;
  const requester = state.actor.role === "requester";
  const underallocated = state.items.filter(
    (item) =>
      ["planned", "in_progress"].includes(item.status) &&
      (item.remainingMinutes === null ||
        item.remainingMinutes >
          state.sessions
            .filter((s) => s.workItemId === item.id && s.status === "planned")
            .reduce((sum, s) => sum + minutesBetween(s.start, s.end), 0)),
  ).length;
  return (
    <div
      className={`proposal ${ready ? "proposal-ready" : "proposal-conflict"}`}
    >
      <h3>
        {ready ? <Clock3 size={18} /> : <TriangleAlert size={18} />}
        {ready ? "This fits your schedule" : "This needs a decision"}
      </h3>
      <p>
        {ready
          ? requester
            ? "Your entire request fits without moving existing work. You can book it directly."
            : "Review the planned changes below. Work stays inside your configured hours."
          : "Nothing has moved. Existing commitments remain in place."}
      </p>
      {requester && underallocated > 0 && (
        <p className="micro">
          Capacity reflects reserved sessions. {underallocated} existing project
          {underallocated === 1 ? " still needs" : "s still need"} estimates or
          full scheduling; Bryan may need to reconcile that work.
        </p>
      )}
      <ul>
        {proposal.summary.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
        {proposal.conflicts.map((c, i) => (
          <li key={`c${i}`}>{c.message}</li>
        ))}
      </ul>
      <div className="proposal-sessions">
        {proposal.sessions
          .filter(
            (s) =>
              proposal.affectedItemIds.includes(s.workItemId) &&
              s.status === "planned",
          )
          .slice(0, 15)
          .map((s) => (
            <div key={s.id}>
              <span>
                {proposal.items.find((i) => i.id === s.workItemId)?.title}
              </span>
              <strong>
                {dateLabel(localDate(s.start, state.settings.timeZone))} ·{" "}
                {timeLabel(s.start, state.settings.timeZone)}–
                {timeLabel(s.end, state.settings.timeZone)}{" "}
                {s.protected && "🔒"}
              </strong>
            </div>
          ))}
      </div>
      {proposal.alternatives.length > 0 && (
        <div className="alternatives">
          <strong>Suggested openings</strong>
          {proposal.alternatives.map((a, i) => (
            <p key={i}>{a.label}</p>
          ))}
          <p className="micro">
            Adjust the dates above and preview again to choose an opening.
          </p>
        </div>
      )}
      {(ready || requester) && (
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => onCommit(!ready)}
        >
          {busy
            ? "Saving…"
            : ready
              ? requester
                ? "Book this work"
                : "Confirm changes"
              : "Send priority request to Bryan"}
          <ArrowRight size={15} />
        </button>
      )}
    </div>
  );
}

export function WorkForm({
  state,
  date,
  existing,
  onSaved,
  onClose,
}: {
  state: AppState;
  date: string;
  existing?: WorkItem;
  onSaved: (state: AppState) => void;
  onClose: () => void;
}) {
  const [item, setItem] = useState<WorkItem>(
    () =>
      existing ??
      newWorkItem(state.actor, date, { clientId: state.clients[0]?.id || "" }),
  );
  const [exact, setExact] = useState(false);
  const [sessionDates, setSessionDates] = useState(date);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("11:00");
  const [protect, setProtect] = useState(true);
  const [urgent, setUrgent] = useState(false);
  const [proposal, setProposal] = useState<ScheduleProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const allowUnknownEffort = existing?.remainingMinutes === null;
  function patch(p: Partial<WorkItem>) {
    setItem({ ...item, ...p });
    setProposal(null);
    setOperationId(crypto.randomUUID());
  }
  async function preview(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const commands: WorkCommand[] = existing
        ? [
            {
              type: "update",
              itemId: item.id,
              patch: {
                title: item.title,
                description: item.description,
                clientId: item.clientId,
                category: item.category,
                webKind: item.webKind,
                estimatedMinutes: item.estimatedMinutes,
                remainingMinutes: item.remainingMinutes,
                windowStart: item.windowStart,
                windowEnd: item.windowEnd,
                targetDate: item.targetDate,
                deadline: item.deadline,
                minimumSessionMinutes: item.minimumSessionMinutes,
                priorityId: item.priorityId,
                progressTotal: item.progressTotal,
                updateDate: item.updateDate,
                references: item.references,
              },
            },
          ]
        : [
            {
              type: "create",
              item,
              urgent,
              ...(exact
                ? {
                    sessions: sessionDates.split(",").map((d) => ({
                      id: crypto.randomUUID(),
                      workItemId: item.id,
                      start: localDateTime(
                        d.trim(),
                        start,
                        state.settings.timeZone,
                      ),
                      end: localDateTime(
                        d.trim(),
                        end,
                        state.settings.timeZone,
                      ),
                      protected: state.actor.role === "owner" && protect,
                      status: "planned" as const,
                      usesReserve: false,
                    })),
                  }
                : {}),
            },
          ];
      setProposal(
        (
          await api<{ proposal: ScheduleProposal }>("commands", {
            commands,
            operationId,
            action: "preview",
          })
        ).proposal,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function commit(request: boolean) {
    if (!proposal) return;
    setBusy(true);
    setError("");
    try {
      const response = await api("commands", {
        commands: proposal.commands,
        operationId,
        baseVersion: proposal.baseVersion,
        reviewFingerprint: proposal.reviewFingerprint,
        action: request ? "request" : "commit",
      });
      onSaved(response.state);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setProposal(e instanceof ApiError ? e.proposal ?? null : null);
      if (e instanceof ApiError && e.state) onSaved(e.state);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={preview} className="work-form">
      <div className="form-grid">
        <Field label="Client">
          <select
            value={item.clientId}
            required
            onChange={(e) => patch({ clientId: e.target.value })}
          >
            {state.clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Work category">
          <select
            value={
              item.category === "web" ? `web-${item.webKind}` : item.category
            }
            onChange={(e) => {
              const value = e.target.value;
              patch({
                category: value.startsWith("web")
                  ? "web"
                  : (value as WorkItem["category"]),
                webKind: value.startsWith("web")
                  ? (value.split("-")[1] as "edit" | "build")
                  : null,
                minimumSessionMinutes:
                  value === "software" || value === "web-build" ? 120 : 15,
              });
            }}
          >
            <option value="web-edit">Web · edit</option>
            <option value="web-build">Web · new build</option>
            <option value="it">IT</option>
            <option value="landings">Landings</option>
            <option value="software">Software</option>
          </select>
        </Field>
      </div>
      <Field label="What needs doing?">
        <input
          value={item.title}
          required
          maxLength={200}
          placeholder="e.g. South Bend service landings"
          onChange={(e) => patch({ title: e.target.value })}
        />
      </Field>
      <Field label="Description">
        <textarea
          rows={3}
          value={item.description}
          placeholder="Context, requirements, and what finished looks like…"
          onChange={(e) => patch({ description: e.target.value })}
        />
      </Field>
      <div className="form-grid">
        <Field
          label={
            state.actor.role === "owner" ? "Priority" : "Suggested priority"
          }
        >
          <select
            value={
              state.actor.role === "owner"
                ? item.priorityId
                : item.requestedPriorityId || "normal"
            }
            onChange={(e) =>
              patch(
                state.actor.role === "owner"
                  ? { priorityId: e.target.value }
                  : { requestedPriorityId: e.target.value },
              )
            }
          >
            {state.priorities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={
            existing ? "Remaining effort (hours)" : "Estimated effort (hours)"
          }
          hint={allowUnknownEffort
            ? existing?.status === "waiting"
              ? "Leave blank while the effort is unknown. Saving hours does not resume waiting work."
              : "Leave blank while the total is unknown. Only your explicitly booked sessions reserve time."
            : "Work time, not the number of days it spans."}
        >
          <input
            type="number"
            min="0.25"
            max="1000"
            step="0.25"
            required={!allowUnknownEffort}
            value={item.remainingMinutes === null ? "" : item.remainingMinutes / 60}
            onChange={(e) =>
              patch({
                remainingMinutes: e.target.value === "" ? null : Number(e.target.value) * 60,
                ...(!existing
                  ? { estimatedMinutes: e.target.value === "" ? null : Number(e.target.value) * 60 }
                  : {}),
              })
            }
          />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="Earliest start">
          <input
            type="date"
            required
            value={item.windowStart}
            onChange={(e) => patch({ windowStart: e.target.value })}
          />
        </Field>
        <Field
          label="Project span ends"
          hint="The faded ribbon ends here. This is not a firm deadline."
        >
          <input
            type="date"
            min={item.windowStart}
            value={item.windowEnd ?? ""}
            onChange={(e) => patch({ windowEnd: e.target.value || null })}
          />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="Target finish (optional)">
          <input
            type="date"
            value={item.targetDate ?? ""}
            onChange={(e) => patch({ targetDate: e.target.value || null })}
          />
        </Field>
        <Field label="Firm deadline (optional)">
          <input
            type="date"
            value={item.deadline ?? ""}
            onChange={(e) => patch({ deadline: e.target.value || null })}
          />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="Minimum focus session">
          <select
            value={item.minimumSessionMinutes}
            onChange={(e) =>
              patch({ minimumSessionMinutes: Number(e.target.value) })
            }
          >
            {[15, 30, 60, 90, 120, 180].map((n) => (
              <option key={n} value={n}>
                {formatHours(n)}
              </option>
            ))}
          </select>
        </Field>
        {item.category === "landings" && (
          <Field label="Number of pages">
            <input
              type="number"
              min="1"
              value={item.progressTotal ?? ""}
              onChange={(e) =>
                patch({
                  progressTotal: e.target.value ? Number(e.target.value) : null,
                })
              }
            />
          </Field>
        )}
      </div>
      {item.category === "landings" && (
        <Field
          label="Client update checkpoint"
          hint="An update checkpoint does not make all pages due."
        >
          <input
            type="date"
            value={item.updateDate ?? ""}
            onChange={(e) => patch({ updateDate: e.target.value || null })}
          />
        </Field>
      )}
      <Field label="Links or email references (one per line)">
        <textarea
          rows={2}
          placeholder="Shared folder URL or ‘Kyle’s email, Sep 8: homepage images’"
          value={item.references.join("\n")}
          onChange={(e) =>
            patch({ references: e.target.value.split("\n").filter(Boolean) })
          }
        />
      </Field>
      {!existing && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={exact}
              onChange={(e) => {
                setExact(e.target.checked);
                setProposal(null);
              }}
            />
            Choose exact work sessions
          </label>
          {exact && (
            <div className="inset">
              <Field label="Session dates (YYYY-MM-DD, comma-separated)">
                <input
                  value={sessionDates}
                  onChange={(e) => {
                    setSessionDates(e.target.value);
                    setProposal(null);
                  }}
                  required
                />
              </Field>
              <div className="form-grid">
                <Field label="Start time">
                  <input
                    type="time"
                    step="900"
                    value={start}
                    onChange={(e) => {
                      setStart(e.target.value);
                      setProposal(null);
                    }}
                  />
                </Field>
                <Field label="End time">
                  <input
                    type="time"
                    step="900"
                    value={end}
                    onChange={(e) => {
                      setEnd(e.target.value);
                      setProposal(null);
                    }}
                  />
                </Field>
              </div>
              {state.actor.role === "owner" && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={protect}
                    onChange={(e) => {
                      setProtect(e.target.checked);
                      setProposal(null);
                    }}
                  />
                  <LockKeyhole size={14} />
                  Protect these sessions
                </label>
              )}
              <p className="micro muted">
                Use separate sessions around lunch. Any remaining effort is
                scheduled automatically.
              </p>
            </div>
          )}
          {state.actor.role === "owner" && (
            <label className="check">
              <input
                type="checkbox"
                checked={urgent}
                onChange={(e) => {
                  setUrgent(e.target.checked);
                  setProposal(null);
                }}
              />
              This is an interruption; permit use of available reserve
            </label>
          )}
        </>
      )}
      <p className="micro muted">
        {CATEGORY_LABELS[item.category]} · Files can be attached after the work
        is saved. Every committed change notifies Kyle and William.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {proposal ? (
        <ProposalCard
          proposal={proposal}
          state={state}
          onCommit={commit}
          busy={busy}
        />
      ) : (
        <div className="form-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !state.clients.length}>
            {busy ? "Checking…" : "Check schedule"}
            <ArrowRight size={16} />
          </button>
        </div>
      )}
    </form>
  );
}
