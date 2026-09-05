import type {
  Actor, ScheduleAlternative, ScheduleConflict, ScheduleProposal, ScheduleSnapshot,
  UnavailableBlock, WorkCommand, WorkItem, WorkSession,
} from "./types";
import {
  addDays, addMinutes, ceilToSlot, dayOfWeek, instantFromMs, instantMs, isDate, isInstant,
  localDate, localDateTime, maxDate, minutesBetween,
} from "./time";

type Interval = { start: number; end: number };
type PlanOptions = { now?: string; operationId?: string; approveDisplacement?: boolean };
type Allocation = { sessions: WorkSession[]; missing: number };
const MINUTE = 60_000;
const HORIZON_DAYS = 366;
const schedulingFields = new Set(["estimatedMinutes", "remainingMinutes", "windowStart", "windowEnd", "targetDate", "deadline", "allowedDates", "minimumSessionMinutes", "priorityId", "status"]);

const clone = <T>(value: T): T => structuredClone(value);
const uuid = () => crypto.randomUUID();
const liveItem = (item: WorkItem) => item.status === "planned" || item.status === "in_progress";
// Completed reservations are history, not capacity. In particular an early completion
// must not turn back into occupied time when its original planned date eventually arrives.
const activeSession = (session: WorkSession) => session.status === "planned";
const planned = (session: WorkSession) => session.status === "planned";
const overlap = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;
const range = (value: { start: string; end: string }): Interval => ({ start: instantMs(value.start), end: instantMs(value.end) });
const duration = (interval: Interval) => Math.max(0, (interval.end - interval.start) / MINUTE);
const conflict = (code: string, message: string, itemIds: string[] = []): ScheduleConflict => ({ code, message, itemIds });
const rank = (snapshot: ScheduleSnapshot, item: WorkItem) => snapshot.priorities.find((priority) => priority.id === item.priorityId)?.rank ?? 2;

function dayBounds(snapshot: ScheduleSnapshot, date: string) {
  const s = snapshot.settings;
  const start = instantMs(localDateTime(date, s.dayStart, s.timeZone));
  const end = instantMs(localDateTime(date, s.dayEnd, s.timeZone));
  const lunch = { start: instantMs(localDateTime(date, s.lunchStart, s.timeZone)), end: instantMs(localDateTime(date, s.lunchEnd, s.timeZone)) };
  const reserveStart = instantMs(localDateTime(date, s.reserveStart, s.timeZone));
  return { start, end, lunch, reserve: { start: reserveStart, end: Math.min(end, reserveStart + s.reserveMinutes * MINUTE) } };
}

function settingsConflicts(snapshot: ScheduleSnapshot, now: string): ScheduleConflict[] {
  if (!isInstant(now)) return [conflict("invalid_now", "The scheduling clock is invalid.")];
  const settings = snapshot.settings;
  try {
    const date = localDate(now, settings.timeZone);
    const bounds = dayBounds(snapshot, date);
    if (!settings.weekdays.length || settings.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7) ||
      !Number.isInteger(settings.slotMinutes) || settings.slotMinutes <= 0 || !Number.isFinite(settings.reserveMinutes) || settings.reserveMinutes < 0 ||
      bounds.end <= bounds.start || bounds.lunch.start < bounds.start || bounds.lunch.end > bounds.end || bounds.lunch.end < bounds.lunch.start ||
      bounds.reserve.start < bounds.start || bounds.reserve.start + settings.reserveMinutes * MINUTE > bounds.end || overlap(bounds.lunch, bounds.reserve)) {
      return [conflict("invalid_settings", "Working hours, lunch, reserve, weekdays, and scheduling increments must describe a valid workday.")];
    }
  } catch { return [conflict("invalid_settings", "Workspace hours or timezone are invalid.")]; }
  return [];
}

function merge(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((part) => part.end > part.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const result: Interval[] = [];
  for (const part of sorted) {
    const last = result.at(-1);
    if (last && part.start <= last.end) last.end = Math.max(last.end, part.end);
    else result.push({ ...part });
  }
  return result;
}

function subtract(whole: Interval, occupied: Interval[]): Interval[] {
  let cursor = whole.start;
  const result: Interval[] = [];
  for (const part of merge(occupied)) {
    if (part.end <= cursor || part.start >= whole.end) continue;
    if (part.start > cursor) result.push({ start: cursor, end: Math.min(part.start, whole.end) });
    cursor = Math.max(cursor, part.end);
    if (cursor >= whole.end) break;
  }
  if (cursor < whole.end) result.push({ start: cursor, end: whole.end });
  return result;
}

/** Reserve-eligible IT may occur earlier than the displayed reserve. Its minutes release
 * equivalent *still usable* reserve capacity; elapsed reserve time is never recreated. */
function reserveBlock(snapshot: ScheduleSnapshot, date: string, now: string): Interval | null {
  const { reserve } = dayBounds(snapshot, date);
  const nowMs = instantMs(now);
  const usableStart = Math.max(reserve.start, nowMs);
  if (usableStart >= reserve.end) return null;
  const consumed = snapshot.sessions.filter((session) => session.status !== "cancelled" && session.usesReserve && isInstant(session.start) && isInstant(session.end) && (planned(session) || instantMs(session.end) <= nowMs) && localDate(session.start, snapshot.settings.timeZone) === date)
    .reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0);
  const released = Math.min(snapshot.settings.reserveMinutes, consumed, duration({ start: usableStart, end: reserve.end }));
  const start = usableStart + released * MINUTE;
  return start < reserve.end ? { start, end: reserve.end } : null;
}

