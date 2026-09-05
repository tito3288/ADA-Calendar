-- One SQL statement/statement snapshot is essential: reading a new workspace version
-- and an older session collection separately could otherwise overwrite concurrent work.
-- JSON aggregation also avoids the PostgREST row limit truncating session history.
create function public.read_schedule_snapshot() returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_object(
    'workspaceId',w.id,'version',w.version,'settings',w.settings,
    'clients',w.clients,'priorities',w.priorities,'items',w.items,'blocks',w.blocks,
    'sessions',coalesce((select jsonb_agg(s.body order by s.starts_at,s.id) from public.work_sessions s where s.workspace_id=w.id),'[]'::jsonb)
  ) from public.workspaces w where w.id=(select public.current_workspace_id());
$$;
revoke all on function public.read_schedule_snapshot() from public,anon;
grant execute on function public.read_schedule_snapshot() to authenticated;

-- Keep the existing atomic transaction and add defense at the exposed RPC boundary.
-- Requesters may create planned, unprotected work only, even when bypassing the app.
alter function public.commit_schedule(jsonb,jsonb,jsonb,text,text) rename to commit_schedule_transaction;
revoke all on function public.commit_schedule_transaction(jsonb,jsonb,jsonb,text,text) from public,anon,authenticated;
create function public.commit_schedule(p_proposal jsonb,p_event jsonb,p_notifications jsonb default '[]',p_request_id text default null,p_undo_id text default null)
returns bigint language plpgsql security definer set search_path='' as $$
declare member public.workspace_members;
begin
  select * into member from public.workspace_members where user_id=auth.uid() and active;
  if member.role='requester' and exists(
    select 1 from jsonb_array_elements(p_proposal->'sessions') fresh
    where not exists(select 1 from public.work_sessions old where old.workspace_id=member.workspace_id and old.body=fresh)
      and (coalesce((fresh->>'protected')::boolean,false) or fresh->>'status' is distinct from 'planned')
  ) then raise exception 'Requesters cannot create protected or historical sessions'; end if;
  return public.commit_schedule_transaction(p_proposal,p_event,p_notifications,p_request_id,p_undo_id);
end;
$$;
revoke all on function public.commit_schedule(jsonb,jsonb,jsonb,text,text) from public,anon;
grant execute on function public.commit_schedule(jsonb,jsonb,jsonb,text,text) to authenticated;
