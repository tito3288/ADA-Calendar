-- A clarification is private and may be continued by exactly one operation.
-- Retries keep their original operation ID; competing tabs cannot branch it into duplicate work.
alter table public.ai_operations add column parent_id text references public.ai_operations(id);
create unique index ai_operations_one_followup on public.ai_operations(parent_id) where parent_id is not null;

drop function public.begin_ai_operation(uuid,text,text,text,numeric);
create function public.begin_ai_operation(p_actor uuid,p_id text,p_kind text,p_input_hash text,p_reserve_usd numeric,p_parent_id text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.workspace_members; workspace public.workspaces; operation public.ai_operations; parent public.ai_operations;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Trusted assistant server access required'; end if;
  select * into member from public.workspace_members where user_id=p_actor and active;
  if member.user_id is null or member.role='viewer' then raise exception 'Actor is not authorized to use the assistant'; end if;
  select * into workspace from public.workspaces where id=member.workspace_id for update;
  select * into operation from public.ai_operations where id=p_id for update;
  if operation.id is not null then
    if operation.workspace_id<>workspace.id or operation.actor_id<>member.user_id or operation.kind is distinct from p_kind or operation.input_hash is distinct from p_input_hash or operation.parent_id is distinct from p_parent_id then raise exception 'AI operation id was already used for different input'; end if;
    return jsonb_build_object('status',operation.status,'result',operation.result);
  end if;
  if coalesce(p_id,'')='' or p_kind is null or p_kind not in ('assistant','transcribe') or p_input_hash is null or p_input_hash !~ '^[0-9a-f]{64}$' or p_reserve_usd is null or p_reserve_usd<=0 or p_reserve_usd::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid AI operation or reservation'; end if;
  if p_parent_id is not null then
    select * into parent from public.ai_operations where id=p_parent_id for update;
    if p_id=p_parent_id or p_kind<>'assistant' or parent.id is null or parent.workspace_id<>workspace.id or parent.actor_id<>member.user_id or parent.kind<>'assistant' or parent.status<>'completed' or parent.result#>>'{interpretation,kind}' is distinct from 'clarification' or jsonb_typeof(parent.result->'continuation') is distinct from 'object' then
      raise exception 'This clarification is not available to continue';
    end if;
    if exists(select 1 from public.ai_operations where parent_id=p_parent_id) then raise exception 'This clarification already has a reply. Continue from the latest question or start a new request.'; end if;
  end if;
  if exists(select 1 from public.ai_usage where reservation_id=p_id) then raise exception 'AI reservation already exists without a matching operation; reconcile it before retrying'; end if;
  if coalesce((select sum(amount_usd) from public.ai_usage where workspace_id=workspace.id and created_at>=date_trunc('month',now())),0)+p_reserve_usd>coalesce((workspace.settings->>'aiLimitUsd')::numeric,25) then raise exception 'Monthly AI budget reached. Manual scheduling remains available.'; end if;
  insert into public.ai_usage(workspace_id,actor_id,amount_usd,reservation_id) values(workspace.id,member.user_id,p_reserve_usd,p_id);
  insert into public.ai_operations(id,workspace_id,actor_id,kind,input_hash,status,parent_id) values(p_id,workspace.id,member.user_id,p_kind,p_input_hash,'processing',p_parent_id);
  return jsonb_build_object('status','claimed','result',null);
end;
$$;
revoke all on function public.begin_ai_operation(uuid,text,text,text,numeric,text) from public,anon,authenticated;
grant execute on function public.begin_ai_operation(uuid,text,text,text,numeric,text) to service_role;
