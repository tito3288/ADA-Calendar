import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../supabase/migrations/202609090001_booking_focus.sql", import.meta.url), "utf8");
const dailyHours = readFileSync(new URL("../../supabase/migrations/202609080001_daily_hours.sql", import.meta.url), "utf8");
const sql = migration.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();

// Static release guards only. These do not claim to execute PostgreSQL or prove
// the RPC behavior; they keep its validation/delegation contract reviewable.
describe("booking-specific focus SQL boundary", () => {
  it("keeps the existing daily-hours wrapper and atomic commit behind the exposed RPC", () => {
    expect(sql).toContain("alter function public.commit_schedule(jsonb,jsonb,jsonb,text,text) rename to commit_schedule_daily_hours;");
    expect(sql).toContain("revoke all on function public.commit_schedule_daily_hours(jsonb,jsonb,jsonb,text,text) from public,anon,authenticated;");
    expect(sql).toContain("return public.commit_schedule_daily_hours(p_proposal,p_event,p_notifications,p_request_id,p_undo_id);");
    expect(sql).not.toContain("return public.commit_schedule_transaction(");
    expect(dailyHours).toContain("Sessions exceed daily hours on %");
    expect(dailyHours).toContain("return public.commit_schedule_transaction(p_proposal,p_event,p_notifications,p_request_id,p_undo_id);");
    expect(sql).not.toMatch(/\b(?:insert into|update|delete from) public\.(?:workspaces|work_sessions)\b/);
  });

  it("retains authenticated-only access and checks membership before comparing persisted sessions", () => {
    expect(sql).toContain("security definer set search_path=''");
    expect(sql).toContain("where user_id=auth.uid() and active;");
    expect(sql).toContain("if member.user_id is null or member.role='viewer' then raise exception");
    expect(sql).toContain("revoke all on function public.commit_schedule(jsonb,jsonb,jsonb,text,text) from public,anon;");
    expect(sql).toContain("grant execute on function public.commit_schedule(jsonb,jsonb,jsonb,text,text) to authenticated;");
    expect(sql.indexOf("for update;")).toBeLessThan(sql.indexOf("for session in"));
    expect(sql.indexOf("for session in")).toBeLessThan(sql.indexOf("return public.commit_schedule_daily_hours("));
  });

  it("requires optional focus metadata to be numeric and match the server's 15-minute bounds", () => {
    expect(sql).toContain("if jsonb_typeof(p_proposal->'sessions') is distinct from 'array' then raise exception");
    expect(sql).toContain("if session ? 'focusOverrideMinutes' then");
    expect(sql).toContain("if jsonb_typeof(session->'focusOverrideMinutes') is distinct from 'number' then raise exception");
    expect(sql).toContain("minimum := (session->>'focusOverrideMinutes')::numeric;");
    expect(sql).toContain("if minimum<15 or minimum>480 or mod(minimum,15)<>0 then raise exception");
    expect(sql.indexOf("is distinct from 'number'")).toBeLessThan(sql.indexOf("::numeric;"));
    expect(sql).not.toContain("session->>'status'='planned'");
  });

  it("allows requester snapshots to retain exact owner-created rows but rejects new or changed overrides", () => {
    expect(sql).toContain("if member.role='requester' and not exists( select 1 from public.work_sessions old where old.workspace_id=member.workspace_id and old.body=session ) then raise exception");
    expect(sql).toContain("Only the owner can authorize booking-specific shorter focus");
    // Comparing only session IDs or the override value would let a requester
    // smuggle changes into an otherwise owner-created booking.
    expect(sql).not.toContain("old.id=session->>'id'");
    expect(sql).not.toContain("old.body->'focusOverrideMinutes'=session->'focusOverrideMinutes'");
  });
});
