-- Days and hours: display spans and legacy focus/date fields are not restrictions.
-- Only explicit dateConstraints apply. Keep the original transactional and Undo guards.
-- No work item, session, notification, or immutable event is rewritten.
create or replace function public.commit_schedule_transaction(p_proposal jsonb,p_event jsonb,p_notifications jsonb default '[]',p_request_id text default null,p_undo_id text default null)
returns bigint language plpgsql security definer set search_path='' as $$
declare m public.workspace_members; w public.workspaces; s jsonb; i jsonb; b jsonb; found_item jsonb;
  start_local timestamp; end_local timestamp; tz text; evt jsonb; before_state jsonb; after_state jsonb;
  has_override boolean; duplicate_version bigint; prior_event public.work_events; request_row public.pending_requests;
  reserve_start timestamp; reserve_end timestamp; usable_start timestamp; reserve_used numeric;
begin
  select * into m from public.workspace_members where user_id=auth.uid() and active;
  if m.user_id is null or m.role='viewer' then raise exception 'Not authorized to schedule work'; end if;
  select * into w from public.workspaces where id=m.workspace_id for update;
  select version into duplicate_version from public.work_events where workspace_id=w.id and operation_id=p_proposal->>'operationId';
  if duplicate_version is not null then
    if not exists(select 1 from public.work_events where workspace_id=w.id and operation_id=p_proposal->>'operationId' and actor_id=m.user_id and operation_payload=p_proposal->'commands') then raise exception 'Operation id was already used for a different actor or command'; end if;
    return duplicate_version;
  end if;
  if coalesce((p_proposal->>'baseVersion')::bigint,-1)<>w.version then raise exception 'Schedule changed. Refresh and re-plan this operation.' using errcode='40001'; end if;
  if p_proposal->>'actorId' is distinct from m.user_id::text then raise exception 'Actor does not match authenticated session'; end if;
  if p_proposal->>'status' is distinct from 'ready' or coalesce((p_proposal->>'requiresApproval')::boolean,true) then raise exception 'Proposal is not ready to commit'; end if;
  if jsonb_typeof(p_proposal->'items') is distinct from 'array' or jsonb_typeof(p_proposal->'sessions') is distinct from 'array' or jsonb_typeof(p_proposal->'blocks') is distinct from 'array' then raise exception 'Invalid schedule shape'; end if;
  if exists(select 1 from jsonb_array_elements(p_proposal->'items') v group by v->>'id' having count(*)>1) then raise exception 'Duplicate item id'; end if;
  if m.role='requester' then
    if p_request_id is not null or p_undo_id is not null then raise exception 'Owner approval required'; end if;
    if p_proposal->'blocks'<>w.blocks then raise exception 'Requesters cannot change blocked time'; end if;
    if exists(select 1 from jsonb_array_elements(w.items) old where not exists(select 1 from jsonb_array_elements(p_proposal->'items') fresh where fresh=old)) then raise exception 'Requesters cannot edit or delete existing work'; end if;
    if exists(select 1 from public.work_sessions old where old.workspace_id=w.id and not exists(select 1 from jsonb_array_elements(p_proposal->'sessions') fresh where fresh=old.body)) then raise exception 'Requesters cannot move existing sessions'; end if;
    if exists(select 1 from jsonb_array_elements(p_proposal->'commands') cmd where cmd->>'type'<>'create' or coalesce((cmd->>'overrideProtected')::boolean,false) or coalesce((cmd->>'overrideDeadline')::boolean,false) or coalesce((cmd->>'urgent')::boolean,false)) then raise exception 'Requesters may only create clean-fit work'; end if;
    for i in select value from jsonb_array_elements(p_proposal->'items') loop
      if not exists(select 1 from jsonb_array_elements(w.items) old where old->>'id'=i->>'id') then
        if i->>'requesterId' is distinct from m.user_id::text or i->>'requestedBy' is distinct from m.name or i->>'status' is distinct from 'planned' or coalesce((i->>'estimatedMinutes')::integer,0)<=0 or coalesce((i->>'remainingMinutes')::integer,0)<=0 then raise exception 'New requests need your identity and a positive effort estimate'; end if;
        if i->>'priorityId' is distinct from 'normal' then raise exception 'Requested priority is advisory; new bookings start at Normal'; end if;
      end if;
    end loop;
    if exists(select 1 from jsonb_array_elements(p_proposal->'sessions') fresh where not exists(select 1 from public.work_sessions old where old.workspace_id=w.id and old.body=fresh) and (coalesce((fresh->>'usesReserve')::boolean,false) or exists(select 1 from jsonb_array_elements(w.items) old where old->>'id'=fresh->>'workItemId'))) then raise exception 'Requesters cannot reserve interruption time or add sessions to existing work'; end if;
  end if;
  has_override := m.role='owner' and exists(select 1 from jsonb_array_elements(coalesce(p_proposal->'commands','[]')) cmd where coalesce((cmd->>'overrideProtected')::boolean,false));
  if not has_override and p_undo_id is null and exists(
    select 1 from public.work_sessions old where old.workspace_id=w.id and old.status='planned' and coalesce((old.body->>'protected')::boolean,false)
      and not exists(select 1 from jsonb_array_elements(p_proposal->'sessions') fresh where fresh=old.body)
      and not (m.role='owner' and exists(select 1 from jsonb_array_elements(p_proposal->'commands') cmd
        where cmd->>'type'='status' and cmd->>'itemId'=old.work_item_id and cmd->>'status' in ('completed','cancelled')
        or cmd->>'type'='complete_session' and cmd->>'sessionId'=old.id and exists(select 1 from jsonb_array_elements(p_proposal->'sessions') fresh where fresh->>'id'=old.id and fresh->>'status'='completed' and fresh->>'start'=old.body->>'start' and (fresh->>'end')::timestamptz<=old.ends_at)))
  ) then raise exception 'Protected work needs an explicit owner override'; end if;
  if p_request_id is not null then
    if m.role<>'owner' then raise exception 'Only owner can approve requests'; end if;
    select * into request_row from public.pending_requests where id=p_request_id and workspace_id=w.id for update;
    if request_row.id is null or request_row.body->>'status' not in ('pending','needs_information') then raise exception 'Request is no longer pending'; end if;
  end if;
  if p_undo_id is not null then
    if m.role<>'owner' then raise exception 'Only owner can undo'; end if;
    select * into prior_event from public.work_events where id=p_undo_id and workspace_id=w.id for update;
    if prior_event.id is null or prior_event.version<>w.version or prior_event.body->>'undoneBy' is not null then raise exception 'Only the latest unchanged schedule event can be undone'; end if;
    if jsonb_build_object('items',p_proposal->'items','sessions',p_proposal->'sessions','blocks',p_proposal->'blocks')<>prior_event.body->'before' then raise exception 'Undo does not match original state'; end if;
  end if;
  tz := w.settings->>'timeZone';
  for i in select value from jsonb_array_elements(p_proposal->'items') loop

    if i ? 'timelineMode' and coalesce(i->>'timelineMode','') not in ('bookings','span') then raise exception 'Invalid timeline mode'; end if;
    if i ? 'dateConstraints' then
      if jsonb_typeof(i->'dateConstraints') is distinct from 'object'
        or ((i->'dateConstraints')-'earliestStart'-'allowedDates')<>'{}'::jsonb
        or not (i->'dateConstraints' ? 'earliestStart')
        or jsonb_typeof(i#>'{dateConstraints,allowedDates}') is distinct from 'array'
        then raise exception 'Invalid scheduling limits'; end if;
      if i#>>'{dateConstraints,earliestStart}' is not null and
        (coalesce(i#>>'{dateConstraints,earliestStart}','') !~ '^\d{4}-\d{2}-\d{2}$'
        or (i#>>'{dateConstraints,earliestStart}')::date::text<>i#>>'{dateConstraints,earliestStart}')
        then raise exception 'Invalid earliest start'; end if;
      if jsonb_array_length(i#>'{dateConstraints,allowedDates}')>366 or exists(
        select 1 from jsonb_array_elements_text(i#>'{dateConstraints,allowedDates}') d
        where d is null or d !~ '^\d{4}-\d{2}-\d{2}$' or d::date::text<>d
      ) then raise exception 'Invalid allowed work dates'; end if;
    end if;
    if coalesce(i->>'id','')='' or coalesce(i->>'title','')='' then raise exception 'Work needs id and title'; end if;
    if not exists(select 1 from jsonb_array_elements(w.clients) c where c->>'id'=i->>'clientId') then raise exception 'Unknown client'; end if;
    if not exists(select 1 from jsonb_array_elements(w.priorities) p where p->>'id'=i->>'priorityId') then raise exception 'Unknown priority'; end if;
    if coalesce(i->>'category','') not in ('web','it','landings','software') or coalesce(i->>'status','') not in ('planned','in_progress','waiting','completed','cancelled') then raise exception 'Invalid work category or status'; end if;
    if coalesce((i->>'estimatedMinutes')::integer,0)<0 or coalesce((i->>'remainingMinutes')::integer,0)<0 then raise exception 'Negative effort is invalid'; end if;
  end loop;
  for b in select value from jsonb_array_elements(p_proposal->'blocks') loop
    if (b->>'end')::timestamptz<=(b->>'start')::timestamptz then raise exception 'Invalid unavailable block'; end if;
  end loop;
  for s in select value from jsonb_array_elements(p_proposal->'sessions') loop
    select value into found_item from jsonb_array_elements(p_proposal->'items') where value->>'id'=s->>'workItemId';
    if found_item is null then raise exception 'Session refers to missing work'; end if;
    if s->>'status'='planned' then
      start_local := (s->>'start')::timestamptz at time zone tz;
      end_local := (s->>'end')::timestamptz at time zone tz;
      if end_local<=start_local or start_local::date<>end_local::date then raise exception 'Invalid session duration'; end if;
      if (s->>'start')::timestamptz<now() and not exists(select 1 from public.work_sessions old where old.workspace_id=w.id and (old.body=s or m.role='owner' and old.id=s->>'id' and old.body-'end'=s-'end' and (s->>'end')::timestamptz<=least(old.ends_at,now()))) then raise exception 'New or changed work cannot be scheduled in the past'; end if;
      if (found_item#>>'{dateConstraints,earliestStart}' is not null and start_local::date<(found_item#>>'{dateConstraints,earliestStart}')::date) or (jsonb_array_length(coalesce(found_item#>'{dateConstraints,allowedDates}','[]'))>0 and not exists(select 1 from jsonb_array_elements_text(found_item#>'{dateConstraints,allowedDates}') allowed where allowed=start_local::date::text)) then raise exception 'Session is outside allowed work dates'; end if;
      if found_item->>'deadline' is not null and start_local::date>(found_item->>'deadline')::date then raise exception 'Session exceeds its firm deadline'; end if;
      if not exists(select 1 from jsonb_array_elements_text(w.settings->'weekdays') d where d::integer=extract(dow from start_local)::integer) or start_local::time<(w.settings->>'dayStart')::time or end_local::time>(w.settings->>'dayEnd')::time then raise exception 'Session exceeds working hours'; end if;
      if start_local::time<(w.settings->>'lunchEnd')::time and end_local::time>(w.settings->>'lunchStart')::time then raise exception 'Session overlaps lunch'; end if;
      reserve_start:=start_local::date+(w.settings->>'reserveStart')::time;
      reserve_end:=least(start_local::date+(w.settings->>'dayEnd')::time,reserve_start+make_interval(mins=>(w.settings->>'reserveMinutes')::integer));
      usable_start:=greatest(reserve_start,now() at time zone tz);
      select coalesce(sum(extract(epoch from ((r->>'end')::timestamptz-(r->>'start')::timestamptz))/60),0) into reserve_used from jsonb_array_elements(p_proposal->'sessions') r where r->>'status'<>'cancelled' and (r->>'status'='planned' or (r->>'end')::timestamptz<=now()) and coalesce((r->>'usesReserve')::boolean,false) and ((r->>'start')::timestamptz at time zone tz)::date=start_local::date;
      reserve_start:=usable_start+make_interval(secs=>(least((w.settings->>'reserveMinutes')::numeric,reserve_used,greatest(0,extract(epoch from reserve_end-usable_start)/60))*60)::double precision);
      if reserve_start<reserve_end and start_local<reserve_end and end_local>reserve_start and not coalesce((s->>'usesReserve')::boolean,false) then raise exception 'Session consumes reserved interruption capacity'; end if;
      if found_item->>'status' in ('completed','cancelled','waiting') and (s->>'end')::timestamptz>now() then raise exception 'Inactive work cannot have future planned sessions'; end if;
      if exists(select 1 from jsonb_array_elements(p_proposal->'blocks') block where tstzrange((block->>'start')::timestamptz,(block->>'end')::timestamptz,'[)') && tstzrange((s->>'start')::timestamptz,(s->>'end')::timestamptz,'[)')) then raise exception 'Session overlaps unavailable time'; end if;
    end if;
  end loop;
  before_state := jsonb_build_object('items',w.items,'blocks',w.blocks,'sessions',coalesce((select jsonb_agg(body order by starts_at,id) from public.work_sessions where workspace_id=w.id),'[]'));
  after_state := jsonb_build_object('items',p_proposal->'items','sessions',p_proposal->'sessions','blocks',p_proposal->'blocks');
  -- A replace inside the locked transaction permits legitimate multi-session moves; the
  -- exclusion constraint catches overlap before the transaction becomes visible.
  delete from public.work_sessions where workspace_id=w.id;
  insert into public.work_sessions(workspace_id,id,work_item_id,starts_at,ends_at,status,body)
    select w.id,entry.value->>'id',entry.value->>'workItemId',(entry.value->>'start')::timestamptz,(entry.value->>'end')::timestamptz,entry.value->>'status',entry.value from jsonb_array_elements(p_proposal->'sessions') entry;
  update public.workspaces set items=p_proposal->'items',blocks=p_proposal->'blocks',version=version+1 where id=w.id;
  evt := p_event || jsonb_build_object('operationId',p_proposal->>'operationId','actorId',m.user_id,'actorName',m.name,'version',w.version+1,'before',before_state,'after',after_state,'createdAt',now(),'undoneBy',null);
  insert into public.work_events(id,workspace_id,operation_id,actor_id,version,body,operation_payload) values(evt->>'id',w.id,p_proposal->>'operationId',m.user_id,w.version+1,evt,p_proposal->'commands');
  if p_request_id is not null then update public.pending_requests set body=body||jsonb_build_object('status','approved','resolvedAt',now()) where id=p_request_id; end if;
  if p_undo_id is not null then update public.work_events set body=jsonb_set(body,'{undoneBy}',to_jsonb(evt->>'id')) where id=p_undo_id; end if;
  perform public.enqueue_notifications(w.id,evt->>'id',p_notifications,'updates',m.user_id);
  return w.version+1;
end;
$$;

create or replace function public.commit_schedule_daily_hours(p_proposal jsonb,p_event jsonb,p_notifications jsonb default '[]',p_request_id text default null,p_undo_id text default null)
returns bigint language plpgsql security definer set search_path='' as $$
declare member public.workspace_members; workspace public.workspaces; item jsonb; day jsonb;
  budget numeric; booked numeric; total numeric; entry record; tz text;
begin
  select * into member from public.workspace_members where user_id=auth.uid() and active;
  if member.user_id is null or member.role='viewer' then raise exception 'Not authorized to schedule work'; end if;
  select * into workspace from public.workspaces where id=member.workspace_id for update;
  tz := workspace.settings->>'timeZone';
  if member.role='requester' and exists(
    select 1 from jsonb_array_elements(p_proposal->'sessions') fresh
    where not exists(select 1 from public.work_sessions old where old.workspace_id=member.workspace_id and old.body=fresh)
      and (coalesce((fresh->>'protected')::boolean,false) or fresh->>'status' is distinct from 'planned')
  ) then raise exception 'Requesters cannot create protected or historical sessions'; end if;
  for item in select value from jsonb_array_elements(p_proposal->'items') loop
    if item ? 'dailyPlan' then
      if jsonb_typeof(item->'dailyPlan') is distinct from 'array' then raise exception 'Daily plan must be an array'; end if;
      if jsonb_array_length(item->'dailyPlan')>366 then raise exception 'Daily plan exceeds 366 days'; end if;
      if exists(select 1 from jsonb_array_elements(item->'dailyPlan') d group by d->>'date' having count(*)>1) then raise exception 'Duplicate daily-plan date'; end if;
      total := 0;
      for day in select value from jsonb_array_elements(item->'dailyPlan') loop
        if jsonb_typeof(day) is distinct from 'object' or (day-'date'-'minutes')<>'{}'::jsonb or jsonb_typeof(day->'minutes') is distinct from 'number'
          or coalesce(day->>'date','') !~ '^\d{4}-\d{2}-\d{2}$' or (day->>'date')::date::text<>day->>'date' then raise exception 'Invalid daily-plan entry'; end if;
        budget := (day->>'minutes')::numeric;
        if budget<15 or budget>480 or mod(budget,15)<>0 then raise exception 'Daily hours require positive 15-minute increments'; end if;
        total := total+budget;
        if (item#>>'{dateConstraints,earliestStart}' is not null and (day->>'date')::date<(item#>>'{dateConstraints,earliestStart}')::date)
          or (item->>'deadline' is not null and (day->>'date')::date>(item->>'deadline')::date)
          or (jsonb_array_length(coalesce(item#>'{dateConstraints,allowedDates}','[]'))>0 and not exists(select 1 from jsonb_array_elements_text(item#>'{dateConstraints,allowedDates}') d where d=day->>'date'))
          then raise exception 'Daily plan is outside allowed dates'; end if;
      end loop;
      if total>100000 then raise exception 'Daily plan exceeds supported effort'; end if;
      if jsonb_array_length(item->'dailyPlan')>0 then
        for entry in select ((s->>'start')::timestamptz at time zone tz)::date::text as work_date,
          sum(extract(epoch from ((s->>'end')::timestamptz-greatest((s->>'start')::timestamptz,now())))/60) as minutes
          from jsonb_array_elements(p_proposal->'sessions') s where s->>'workItemId'=item->>'id' and s->>'status'='planned' and (s->>'end')::timestamptz>now()
          group by 1 loop
          select (d->>'minutes')::numeric into budget from jsonb_array_elements(item->'dailyPlan') d where d->>'date'=entry.work_date;
          booked := entry.minutes;
          if booked>coalesce(budget,0) then raise exception 'Sessions exceed daily hours on %',entry.work_date; end if;
        end loop;
      end if;
    end if;
  end loop;
  return public.commit_schedule_transaction(p_proposal,p_event,p_notifications,p_request_id,p_undo_id);
end;
$$;

-- The legacy focus JSON remains untouched but has no scheduling authority.
create or replace function public.commit_schedule_booking_focus(p_proposal jsonb,p_event jsonb,p_notifications jsonb default '[]',p_request_id text default null,p_undo_id text default null)
returns bigint language plpgsql security definer set search_path='' as $$
declare member public.workspace_members; command jsonb; day jsonb; total numeric; session jsonb; minimum numeric; checked_at timestamptz;
begin
  select * into member from public.workspace_members where user_id=auth.uid() and active;
  if member.user_id is null or member.role='viewer' then raise exception 'Not authorized to schedule work'; end if;
  perform 1 from public.workspaces where id=member.workspace_id for update;
  if jsonb_typeof(p_proposal->'sessions') is distinct from 'array' then raise exception 'Invalid schedule shape'; end if;
  if exists(select 1 from jsonb_array_elements(p_proposal->'commands') cmd where cmd->>'type' in ('set_day_hours','move_bookings'))
    and not exists(select 1 from public.work_events where workspace_id=member.workspace_id and operation_id=p_proposal->>'operationId') then
    -- Check after the lock: a selected booking can start while confirmation
    -- waits. Day edits cannot remove or move it, or rewrite completed history.
    -- The delegated transaction verifies actor/commands for duplicate replays.
    checked_at := clock_timestamp();
    if exists(
      select 1 from public.work_sessions old
      where old.workspace_id=member.workspace_id and (old.starts_at<checked_at or old.status<>'planned')
        and not exists(select 1 from jsonb_array_elements(p_proposal->'sessions') fresh where fresh=old.body)
    ) then raise exception 'Day edits cannot remove or change work that has already started or its history'; end if;
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

revoke all on function public.commit_schedule_transaction(jsonb,jsonb,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.commit_schedule_daily_hours(jsonb,jsonb,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.commit_schedule_booking_focus(jsonb,jsonb,jsonb,text,text) from public,anon,authenticated;

-- Invalidate old previews/Undo exactly once when this forward migration is installed.
update public.workspaces set version=version+1;