function freeIntervals(snapshot: ScheduleSnapshot, date: string, now: string, useReserve: boolean, ignore: Set<string> = new Set()): Interval[] {
  if (!snapshot.settings.weekdays.includes(dayOfWeek(date))) return [];
  const bounds = dayBounds(snapshot, date);
  const start = Math.max(bounds.start, instantMs(ceilToSlot(now, date, snapshot.settings)));
  if (start >= bounds.end) return [];
  const occupied: Interval[] = [bounds.lunch, ...snapshot.blocks.map(range)];
  for (const session of snapshot.sessions) {
    if (activeSession(session) && !ignore.has(session.id)) occupied.push(range(session));
  }
  if (!useReserve) {
    const reserved = reserveBlock(snapshot, date, now);
    if (reserved) occupied.push(reserved);
  }
  return subtract({ start, end: bounds.end }, occupied);
}

function futureMinutes(session: WorkSession, now: string): number {
  return planned(session) ? Math.max(0, (instantMs(session.end) - Math.max(instantMs(session.start), instantMs(now))) / MINUTE) : 0;
}

function target(item: WorkItem): string | null {
  return [item.targetDate, item.windowEnd, item.deadline].filter((date): date is string => !!date).sort()[0] ?? null;
}

function allocation(snapshot: ScheduleSnapshot, item: WorkItem, now: string, options: { useReserve?: boolean; ignore?: Set<string>; until?: string; from?: string } = {}): Allocation {
  const ignore = options.ignore ?? new Set<string>();
  const existing = snapshot.sessions.filter((session) => session.workItemId === item.id && !ignore.has(session.id));
  const reservedEffort = Math.ceil((item.remainingMinutes ?? 0) / snapshot.settings.slotMinutes) * snapshot.settings.slotMinutes;
  let missing = Math.max(0, Math.ceil((reservedEffort - existing.reduce((sum, session) => sum + futureMinutes(session, now), 0)) / snapshot.settings.slotMinutes) * snapshot.settings.slotMinutes);
  if (!liveItem(item) || missing === 0) return { sessions: [], missing: 0 };
  const first = maxDate(item.windowStart, localDate(now, snapshot.settings.timeZone), options.from ?? item.windowStart);
  const last = [addDays(first, HORIZON_DAYS), item.deadline, options.until].filter((date): date is string => !!date).sort()[0];
  const sessions: WorkSession[] = [];
  const allowed = new Set(item.allowedDates);
  const minimum = Math.max(snapshot.settings.slotMinutes, Math.ceil(item.minimumSessionMinutes / snapshot.settings.slotMinutes) * snapshot.settings.slotMinutes);
  for (let date = first; date <= last && missing > 0; date = addDays(date, 1)) {
    if (allowed.size && !allowed.has(date)) continue;
    for (const free of freeIntervals(snapshot, date, now, !!options.useReserve, ignore)) {
      const alignedStart = instantMs(ceilToSlot(instantFromMs(free.start), date, snapshot.settings));
      const available = Math.floor(duration({ start: alignedStart, end: free.end }) / snapshot.settings.slotMinutes) * snapshot.settings.slotMinutes;
      const effectiveMinimum = Math.min(minimum, missing);
      if (available < effectiveMinimum) continue;
      let take = Math.min(available, missing);
      // Do not manufacture an undersized final focus session by greedily taking a partial gap.
      if (take < missing && missing - take < minimum) take = Math.floor((missing - minimum) / snapshot.settings.slotMinutes) * snapshot.settings.slotMinutes;
      if (take < effectiveMinimum) continue;
      const start = instantFromMs(alignedStart);
      sessions.push({ id: uuid(), workItemId: item.id, start, end: addMinutes(start, take), protected: false, status: "planned", usesReserve: !!options.useReserve });
      missing -= take;
      if (missing <= 0) break;
    }
  }
  return { sessions, missing };
}

function itemConflicts(snapshot: ScheduleSnapshot, item: WorkItem): ScheduleConflict[] {
  const errors: ScheduleConflict[] = [];
  const add = (code: string, message: string) => errors.push(conflict(code, message, [item.id]));
  if (!snapshot.clients.some((client) => client.id === item.clientId)) add("unknown_client", `Choose an existing client for “${item.title}”.`);
  if (!item.title.trim()) add("missing_title", "Work needs a title.");
  if (!snapshot.priorities.some((priority) => priority.id === item.priorityId)) add("unknown_priority", `“${item.title}” has an unknown priority.`);
  if (item.estimatedMinutes === null || !Number.isFinite(item.estimatedMinutes) || item.estimatedMinutes <= 0) add("missing_estimate", `“${item.title}” needs a positive effort estimate.`);
  if (item.remainingMinutes === null || !Number.isFinite(item.remainingMinutes) || item.remainingMinutes < 0) add("invalid_remaining", `“${item.title}” needs a nonnegative remaining-effort estimate.`);
  if (!Number.isFinite(item.minimumSessionMinutes) || item.minimumSessionMinutes <= 0) add("invalid_focus", `“${item.title}” needs a positive minimum session length.`);
  if (!isDate(item.windowStart) || [item.windowEnd, item.targetDate, item.deadline, item.updateDate, ...item.allowedDates].some((date) => date !== null && !isDate(date))) add("invalid_date", `“${item.title}” has an invalid calendar date.`);
  if (item.deadline && item.deadline < item.windowStart) add("deadline_before_start", `“${item.title}” has a firm deadline before its start date.`);
  if (item.progressCompleted < 0 || (item.progressTotal !== null && item.progressCompleted > item.progressTotal)) add("invalid_progress", `“${item.title}” has an invalid progress count.`);
  return errors;
}

