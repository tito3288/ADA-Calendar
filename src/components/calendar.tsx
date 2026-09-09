"use client";
import { useMemo, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import { LockKeyhole, ArrowUpRight } from "lucide-react";
import type { AppState, WorkCommand, WorkItem } from "@/lib/types";
import type { AssistantDateSelection } from "@/lib/assistant-date-selection";
import { addDays, dayOfWeek, localDate, minutesBetween } from "@/lib/time";
import { dayCapacity } from "@/lib/scheduler";
import { formatHours } from "@/lib/work";
import { dateLabel, Empty, timeLabel } from "./ui";

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
};
export function MonthCalendar({
  state,
  date,
  items,
  onSelect,
  onDate,
  selectingDates = false,
  dateSelection,
}: Props) {
  const first = date.slice(0, 7) + "-01";
  const start = addDays(first, -(dayOfWeek(first) % 7));
  const today = localDate(new Date().toISOString(), state.settings.timeZone);
  const weeks = useMemo(
    () =>
      Array.from({ length: 6 }, (_, w) =>
        Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)),
      ),
    [start],
  );
  return (
    <div
      className={`month-calendar ${selectingDates ? "is-selecting-dates" : ""}`}
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
                    className={`day-cell ${d.slice(0, 7) !== first.slice(0, 7) ? "outside-month" : ""} ${d === today ? "is-today" : d < today ? "is-past" : ""} ${!isWorkday ? "weekend" : ""} ${inSelection ? "date-selected" : ""} ${dateSelection && (d === dateSelection.start || d === dateSelection.end) ? "date-endpoint" : ""}`}
                    onClick={() => onDate(d)}
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
                return (
                  <button
                    key={item.id}
                    disabled={selectingDates}
                    title={`${client?.name} · ${item.title}`}
                    onClick={() => onSelect(item.id)}
                    className={`project-ribbon category-${item.category} ${item.status === "waiting" ? "ribbon-waiting" : ""}`}
                    style={{
                      gridColumn: `${from + 1} / ${to + 2}`,
                      gridRow: lane + 1,
                    }}
                  >
                    <span
                      className="ribbon-segments"
                      style={{
                        gridTemplateColumns: `repeat(${to - from + 1}, 1fr)`,
                      }}
                    >
                      {days.slice(from, to + 1).map((d) => {
                        const sessions = state.sessions.filter(
                          (s) =>
                            s.workItemId === item.id &&
                            s.status === "planned" &&
                            localDate(s.start, state.settings.timeZone) === d,
                        );
                        const minutes = sessions.reduce(
                          (n, s) => n + minutesBetween(s.start, s.end),
                          0,
                        );
                        return (
                          <span
                            key={d}
                            className={
                              minutes
                                ? "ribbon-reserved"
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
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
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
