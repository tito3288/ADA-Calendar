import { createHash } from "node:crypto";
import type { ScheduleProposal, WorkItem, WorkSession } from "../types";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return "{" + entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",") + "}";
  }
  return JSON.stringify(value);
}
function work(item: WorkItem) {
  const { createdAt: _created, updatedAt: _updated, completedAt, ...fields } = item;
  void _created; void _updated;
  // Completion remains meaningful; the precise server-generated instant is not a reviewed placement.
  return { ...fields, completedAt: completedAt === null ? null : "completed" };
}
function sessions(entries: WorkSession[]) {
  return entries.map(({ id: _id, ...fields }) => { void _id; return fields; }).sort((a, b) => canonical(a).localeCompare(canonical(b)));
}

/** Semantic comparison, not authorization. Ignore regenerated identifiers/clock metadata only. */
export function reviewFingerprint(proposal: ScheduleProposal): string {
  const visible = {
    baseVersion: proposal.baseVersion, actorId: proposal.actorId,
    status: proposal.status, requiresApproval: proposal.requiresApproval,
    commands: proposal.commands,
    items: proposal.items.map(work).sort((a, b) => a.id.localeCompare(b.id)),
    sessions: sessions(proposal.sessions), blocks: [...proposal.blocks].sort((a, b) => a.id.localeCompare(b.id)),
    affectedItemIds: [...proposal.affectedItemIds].sort(), summary: proposal.summary,
    conflicts: proposal.conflicts,
    alternatives: proposal.alternatives.map(alternative => ({ ...alternative, sessions: sessions(alternative.sessions) })),
  };
  return createHash("sha256").update(canonical(visible)).digest("hex");
}
export function withReviewFingerprint(proposal: ScheduleProposal): ScheduleProposal {
  return { ...proposal, reviewFingerprint: reviewFingerprint(proposal) };
}
export class PreviewChangedError extends Error {
  readonly proposal: ScheduleProposal;
  constructor(proposal: ScheduleProposal) {
    super("The reviewed plan changed as time passed or the schedule changed. Review this fresh preview before saving.");
    this.name = "PreviewChangedError";
    this.proposal = withReviewFingerprint(proposal);
  }
}
export function assertReviewedProposal(reviewed: ScheduleProposal, fresh: ScheduleProposal): void {
  // Direct, explicit assistant instructions have no human preview; manual routes require one.
  if (reviewed.reviewFingerprint && reviewed.reviewFingerprint !== reviewFingerprint(fresh)) throw new PreviewChangedError(fresh);
}