/** Checks hard calendar invariants. Missing future effort is validated by the planner for
 * changed work, not by treating the passage of time as implicit task completion. */
export function validateSchedule(snapshot: ScheduleSnapshot, now = new Date().toISOString()): ScheduleConflict[] {
  const settingsErrors = settingsConflicts(snapshot, now);
  if (settingsErrors.length) return settingsErrors;
  const errors: ScheduleConflict[] = [];
  const ids = new Set<string>();
  for (const item of snapshot.items) {
    if (ids.has(item.id)) errors.push(conflict("duplicate_item", "Two work items have the same identifier.", [item.id]));
    ids.add(item.id);
    errors.push(...itemConflicts(snapshot, item));
  }
  const sessionIds = new Set<string>();
  const valid: WorkSession[] = [];
  for (const session of snapshot.sessions) {
    if (sessionIds.has(session.id)) errors.push(conflict("duplicate_session", "Two work sessions have the same identifier.", [session.workItemId]));
    sessionIds.add(session.id);
    if (!activeSession(session)) continue;
    const item = snapshot.items.find((candidate) => candidate.id === session.workItemId);
    if (!item) { errors.push(conflict("unknown_work", "A session refers to missing work.", [session.workItemId])); continue; }
    if (!isInstant(session.start) || !isInstant(session.end) || minutesBetween(session.start, session.end) <= 0) { errors.push(conflict("invalid_session", `“${item.title}” has an invalid session.`, [item.id])); continue; }
    valid.push(session);
    const date = localDate(session.start, snapshot.settings.timeZone);
    const bounds = dayBounds(snapshot, date);
    const part = range(session);
    if (!snapshot.settings.weekdays.includes(dayOfWeek(date)) || part.start < bounds.start || part.end > bounds.end || overlap(part, bounds.lunch)) errors.push(conflict("outside_work_hours", `“${item.title}” must fit working hours and avoid lunch.`, [item.id]));
    if (planned(session) && part.end > instantMs(now) && !liveItem(item)) errors.push(conflict("inactive_work", `“${item.title}” cannot reserve work time while ${item.status}.`, [item.id]));
    if (planned(session) && part.start >= instantMs(now)) {
      const scheduledMinutes = minutesBetween(session.start, session.end);
      if (minutesBetween(instantFromMs(bounds.start), session.start) % snapshot.settings.slotMinutes !== 0 || scheduledMinutes % snapshot.settings.slotMinutes !== 0) errors.push(conflict("slot_alignment", `“${item.title}” must use ${snapshot.settings.slotMinutes}-minute scheduling increments.`, [item.id]));
      const itemSessions = snapshot.sessions.filter((entry) => entry.workItemId === item.id && isInstant(entry.start) && isInstant(entry.end) && futureMinutes(entry, now) > 0).sort((a, b) => instantMs(a.start) - instantMs(b.start));
      const minimum = Math.min(item.minimumSessionMinutes, item.remainingMinutes ?? 0);
      const earlierMinutes = itemSessions.filter((entry) => instantMs(entry.end) <= part.start).reduce((sum, entry) => sum + futureMinutes(entry, now), 0);
      const smallerRemainder = itemSessions.at(-1)?.id === session.id && earlierMinutes > 0 && (item.remainingMinutes ?? 0) - earlierMinutes <= scheduledMinutes;
      if (scheduledMinutes < minimum && !smallerRemainder) errors.push(conflict("focus_length", `“${item.title}” needs a focus session of at least ${minimum} minutes.`, [item.id]));
    }
    if (planned(session) && (date < item.windowStart || (item.allowedDates.length > 0 && !item.allowedDates.includes(date)))) errors.push(conflict("outside_allowed_dates", `“${item.title}” is outside its allowed work dates.`, [item.id]));
    if (planned(session) && item.deadline && date > item.deadline) errors.push(conflict("firm_deadline", `“${item.title}” would miss its firm deadline of ${item.deadline}.`, [item.id]));
    if (planned(session) && part.end > instantMs(now) && !session.usesReserve) {
      const reserved = reserveBlock(snapshot, date, now);
      if (reserved && overlap(part, reserved)) errors.push(conflict("it_reserve", `“${item.title}” occupies unallocated IT reserve.`, [item.id]));
    }
    if (session.usesReserve && item.category !== "it") errors.push(conflict("reserve_category", `Only IT work may consume the IT reserve.`, [item.id]));
    if (snapshot.blocks.some((block) => isInstant(block.start) && isInstant(block.end) && overlap(part, range(block)))) errors.push(conflict("unavailable", `“${item.title}” overlaps unavailable time.`, [item.id]));
  }
  valid.sort((a, b) => instantMs(a.start) - instantMs(b.start) || a.id.localeCompare(b.id));
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length && instantMs(valid[j].start) < instantMs(valid[i].end); j++) {
      if (overlap(range(valid[i]), range(valid[j]))) errors.push(conflict("overlap", "Two work sessions overlap.", [...new Set([valid[i].workItemId, valid[j].workItemId])]));
    }
  }
  for (const block of snapshot.blocks) if (!isInstant(block.start) || !isInstant(block.end) || minutesBetween(block.start, block.end) <= 0) errors.push(conflict("invalid_block", "Unavailable time needs a valid start and end."));
  return errors;
}

