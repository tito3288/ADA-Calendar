-- Optional per-day reservation budgets. Existing JSON work items need no backfill.
-- Keep the original locked transaction, actor checks, idempotency and notification
-- behavior; add the same daily-plan hard invariants checked by validateSchedule.
create or replace function public.commit_schedule(p_proposal jsonb,p_event jsonb,p_notifications jsonb default '[]',p_request_id text default null,p_undo_id text default null)
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
        if (day->>'date')::date<(item->>'windowStart')::date
          or (item->>'deadline' is not null and (day->>'date')::date>(item->>'deadline')::date)
          or (jsonb_array_length(coalesce(item->'allowedDates','[]'))>0 and not exists(select 1 from jsonb_array_elements_text(item->'allowedDates') d where d=day->>'date'))
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
revoke all on function public.commit_schedule(jsonb,jsonb,jsonb,text,text) from public,anon;
grant execute on function public.commit_schedule(jsonb,jsonb,jsonb,text,text) to authenticated;
