"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import type { AppState } from "@/lib/types";
import { localDate, minutesBetween } from "@/lib/time";
import {
  calendarBookingMoveSourceUnavailableReason,
  calendarBookingMoveTargetUnavailableReason,
  type CalendarBookingMoveSelection,
} from "@/lib/calendar-booking-move";

const DRAG_TYPE = "application/x-ada-booked-hours";
interface DragSource {
  sessionIds: string[];
  date: string;
  label: string;
  minutes: number;
  workspaceId: string;
  actorId: string;
  version: number;
  token: string;
}

/** Drag data identifies only an in-memory selection. External drops, a stale
 * source, or a different actor can never become scheduling commands. */
export function useCalendarBookingDrag(
  state: AppState,
  enabled: boolean,
  onMove?: (selection: CalendarBookingMoveSelection) => void,
) {
  const [selected, setSelected] = useState<DragSource | null>(null);
  const [hover, setHover] = useState<{ date: string; reason: string | null } | null>(null);
  const [message, setMessage] = useState("");
  const [destination, setDestination] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const selectionRef = useRef<DragSource | null>(null);
  const dragging = useRef(false);
  const suppressUntil = useRef(0);
  const current = (value: DragSource | null): value is DragSource => Boolean(value && enabled && onMove &&
    state.actor.role === "owner" && value.workspaceId === state.workspaceId && value.actorId === state.actor.id && value.version === state.version);
  const source = current(selected) ? selected : null;

  function clear() {
    selectionRef.current = null;
    dragging.current = false;
    setSelected(null);
    setHover(null);
    setDestination("");
    setIsDragging(false);
  }
  function cancel() {
    clear();
    setMessage("Move cancelled. No bookings changed.");
  }
  useEffect(() => {
    if (!source) return;
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      selectionRef.current = null;
      dragging.current = false;
      setSelected(null); setHover(null); setDestination("");
      setIsDragging(false);
      setMessage("Move cancelled. No bookings changed.");
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [source]);

  function pickSource(sessionIds: string[], label: string): DragSource | null {
    if (!enabled || !onMove) return null;
    const reason = calendarBookingMoveSourceUnavailableReason(state, sessionIds, new Date().toISOString());
    if (reason) { setMessage(reason); return null; }
    const sessions = sessionIds.map(id => state.sessions.find(session => session.id === id)!);
    const next: DragSource = { sessionIds: [...sessionIds], label, date: localDate(sessions[0].start, state.settings.timeZone),
      minutes: sessions.reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0),
      workspaceId: state.workspaceId, actorId: state.actor.id, version: state.version, token: crypto.randomUUID() };
    selectionRef.current = next;
    setSelected(next); setHover(null); setDestination(""); setMessage("");
    return next;
  }
  function chooseDay(date: string) {
    const value = selectionRef.current;
    if (!current(value)) {
      clear(); setMessage("Your calendar changed. Select the booked hours again before moving them."); return;
    }
    const now = new Date().toISOString();
    const reason = calendarBookingMoveSourceUnavailableReason(state, value.sessionIds, now) ||
      calendarBookingMoveTargetUnavailableReason(state, value.date, date, now);
    if (reason) { setMessage(reason); setHover(null); return; }
    clear(); setMessage("");
    onMove!({ sessionIds: value.sessionIds, date });
  }
  function startDrag(event: DragEvent, sessionIds: string[], label: string) {
    const value = pickSource(sessionIds, label);
    if (!value) { event.preventDefault(); return; }
    dragging.current = true;
    setIsDragging(true);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_TYPE, value.token);
  }
  function endDrag() {
    suppressUntil.current = Date.now() + 350;
    if (dragging.current) { if (hover?.reason) setMessage(hover.reason); clear(); }
  }
  function dayUnderPointer(event: DragEvent<HTMLElement>, dates: string[]) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientX - bounds.left) / bounds.width;
    return fraction >= 0 && fraction < 1 ? dates[Math.floor(fraction * 7)] : undefined;
  }
  function accepts(event: DragEvent) {
    return dragging.current && current(selectionRef.current) && event.dataTransfer.types.includes(DRAG_TYPE);
  }
  function dragOverWeek(event: DragEvent<HTMLElement>, dates: string[]) {
    if (!accepts(event)) return;
    const date = dayUnderPointer(event, dates);
    if (!date) return;
    event.preventDefault();
    const reason = calendarBookingMoveTargetUnavailableReason(state, selectionRef.current!.date, date, new Date().toISOString());
    event.dataTransfer.dropEffect = reason ? "none" : "move";
    setHover(previous => previous?.date === date && previous.reason === reason ? previous : { date, reason });
  }
  function dropOnWeek(event: DragEvent<HTMLElement>, dates: string[]) {
    if (!accepts(event) || event.dataTransfer.getData(DRAG_TYPE) !== selectionRef.current?.token) return;
    event.preventDefault(); event.stopPropagation();
    const date = dayUnderPointer(event, dates);
    suppressUntil.current = Date.now() + 350;
    if (date) chooseDay(date);
    else cancel();
  }
  function leaveWeek(event: DragEvent<HTMLElement>) {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setHover(null);
  }
  return { source, hover, destination, isDragging, setDestination, pickSource, chooseDay, startDrag, endDrag, dragOverWeek, dropOnWeek, leaveWeek, cancel,
    suppressClick: () => Date.now() < suppressUntil.current,
    message: selected && !source ? "Your calendar changed. Select the booked hours again before moving them." : message };
}
