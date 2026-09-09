"use client";

import { Plus, Trash2 } from "lucide-react";
import { addDays, localDate } from "@/lib/time";
import {
  parseDayHours,
  usableWorkDate,
  type DayHoursDraft,
} from "@/lib/day-hours";
import type { WorkspaceSettings } from "@/lib/types";
import { formatHours } from "@/lib/work";
import { Field } from "./ui";

export function DayHoursFields({
  rows,
  onChange,
  settings,
  disabled,
  defaultDate,
  emptyText = "No days booked. Add a day when you are ready.",
}: {
  rows: DayHoursDraft[];
  onChange: (rows: DayHoursDraft[]) => void;
  settings: WorkspaceSettings;
  disabled?: boolean;
  defaultDate?: string;
  emptyText?: string;
}) {
  let total: number | null = null;
  try {
    total = parseDayHours(rows).reduce((sum, day) => sum + day.minutes, 0);
  } catch {
    /* Keep incomplete drafts editable. */
  }
  function addDay() {
    const latest = rows
      .map((row) => row.date)
      .filter(Boolean)
      .sort()
      .at(-1);
    const now = new Date().toISOString();
    const date = usableWorkDate(
      latest
        ? addDays(latest, 1)
        : (defaultDate ?? localDate(now, settings.timeZone)),
      settings,
      now,
    );
    onChange([...rows, { id: crypto.randomUUID(), date, hours: "" }]);
  }
  return (
    <fieldset className="day-hours-fields" disabled={disabled}>
      {rows.map((row, index) => (
        <div className="day-hours-row" key={row.id}>
          <Field label={`Work day ${index + 1}`}>
            <input
              type="date"
              required
              value={row.date}
              onChange={(event) =>
                onChange(
                  rows.map((entry) =>
                    entry.id === row.id
                      ? { ...entry, date: event.target.value }
                      : entry,
                  ),
                )
              }
            />
          </Field>
          <Field label={`Hours on day ${index + 1}`}>
            <input
              type="number"
              min="0.25"
              max="8"
              step="0.25"
              required
              value={row.hours}
              onChange={(event) =>
                onChange(
                  rows.map((entry) =>
                    entry.id === row.id
                      ? { ...entry, hours: event.target.value }
                      : entry,
                  ),
                )
              }
            />
          </Field>
          <button
            type="button"
            className="text-button"
            aria-label={`Remove day ${index + 1}`}
            onClick={() =>
              onChange(rows.filter((entry) => entry.id !== row.id))
            }
          >
            <Trash2 size={15} />
            <span>Remove</span>
          </button>
        </div>
      ))}
      {!rows.length && <p className="micro muted">{emptyText}</p>}
      <div className="day-hours-footer">
        <button
          type="button"
          className="secondary"
          disabled={rows.length >= 366}
          onClick={addDay}
        >
          <Plus size={15} />
          Add day
        </button>
        <strong aria-live="polite">
          {total === null
            ? "Enter the hours for each day"
            : `${formatHours(total)} across ${rows.length} day${rows.length === 1 ? "" : "s"}`}
        </strong>
      </div>
      <p className="micro muted">
        ADA finds space on these days, including separate openings around lunch.
        You will review the times before saving.
      </p>
    </fieldset>
  );
}
