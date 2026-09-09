-- Permit only an exact latest-event Undo of an explicitly completed booked day.
-- No stored work, history, events or workspace settings are rewritten.
create or replace function public.commit_schedule_booking_focus(p_proposal jsonb,p_event jsonb,p_notifications jsonb default '[]',p_request_id text default null,p_undo_id text default null)
returns bigint language plpgsql security definer set search_path='' as $$
declare member public.workspace_members; workspace public.workspaces; command jsonb; day jsonb; total numeric; session jsonb; minimum numeric;
  prior_event public.work_events; completion jsonb; allow_completed_undo boolean := false;
begin
  select * into member from public.workspace_members where user_id=auth.uid() and active;
  if member.user_id is null or member.role='viewer' then raise exception 'Not authorized to schedule work'; end if;
  select * into workspace from public.workspaces where id=member.workspace_id for update;
  if jsonb_typeof(p_proposal->'sessions') is distinct from 'array' then raise exception 'Invalid schedule shape'; end if;
  if not exists(select 1 from public.work_events where workspace_id=member.workspace_id and operation_id=p_proposal->>'operationId') then
    -- Only the latest single day-completion event may reverse its own exact
    -- planned-to-completed transition. Stored commands and snapshots are the
    -- authority; event prose or caller-supplied metadata grants no permission.
    if p_undo_id is not null and member.role='owner' then
      select * into prior_event from public.work_events where id=p_undo_id and workspace_id=workspace.id for update;
      if prior_event.id is not null and prior_event.version=workspace.version and prior_event.body->>'undoneBy' is null
        and jsonb_typeof(prior_event.operation_payload)='array' and jsonb_array_length(prior_event.operation_payload)=1
        and prior_event.operation_payload->0->>'type'='complete_day'
        and ((prior_event.operation_payload->0)-'type'-'itemId'-'date')='{}'::jsonb
        and coalesce(prior_event.operation_payload->0->>'itemId','')<>''
        and coalesce(prior_event.operation_payload->0->>'date','') ~ '^\d{4}-\d{2}-\d{2}$'
        and jsonb_build_object('items',p_proposal->'items','sessions',p_proposal->'sessions','blocks',p_proposal->'blocks')=prior_event.body->'before'
        and workspace.items=prior_event.body#>'{after,items}' and workspace.blocks=prior_event.body#>'{after,blocks}'
        and jsonb_array_length(prior_event.body#>'{after,sessions}')=(select count(*) from public.work_sessions where workspace_id=workspace.id)
        and jsonb_array_length(prior_event.body#>'{before,sessions}')=jsonb_array_length(prior_event.body#>'{after,sessions}')
        and not exists(select 1 from public.work_sessions old where old.workspace_id=workspace.id
          and not exists(select 1 from jsonb_array_elements(prior_event.body#>'{after,sessions}') saved where saved=old.body))
      then
        completion:=prior_event.operation_payload->0;
        allow_completed_undo:=true;
      end if;
    end if;
    -- All other completion/cancellation remains immutable. The delegated core
    -- also verifies exact latest-event Undo and actor-bound duplicate replays.
    if exists(
      select 1 from public.work_sessions old
      where old.workspace_id=member.workspace_id and old.status<>'planned'
        and not exists(select 1 from jsonb_array_elements(p_proposal->'sessions') fresh where fresh=old.body)
        and not coalesce((allow_completed_undo and old.status='completed' and old.work_item_id=completion->>'itemId'
          and (old.starts_at at time zone (workspace.settings->>'timeZone'))::date::text=completion->>'date'
          and exists(select 1 from jsonb_array_elements(prior_event.body#>'{before,sessions}') original
            where original->>'id'=old.id and original->>'status'='planned'
              and original||jsonb_build_object('status','completed')=old.body
              and exists(select 1 from jsonb_array_elements(p_proposal->'sessions') fresh where fresh=original))),false)
    ) then raise exception 'Scheduling cannot remove or change completed or cancelled work'; end if;
  end if;
  for session in select value from jsonb_array_elements(p_proposal->'sessions') loop
    if session ? 'focusOverrideMinutes' then
      if jsonb_typeof(session->'focusOverrideMinutes') is distinct from 'number' then raise exception 'Invalid legacy booking metadata'; end if;
      minimum := (session->>'focusOverrideMinutes')::numeric;
      if minimum<15 or minimum>480 or mod(minimum,15)<>0 then raise exception 'Invalid legacy booking metadata'; end if;
      if member.role='requester' and not exists(select 1 from public.work_sessions old where old.workspace_id=member.workspace_id and old.body=session)
        then raise exception 'Requesters cannot add legacy booking metadata'; end if;
    end if;
  end loop;
  for command in select value from jsonb_array_elements(p_proposal->'commands') loop
    if command->>'type'='set_day_hours' then
      if member.role<>'owner' then raise exception 'Only owner can edit daily hours'; end if;
      if jsonb_typeof(command->'days') is distinct from 'array' or jsonb_array_length(command->'days') not between 1 and 366
        then raise exception 'Invalid day hours'; end if;
      if exists(select 1 from jsonb_array_elements(command->'days') d group by d->>'date' having count(*)>1) then raise exception 'Duplicate work day'; end if;
      total:=0;
      for day in select value from jsonb_array_elements(command->'days') loop
        if jsonb_typeof(day) is distinct from 'object' or (day-'date'-'minutes')<>'{}'::jsonb
          or jsonb_typeof(day->'minutes') is distinct from 'number'
          or coalesce(day->>'date','') !~ '^\d{4}-\d{2}-\d{2}$' or (day->>'date')::date::text<>day->>'date'
          or (day->>'minutes')::numeric<0 or (day->>'minutes')::numeric>480 or mod((day->>'minutes')::numeric,15)<>0
          then raise exception 'Invalid day hours'; end if;
        total:=total+(day->>'minutes')::numeric;
      end loop;
      if total>100000 then raise exception 'Day hours exceed supported effort'; end if;
    end if;
  end loop;
  return public.commit_schedule_daily_hours(p_proposal,p_event,p_notifications,p_request_id,p_undo_id);
end;
$$;

revoke all on function public.commit_schedule_booking_focus(jsonb,jsonb,jsonb,text,text) from public,anon,authenticated;
