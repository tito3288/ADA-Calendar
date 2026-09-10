"use client";

import { Plus, Sparkles } from "lucide-react";
import type { AssistantDateSelection } from "@/lib/assistant-date-selection";

export function DateSelectionActions({
  selection, owner, onChange, onCancel, onAddWork, onAskAda,
}: {
  selection: AssistantDateSelection | null;
  owner: boolean;
  onChange: (selection: AssistantDateSelection) => void;
  onCancel: () => void;
  onAddWork: () => void;
  onAskAda: () => void;
}) {
  return (
    <div className="date-selection-actions">
      {owner && selection && (
        <label className="micro">
          Use dates as
          <select
            aria-label="Use selected dates as"
            value={selection.kind}
            onChange={event => onChange({ ...selection, kind: event.target.value as AssistantDateSelection["kind"] })}
          >
            <option value="work_window">Work window</option>
            <option value="project_span">Project timeline only</option>
          </select>
        </label>
      )}
      <button className="secondary" onClick={onCancel}>Cancel selection</button>
      <button
        className="secondary date-selection-book"
        disabled={!selection || selection.kind !== "work_window"}
        onClick={onAddWork}
      >
        <Plus size={16} />
        {owner ? "Add work on these dates" : "Request work on these dates"}
      </button>
      <button className="primary" disabled={!selection} onClick={onAskAda}>
        <Sparkles size={16} />Ask ADA about these dates
      </button>
    </div>
  );
}
