-- Personal notes are private to their owner. They are not schedule state, AI
-- context, work events, or email drafts, and saving one never changes capacity.
create table public.personal_notes (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  id text not null check (id ~ '^[A-Za-z0-9_-]{1,150}$'),
  title text not null check (char_length(title) <= 200 and title ~ '[^[:space:]]'),
  body text not null check (char_length(body) <= 50000),
  version bigint not null default 1 check (version between 1 and 9007199254740991),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, author_id, id)
);
create index personal_notes_recent on public.personal_notes(workspace_id, author_id, updated_at desc, id);
alter table public.personal_notes enable row level security;
revoke all on public.personal_notes from public, anon, authenticated, service_role;
grant select on public.personal_notes to authenticated;
create policy personal_notes_owner_read on public.personal_notes for select to authenticated using (
  author_id = (select auth.uid())
  and workspace_id = (select public.current_workspace_id())
  and (select public.current_workspace_role()) = 'owner'
);

create function public.save_personal_note(p_id text, p_title text, p_body text, p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  member public.workspace_members%rowtype;
  saved public.personal_notes%rowtype;
begin
  -- Derive workspace and author from the authenticated session, never input.
  -- Hold the membership lock through the write so revocation cannot race it.
  select * into member from public.workspace_members
    where user_id = auth.uid() and active and role = 'owner' for share;
  if not found then raise exception 'Only the workspace owner can access personal notes.' using errcode = '42501'; end if;
  if p_id is null or p_id !~ '^[A-Za-z0-9_-]{1,150}$'
    or p_title is null or char_length(p_title) > 200 or p_title !~ '[^[:space:]]'
    or p_body is null or char_length(p_body) > 50000
    or p_expected_version is null or p_expected_version < 0 or p_expected_version > 9007199254740990
  then raise exception 'Invalid note input.' using errcode = '22023'; end if;

  if p_expected_version = 0 then
    insert into public.personal_notes(workspace_id, author_id, id, title, body)
      values(member.workspace_id, member.user_id, p_id, p_title, p_body)
      on conflict (workspace_id, author_id, id) do nothing
      returning * into saved;
    if found then
      return jsonb_build_object('id', saved.id, 'title', saved.title, 'body', saved.body,
        'version', saved.version, 'createdAt', saved.created_at, 'updatedAt', saved.updated_at);
    end if;
  end if;

  select * into saved from public.personal_notes
    where workspace_id = member.workspace_id and author_id = member.user_id and id = p_id for update;
  if not found then raise exception 'Note changed; reload the saved note.' using errcode = '40001'; end if;
  -- A retried response or unchanged Save is a no-op, not a second revision.
  if p_expected_version <= saved.version and saved.title = p_title and saved.body = p_body then
    return jsonb_build_object('id', saved.id, 'title', saved.title, 'body', saved.body,
      'version', saved.version, 'createdAt', saved.created_at, 'updatedAt', saved.updated_at);
  end if;
  if p_expected_version <> saved.version then
    raise exception 'Note changed; reload the saved note.' using errcode = '40001';
  end if;
  update public.personal_notes set title = p_title, body = p_body, version = version + 1, updated_at = now()
    where workspace_id = member.workspace_id and author_id = member.user_id and id = p_id
    returning * into saved;
  return jsonb_build_object('id', saved.id, 'title', saved.title, 'body', saved.body,
    'version', saved.version, 'createdAt', saved.created_at, 'updatedAt', saved.updated_at);
end;
$$;
revoke all on function public.save_personal_note(text, text, text, bigint) from public, anon, authenticated, service_role;
grant execute on function public.save_personal_note(text, text, text, bigint) to authenticated;
