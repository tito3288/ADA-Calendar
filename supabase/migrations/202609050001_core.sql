-- Workspace mutations are versioned RPC transactions. Browser roles never write tables directly.
create extension if not exists btree_gist with schema extensions;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  version bigint not null default 0 check (version >= 0),
  settings jsonb not null,
  clients jsonb not null default '[]' check (jsonb_typeof(clients) = 'array'),
  priorities jsonb not null default '[]' check (jsonb_typeof(priorities) = 'array'),
  items jsonb not null default '[]' check (jsonb_typeof(items) = 'array'),
  blocks jsonb not null default '[]' check (jsonb_typeof(blocks) = 'array'),
  created_at timestamptz not null default now()
);
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null, email text not null,
  role text not null check (role in ('owner','requester','viewer')),
  active boolean not null default true,
  receive_updates boolean not null default true,
  unique (workspace_id, email)
);
create unique index one_owner_per_workspace on public.workspace_members(workspace_id) where role='owner' and active;
create table public.work_sessions (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  id text not null, work_item_id text not null,
  starts_at timestamptz not null, ends_at timestamptz not null,
  status text not null check (status in ('planned','completed','cancelled')),
  body jsonb not null,
  primary key(workspace_id,id),
  check (ends_at > starts_at),
  exclude using gist (workspace_id with =, tstzrange(starts_at, ends_at, '[)') with &&) where (status='planned')
);
create table public.work_events (
  id text primary key, workspace_id uuid not null references public.workspaces(id),
  operation_id text not null, actor_id uuid not null references auth.users(id),
  version bigint not null, body jsonb not null, operation_payload jsonb not null default '[]', created_at timestamptz not null default now(),
  unique(workspace_id,operation_id)
);
create table public.pending_requests (
  id text primary key, workspace_id uuid not null references public.workspaces(id),
  requester_id uuid not null references auth.users(id), body jsonb not null,
  created_at timestamptz not null default now()
);
create table public.notifications (
  id text primary key, workspace_id uuid not null references public.workspaces(id),
  event_id text not null, recipient text not null, recipient_name text not null,
  subject text not null, body text not null,
  status text not null default 'queued' check (status in ('queued','captured','sent','delivered','failed','uncertain','bounced')),
  attempts integer not null default 0, provider_id text, created_at timestamptz not null default now(), last_error text,
  next_attempt_at timestamptz not null default now(), lease_until timestamptz, send_started_at timestamptz,
  idempotency_key text not null unique,
  unique(workspace_id,event_id,recipient)
);
create index notifications_ready on public.notifications(next_attempt_at) where status='queued';
create table public.attachments (
  id text primary key, workspace_id uuid not null references public.workspaces(id),
  work_item_id text not null, name text not null, content_type text not null,
  size bigint not null check (size>0 and size<=20971520), path text not null unique,
  uploaded_by uuid not null references auth.users(id), created_at timestamptz not null default now(), removed_at timestamptz
  , upload_status text not null default 'pending' check (upload_status in ('pending','ready'))
);
create table public.email_drafts (
  id text primary key, workspace_id uuid not null references public.workspaces(id),
  author_id uuid not null references auth.users(id), item_id text, subject text not null, body text not null,
  status text not null default 'draft' check (status in ('draft','sent','dismissed')),
  created_at timestamptz not null default now()
);
create table public.ai_usage (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
  actor_id uuid not null references auth.users(id), amount_usd numeric(12,6) not null check (amount_usd>=0),
  created_at timestamptz not null default now()
);
create table public.webhook_receipts (
  id text primary key, received_at timestamptz not null default now(),
  provider_id text not null, status text not null, error text
);
create index webhook_receipts_provider on public.webhook_receipts(provider_id);

create function public.current_workspace_id() returns uuid language sql stable security definer set search_path='' as $$
  select workspace_id from public.workspace_members where user_id=auth.uid() and active;
$$;
create function public.current_workspace_role() returns text language sql stable security definer set search_path='' as $$
  select role from public.workspace_members where user_id=auth.uid() and active;