export function dayCapacity(snapshot: ScheduleSnapshot, date: string): { plannedMinutes: number; availableMinutes: number; capacityMinutes: number } {
  if (!snapshot.settings.weekdays.includes(dayOfWeek(date))) return { plannedMinutes: 0, availableMinutes: 0, capacityMinutes: 0 };
  const bounds = dayBounds(snapshot, date);
  const dayStart = instantFromMs(bounds.start);
  const sessions = snapshot.sessions.filter((session) => activeSession(session) && localDate(session.start, snapshot.settings.timeZone) === date);
  const reserveUsed = Math.min(snapshot.settings.reserveMinutes, sessions.filter((session) => session.usesReserve).reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0));
  const unavailable = [bounds.lunch, bounds.reserve, ...snapshot.blocks.map(range)];
  const capacityMinutes = subtract({ start: bounds.start, end: bounds.end }, unavailable).reduce((sum, part) => sum + duration(part), 0);
  const plannedMinutes = Math.max(0, sessions.reduce((sum, session) => sum + minutesBetween(session.start, session.end), 0) - reserveUsed);
  const availableMinutes = Math.min(Math.max(0, capacityMinutes - plannedMinutes), freeIntervals(snapshot, date, dayStart, false).reduce((sum, part) => sum + duration(part), 0));
  return { plannedMinutes, availableMinutes, capacityMinutes };
}

function cancelFuture(snapshot: ScheduleSnapshot, itemId: string, now: string, overrideProtected: boolean): ScheduleConflict | null {
  const affected = snapshot.sessions.filter((session) => session.workItemId === itemId && planned(session) && instantMs(session.end) > instantMs(now));
  if (!overrideProtected && affected.some((session) => session.protected)) return conflict("protected_session", "This change would remove protected work time. Bryan must explicitly override it.", [itemId]);
  for (const session of affected) removeFutureSession(snapshot, session, now);
  return null;
}

function removeFutureSession(snapshot: ScheduleSnapshot, session: WorkSession, now: string) {
  if (instantMs(session.start) < instantMs(now) && instantMs(session.end) > instantMs(now)) session.end = now;
  else snapshot.sessions = snapshot.sessions.filter((candidate) => candidate.id !== session.id);
}

function refreshForecasts(snapshot: ScheduleSnapshot, now: string, affected: Set<string>) {
  for (const item of snapshot.items) {
    if (!affected.has(item.id)) continue;
    const dates = snapshot.sessions.filter((session) => session.workItemId === item.id && planned(session) && instantMs(session.end) > instantMs(now)).map((session) => localDate(session.end, snapshot.settings.timeZone));
    item.forecastDate = dates.sort().at(-1) ?? (item.status === "completed" && item.completedAt ? localDate(item.completedAt, snapshot.settings.timeZone) : null);
  }
}

function changes(before: ScheduleSnapshot, after: ScheduleSnapshot): string[] {
  const affected = new Set<string>();
  const itemMap = new Map(before.items.map((item) => [item.id, item]));
  for (const item of after.items) if (JSON.stringify(itemMap.get(item.id)) !== JSON.stringify(item)) affected.add(item.id);
  const sessionsBefore = new Map(before.sessions.map((session) => [session.id, session]));
  const sessionsAfter = new Map(after.sessions.map((session) => [session.id, session]));
  for (const session of [...before.sessions, ...after.sessions]) if (JSON.stringify(sessionsBefore.get(session.id)) !== JSON.stringify(sessionsAfter.get(session.id))) affected.add(session.workItemId);
  return [...affected];
}

function alternatives(snapshot: ScheduleSnapshot, item: WorkItem, now: string): ScheduleAlternative[] {
  const result: ScheduleAlternative[] = [];
  let from = maxDate(item.windowStart, localDate(now, snapshot.settings.timeZone));
  for (let i = 0; i < 3; i++) {
    const found = allocation(snapshot, item, now, { from });
    if (found.missing > 0 || !found.sessions.length) break;
    const start = found.sessions[0].start;
    const end = found.sessions.at(-1)!.end;
    result.push({ start, end, label: `${localDate(start, snapshot.settings.timeZone)}–${localDate(end, snapshot.settings.timeZone)} · no existing work moves`, sessions: found.sessions });
    from = addDays(localDate(start, snapshot.settings.timeZone), 1);
  }
  return result;
}

function trimExcess(snapshot: ScheduleSnapshot, item: WorkItem, now: string, override: boolean): ScheduleConflict | null {
  const reservedEffort = Math.ceil((item.remainingMinutes ?? 0) / snapshot.settings.slotMinutes) * snapshot.settings.slotMinutes;
  let excess = Math.floor((snapshot.sessions.filter((session) => session.workItemId === item.id).reduce((sum, session) => sum + futureMinutes(session, now), 0) - reservedEffort) / snapshot.settings.slotMinutes) * snapshot.settings.slotMinutes;
  const candidates = snapshot.sessions.filter((session) => session.workItemId === item.id && futureMinutes(session, now) > 0).sort((a, b) => instantMs(b.end) - instantMs(a.end));
  for (const session of candidates) {
    if (excess <= 0) break;
    if (session.protected && !override) return conflict("protected_session", `Reducing “${item.title}” would change protected time; explicitly override it.`, [item.id]);
    const take = Math.min(excess, futureMinutes(session, now));
    const newEnd = addMinutes(session.end, -take);
    if (instantMs(newEnd) <= Math.max(instantMs(session.start), instantMs(now))) snapshot.sessions = snapshot.sessions.filter((candidate) => candidate.id !== session.id);
    else session.end = newEnd;
    excess -= take;
  }
  return null;
}

/** Pure, deterministic placement decisions. IDs identify the proposal; callers MUST
 * commit against baseVersion atomically and rerun this function after any version race. */
