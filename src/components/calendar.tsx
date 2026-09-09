"use client";
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import { LockKeyhole, ArrowUpRight, GripVertical } from "lucide-react";
import type { AppState, WorkCommand, WorkItem } from "@/lib/types";
import type { AssistantDateSelection } from "@/lib/assistant-date-selection";
import { addDays, dayOfWeek, localDate, minutesBetween } from "@/lib/time";
import { dayCapacity } from "@/lib/scheduler";
import { formatHours } from "@/lib/work";
import { dateLabel, Empty, timeLabel } from "./ui";
import { calendarBookingMoveSourceUnavailableReason, type CalendarBookingMoveSelection } from "@/lib/calendar-booking-move";
import { useCalendarBookingDrag } from "./use-calendar-booking-drag";

const TimedCalendar = dynamic(() => import("./timed-calendar"), {
  ssr: false,
  loading: () => <div className="empty">Loading timed calendar…</div>,
});
export type CalendarView = "month" | "week" | "day" | "agenda";
type Props = {
  state: AppState;
  date: string;
  items: WorkItem[];
  onSelect: (id: string) => void;
  onDate: (date: string) => void;
  selectingDates?: boolean;
  dateSelection?: AssistantDateSelection | null;
  onMoveBookings?: (selection: CalendarBookingMoveSelection) => void;
  movingBookings?: boolean;
};
export function MonthCalendar({
  state,
  date,
  items,
  onSelect,
  onDate,
  selectingDates = false,
  dateSelection,
  onMoveBookings,
  movingBookings = false,
}: Props) {
  const first = date.slice(0, 7) + "-01";
  const start = addDays(first, -(dayOfWeek(first) % 7));
  const today = localDate(new Date().toISOString(), state.settings.timeZone);
  const canMove = Boolean(onMoveBookings && state.actor.role === "owner" && !selectingDates && !movingBookings);
  const move = useCalendarBookingDrag(state, canMove, onMoveBookings);
  const movePicker = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Keep keyboard/touch destination controls discoverable even when a handle
    // was selected in a lower week; never shift focus during a native drag.
    if (move.source && !move.isDragging) movePicker.current?.focus();
  }, [move.source, move.isDragging]);
  const weeks = useMemo(
    () =>
      Array.from({ length: 6 }, (_, w) =>
        Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)),
      ),
    [start],
  );
  return (
    <>
    {canMove && (
      <div className="calendar-booking-drag-tools">
        {move.source && !move.isDragging ? (
          <section ref={movePicker} tabIndex={-1} className="calendar-booking-drag-picker" aria-label="Choose a day for booked hours">
            <div>
              <p className="eyebrow">MOVE BOOKED HOURS</p>
              <strong>{move.source.label}</strong>
              <p>{formatHours(move.source.minutes)} from {dateLabel(move.source.date)}. Choose another day below, or enter a date. You’ll review the time before saving.</p>
            </div>
            <div className="calendar-booking-drag-picker-actions">
              <label>Move booking to date<input type="date" value={move.destination} onChange={e => move.setDestination(e.target.value)} /></label>
              <button className="primary" disabled={!move.destination} onClick={() => move.chooseDay(move.destination)}>Preview move</button>
              <button className="secondary" onClick={move.cancel}>Cancel move</button>
            </div>
          </section>
        ) : <p className="calendar-booking-drag-hint"><GripVertical size={14} /> Drag booked hours to another day, or use the move handle. Review before saving.</p>}
        <p className="calendar-booking-drag-status" role="status">{move.isDragging ? "" : move.message}</p>
        {move.isDragging && move.source && <p className="calendar-booking-drag-active" role="status">{move.hover?.reason || `Move ${formatHours(move.source.minutes)} to another day · review before saving`}</p>}
      </div>
    )}
    <div
      className={`month-calendar ${selectingDates ? "is-selecting-dates" : ""} ${move.source ? "is-moving-bookings" : ""} ${move.source && !move.isDragging ? "is-picking-booking-date" : ""}`}
      aria-label="Month workload calendar"
    >
      <div className="weekday-head">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      {weeks.map((days, week) => {
        const visibleDates = (item: WorkItem) => {
          const spanEnd =
            item.windowEnd ||
            item.forecastDate ||
            item.targetDate ||
            item.windowStart;
          const sessionDays = state.sessions
            .filter((s) => s.workItemId === item.id && s.status === "planned")
            .map((s) => localDate(s.start, state.settings.timeZone));
          return days.filter(
            (d) =>
              (d >= item.windowStart && d <= spanEnd) ||
              sessionDays.includes(d),
          );
        };
        const ribbons = items.filter((item) => visibleDates(item).length > 0);
        const lanes: { end: number; count: number }[] = [];
        const spans = ribbons
          .sort(
            (a, b) =>
              a.windowStart.localeCompare(b.windowStart) ||
              a.createdAt.localeCompare(b.createdAt),
          )
          .map((item) => {
            const visible = visibleDates(item);
            const from = days.indexOf(visible[0]);
            const to = days.indexOf(visible[visible.length - 1]);
            let lane = lanes.findIndex((l) => l.end < from);
            if (lane < 0) {
              lane = lanes.length;
              lanes.push({ end: to, count: 1 });
            } else lanes[lane] = { end: to, count: lanes[lane].count + 1 };
            return { item, from, to, lane };
          });
        return (
          <div
            className="calendar-week"
            key={week}
            style={{ "--ribbon-lanes": lanes.length } as CSSProperties}
            onDragOver={e => move.dragOverWeek(e, days)}
            onDrop={e => move.dropOnWeek(e, days)}
            onDragLeave={move.leaveWeek}
          >
            <div className="day-backgrounds">
              {days.map((d) => {
                const capacity = dayCapacity(state, d);
                const isWorkday = state.settings.weekdays.includes(
                  dayOfWeek(d),
                );
                const inSelection = Boolean(
                  dateSelection &&
                  d >= dateSelection.start &&
                  d <= dateSelection.end,
                );
                return (
                  <button
                    key={d}
                    data-date={d}
                    className={`day-cell ${d.slice(0, 7) !== first.slice(0, 7) ? "outside-month" : ""} ${d === today ? "is-today" : d < today ? "is-past" : ""} ${!isWorkday ? "weekend" : ""} ${inSelection ? "date-selected" : ""} ${dateSelection && (d === dateSelection.start || d === dateSelection.end) ? "date-endpoint" : ""} ${move.hover?.date === d ? move.hover.reason ? "booking-drop-blocked" : "booking-drop-target" : ""}`}
                    onClick={() => { if (!move.suppressClick()) { if (move.source) move.chooseDay(d); else onDate(d); } }}
                    aria-pressed={selectingDates ? inSelection : undefined}
                    aria-label={`${dateLabel(d, { weekday: "long", month: "long", day: "numeric" })}, ${isWorkday ? `${formatHours(capacity.availableMinutes)} available, ${formatHours(capacity.plannedMinutes)} planned` : "Non-working day"}`}
                    title={
                      isWorkday
                        ? `${formatHours(capacity.availableMinutes)} left to book · ${formatHours(capacity.plannedMinutes)} planned · ${formatHours(capacity.capacityMinutes)} daily capacity. Lunch, interruption reserve and unavailable time are excluded.`
                        : "Non-working day"
                    }
                  >
                    <span className="day-header">
                      <span className="day-number">{Number(d.slice(-2))}</span>
                      {isWorkday && (
                        <span
                          className={`day-capacity ${capacity.availableMinutes === 0 ? "capacity-full" : capacity.availableMinutes <= 60 ? "capacity-low" : ""}`}
                        >
                          <span className="day-capacity-remaining">
                            <strong>
                              {formatHours(capacity.availableMinutes)}
                            </strong>
                            <span>left</span>
                          </span>
                          <small
                            className={`day-capacity-planned ${capacity.plannedMinutes === 0 ? "is-empty" : ""}`}
                          >
                            {formatHours(capacity.plannedMinutes)} planned
                          </small>
                        </span>
                      )}
                    </span>
                    {isWorkday && (
                      <span className="capacity-line" aria-hidden="true">
                        <i
                          style={{
                            width: `${Math.min(100, (capacity.plannedMinutes / (capacity.capacityMinutes || 1)) * 100)}%`,
                          }}
                        />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div
              className="ribbon-grid"
              style={{
                gridTemplateRows: `repeat(${Math.max(1, lanes.length)}, 26px)`,
              }}
            >
              {spans.map(({ item, from, to, lane }) => {
                const client = state.clients.find(
                  (c) => c.id === item.clientId,
                );
                const label = `${client?.name} · ${item.title}`;
                const segments = days.slice(from, to + 1).map(d => {
                  const sessions = state.sessions.filter(s => s.workItemId === item.id && s.status === "planned" && localDate(s.start, state.settings.timeZone) === d);
                  const sessionIds = sessions.map(s => s.id);
                  const minutes = sessions.reduce((sum, s) => sum + minutesBetween(s.start, s.end), 0);
                  const reason = minutes ? calendarBookingMoveSourceUnavailableReason(state, sessionIds, new Date().toISOString()) : null;
                  return { d, sessions, sessionIds, minutes, reason, draggable: canMove && minutes > 0 && !reason };
                });
                return (
                  <div key={item.id} className={`project-ribbon-lane category-${item.category}`} data-work-item-id={item.id} style={{ gridColumn: `${from + 1} / ${to + 2}`, gridRow: lane + 1 }}>
                  <button
                    disabled={selectingDates || !!move.source && !move.isDragging}
                    title={label}
                    onClick={() => { if (!move.suppressClick()) onSelect(item.id); }}
                    className={`project-ribbon category-${item.category} ${item.status === "waiting" ? "ribbon-waiting" : ""}`}
                  >
                    <span
                      className="ribbon-segments"
                      style={{
                        gridTemplateColumns: `repeat(${to - from + 1}, 1fr)`,
                      }}
                    >
                      {segments.map(({ d, sessions, sessionIds, minutes, draggable }) => {
                        return (
                          <span
                            key={d}
                            data-booking-date={minutes ? d : undefined}
                            data-work-item-id={minutes ? item.id : undefined}
                            draggable={draggable}
                            onDragStart={e => move.startDrag(e, sessionIds, label)}
                            onDragEnd={move.endDrag}
                            className={
                              minutes
                                ? `ribbon-reserved ${draggable ? "booking-draggable" : ""}`
                                : d >= item.windowStart &&
                                    d <=
                                      (item.windowEnd ||
                                        item.forecastDate ||
                                        item.targetDate ||
                                        item.windowStart)
                                  ? "ribbon-span"
                                  : "ribbon-gap"
                            }
                          >
                            {minutes > 0 && (
                              <span>
                                {sessions.some((s) => s.protected) && (
                                  <LockKeyhole size={10} />
                                )}
                                {formatHours(minutes)}
                              </span>
                            )}
                          </span>
                        );
                      })}
                    </span>
                    <span className="ribbon-title">
                      {(state.priorities.find((p) => p.id === item.priorityId)
                        ?.rank ?? 99) <= 1 && (
                        <b
                          className="ribbon-priority"
                          title={`${state.priorities.find((p) => p.id === item.priorityId)?.label} priority`}
                        >
                          {state.priorities.find(
                            (p) => p.id === item.priorityId,
                          )?.rank === 0
                            ? "!"
                            : "↑"}
                        </b>
                      )}
                      {client?.name} <span>· {item.title}</span>
                    </span>
                  </button>
                  {canMove && <div className="ribbon-move-handles" style={{ gridTemplateColumns: `repeat(${to - from + 1}, minmax(0, 1fr))` }}>
                    {segments.map(({ d, sessionIds, minutes, reason, draggable }) => <span key={d}>{draggable && (
                      <button type="button" className="booking-move-handle" data-booking-date={d} data-work-item-id={item.id}
                        aria-label={`Move ${label} on ${dateLabel(d)}`} title={reason || `Move ${formatHours(minutes)} from ${dateLabel(d)}`}
                        disabled={!draggable || !!move.source && !move.isDragging} draggable={draggable}
                        onClick={e => { e.stopPropagation(); if (!move.suppressClick()) move.pickSource(sessionIds, label); }}
                        onDragStart={e => move.startDrag(e, sessionIds, label)} onDragEnd={move.endDrag}>
                        <GripVertical size={14} aria-hidden="true" />
                      </button>
                    )}</span>)}
                  </div>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
    </>
  );
}
export function Agenda({ state, date, items, onSelect }: Props) {
  const upcoming = state.sessions
    .filter(
      (s) =>
        s.status === "planned" &&
        localDate(s.start, state.settings.timeZone) >= date &&
        items.some((i) => i.id === s.workItemId),
    )
    .sort((a, b) => a.start.localeCompare(b.start));
  const days = [
    ...new Set(
      upcoming.map((s) => localDate(s.start, state.settings.timeZone)),
    ),
  ];
  if (!days.length)
    return (
      <Empty title="A little breathing room">
        No reserved sessions from this date. Unscheduled and waiting projects
        remain on your plate.
      </Empty>
    );
  return (
    <div className="agenda">
      {days.map((d) => (
        <section key={d}>
          <h3>
            {dateLabel(d, { weekday: "long", month: "long", day: "numeric" })}
            <span>
              {formatHours(dayCapacity(state, d).plannedMinutes)} planned
            </span>
          </h3>
          {upcoming
            .filter((s) => localDate(s.start, state.settings.timeZone) === d)
            .map((s) => {
              const item = state.items.find((i) => i.id === s.workItemId)!;
              return (
                <button
                  className="agenda-item"
                  key={s.id}
                  onClick={() => onSelect(item.id)}
                >
                  <span className="agenda-time">
                    {timeLabel(s.start, state.settings.timeZone)}
                    <small>{timeLabel(s.end, state.settings.timeZone)}</small>
                  </span>
                  <span className={`category-dot category-${item.category}`} />
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      {state.clients.find((c) => c.id === item.clientId)?.name}
                    </small>
                  </span>
                  <span className="agenda-end">
                    {s.protected && <LockKeyhole size={14} />}
                    {formatHours(minutesBetween(s.start, s.end))}
                    <ArrowUpRight size={16} />
                  </span>
                </button>
              );
            })}
        </section>
      ))}
    </div>
  );
}
export function CalendarContent(
  props: Props & {
    view: CalendarView;
    onCommand: (command: WorkCommand) => Promise<void>;
  },
) {
  if (props.view === "month") return <MonthCalendar {...props} />;
  if (props.view === "agenda") return <Agenda {...props} />;
  return <TimedCalendar {...props} view={props.view} />;
}