$$;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.work_sessions enable row level security;
alter table public.work_events enable row level security;
alter table public.pending_requests enable row level security;
alter table public.notifications enable row level security;
alter table public.attachments enable row level security;
alter table public.email_drafts enable row level security;
alter table public.ai_usage enable row level security;
alter table public.webhook_receipts enable row level security;
revoke all on public.workspaces, public.workspace_members, public.work_sessions, public.work_events, public.pending_requests,
  public.notifications, public.attachments, public.email_drafts, public.ai_usage, public.webhook_receipts from anon, authenticated;
grant select on public.workspaces, public.workspace_members, public.work_sessions, public.work_events, public.pending_requests,
  public.notifications, public.attachments, public.email_drafts, public.ai_usage to authenticated;
grant all on public.workspaces, public.workspace_members, public.work_sessions, public.work_events, public.pending_requests,
  public.notifications, public.attachments, public.email_drafts, public.ai_usage, public.webhook_receipts to service_role;
create policy workspace_read on public.workspaces for select to authenticated using (id=(select public.current_workspace_id()));
create policy member_read on public.workspace_members for select to authenticated using (workspace_id=(select public.current_workspace_id()));
create policy sessions_read on public.work_sessions for select to authenticated using (workspace_id=(select public.current_workspace_id()));
create policy events_read on public.work_events for select to authenticated using (workspace_id=(select public.current_workspace_id()));
create policy requests_read on public.pending_requests for select to authenticated using (workspace_id=(select public.current_workspace_id()) and (requester_id=auth.uid() or public.current_workspace_role()='owner'));
create policy notifications_read on public.notifications for select to authenticated using (workspace_id=(select public.current_workspace_id()) and (public.current_workspace_role()='owner' or recipient=(select email from public.workspace_members where user_id=auth.uid())));
create policy attachments_read on public.attachments for select to authenticated using (
  workspace_id=(select public.current_workspace_id()) and (
    public.current_workspace_role()='owner'
    or exists(select 1 from public.workspaces w, jsonb_array_elements(w.items) i where w.id=attachments.workspace_id and i->>'id'=attachments.work_item_id)
    or exists(select 1 from public.pending_requests r, jsonb_array_elements(r.body#>'{proposal,commands}') cmd
      where r.workspace_id=attachments.workspace_id and r.requester_id=auth.uid() and r.body->>'status' in ('pending','needs_information') and cmd->>'type'='create' and cmd#>>'{item,id}'=attachments.work_item_id)
  )
);
create policy drafts_read on public.email_drafts for select to authenticated using (workspace_id=(select public.current_workspace_id()) and author_id=auth.uid());
create policy usage_read on public.ai_usage for select to authenticated using (workspace_id=(select public.current_workspace_id()) and (actor_id=auth.uid() or public.current_workspace_role()='owner'));

-- Called only from security-definer application RPCs, never exposed as an API capability.
create function public.enqueue_notifications(p_workspace uuid, p_event text, p_notifications jsonb, p_audience text, p_actor uuid)
returns void language plpgsql security definer set search_path='' as $$
declare n jsonb; m public.workspace_members;
begin
  for n in select value from jsonb_array_elements(coalesce(p_notifications,'[]')) loop
    select * into m from public.workspace_members where workspace_id=p_workspace and lower(email)=lower(n->>'recipient') and active;
    if m.user_id is null then raise exception 'Invalid notification recipient'; end if;
    if p_audience='owner' and m.role<>'owner' then raise exception 'Invalid request notification recipient'; end if;
    if p_audience='updates' and not (m.role='requester' and m.receive_updates or m.role='owner' and m.user_id<>p_actor) then raise exception 'Invalid update notification recipient'; end if;
    if p_audience='draft' and not (m.role='requester' and m.receive_updates) then raise exception 'Invalid draft recipient'; end if;
    insert into public.notifications(id,workspace_id,event_id,recipient,recipient_name,subject,body,idempotency_key)
      values(n->>'id',p_workspace,p_event,m.email,m.name,left(n->>'subject',500),n->>'body','ada/'||p_event||'/'||m.user_id::text)
      on conflict(workspace_id,event_id,recipient) do nothing;
  end loop;
end;
$$;
revoke all on function public.enqueue_notifications(uuid,text,jsonb,text,uuid) from public, anon, authenticated;

create function public.commit_schedule(p_proposal jsonb,p_event jsonb,p_notifications jsonb default '[]',p_request_id text default null,p_undo_id text default null)
returns bigint language plpgsql security definer set search_path='' as $$
declare m public.workspace_members; w public.workspaces; s jsonb; i jsonb; b jsonb; prior jsonb; found_item jsonb;
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
      if start_local::date<(found_item->>'windowStart')::date or (jsonb_array_length(coalesce(found_item->'allowedDates','[]'))>0 and not exists(select 1 from jsonb_array_elements_text(found_item->'allowedDates') allowed where allowed=start_local::date::text)) then raise exception 'Session is outside allowed work dates'; end if;
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
revoke all on function public.commit_schedule(jsonb,jsonb,jsonb,text,text) from public,anon;
grant execute on function public.commit_schedule(jsonb,jsonb,jsonb,text,text) to authenticated;

create function public.submit_schedule_request(p_request jsonb,p_notifications jsonb default '[]') returns text
language plpgsql security definer set search_path='' as $$
declare m public.workspace_members; w public.workspaces; req jsonb;
begin
  select * into m from public.workspace_members where user_id=auth.uid() and active;
  if m.user_id is null or m.role<>'requester' then raise exception 'Only requesters can submit priority requests'; end if;
  select * into w from public.workspaces where id=m.workspace_id for update;
  if exists(select 1 from public.pending_requests where id=p_request->>'id' and workspace_id=w.id and requester_id=m.user_id) then return p_request->>'id'; end if;
  if coalesce((p_request#>>'{proposal,baseVersion}')::bigint,-1)<>w.version then raise exception 'Schedule changed. Refresh request.' using errcode='40001'; end if;
  if p_request#>>'{proposal,actorId}' is distinct from m.user_id::text then raise exception 'Request actor mismatch'; end if;
  if exists(select 1 from jsonb_array_elements(p_request#>'{proposal,commands}') cmd where cmd->>'type'<>'create') then raise exception 'Requesters may request new work only'; end if;
  req := p_request||jsonb_build_object('requesterId',m.user_id,'requesterName',m.name,'status','pending','createdAt',now(),'resolvedAt',null);
  insert into public.pending_requests(id,workspace_id,requester_id,body) values(req->>'id',w.id,m.user_id,req);
  perform public.enqueue_notifications(w.id,req->>'id',p_notifications,'owner',m.user_id);
  return req->>'id';
end;
$$;
revoke all on function public.submit_schedule_request(jsonb,jsonb) from public,anon;
grant execute on function public.submit_schedule_request(jsonb,jsonb) to authenticated;

create function public.resolve_schedule_request(p_id text,p_decision text,p_note text default '') returns void
language plpgsql security definer set search_path='' as $$
declare m public.workspace_members;
begin
  select * into m from public.workspace_members where user_id=auth.uid() and active;
  if m.role is distinct from 'owner' then raise exception 'Only owner can resolve requests'; end if;
  if p_decision not in ('declined','needs_information') then raise exception 'Approvals must atomically commit the proposed schedule'; end if;
  update public.pending_requests set body=body||jsonb_build_object('status',p_decision,'note',p_note,'resolvedAt',now()) where id=p_id and workspace_id=m.workspace_id and body->>'status' in ('pending','needs_information');
  if not found then raise exception 'Request is not pending'; end if;
end;
$$;
revoke all on function public.resolve_schedule_request(text,text,text) from public,anon;
grant execute on function public.resolve_schedule_request(text,text,text) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('work-attachments','work-attachments',false,20971520,array['text/markdown','text/plain','image/png','image/jpeg','image/webp','application/pdf'])
on conflict(id) do nothing;
create policy attachment_objects_read on storage.objects for select to authenticated using(bucket_id='work-attachments' and exists(
  select 1 from public.attachments a where a.path=storage.objects.name and a.workspace_id=public.current_workspace_id() and a.upload_status='ready' and a.removed_at is null
));
-- Storage writes use short-lived signed uploads created by the authenticated server.
-- There is deliberately no broad browser insert/update/delete policy.