export function planCommands(snapshot: ScheduleSnapshot, commands: WorkCommand[], actor: Actor, options: PlanOptions = {}): ScheduleProposal {
  const now = options.now ?? new Date().toISOString();
  const result: ScheduleProposal = { id: uuid(), operationId: options.operationId ?? uuid(), baseVersion: snapshot.version, actorId: actor.id, commands: clone(commands), status: "ready", requiresApproval: false, items: clone(snapshot.items), sessions: clone(snapshot.sessions), blocks: clone(snapshot.blocks), affectedItemIds: [], summary: [], conflicts: [], alternatives: [], createdAt: now };
  const fail = (errors: ScheduleConflict[], status: "infeasible" | "approval_required" = "infeasible"): ScheduleProposal => ({ ...result, status, requiresApproval: status === "approval_required", conflicts: errors, items: clone(snapshot.items), sessions: clone(snapshot.sessions), blocks: clone(snapshot.blocks) });
  if (actor.role === "viewer") return fail([conflict("forbidden", "Viewers cannot change or book work.")]);
  const settingsErrors = settingsConflicts(snapshot, now);
  if (settingsErrors.length) return fail(settingsErrors);
  if (actor.role !== "owner" && commands.some((command) => command.type !== "create")) return fail([conflict("forbidden", "Requesters can submit new work, but cannot edit existing work.")]);
  if (actor.role !== "owner" && commands.some((command) => ("overrideProtected" in command && command.overrideProtected) || ("overrideDeadline" in command && command.overrideDeadline))) return fail([conflict("forbidden", "Only Bryan can authorize protected-time or deadline overrides.")]);
  const draft = clone(snapshot);
  const scheduleIds = new Set<string>();
  const explicitIds = new Set<string>();
  const urgentIds = new Set<string>();
  const replacementProtected = new Set<string>();
  const forcedDisplacedIds = new Set<string>();
  const globalProtectedOverride = actor.role === "owner" && commands.some((command) => "overrideProtected" in command && command.overrideProtected && (command.type === "create" || command.type === "block" || command.type === "schedule" && command.urgent));
  const individuallyOverridden = new Set(actor.role === "owner" ? commands.flatMap((command) => {
    if (!("overrideProtected" in command) || !command.overrideProtected) return [];
    if ("itemId" in command) return [command.itemId];
    if (command.type === "move") return snapshot.sessions.filter((session) => session.id === command.sessionId).map((session) => session.workItemId);
    return [];
  }) : []);
  const protectedOverride = (itemId: string) => globalProtectedOverride || individuallyOverridden.has(itemId);
  const changedBlocks: UnavailableBlock[] = [];
  const summaries: string[] = [];
  const errors: ScheduleConflict[] = [];
  try {
    for (const command of commands) {
      if (command.type === "create") {
        const item = clone(command.item);
        if (draft.items.some((existing) => existing.id === item.id)) { errors.push(conflict("duplicate_item", "This work item already exists.", [item.id])); continue; }
        if (actor.role === "requester") {
          item.requestedPriorityId = item.requestedPriorityId ?? item.priorityId;
          item.priorityId = snapshot.priorities.find((priority) => priority.id === "normal")?.id ?? snapshot.priorities.find((priority) => priority.rank === 2)?.id ?? snapshot.priorities.at(-1)?.id ?? "normal";
          item.requesterId = actor.id; item.requestedBy = actor.name;
          item.status = "planned"; item.remainingMinutes = item.estimatedMinutes; item.completedAt = null;
          item.progressCompleted = 0; item.checklist = item.checklist.map((entry) => ({ ...entry, done: false }));
        }
        item.createdAt = now; item.updatedAt = now; item.forecastDate = null;
        draft.items.push(item); scheduleIds.add(item.id);
        if (actor.role === "owner" && (command.urgent || rank(draft, item) === 0)) urgentIds.add(item.id);
        if (command.sessions?.length) {
          explicitIds.add(item.id);
          for (const session of command.sessions) {
            if (session.workItemId !== item.id || session.status !== "planned" || (actor.role !== "owner" && (session.usesReserve || session.protected))) errors.push(conflict("invalid_session", "Requested work sessions contain unsupported settings.", [item.id]));
            draft.sessions.push(clone(session));
          }
        }
        summaries.push(`Added ${item.title}.`);
        continue;
      }
      if (command.type === "block") {
        if (!isInstant(command.block.start) || !isInstant(command.block.end) || minutesBetween(command.block.start, command.block.end) <= 0) { errors.push(conflict("invalid_block", "Unavailable time needs a valid start and end.")); continue; }
        const index = draft.blocks.findIndex((block) => block.id === command.block.id);
        if (command.remove) {
          if (index < 0) errors.push(conflict("unknown_block", "This unavailable block no longer exists."));
          else draft.blocks.splice(index, 1);
        } else {
          if (index >= 0) draft.blocks[index] = clone(command.block); else draft.blocks.push(clone(command.block));
          changedBlocks.push(command.block);
        }
        summaries.push(`${command.remove ? "Removed" : "Updated"} unavailable time: ${command.block.title}.`);
        continue;
      }
      if (command.type === "move") {
        const session = draft.sessions.find((entry) => entry.id === command.sessionId);
        if (!session) { errors.push(conflict("unknown_session", "The work session no longer exists.")); continue; }
        if (session.protected && !command.overrideProtected) { errors.push(conflict("protected_session", "Bryan must explicitly override this protected session before moving it.", [session.workItemId])); continue; }
        if (!planned(session) || instantMs(session.start) < instantMs(now)) { errors.push(conflict("historical_session", "Historical or started sessions cannot be moved; schedule their remaining work instead.", [session.workItemId])); continue; }
        if (!isInstant(command.start) || !isInstant(command.end) || instantMs(command.start) < instantMs(now) || minutesBetween(command.start, command.end) <= 0) { errors.push(conflict("past_session", "New work sessions must start in the future and have positive duration.", [session.workItemId])); continue; }
        if (minutesBetween(session.start, session.end) !== minutesBetween(command.start, command.end)) { errors.push(conflict("move_duration", "Moving a session must preserve its duration; update the effort estimate separately.", [session.workItemId])); continue; }
        session.start = command.start; session.end = command.end;
        scheduleIds.add(session.workItemId); explicitIds.add(session.workItemId);
        summaries.push("Moved a work session.");
        continue;
      }
      if (command.type === "complete_session") {
        const session = draft.sessions.find((entry) => entry.id === command.sessionId);
        if (!session || session.status === "cancelled") { errors.push(conflict("unknown_session", "This work session is no longer available.")); continue; }
        const item = draft.items.find((entry) => entry.id === session.workItemId);
        if (!item) { errors.push(conflict("unknown_work", "This session’s work item is no longer available.", [session.workItemId])); continue; }
        session.status = "completed";
        if (instantMs(session.start) >= instantMs(now)) session.usesReserve = false;
        else if (instantMs(session.end) > instantMs(now)) session.end = now;
        if (command.remainingMinutes !== undefined) item.remainingMinutes = command.remainingMinutes;
        item.updatedAt = now;
        scheduleIds.add(item.id);
        summaries.push(`Completed a work session for ${item.title}; ${command.remainingMinutes === undefined ? "the project’s remaining-effort estimate is unchanged" : `remaining effort is ${command.remainingMinutes} minutes`}.`);
        continue;
      }
      const item = draft.items.find((entry) => entry.id === command.itemId);
      if (!item) { errors.push(conflict("unknown_work", "This work item no longer exists.", [command.itemId])); continue; }
      if (command.type === "client_update") { summaries.push(`Client update for ${item.title}: ${command.message}`); continue; }
      if (command.type === "update") {
        const patch = clone(command.patch);
        const protectedFields = ["id", "createdAt", "completedAt", "forecastDate", "requesterId", "requestedBy"];
        if (protectedFields.some((key) => key in patch)) { errors.push(conflict("immutable_field", "This update includes fields that must be changed through their dedicated action.", [item.id])); continue; }
        if (patch.status === "completed") { errors.push(conflict("completion_command", "Use an explicit completion action to finish work.", [item.id])); continue; }
        if ("deadline" in patch && item.deadline && patch.deadline !== item.deadline && !command.overrideDeadline) { errors.push(conflict("firm_deadline", "Changing a firm deadline requires Bryan’s explicit override.", [item.id])); continue; }
        if (patch.estimatedMinutes !== undefined && patch.estimatedMinutes !== null && patch.remainingMinutes === undefined) patch.remainingMinutes = Math.max(0, patch.estimatedMinutes - Math.max(0, (item.estimatedMinutes ?? 0) - (item.remainingMinutes ?? 0)));
        Object.assign(item, patch);
        if (Object.keys(patch).some((key) => schedulingFields.has(key))) scheduleIds.add(item.id);
        item.updatedAt = now; summaries.push(`Updated ${item.title}.`);
      } else if (command.type === "progress") {
        if (command.remainingMinutes !== undefined) { item.remainingMinutes = command.remainingMinutes; scheduleIds.add(item.id); }
        if (command.progressCompleted !== undefined) item.progressCompleted = command.progressCompleted;
        if (command.checklist !== undefined) item.checklist = clone(command.checklist);
        item.updatedAt = now; summaries.push(`Updated progress on ${item.title}.`);
      } else if (command.type === "status") {
        if (command.remainingMinutes !== undefined) item.remainingMinutes = command.remainingMinutes;
        item.status = command.status; item.updatedAt = now;
        item.blockedReason = command.status === "waiting" ? command.reason ?? "Waiting for a dependency" : null;
        if (command.status === "completed") { item.remainingMinutes = 0; item.completedAt = now; }
        else item.completedAt = null;
        scheduleIds.add(item.id); summaries.push(`${command.status === "completed" ? "Completed" : "Changed status of"} ${item.title}${command.status === "completed" ? "." : ` to ${command.status}.`}`);
      } else if (command.type === "schedule") {
        scheduleIds.add(item.id);
        if (command.urgent || rank(draft, item) === 0) urgentIds.add(item.id);
        if (command.sessions) {
          if (command.sessions.some((session) => session.workItemId !== item.id || session.status !== "planned")) {
            errors.push(conflict("invalid_session", "Replacement sessions must belong to this work item and be planned.", [item.id]));
            continue;
          }
          const cancellation = cancelFuture(draft, item.id, now, !!command.overrideProtected);
          if (cancellation) errors.push(cancellation);
          else { draft.sessions.push(...clone(command.sessions)); explicitIds.add(item.id); }
        } else if (urgentIds.has(item.id)) {
          const ownSessions = draft.sessions.filter((session) => session.workItemId === item.id && planned(session) && instantMs(session.end) > instantMs(now));
          if (!command.overrideProtected && ownSessions.some((session) => session.protected)) errors.push(conflict("protected_session", "Moving this work earlier would change protected time; explicitly override it.", [item.id]));
          else for (const session of ownSessions) {
            if (session.protected) replacementProtected.add(item.id);
            removeFutureSession(draft, session, now);
          }
        }
        summaries.push(`Scheduled ${item.title}.`);
      }
    }
    if (errors.length) return fail(errors);
    for (const id of scheduleIds) {
      const item = draft.items.find((entry) => entry.id === id)!;
      errors.push(...itemConflicts(draft, item));
      if (errors.length) continue;
      if (!liveItem(item)) {
        // Explicit completion/cancellation releases its own reservation, including protected
        // time. Merely pausing/waiting still needs permission to remove protected sessions.
        const release = cancelFuture(draft, id, now, protectedOverride(id) || item.status === "completed" || item.status === "cancelled");
        if (release) errors.push(release);
        if (item.status === "completed") for (const session of draft.sessions) {
          if (session.workItemId === id && planned(session) && instantMs(session.end) <= instantMs(now)) session.status = "completed";
        }
        continue;
      }
      const invalid = draft.sessions.filter((session) => session.workItemId === id && planned(session) && (
        instantMs(session.end) <= instantMs(now) || localDate(session.start, draft.settings.timeZone) < item.windowStart ||
        (item.allowedDates.length > 0 && !item.allowedDates.includes(localDate(session.start, draft.settings.timeZone))) ||
        (item.deadline && localDate(session.end, draft.settings.timeZone) > item.deadline)
      ));
      for (const session of invalid) {
        if (session.protected && instantMs(session.end) > instantMs(now) && !protectedOverride(id)) errors.push(conflict("protected_session", `Changing “${item.title}” would move protected time.`, [id]));
        else {
          if (session.protected && instantMs(session.end) > instantMs(now)) replacementProtected.add(id);
          draft.sessions = draft.sessions.filter((entry) => entry.id !== session.id);
        }
      }
      const trimming = trimExcess(draft, item, now, protectedOverride(id));
      if (trimming) errors.push(trimming);
    }
    if (errors.length) return fail(errors);
    for (const block of changedBlocks) {
      const collisions = draft.sessions.filter((session) => planned(session) && overlap(range(session), range(block)));
      for (const session of collisions) {
        if (session.protected && !protectedOverride(session.workItemId)) errors.push(conflict("protected_session", "Unavailable time would displace a protected session; explicitly override it.", [session.workItemId]));
        else {
          if (session.protected) replacementProtected.add(session.workItemId);
          removeFutureSession(draft, session, now); scheduleIds.add(session.workItemId);
        }
      }
    }
    if (errors.length) return fail(errors);
    if (actor.role === "owner") {
      // A precise owner placement authorizes ordinary displacement at that position.
      // Requester exact-slot collisions remain proposals, never implicit edits.
      const explicitSessions = draft.sessions.filter((session) => explicitIds.has(session.workItemId) && futureMinutes(session, now) > 0);
      for (const fixed of explicitSessions) {
        const collisions = draft.sessions.filter((session) => session.workItemId !== fixed.workItemId && planned(session) && overlap(range(session), range(fixed)));
        for (const session of collisions) {
          if (explicitIds.has(session.workItemId)) { errors.push(conflict("overlap", "Two explicitly requested work sessions overlap.", [fixed.workItemId, session.workItemId])); continue; }
          if (session.protected && !protectedOverride(session.workItemId)) { errors.push(conflict("protected_session", "This placement would move protected work; explicitly override it.", [session.workItemId])); continue; }
          if (session.protected) replacementProtected.add(session.workItemId);
          removeFutureSession(draft, session, now);
          scheduleIds.add(session.workItemId); forcedDisplacedIds.add(session.workItemId);
        }
      }
    }
    // Cancelling/reducing an IT reservation can close capacity it previously released.
    // Replan affected ordinary sessions instead of leaving a hidden reserve violation.
    const reserveDependent = draft.sessions.filter((session) => {
      if (!planned(session) || session.usesReserve || instantMs(session.end) <= instantMs(now)) return false;
      const reserved = reserveBlock(draft, localDate(session.start, draft.settings.timeZone), now);
      return reserved && overlap(range(session), reserved);
    });
    for (const session of reserveDependent) {
      if (explicitIds.has(session.workItemId) || actor.role !== "owner") continue;
      if (session.protected && !protectedOverride(session.workItemId)) { errors.push(conflict("protected_session", "Changing IT reserve would move protected work; explicitly override it.", [session.workItemId])); continue; }
      if (session.protected) replacementProtected.add(session.workItemId);
      removeFutureSession(draft, session, now);
      scheduleIds.add(session.workItemId); forcedDisplacedIds.add(session.workItemId);
    }
    if (errors.length) return fail(errors);

    const queue = [...scheduleIds].map((id) => draft.items.find((item) => item.id === id)!).filter(liveItem)
      .sort((a, b) => Number(urgentIds.has(b.id)) - Number(urgentIds.has(a.id)) || rank(draft, a) - rank(draft, b) || (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") || a.id.localeCompare(b.id));
    const requester = actor.role === "requester";
    const displacedIds = new Set<string>(forcedDisplacedIds);
    const settledIds = new Set<string>();
    let requiresApproval = false;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const item = queue[cursor];
      settledIds.add(item.id);
      const incomingRequest = requester && !snapshot.items.some((existing) => existing.id === item.id);
      const desiredEnd = target(item);
      const useReserve = !requester && urgentIds.has(item.id) && item.category === "it";
      const urgent = urgentIds.has(item.id);
      const ownerApproved = actor.role === "owner" && !!options.approveDisplacement;
      const accept = (sessions: WorkSession[]) => draft.sessions.push(...sessions.map((session) => ({ ...session, protected: replacementProtected.has(item.id) || session.protected })));
      const clean = allocation(draft, item, now, { until: desiredEnd ?? undefined, useReserve });
      if (!urgent && clean.missing === 0) { accept(clean.sessions); continue; }
      if (explicitIds.has(item.id)) {
        if (clean.missing === 0) { accept(clean.sessions); continue; }
        errors.push(conflict("insufficient_sessions", `The supplied sessions do not fit the remaining effort for “${item.title}”.`, [item.id]));
        break;
      }
      // Borrow only lower-ranked work (or equal-ranked work for an explicit urgent action).
      // Requester priority is considered solely in the approval preview, never on clean fit.
      const requestedRank = incomingRequest && item.requestedPriorityId ? draft.priorities.find((priority) => priority.id === item.requestedPriorityId)?.rank ?? rank(draft, item) : rank(draft, item);
      const movable = draft.sessions.filter((session) => {
        const other = draft.items.find((candidate) => candidate.id === session.workItemId);
        return other && other.id !== item.id && planned(session) && instantMs(session.end) > instantMs(now) &&
          (!session.protected || protectedOverride(other.id)) && !explicitIds.has(other.id) && !settledIds.has(other.id) &&
          (rank(draft, other) > requestedRank || ((urgent || incomingRequest || ownerApproved) && rank(draft, other) === requestedRank));
      });
      const ignore = new Set(movable.map((session) => session.id));
      const borrowed = allocation(draft, item, now, { until: desiredEnd ?? undefined, useReserve, ignore });
      const hasEarlierPlacement = borrowed.sessions.length > 0 && (clean.missing > 0 || !clean.sessions.length || instantMs(borrowed.sessions[0].start) < instantMs(clean.sessions[0].start));
      if (borrowed.missing === 0 && hasEarlierPlacement) {
        const overlaps = movable.filter((session) => borrowed.sessions.some((added) => overlap(range(session), range(added))));
        // Prove the displaced work still fits before accepting a seemingly attractive
        // earlier slot. Otherwise a valid clean placement could be rejected needlessly.
        const trial = clone(draft);
        for (const old of overlaps) removeFutureSession(trial, trial.sessions.find((session) => session.id === old.id)!, now);
        trial.sessions.push(...borrowed.sessions.map((session) => ({ ...session, protected: replacementProtected.has(item.id) || session.protected })));
        const displaced = [...new Set(overlaps.map((session) => session.workItemId))].map((id) => trial.items.find((entry) => entry.id === id)!)
          .sort((a, b) => (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") || rank(trial, a) - rank(trial, b) || a.id.localeCompare(b.id));
        let repairable = true;
        for (const displacedItem of displaced) {
          const repair = allocation(trial, displacedItem, now);
          if (repair.missing > 0) { repairable = false; break; }
          const keepProtected = replacementProtected.has(displacedItem.id) || overlaps.some((session) => session.workItemId === displacedItem.id && session.protected);
          trial.sessions.push(...repair.sessions.map((session) => ({ ...session, protected: keepProtected })));
        }
        if (repairable) {
          draft.sessions = trial.sessions;
          for (const displacedItem of displaced) {
            displacedIds.add(displacedItem.id);
            if (overlaps.some((session) => session.workItemId === displacedItem.id && session.protected)) replacementProtected.add(displacedItem.id);
          }
          if (requester && overlaps.length) requiresApproval = true;
          continue;
        }
      }
      if (clean.missing === 0) { accept(clean.sessions); continue; }
      if (!incomingRequest) {
        const later = allocation(draft, item, now, { useReserve });
        if (later.missing === 0) {
          accept(later.sessions);
          if (desiredEnd) summaries.push(`${item.title} is forecast after its requested target ${desiredEnd}; its firm deadline is unchanged.`);
          continue;
        }
      }
      if (incomingRequest) result.alternatives.push(...alternatives(draft, item, now));
      errors.push(conflict(item.deadline ? "firm_deadline" : "capacity", `The remaining ${item.remainingMinutes} minutes for “${item.title}” cannot fit ${item.deadline ? `before its firm deadline ${item.deadline}` : "within the requested dates and available focus sessions"}.`, [item.id]));
      break;
    }
    if (errors.length) return fail(errors, requester ? "approval_required" : "infeasible");
    const validation = validateSchedule(draft, now);
    // Explicitly supplied sessions may never create past work, even if other historical
    // sessions are retained as history in the same snapshot.
    const oldSessions = new Map(snapshot.sessions.map((session) => [session.id, session]));
    for (const session of draft.sessions) {
      const original = oldSessions.get(session.id);
      if (planned(session) && (!original || original.start !== session.start) && instantMs(session.start) < instantMs(now)) validation.push(conflict("past_session", "A new work session cannot be scheduled in the past.", [session.workItemId]));
    }
    if (validation.length) return fail(validation, requester ? "approval_required" : "infeasible");
    refreshForecasts(draft, now, new Set([...scheduleIds, ...displacedIds]));
    const affected = new Set(changes(snapshot, draft));
    for (const command of commands) if (command.type === "client_update") affected.add(command.itemId);
    for (const id of displacedIds) {
      const item = draft.items.find((entry) => entry.id === id)!;
      item.updatedAt = now;
      summaries.push(`Moved remaining work for ${item.title}${item.forecastDate ? `; forecast ${item.forecastDate}` : ""}.`);
    }
    result.items = draft.items; result.sessions = draft.sessions; result.blocks = draft.blocks;
    result.affectedItemIds = [...affected]; result.summary = summaries;
    result.requiresApproval = requiresApproval;
    result.status = requiresApproval ? "approval_required" : "ready";
    if (requiresApproval) {
      result.conflicts.push(conflict("displacement_approval", "This request would move existing work. Bryan must approve the displayed changes.", [...displacedIds]));
      for (const item of queue.filter((entry) => !snapshot.items.some((old) => old.id === entry.id))) result.alternatives.push(...alternatives(snapshot, item, now));
    }
    return result;
  } catch (error) {
    return fail([conflict("invalid_input", error instanceof Error ? error.message : "The proposed calendar change is invalid.")]);
  }
}
