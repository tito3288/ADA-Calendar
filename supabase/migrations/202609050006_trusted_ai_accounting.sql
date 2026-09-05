-- Provider usage is server-attested. Browser-authenticated callers must not invent
-- zero-cost settlements or fake cached provider results to defeat the monthly limit.
alter function public.mutate_workspace(jsonb,bigint,jsonb) rename to mutate_workspace_transaction;
revoke all on function public.mutate_workspace_transaction(jsonb,bigint,jsonb) from public,anon,authenticated;
create function public.mutate_workspace(p_action jsonb,p_base_version bigint,p_notifications jsonb default '[]') returns void
language plpgsql security definer set search_path='' as $$
begin
  if p_action->>'type' in ('reserve_ai','settle_ai') then raise exception 'AI accounting is a server-only operation'; end if;
  perform public.mutate_workspace_transaction(p_action,p_base_version,p_notifications);
end;
$$;
revoke all on function public.mutate_workspace(jsonb,bigint,jsonb) from public,anon;
grant execute on function public.mutate_workspace(jsonb,bigint,jsonb) to authenticated;

drop function public.begin_ai_operation(text,text,text,numeric);
drop function public.finish_ai_operation(text,jsonb,numeric,text);

create function public.begin_ai_operation(p_actor uuid,p_id text,p_kind text,p_input_hash text,p_reserve_usd numeric) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.workspace_members; workspace public.workspaces; operation public.ai_operations;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Trusted assistant server access required'; end if;
  select * into member from public.workspace_members where user_id=p_actor and active;
  if member.user_id is null or member.role='viewer' then raise exception 'Actor is not authorized to use the assistant'; end if;
  select * into workspace from public.workspaces where id=member.workspace_id for update;
  select * into operation from public.ai_operations where id=p_id for update;
  if operation.id is not null then
    if operation.workspace_id<>workspace.id or operation.actor_id<>member.user_id or operation.kind<>p_kind or operation.input_hash<>p_input_hash then raise exception 'AI operation id was already used for different input'; end if;
    return jsonb_build_object('status',operation.status,'result',operation.result);
  end if;
  if coalesce(p_id,'')='' or p_kind not in ('assistant','transcribe') or p_input_hash !~ '^[0-9a-f]{64}$' or p_reserve_usd is null or p_reserve_usd<=0 or p_reserve_usd::text in ('NaN','Infinity','-Infinity') then raise exception 'Invalid AI operation or reservation'; end if;
  if exists(select 1 from public.ai_usage where reservation_id=p_id) then raise exception 'AI reservation already exists without a matching operation; reconcile it before retrying'; end if;
  if coalesce((select sum(amount_usd) from public.ai_usage where workspace_id=workspace.id and created_at>=date_trunc('month',now())),0)+p_reserve_usd>coalesce((workspace.settings->>'aiLimitUsd')::numeric,25) then raise exception 'Monthly AI budget reached. Manual scheduling remains available.'; end if;
  insert into public.ai_usage(workspace_id,actor_id,amount_usd,reservation_id) values(workspace.id,member.user_id,p_reserve_usd,p_id);
  insert into public.ai_operations(id,workspace_id,actor_id,kind,input_hash,status) values(p_id,workspace.id,member.user_id,p_kind,p_input_hash,'processing');
  return jsonb_build_object('status','claimed','result',null);
end;
$$;
revoke all on function public.begin_ai_operation(uuid,text,text,text,numeric) from public,anon,authenticated;
grant execute on function public.begin_ai_operation(uuid,text,text,text,numeric) to service_role;

create function public.finish_ai_operation(p_actor uuid,p_id text,p_result jsonb,p_cost_usd numeric default null,p_error text default null) returns void
language plpgsql security definer set search_path='' as $$
declare member public.workspace_members; workspace public.workspaces; operation public.ai_operations;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Trusted assistant server access required'; end if;
  select * into member from public.workspace_members where user_id=p_actor and active;
  if member.user_id is null or member.role='viewer' then raise exception 'Actor is not authorized to use the assistant'; end if;
  select * into workspace from public.workspaces where id=member.workspace_id for update;
  select * into operation from public.ai_operations where id=p_id for update;
  if operation.id is null or operation.workspace_id<>workspace.id or operation.actor_id<>member.user_id then raise exception 'AI operation is unavailable'; end if;
  if operation.status<>'processing' then return; end if;
  if not exists(select 1 from public.ai_usage where reservation_id=p_id and workspace_id=workspace.id and actor_id=member.user_id) then raise exception 'AI operation has no matching reservation'; end if;
  if p_cost_usd is not null then
    if p_cost_usd<0 or p_cost_usd::text in ('NaN','Infinity','-Infinity') then raise exception 'AI cost must be a known nonnegative amount'; end if;
    update public.ai_usage set amount_usd=p_cost_usd,settled=true where reservation_id=p_id and workspace_id=workspace.id and actor_id=member.user_id and not settled;
  end if;
  update public.ai_operations set status=case when p_error is null then 'completed' else 'failed' end,result=p_result,last_error=left(p_error,1000),completed_at=now() where id=p_id;
end;
$$;
revoke all on function public.finish_ai_operation(uuid,text,jsonb,numeric,text) from public,anon,authenticated;
grant execute on function public.finish_ai_operation(uuid,text,jsonb,numeric,text) to service_role;
