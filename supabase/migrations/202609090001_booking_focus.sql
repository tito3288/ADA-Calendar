-- A shorter booking may carry its own focus minimum without changing the
-- project's minimum or effort. Session JSON persists it without a backfill.
-- Preserve the daily-hours checks and the original locked transaction intact.
alter function public.commit_schedule(jsonb,jsonb,jsonb,text,text) rename to commit_schedule_daily_hours;
revoke all on function public.commit_schedule_daily_hours(jsonb,jsonb,jsonb,text,text) from public,anon,authenticated;

create function public.commit_schedule(p_proposal jsonb,p_event jsonb,p_notifications jsonb default '[]',p_request_id text default null,p_undo_id text default null)
returns bigint language plpgsql security definer set search_path='' as $$
declare member public.workspace_members; session jsonb; minimum numeric;
begin
  select * into member from public.workspace_members where user_id=auth.uid() and active;
  if member.user_id is null or member.role='viewer' then raise exception 'Not authorized to schedule work'; end if;
  -- Compare unchanged sessions under the same lock as the delegated commit.
  perform 1 from public.workspaces where id=member.workspace_id for update;
  if jsonb_typeof(p_proposal->'sessions') is distinct from 'array' then raise exception 'Invalid schedule shape'; end if;
  for session in select value from jsonb_array_elements(p_proposal->'sessions') loop
    if session ? 'focusOverrideMinutes' then
      if jsonb_typeof(session->'focusOverrideMinutes') is distinct from 'number' then raise exception 'Booking-specific focus must be a number'; end if;
      minimum := (session->>'focusOverrideMinutes')::numeric;
      if minimum<15 or minimum>480 or mod(minimum,15)<>0 then raise exception 'Booking-specific focus requires positive 15-minute increments up to 480 minutes'; end if;
      -- A requester may retain an owner's existing override in the snapshot,
      -- but cannot create or change one, even by calling the RPC directly.
      if member.role='requester' and not exists(
        select 1 from public.work_sessions old
        where old.workspace_id=member.workspace_id and old.body=session
      ) then raise exception 'Only the owner can authorize booking-specific shorter focus'; end if;
    end if;
  end loop;
  return public.commit_schedule_daily_hours(p_proposal,p_event,p_notifications,p_request_id,p_undo_id);
end;
$$;
revoke all on function public.commit_schedule(jsonb,jsonb,jsonb,text,text) from public,anon;
grant execute on function public.commit_schedule(jsonb,jsonb,jsonb,text,text) to authenticated;
