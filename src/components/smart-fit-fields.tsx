"use client";

import { useState } from "react";
import { CalendarDays, Clock3, Sparkles } from "lucide-react";
import type { WorkspaceSettings } from "@/lib/types";
import { addDays, localDate } from "@/lib/time";
import { smartFitRequest, smartFitTotal, smartFitWorkingDays, type SmartFitDraft } from "@/lib/smart-fit";
import { formatHours } from "@/lib/work";
import { Field } from "./ui";

export function SchedulingMode({ mode, onChange, disabled }: { mode: "smart" | "exact"; onChange: (mode: "smart" | "exact") => void; disabled?: boolean }) {
  return <div className="scheduling-mode" role="group" aria-label="How to choose work times">
    <button type="button" disabled={disabled} aria-pressed={mode === "smart"} onClick={() => onChange("smart")}>
      <Sparkles size={16} /><span><strong>Find a time for me</strong><small>Choose days and hours. ADA finds space.</small></span>
    </button>
    <button type="button" disabled={disabled} aria-pressed={mode === "exact"} onClick={() => onChange("exact")}>
      <Clock3 size={16} /><span><strong>Choose exact times</strong><small>Set or edit start and end times yourself.</small></span>
    </button>
  </div>;
}

export function SmartFitFields({ value, onChange, settings, disabled, allowPerDay = true }: {
  value: SmartFitDraft; onChange: (value: SmartFitDraft) => void; settings: WorkspaceSettings; disabled?: boolean; allowPerDay?: boolean;
}) {
  const [range, setRange] = useState(value.startDate !== value.endDate);
  const today = localDate(new Date().toISOString(), settings.timeZone);
  function chooseDay(day: string) {
    setRange(false);
    onChange({ ...value, startDate: day, endDate: day, distribution: "total" });
  }
  let total: number | null = null;
  try { const request = smartFitRequest(value); total = smartFitWorkingDays(request, settings) ? smartFitTotal(request, settings) : 0; } catch { /* Inline summary waits for complete input. */ }
  return <fieldset className="smart-fit-fields" disabled={disabled}>
    <div className="smart-fit-heading"><CalendarDays size={16} /><strong>When would you like to work?</strong></div>
    <div className="smart-fit-quick-days">
      <button type="button" className="secondary" onClick={() => chooseDay(today)}>Today</button>
      <button type="button" className="secondary" onClick={() => chooseDay(addDays(today, 1))}>Tomorrow</button>
      <label className="check"><input type="checkbox" checked={range} onChange={event => {
        setRange(event.target.checked);
        if (!event.target.checked) onChange({ ...value, endDate: value.startDate, distribution: "total" });
      }} />Choose multiple days</label>
    </div>
    <div className="form-grid">
      <Field label={range ? "First day" : "Work day"}>
        <input type="date" required value={value.startDate} onChange={event => onChange({ ...value, startDate: event.target.value, endDate: !range || value.endDate < event.target.value ? event.target.value : value.endDate })} />
      </Field>
      {range && <Field label="Last day"><input type="date" required min={value.startDate} value={value.endDate} onChange={event => onChange({ ...value, endDate: event.target.value })} /></Field>}
      <Field label={value.distribution === "per_day" ? "Hours each working day" : "Hours to book"}>
        <input type="number" required min="0.25" max={value.distribution === "per_day" ? "8" : "1000"} step="0.25" value={value.hours} onChange={event => onChange({ ...value, hours: event.target.value })} />
      </Field>
      {range && allowPerDay && <Field label="Spread the hours"><select value={value.distribution} onChange={event => onChange({ ...value, distribution: event.target.value as SmartFitDraft["distribution"] })}>
        <option value="total">Total across these days</option><option value="per_day">This many hours each working day</option>
      </select></Field>}
    </div>
    <p className="smart-fit-summary" aria-live="polite">{total === null ? "Choose your days and hours." : total === 0 ? "This range has no working days. Choose another day or range." : `${formatHours(total)} to book${value.distribution === "per_day" ? ` · ${value.hours}h on each working day` : range ? " total across these days" : " on this day"}.`} Existing bookings stay where they are.</p>
    <p className="micro muted">ADA uses available openings around lunch. Nothing is booked outside these dates.</p>
  </fieldset>;
}
