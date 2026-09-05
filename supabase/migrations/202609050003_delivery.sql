create extension if not exists pgmq;
select pgmq.create('ada_notifications');
alter table public.notifications add column queue_message_id bigint;

create function public.queue_notification_insert() returns trigger language plpgsql security definer set search_path='' as $$
declare message_id bigint;
begin
  select pgmq.send('ada_notifications',jsonb_build_object('notificationId',new.id)) into message_id;
  update public.notifications set queue_message_id=message_id where id=new.id;
  return new;
end;
$$;
revoke all on function public.queue_notification_insert() from public,anon,authenticated;
create trigger queue_notification_after_insert after insert on public.notifications for each row execute function public.queue_notification_insert();

create or replace function public.claim_notifications(p_limit integer default 20) returns setof public.notifications
language plpgsql security definer set search_path='' as $$
declare q record; n public.notifications;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Worker access only'; end if;
  for q in select * from pgmq.read('ada_notifications',120,least(greatest(p_limit,1),50)) loop
    select * into n from public.notifications where id=q.message->>'notificationId' for update;
    if n.id is null or n.status<>'queued' then perform pgmq.archive('ada_notifications',q.msg_id); continue; end if;
    if n.send_started_at<now()-interval '23 hours' and n.provider_id is null then
      update public.notifications set status='uncertain',last_error='Delivery requires reconciliation; provider idempotency window is expiring.',lease_until=null where id=n.id;
      perform pgmq.archive('ada_notifications',q.msg_id); continue;
    end if;
    if n.next_attempt_at>now() then perform pgmq.set_vt('ada_notifications',q.msg_id,greatest(1,extract(epoch from n.next_attempt_at-now())::integer)); continue; end if;
    update public.notifications set lease_until=now()+interval '2 minutes',attempts=attempts+1,send_started_at=coalesce(send_started_at,now()) where id=n.id returning * into n;
    return next n;
  end loop;
end;
$$;

create or replace function public.finish_notification(p_id text,p_status text,p_provider_id text default null,p_error text default null,p_retry_seconds integer default null) returns void
language plpgsql security definer set search_path='' as $$
declare qid bigint;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Worker access only'; end if;
  if p_status not in ('captured','sent','failed','uncertain','queued') then raise exception 'Invalid delivery result'; end if;
  if p_provider_id is not null then perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_provider_id,0)); end if;
  update public.notifications set status=p_status,provider_id=coalesce(provider_id,p_provider_id),last_error=p_error,lease_until=null,
    next_attempt_at=now()+make_interval(secs=>coalesce(p_retry_seconds,0)) where id=p_id and status='queued' returning queue_message_id into qid;
  if qid is not null then
    if p_status='queued' then perform pgmq.set_vt('ada_notifications',qid,greatest(1,coalesce(p_retry_seconds,60)));
    else perform pgmq.archive('ada_notifications',qid); end if;
  end if;
  if p_provider_id is not null then perform public.reconcile_notification_delivery(p_provider_id); end if;
end;
$$;

create function public.enqueue_weekly_summaries(p_app_url text) returns integer
language plpgsql security definer set search_path='' as $$
declare w public.workspaces; m public.workspace_members; local_now timestamp; event_key text; message text; added integer:=0; rows_added integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Worker access only'; end if;
  if p_app_url !~ '^https?://[^[:space:]]+$' then raise exception 'Trusted app URL is required'; end if;
  for w in select * from public.workspaces loop
    local_now:=now() at time zone (w.settings->>'timeZone');
    if extract(dow from local_now)::integer<>(w.settings->>'weeklyDay')::integer or local_now::time<(w.settings->>'weeklyTime')::time then continue; end if;
    event_key:='weekly/'||w.id::text||'/'||local_now::date::text;
    message:='Bryan''s weekly workload update'||chr(10)||chr(10)||
      'Completed in the last seven days: '||(select count(*) from jsonb_array_elements(w.items) i where i->>'status'='completed' and (i->>'completedAt')::timestamptz>=now()-interval '7 days')::text||chr(10)||
      'Open work items: '||(select count(*) from jsonb_array_elements(w.items) i where i->>'status' not in ('completed','cancelled'))::text||chr(10)||
      'Estimated remaining effort: '||round(coalesce((select sum((i->>'remainingMinutes')::numeric) from jsonb_array_elements(w.items) i where i->>'status' not in ('completed','cancelled')),0)/60,1)::text||' hours (estimates, not tracked hours)'||chr(10)||chr(10)||
      coalesce((select string_agg(coalesce(c->>'name','Client')||' — '||(i->>'title')||' ['||(i->>'status')||']'||case when i->>'deadline' is not null then ' · due '||(i->>'deadline') else '' end,chr(10)) from jsonb_array_elements(w.items) i left join lateral (select value as c from jsonb_array_elements(w.clients) where value->>'id'=i->>'clientId') client on true where i->>'status' not in ('completed','cancelled')),'No open work.')||chr(10)||chr(10)||
      'View the current calendar (sign-in required): '||rtrim(p_app_url,'/');
    for m in select * from public.workspace_members where workspace_id=w.id and role='requester' and active and receive_updates loop
      insert into public.notifications(id,workspace_id,event_id,recipient,recipient_name,subject,body,idempotency_key)
        values(event_key||'/'||m.user_id::text,w.id,event_key,m.email,m.name,'Bryan''s weekly workload · '||local_now::date::text,message,'ada/'||event_key||'/'||m.user_id::text) on conflict(workspace_id,event_id,recipient) do nothing;
      get diagnostics rows_added=row_count; added:=added+rows_added;
    end loop;
  end loop;
  -- Stale upload reservations release capacity. Originals are not physically removed here.
  update public.attachments set removed_at=now() where upload_status='pending' and removed_at is null and created_at<now()-interval '1 day';
  return added;
end;
$$;
revoke all on function public.enqueue_weekly_summaries(text) from public,anon,authenticated;
grant execute on function public.enqueue_weekly_summaries(text) to service_role;

-- Configure Cron only once deployed credentials exist. See docs/RUNBOOK.md.
-- No endpoint or credential is hard-coded into this migration.
