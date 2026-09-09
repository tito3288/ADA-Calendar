import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readMigration = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8");
const migration = readMigration("202609090002_undo_started_work.sql");
const sql = migration.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
const focus = readMigration("202609090001_booking_focus.sql");
const dailyHours = readMigration("202609080001_daily_hours.sql");
const transaction = readMigration("202609050001_core.sql");

// These static release guards document the wrapper contract, not PostgreSQL
// execution. Runtime cases are also exercised against an isolated test database.
describe("started-work undo SQL boundary", () => {
  it("preserves the focus and daily-hours wrappers before the original transaction", () => {
    expect(sql).toContain("alter function public.commit_schedule(jsonb,jsonb,jsonb,text,text) rename to commit_schedule_booking_focus;");
    expect(sql).toContain("revoke all on function public.commit_schedule_booking_focus(jsonb,jsonb,jsonb,text,text) from public,anon,authenticated;");
    expect(sql).toContain("return public.commit_schedule_booking_focus(p_proposal,p_event,p_notifications,p_request_id,p_undo_id);");
    expect(focus).toContain("return public.commit_schedule_daily_hours(p_proposal,p_event,p_notifications,p_request_id,p_undo_id);");
    expect(dailyHours).toContain("return public.commit_schedule_transaction(p_proposal,p_event,p_notifications,p_request_id,p_undo_id);");
    expect(sql).not.toMatch(/\b(?:insert into|update|delete from) public\.(?:workspaces|work_sessions|work_events)\b/);
  });

  it("authenticates, isolates the workspace and locks before examining current bookings", () => {
    expect(sql).toContain("security definer set search_path=''");
    expect(sql).toContain("where user_id=auth.uid() and active;");
    expect(sql).toContain("if member.user_id is null or member.role='viewer' then raise exception");
    expect(sql).toContain("perform 1 from public.workspaces where id=member.workspace_id for update;");
    expect(sql).toContain("if not found then raise exception 'Workspace not found'; end if;");
    expect(sql.indexOf("for update;")).toBeLessThan(sql.indexOf("checked_at := clock_timestamp();"));
    expect(sql.indexOf("checked_at := clock_timestamp();")).toBeLessThan(sql.indexOf("from public.work_sessions old"));
    expect(sql).toContain("old.workspace_id=member.workspace_id and old.starts_at<checked_at");
  });

  it("only adds restrictions to undo and requires the owner", () => {
    expect(sql).toContain("if p_undo_id is not null then if member.role<>'owner' then raise exception 'Only owner can undo'; end if;");
    expect(sql.indexOf("if p_undo_id is not null then")).toBeLessThan(sql.indexOf("from public.work_sessions old"));
    expect(sql).toContain("revoke all on function public.commit_schedule(jsonb,jsonb,jsonb,text,text) from public,anon;");
    expect(sql).toContain("grant execute on function public.commit_schedule(jsonb,jsonb,jsonb,text,text) to authenticated;");
    expect(sql).not.toContain("p_proposal->'commands'");
  });

  it("requires exact retained bodies for all already-started statuses, including absent new bookings", () => {
    expect(sql).toContain("and not exists( select 1 from jsonb_array_elements(p_proposal->'sessions') fresh where fresh=old.body )");
    expect(sql).toContain("Undo cannot remove or change work that has already started");
    expect(sql).not.toMatch(/old\.status|old\.body->>'(?:start|end|status)'|fresh->>'id'/);
    expect(sql.indexOf("is distinct from 'array'")).toBeLessThan(sql.indexOf("jsonb_array_elements(p_proposal->'sessions')"));
  });

  it("delegates duplicate operations to existing actor/command idempotency without a second write", () => {
    expect(sql).toContain("if not exists( select 1 from public.work_events where workspace_id=member.workspace_id and operation_id=p_proposal->>'operationId' ) then");
    expect(sql.indexOf("from public.work_events")).toBeLessThan(sql.indexOf("from public.work_sessions old"));
    expect(transaction).toContain("Operation id was already used for a different actor or command");
    expect(transaction).toContain("return duplicate_version;");
  });

  it("retains original latest-event, exact-before-snapshot and restored-past checks", () => {
    expect(transaction).toContain("where id=p_undo_id and workspace_id=w.id for update;");
    expect(transaction).toContain("Only the latest unchanged schedule event can be undone");
    expect(transaction).toContain("Undo does not match original state");
    expect(transaction).toContain("New or changed work cannot be scheduled in the past");
  });
});
