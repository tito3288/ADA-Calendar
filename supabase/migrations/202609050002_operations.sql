alter table public.ai_usage add column reservation_id text unique;
alter table public.ai_usage add column settled boolean not null default false;

create function public.mutate_workspace(p_action jsonb,p_base_version bigint,p_notifications jsonb default '[]') returns void
language plpgsql security definer set search_path='' as $$
declare m public.workspace_members; w public.workspaces; a jsonb; target public.attachments; d public.email_drafts;
  item jsonb; total bigint; file_count integer; v_id text; amount numeric; prior public.ai_usage;
begin
  select * into m from public.workspace_members where user_id=auth.uid() and active;
  if m.user_id is null then raise exception 'Not a workspace member'; end if;
  select * into w from public.workspaces where id=m.workspace_id for update;
  if p_action->>'type' in ('reserve_ai','settle_ai') then
    if m.role='viewer' then raise exception 'Viewers cannot use the writing assistant'; end if;
    v_id:=p_action->>'reservationId';
    if coalesce(v_id,'')='' then raise exception 'Missing AI reservation id'; end if;
    select * into prior from public.ai_usage where reservation_id=v_id for update;
    if prior.id is not null and (prior.workspace_id<>w.id or prior.actor_id<>m.user_id) then raise exception 'AI reservation belongs to another actor'; end if;
    if p_action->>'type'='reserve_ai' then
      if prior.id is not null then return; end if;
      amount:=(p_action->>'amountUsd')::numeric;
      if amount is null or amount<=0 then raise exception 'AI reserve must be positive'; end if;
      if coalesce((select sum(amount_usd) from public.ai_usage where workspace_id=w.id and created_at>=date_trunc('month',now())),0)+amount>coalesce((w.settings->>'aiLimitUsd')::numeric,25) then raise exception 'Monthly AI budget reached. Manual scheduling remains available.'; end if;
      insert into public.ai_usage(workspace_id,actor_id,amount_usd,reservation_id) values(w.id,m.user_id,amount,v_id);
    else
      if prior.id is null then raise exception 'AI reservation not found'; end if;
      if prior.settled then return; end if;
      amount:=(p_action->>'costUsd')::numeric;
      if amount is null or amount<0 then raise exception 'AI cost must be known and nonnegative'; end if;
      update public.ai_usage set amount_usd=amount,settled=true where id=prior.id;
    end if;
    return;
  end if;
  if m.role<>'owner' and p_action->>'type' not in ('attachment','complete_attachment','abort_attachment') then raise exception 'Owner access required'; end if;
  if p_action->>'type' in ('clients','settings','member','priorities') and p_base_version<>w.version then raise exception 'Workspace changed. Refresh before editing.' using errcode='40001'; end if;
  case p_action->>'type'
  when 'clients' then
    if jsonb_typeof(p_action->'clients') is distinct from 'array' then raise exception 'Clients must be an array'; end if;
    if exists(select 1 from jsonb_array_elements(w.items) i where not exists(select 1 from jsonb_array_elements(p_action->'clients') c where c->>'id'=i->>'clientId')) then raise exception 'Cannot remove a client with recorded work'; end if;
    if exists(select 1 from jsonb_array_elements(p_action->'clients') c where coalesce(c->>'id','')='' or coalesce(trim(c->>'name'),'')='') then raise exception 'Client id and name are required'; end if;
    if exists(select 1 from jsonb_array_elements(p_action->'clients') c group by c->>'id' having count(*)>1) then raise exception 'Duplicate client'; end if;
    update public.workspaces set clients=p_action->'clients',version=version+1 where id=w.id;
  when 'settings' then
    a:=p_action->'settings';
    if (a->>'dayEnd')::time<=(a->>'dayStart')::time or (a->>'lunchEnd')::time<(a->>'lunchStart')::time or (a->>'reserveMinutes')::integer<0 or (a->>'slotMinutes')::integer<>15 or (a->>'aiLimitUsd')::numeric<0 then raise exception 'Invalid working-time or budget settings'; end if;
    if not exists(select 1 from pg_catalog.pg_timezone_names where name=a->>'timeZone') then raise exception 'Unknown timezone'; end if;
    update public.workspaces set settings=a,version=version+1 where id=w.id;
  when 'priorities' then
    a:=p_action->'priorities';
    if jsonb_typeof(a) is distinct from 'array' or jsonb_array_length(a)=0 then raise exception 'At least one priority is required'; end if;
    if exists(select 1 from jsonb_array_elements(w.items) i where not exists(select 1 from jsonb_array_elements(a) p where p->>'id'=i->>'priorityId')) then raise exception 'Cannot remove a priority in use'; end if;
    if exists(select 1 from jsonb_array_elements(a) p where coalesce(p->>'id','')='' or coalesce(trim(p->>'label'),'')='' or (p->>'rank')::integer<0) then raise exception 'Invalid priority'; end if;
    if not exists(select 1 from jsonb_array_elements(a) p where p->>'id'='normal') then raise exception 'Keep the Normal priority for new requester work'; end if;
    update public.workspaces set priorities=a,version=version+1 where id=w.id;
  when 'member' then
    a:=p_action->'member';
    if a->>'id'=m.user_id::text and (a->>'role'<>'owner' or not coalesce((p_action->>'active')::boolean,true)) then raise exception 'The owner cannot remove or demote themselves'; end if;
    if a->>'id'<>m.user_id::text and a->>'role'='owner' then raise exception 'Ownership transfers require an administrative migration'; end if;
    if not exists(select 1 from auth.users u where u.id=(a->>'id')::uuid and lower(u.email)=lower(a->>'email')) then raise exception 'Invite an authenticated account with the matching email first'; end if;
    insert into public.workspace_members(workspace_id,user_id,name,email,role,active)
      values(w.id,(a->>'id')::uuid,a->>'name',lower(a->>'email'),a->>'role',coalesce((p_action->>'active')::boolean,true))
      on conflict(user_id) do update set name=excluded.name,role=excluded.role,active=excluded.active where workspace_members.workspace_id=w.id and (workspace_members.role<>'owner' or workspace_members.user_id=m.user_id);
    if not found then raise exception 'This account already belongs to another workspace'; end if;
    update public.workspaces set version=version+1 where id=w.id;
  when 'attachment' then
    a:=p_action->'attachment';
    if m.role='viewer' then raise exception 'Viewers cannot attach files'; end if;
    select value into item from jsonb_array_elements(w.items) where value->>'id'=a->>'workItemId';
    if item is null then
      if not exists(select 1 from public.pending_requests r, jsonb_array_elements(r.body#>'{proposal,commands}') cmd
        where r.workspace_id=w.id and (r.requester_id=m.user_id or m.role='owner') and r.body->>'status' in ('pending','needs_information') and cmd->>'type'='create' and cmd#>>'{item,id}'=a->>'workItemId') then raise exception 'Save your work or priority request before attaching files'; end if;
    elsif m.role='requester' and item->>'requesterId' is distinct from m.user_id::text then raise exception 'Requesters may attach files to their own requests only'; end if;
    if a->>'uploadedBy' is distinct from m.user_id::text or split_part(a->>'path','/',1)<>w.id::text or split_part(a->>'path','/',2)<>a->>'workItemId' then raise exception 'Attachment path or author mismatch'; end if;
    if a->>'contentType' not in ('text/markdown','text/plain','application/pdf','image/png','image/jpeg','image/webp') then raise exception 'Unsupported attachment type'; end if;
    if exists(select 1 from public.attachments where id=a->>'id' and workspace_id=w.id) then return; end if;
    select count(*),coalesce(sum(size),0) into file_count,total from public.attachments where workspace_id=w.id and work_item_id=a->>'workItemId' and removed_at is null;
    if file_count>=5 or total+(a->>'size')::bigint>20971520 then raise exception 'A work item allows five files and 20 MB total'; end if;
    insert into public.attachments(id,workspace_id,work_item_id,name,content_type,size,path,uploaded_by) values(a->>'id',w.id,a->>'workItemId',a->>'name',a->>'contentType',(a->>'size')::bigint,a->>'path',m.user_id);
  when 'complete_attachment' then
    select * into target from public.attachments where id=p_action->>'id' and workspace_id=w.id and removed_at is null for update;
    if target.id is null or (m.role<>'owner' and target.uploaded_by<>m.user_id) then raise exception 'Attachment not available'; end if;
    if not exists(select 1 from storage.objects where bucket_id='work-attachments' and name=target.path and (metadata->>'size')::bigint=target.size) then raise exception 'Upload is missing or has an unexpected size'; end if;
    update public.attachments set upload_status='ready' where id=target.id;
  when 'abort_attachment' then
    update public.attachments set removed_at=now() where id=p_action->>'id' and workspace_id=w.id and upload_status='pending' and (uploaded_by=m.user_id or m.role='owner');
  when 'remove_attachment' then
    update public.attachments set removed_at=now() where id=p_action->>'id' and workspace_id=w.id and removed_at is null;
    if not found then raise exception 'Attachment not found'; end if;
  when 'draft' then
    a:=p_action->'draft';
    if a->>'authorId' is distinct from m.user_id::text then raise exception 'Draft author mismatch'; end if;
    if a->>'itemId' is not null and not exists(select 1 from jsonb_array_elements(w.items) i where i->>'id'=a->>'itemId') then raise exception 'Unknown draft work item'; end if;
    insert into public.email_drafts(id,workspace_id,author_id,item_id,subject,body) values(a->>'id',w.id,m.user_id,a->>'itemId',left(a->>'subject',500),a->>'body')
    on conflict(id) do update set subject=excluded.subject,body=excluded.body,item_id=excluded.item_id where email_drafts.author_id=m.user_id and email_drafts.status='draft';
    if not found then raise exception 'Draft is not editable'; end if;
  when 'send_draft' then
    select * into d from public.email_drafts where id=p_action->>'id' and workspace_id=w.id and author_id=m.user_id for update;
    if d.id is null then raise exception 'Draft not found'; end if;
    if d.subject is distinct from p_action->>'expectedSubject' or d.body is distinct from p_action->>'expectedBody' then raise exception 'Email draft changed. Review the current text before sending.'; end if;
    if d.status='sent' then return; end if;
    if d.status<>'draft' then raise exception 'Draft is not sendable'; end if;
    -- The explicit send click may only enqueue the exact saved preview.
    if exists(select 1 from jsonb_array_elements(p_notifications) n where n->>'subject'<>d.subject or position(d.body in n->>'body')<>1) then raise exception 'Save the email preview before sending'; end if;
    perform public.enqueue_notifications(w.id,'draft/'||d.id,p_notifications,'draft',m.user_id);
    update public.email_drafts set status='sent' where id=d.id;
  when 'edit_draft' then
    if coalesce(trim(p_action->>'subject'),'')='' or coalesce(trim(p_action->>'body'),'')='' or length(p_action->>'body')>12000 then raise exception 'Draft needs a subject and body up to 12,000 characters'; end if;
    update public.email_drafts set subject=left(p_action->>'subject',200),body=p_action->>'body' where id=p_action->>'id' and workspace_id=w.id and author_id=m.user_id and status='draft';
    if not found then raise exception 'Draft is not editable'; end if;
  when 'dismiss_draft' then
    update public.email_drafts set status='dismissed' where id=p_action->>'id' and workspace_id=w.id and author_id=m.user_id and status='draft';
  else raise exception 'Unknown workspace action';
  end case;
end;
$$;
revoke all on function public.mutate_workspace(jsonb,bigint,jsonb) from public,anon;
grant execute on function public.mutate_workspace(jsonb,bigint,jsonb) to authenticated;

-- Durable outbox leases are the queue. Claims are short, atomic and skip locked rows.
-- A worker crash leaves the row recoverable after its lease, with the same idempotency key.
create function public.claim_notifications(p_limit integer default 20) returns setof public.notifications
language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Worker access only'; end if;
  update public.notifications set status='uncertain',last_error='Delivery was not reconciled within the provider idempotency window.',lease_until=null
    where status='queued' and send_started_at<now()-interval '23 hours' and provider_id is null;
  return query with claim as (
    select id from public.notifications where status='queued' and next_attempt_at<=now() and (lease_until is null or lease_until<now())
      order by created_at for update skip locked limit least(greatest(p_limit,1),50)
  ) update public.notifications n set lease_until=now()+interval '2 minutes',attempts=n.attempts+1,send_started_at=coalesce(n.send_started_at,now())
    from claim where n.id=claim.id returning n.*;
end;
$$;
revoke all on function public.claim_notifications(integer) from public,anon,authenticated;
grant execute on function public.claim_notifications(integer) to service_role;

create function public.finish_notification(p_id text,p_status text,p_provider_id text default null,p_error text default null,p_retry_seconds integer default null) returns void
language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Worker access only'; end if;
  if p_status not in ('captured','sent','failed','uncertain','queued') then raise exception 'Invalid delivery result'; end if;
  update public.notifications set status=p_status,provider_id=coalesce(provider_id,p_provider_id),last_error=p_error,lease_until=null,
    next_attempt_at=now()+make_interval(secs=>coalesce(p_retry_seconds,0)) where id=p_id and status='queued';
end;
$$;
revoke all on function public.finish_notification(text,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.finish_notification(text,text,text,text,integer) to service_role;

create function public.reconcile_notification_delivery(p_provider_id text) returns void
language plpgsql security definer set search_path='' as $$
declare callback public.webhook_receipts;
begin
  -- Receipts can arrive before the sending worker saves its provider id. Reconcile
  -- every persisted callback once that id is known, with monotonic delivery state.
  for callback in select * from public.webhook_receipts where provider_id=p_provider_id order by received_at,id loop
    update public.notifications set status=callback.status,last_error=coalesce(callback.error,last_error)
      where provider_id=p_provider_id and (callback.status='bounced' or callback.error='email.complained' or callback.status='delivered' and status not in ('bounced') and last_error is distinct from 'email.complained' or callback.status='sent' and status in ('queued','uncertain','failed') and last_error is distinct from 'email.complained' or callback.status='failed' and status not in ('sent','delivered','bounced'));
  end loop;
end;
$$;
revoke all on function public.reconcile_notification_delivery(text) from public,anon,authenticated;

create function public.record_notification_webhook(p_receipt text,p_provider_id text,p_status text,p_error text default null) returns void
language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Worker access only'; end if;
  if p_status not in ('sent','delivered','bounced','failed') then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_provider_id,0));
  insert into public.webhook_receipts(id,provider_id,status,error) values(p_receipt,p_provider_id,p_status,p_error) on conflict do nothing;
  if not found then return; end if;
  perform public.reconcile_notification_delivery(p_provider_id);
end;
$$;
revoke all on function public.record_notification_webhook(text,text,text,text) from public,anon,authenticated;
grant execute on function public.record_notification_webhook(text,text,text,text) to service_role;
