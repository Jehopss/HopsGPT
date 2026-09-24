-- ─────────────────────────────────────────────────────────────────────────────
-- Minimal Chat v3: file attachments, edit, retry (message versions).
-- Already ran schema.sql (and upgrade-v2.sql) before? Run THIS file once:
-- SQL Editor → paste → Run. Safe to run more than once.
-- (Fresh installs only need schema.sql, which already includes this.)
-- ─────────────────────────────────────────────────────────────────────────────
begin;

-- Messages form a tree: editing a message or retrying a reply adds a sibling
-- instead of overwriting, so you can flip between versions (‹ 2/3 ›).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'chat_messages' and column_name = 'parent_id'
  ) then
    alter table public.chat_messages
      add column parent_id uuid references public.chat_messages (id) on delete cascade;
    -- Existing chats become one straight line: each message follows the one before it.
    with ordered as (
      select id, lag(id) over (partition by conversation_id order by created_at, id) as prev
      from public.chat_messages
    )
    update public.chat_messages m set parent_id = o.prev
    from ordered o
    where m.id = o.id and o.prev is not null;
  end if;
end $$;
create index if not exists chat_messages_parent_idx on public.chat_messages (parent_id);

-- The version of the chat you looked at last, so it reopens on the same branch.
alter table public.chat_conversations add column if not exists current_leaf_id uuid;

-- Files attached to messages. The file itself lives in Storage (bucket "chat-files");
-- text_content is what was read out of it (PDF, Word, Excel, code, …) for the model.
create table if not exists public.chat_attachments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  conversation_id uuid references public.chat_conversations (id) on delete cascade,
  message_id      uuid references public.chat_messages (id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 255),
  mime            text not null default 'application/octet-stream' check (char_length(mime) <= 200),
  size            bigint not null default 0 check (size >= 0),
  kind            text not null check (kind in ('image', 'document', 'file')),
  storage_path    text check (char_length(storage_path) <= 600),
  image_paths     text[] not null default '{}' check (cardinality(image_paths) <= 20),
  text_content    text check (char_length(text_content) <= 1000000),
  text_chars      integer generated always as (coalesce(char_length(text_content), 0)) stored,
  position        smallint not null default 0,
  meta            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists chat_attachments_message_idx on public.chat_attachments (message_id);
create index if not exists chat_attachments_conversation_idx on public.chat_attachments (conversation_id);
create index if not exists chat_attachments_user_idx on public.chat_attachments (user_id, created_at);

alter table public.chat_attachments enable row level security;
drop policy if exists "Users read their own attachments" on public.chat_attachments;
drop policy if exists "Users add their own attachments" on public.chat_attachments;
drop policy if exists "Users update their own attachments" on public.chat_attachments;
drop policy if exists "Users delete their own attachments" on public.chat_attachments;
create policy "Users read their own attachments" on public.chat_attachments
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add their own attachments" on public.chat_attachments
  for insert to authenticated with check (
    (select auth.uid()) = user_id
    and (storage_path is null or split_part(storage_path, '/', 1) = (select auth.uid())::text)
    and (conversation_id is null or exists (
      select 1 from public.chat_conversations c where c.id = conversation_id and c.user_id = (select auth.uid())
    ))
  );
create policy "Users update their own attachments" on public.chat_attachments
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (storage_path is null or split_part(storage_path, '/', 1) = (select auth.uid())::text)
  );
create policy "Users delete their own attachments" on public.chat_attachments
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on table public.chat_attachments from anon;
grant select, insert, update, delete on table public.chat_attachments to authenticated;
grant all on table public.chat_attachments to service_role;

-- One branch of a chat, from its first message down to `leaf` (RLS applies).
create or replace function public.chat_message_path(leaf uuid, max_count int default 1000)
returns table (id uuid, parent_id uuid, role text, content text, depth int)
language sql
stable
security invoker
set search_path = ''
as $$
  with recursive path as (
    select m.id, m.parent_id, m.role, m.content, 0 as depth
    from public.chat_messages m
    where m.id = leaf
    union all
    select m.id, m.parent_id, m.role, m.content, p.depth + 1
    from public.chat_messages m
    join path p on m.id = p.parent_id
    where p.depth + 1 < least(greatest(max_count, 1), 5000)
  )
  select path.id, path.parent_id, path.role, path.content, path.depth from path order by path.depth desc;
$$;
revoke execute on function public.chat_message_path(uuid, int) from public, anon;
grant execute on function public.chat_message_path(uuid, int) to authenticated, service_role;

-- Storage: a private bucket; everyone can only touch files in their own folder (<user id>/…).
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-files', 'chat-files', false, 26214400) -- 25 MB per file
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "Chat files: read own" on storage.objects;
drop policy if exists "Chat files: upload own" on storage.objects;
drop policy if exists "Chat files: delete own" on storage.objects;
create policy "Chat files: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'chat-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Chat files: upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'chat-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Chat files: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'chat-files' and (storage.foldername(name))[1] = (select auth.uid())::text);

commit;
