"use client";
import Calendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/react/timegrid";
import interactionPlugin from "@fullcalendar/react/interaction";
import classicPlugin from "@fullcalendar/react/themes/classic";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/classic/theme.css";
import "@fullcalendar/react/themes/classic/palette.css";
import type { AppState, WorkCommand, WorkItem } from "@/lib/types";
import { addDays, dayOfWeek, localDateTime, addMinutes } from "@/lib/time";

const colors = {
  software: "#493f65",
  web: "#234554",
  landings: "#51452c",
  it: "#285044",
};
export default function TimedCalendar({
  state,
  date,
  items,
  onSelect,
  view,
  onCommand,
}: {
  state: AppState;
  date: string;
  items: WorkItem[];
  onSelect: (id: string) => void;
  view: "week" | "day";
  onCommand: (command: WorkCommand) => Promise<void>;
}) {
  const start = addDays(date, -(dayOfWeek(date) % 7));
  const backgrounds = Array.from({ length: 7 }, (_, i) =>
    addDays(start, i),
  ).flatMap((d) => [
    {
      id: `lunch-${d}`,
      title: "Lunch",
      start: localDateTime(
        d,
        state.settings.lunchStart,
        state.settings.timeZone,
      ),
      end: localDateTime(d, state.settings.lunchEnd, state.settings.timeZone),
      display: "background",
      color: "#676c77",
    },
    {
      id: `reserve-${d}`,
      title: "Unexpected-work reserve",
      start: localDateTime(
        d,
        state.settings.reserveStart,
        state.settings.timeZone,
      ),
      end: addMinutes(
        localDateTime(d, state.settings.reserveStart, state.settings.timeZone),
        state.settings.reserveMinutes,
      ),
      display: "background",
      color: "#c69c42",
    },
  ]);
  return (
    <div className="timed-calendar" data-color-scheme="dark">
      <Calendar
        key={`${view}-${date}-${state.version}`}
        plugins={[timeGridPlugin, interactionPlugin, classicPlugin]}
        initialView={view === "week" ? "timeGridWeek" : "timeGridDay"}
        initialDate={date}
        timeZone={state.settings.timeZone}
        headerToolbar={false}
        height="auto"
        allDaySlot={false}
        slotMinTime={state.settings.dayStart}
        slotMaxTime={state.settings.dayEnd}
        slotDuration="00:15:00"
        slotHeaderInterval="01:00:00"
        weekends={false}
        nowIndicator
        editable={state.actor.role === "owner"}
        eventOverlap={false}
        events={[
          ...backgrounds,
          ...state.blocks.map((b) => ({
            id: b.id,
            title: b.title,
            start: b.start,
            end: b.end,
            editable: false,
            color: "#555f70",
            extendedProps: { block: true },
          })),
          ...state.sessions
            .filter(
              (s) =>
                s.status === "planned" &&
                items.some((i) => i.id === s.workItemId),
            )
            .map((s) => {
              const item = items.find((i) => i.id === s.workItemId)!;
              return {
                id: s.id,
                title: `${s.protected ? "🔒 " : ""}${state.clients.find((c) => c.id === item.clientId)?.name} · ${item.title}`,
                start: s.start,
                end: s.end,
                color: colors[item.category],
                contrastColor: "#e9edeb",
                editable: state.actor.role === "owner" && !s.protected,
                extendedProps: { workItemId: item.id },
              };
            }),
        ]}
        eventClick={(info) => {
          const id = info.event.extendedProps.workItemId as string | undefined;
          if (id) onSelect(id);
        }}
        eventDrop={(info) => {
          const start = info.event.startStr;
          const end = info.event.endStr;
          info.revert();
          if (start && end)
            void onCommand({
              type: "move",
              sessionId: info.event.id,
              start,
              end,
            });
        }}
        eventResize={(info) => {
          const start = info.event.startStr;
          const end = info.event.endStr;
          const original = state.sessions.find((s) => s.id === info.event.id);
          info.revert();
          if (start && end && original)
            void onCommand({
              type: "schedule",
              itemId: original.workItemId,
              sessions: state.sessions
                .filter(
                  (s) =>
                    s.workItemId === original.workItemId &&
                    s.status === "planned",
                )
                .map((s) => (s.id === original.id ? { ...s, start, end } : s)),
            });
        }}
      />
      <p className="micro muted">
        Amber shading is your interruption reserve. Open a work item to change a
        session with the keyboard. Protected sessions cannot be dragged.
      </p>
    </div>
  );
}
