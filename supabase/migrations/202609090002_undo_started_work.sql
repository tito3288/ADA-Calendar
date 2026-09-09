-- Undo must not erase a newly booked session, or rewrite its history, after
-- that CURRENT session has started. The original transaction separately checks
-- that restored planned sessions are not moved into the past. Preserve both
-- checks and the existing focus / daily-hours validation wrappers.
alter function public.commit_schedule(jsonb,jsonb,jsonb,text,text) rename to commit_schedule_booking_focus;
revoke all on function public.commit_schedule_booking_focus(jsonb,jsonb,jsonb,text,text) from public,anon,authenticated;

create function public.commit_schedule(p_proposal jsonb,p_event jsonb,p_notifications jsonb default '[]',p_request_id text default null,p_undo_id text default null)
returns bigint language plpgsql security definer set search_path='' as $$
declare member public.workspace_members; checked_at timestamptz;
begin
  select * into member from public.workspace_members where user_id=auth.uid() and active;
  if member.user_id is null or member.role='viewer' then raise exception 'Not authorized to schedule work'; end if;
  -- Every delegated commit locks this same workspace row. Checking after this
  -- lock prevents a concurrent booking edit from racing the undo validation.
  perform 1 from public.workspaces where id=member.workspace_id for update;
  if not found then raise exception 'Workspace not found'; end if;
  if p_undo_id is not null then
    if member.role<>'owner' then raise exception 'Only owner can undo'; end if;
    -- A successful operation can be retried after its restored sessions start.
    -- Delegate duplicate requests unchanged: the original transaction verifies
    -- their authenticated actor and exact commands before returning a version.
    if not exists(
      select 1 from public.work_events
      where workspace_id=member.workspace_id and operation_id=p_proposal->>'operationId'
    ) then
      if jsonb_typeof(p_proposal->'sessions') is distinct from 'array' then raise exception 'Invalid schedule shape'; end if;
      -- Use the clock after obtaining the lock, not transaction-start time:
      -- a booking may have started while this transaction waited for the lock.
      checked_at := clock_timestamp();
      if exists(
        select 1 from public.work_sessions old
        where old.workspace_id=member.workspace_id and old.starts_at<checked_at
          and not exists(
            select 1 from jsonb_array_elements(p_proposal->'sessions') fresh
            where fresh=old.body
          )
      ) then raise exception 'Undo cannot remove or change work that has already started'; end if;
    end if;
  end if;
  return public.commit_schedule_booking_focus(p_proposal,p_event,p_notifications,p_request_id,p_undo_id);
end;
$$;
revoke all on function public.commit_schedule(jsonb,jsonb,jsonb,text,text) from public,anon;
grant execute on function public.commit_schedule(jsonb,jsonb,jsonb,text,text) to authenticated;
