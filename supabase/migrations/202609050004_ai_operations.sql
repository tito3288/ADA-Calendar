create table public.ai_operations (
  id text primary key, workspace_id uuid not null references public.workspaces(id),
  actor_id uuid not null references auth.users(id), kind text not null check(kind in ('assistant','transcribe')),
  input_hash text not null, status text not null check(status in ('processing','completed','failed')),
  result jsonb, last_error text, created_at timestamptz not null default now(), completed_at timestamptz
);
alter table public.ai_operations enable row level security;
revoke all on public.ai_operations from anon,authenticated;
grant select on public.ai_operations to authenticated;
grant all on public.ai_operations to service_role;
create policy ai_operations_private on public.ai_operations for select to authenticated using(actor_id=auth.uid() and workspace_id=public.current_workspace_id());

create function public.begin_ai_operation(p_id text,p_kind text,p_input_hash text,p_reserve_usd numeric) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.workspace_members; w public.workspaces; op public.ai_operations;
begin
  select * into m from public.workspace_members where user_id=auth.uid() and active;
  if m.user_id is null or m.role='viewer' then raise exception 'Not authorized to use assistant'; end if;
  select * into w from public.workspaces where id=m.workspace_id for update;
  select * into op from public.ai_operations where id=p_id for update;
  if op.id is not null then
    if op.workspace_id<>w.id or op.actor_id<>m.user_id or op.kind<>p_kind or op.input_hash<>p_input_hash then raise exception 'AI operation id was already used for different input'; end if;
    return jsonb_build_object('status',op.status,'result',op.result);
  end if;
  if coalesce(p_id,'')='' or p_kind not in ('assistant','transcribe') or p_input_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid AI operation'; end if;
  perform public.mutate_workspace(jsonb_build_object('type','reserve_ai','reservationId',p_id,'amountUsd',p_reserve_usd),w.version);
  insert into public.ai_operations(id,workspace_id,actor_id,kind,input_hash,status) values(p_id,w.id,m.user_id,p_kind,p_input_hash,'processing');
  return jsonb_build_object('status','claimed','result',null);
end;
$$;
revoke all on function public.begin_ai_operation(text,text,text,numeric) from public,anon;
grant execute on function public.begin_ai_operation(text,text,text,numeric) to authenticated;

create function public.finish_ai_operation(p_id text,p_result jsonb,p_cost_usd numeric default null,p_error text default null) returns void
language plpgsql security definer set search_path='' as $$
declare m public.workspace_members; w public.workspaces; op public.ai_operations;
begin
  select * into m from public.workspace_members where user_id=auth.uid() and active;
  if m.user_id is null or m.role='viewer' then raise exception 'Not authorized to use assistant'; end if;
  select * into w from public.workspaces where id=m.workspace_id for update;
  select * into op from public.ai_operations where id=p_id for update;
  if op.id is null or op.workspace_id<>w.id or op.actor_id<>m.user_id then raise exception 'AI operation is unavailable'; end if;
  if op.status<>'processing' then return; end if;
  if p_cost_usd is not null then perform public.mutate_workspace(jsonb_build_object('type','settle_ai','reservationId',p_id,'costUsd',p_cost_usd),w.version); end if;
  update public.ai_operations set status=case when p_error is null then 'completed' else 'failed' end,result=p_result,last_error=left(p_error,1000),completed_at=now() where id=p_id;
end;
$$;
revoke all on function public.finish_ai_operation(text,jsonb,numeric,text) from public,anon;
grant execute on function public.finish_ai_operation(text,jsonb,numeric,text) to authenticated;
