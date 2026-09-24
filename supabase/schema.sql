-- ─────────────────────────────────────────────────────────────────────────────
-- Minimal Chat — database schema
-- Fresh project? Run this once: Supabase Dashboard → SQL Editor → paste everything → Run.
-- (Upgrading a project that already ran an older schema.sql? Run upgrade-v2.sql and/or
-- upgrade-v3.sql instead. See the README.)
-- It runs in one transaction, so if anything fails nothing is left half-made.
-- ─────────────────────────────────────────────────────────────────────────────
begin;

-- 1. Tables ───────────────────────────────────────────────────────────────────

-- One row per chat. system_prompt = the "instructions for this chat".
create table public.chat_conversations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title         text not null default 'New chat' check (char_length(title) <= 200),
  model         text check (char_length(model) <= 200),
  system_prompt text not null default '' check (char_length(system_prompt) <= 20000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Every message in every chat (the chat history the model gets as context).
create table public.chat_messages (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null references public.chat_conversations (id) on delete cascade,
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role              text not null check (role in ('user', 'assistant')),
  content           text not null check (char_length(content) <= 400000),
  model             text check (char_length(model) <= 200),
  prompt_tokens     integer,
  completion_tokens integer,
  finish_reason     text,
  created_at        timestamptz not null default now()
);

-- Per-user custom instructions that apply to every chat.
create table public.chat_settings (
  user_id             uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  custom_instructions text not null default '' check (char_length(custom_instructions) <= 20000),
  updated_at          timestamptz not null default now()
);

create index chat_conversations_user_updated_idx on public.chat_conversations (user_id, updated_at desc);
create index chat_messages_conversation_created_idx on public.chat_messages (conversation_id, created_at);
create index chat_messages_user_idx on public.chat_messages (user_id);

-- 2. Keep the chat list sorted by last activity ───────────────────────────────

create function public.chat_touch_conversation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.chat_conversations
     set updated_at = now(),
         model      = coalesce(new.model, model)
   where id = new.conversation_id;
  return new;
end;
$$;

create trigger chat_messages_touch_conversation
after insert on public.chat_messages
for each row execute function public.chat_touch_conversation();

-- 3. Row Level Security: every user only ever sees their own rows ─────────────

alter table public.chat_conversations enable row level security;
alter table public.chat_messages      enable row level security;
alter table public.chat_settings      enable row level security;

create policy "Users read their own chats" on public.chat_conversations
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users create their own chats" on public.chat_conversations
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users update their own chats" on public.chat_conversations
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete their own chats" on public.chat_conversations
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Users read their own messages" on public.chat_messages
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add messages to their own chats" on public.chat_messages
  for insert to authenticated with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.chat_conversations c
      where c.id = conversation_id and c.user_id = (select auth.uid())
    )
  );
create policy "Users update their own messages" on public.chat_messages
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete their own messages" on public.chat_messages
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Users read their own settings" on public.chat_settings
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users create their own settings" on public.chat_settings
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users update their own settings" on public.chat_settings
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- 4. Data API access ─────────────────────────────────────────────────────────
-- New Supabase projects no longer expose new tables to the Data API
-- automatically, so grant exactly what the app needs. Signed-out visitors
-- (anon) get nothing.

revoke all on table public.chat_conversations, public.chat_messages, public.chat_settings from anon;
grant select, insert, update, delete on table public.chat_conversations to authenticated;
grant select, insert, update, delete on table public.chat_messages      to authenticated;
grant select, insert, update         on table public.chat_settings      to authenticated;
grant all on table public.chat_conversations, public.chat_messages, public.chat_settings to service_role;

-- 5. v2: memory, usage, search past chats, preferences ────────────────────
-- (identical to upgrade-v2.sql)

-- Per-user preferences: theme, toggles for memory / artifacts / chat search, …
alter table public.chat_settings
  add column if not exists preferences jsonb not null default '{}'::jsonb;

-- Marks token counts that were estimated because the provider didn't report usage.
alter table public.chat_messages
  add column if not exists tokens_estimated boolean not null default false;

-- Full-text index over messages, for "Search and reference chats".
alter table public.chat_messages
  add column if not exists fts tsvector
  generated always as (to_tsvector('simple', left(content, 20000))) stored;
create index if not exists chat_messages_fts_idx on public.chat_messages using gin (fts);

-- Memory: short facts about the user, used as context in every chat.
create table if not exists public.chat_memories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content    text not null check (char_length(content) between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists chat_memories_user_idx on public.chat_memories (user_id, created_at);

alter table public.chat_memories enable row level security;
drop policy if exists "Users read their own memories" on public.chat_memories;
drop policy if exists "Users add their own memories" on public.chat_memories;
drop policy if exists "Users update their own memories" on public.chat_memories;
drop policy if exists "Users delete their own memories" on public.chat_memories;
create policy "Users read their own memories" on public.chat_memories
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add their own memories" on public.chat_memories
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users update their own memories" on public.chat_memories
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete their own memories" on public.chat_memories
  for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on table public.chat_memories from anon;
grant select, insert, update, delete on table public.chat_memories to authenticated;
grant all on table public.chat_memories to service_role;

-- Search the caller's own past messages (RLS applies: security invoker).
create or replace function public.search_chat_messages(
  query text,
  exclude_conversation uuid default null,
  match_count int default 6
)
returns table (conversation_id uuid, title text, role text, snippet text, created_at timestamptz, rank real)
language sql
stable
security invoker
set search_path = ''
as $$
  select m.conversation_id, c.title, m.role, left(m.content, 600), m.created_at, ts_rank(m.fts, q) as rank
  from public.chat_messages m
  join public.chat_conversations c on c.id = m.conversation_id
  cross join websearch_to_tsquery('simple', query) q
  where m.fts @@ q
    and (exclude_conversation is null or m.conversation_id <> exclude_conversation)
  order by rank desc, m.created_at desc
  limit least(greatest(match_count, 1), 20);
$$;

-- Daily token usage per model for the caller (RLS applies: security invoker).
create or replace function public.chat_usage(since timestamptz, tz text default 'UTC')
returns table (day date, model text, replies bigint, prompt_tokens bigint, completion_tokens bigint, estimated boolean)
language sql
stable
security invoker
set search_path = ''
as $$
  select (m.created_at at time zone tz)::date as day,
         coalesce(m.model, 'unknown') as model,
         count(*) as replies,
         coalesce(sum(m.prompt_tokens), 0)::bigint as prompt_tokens,
         coalesce(sum(m.completion_tokens), 0)::bigint as completion_tokens,
         coalesce(bool_or(m.tokens_estimated), false) as estimated
  from public.chat_messages m
  where m.role = 'assistant' and m.created_at >= since
  group by 1, 2
  order by 1, 2;
$$;

revoke execute on function public.search_chat_messages(text, uuid, int) from public, anon;
revoke execute on function public.chat_usage(timestamptz, text) from public, anon;
grant execute on function public.search_chat_messages(text, uuid, int) to authenticated, service_role;
grant execute on function public.chat_usage(timestamptz, text) to authenticated, service_role;

-- 6. v3: file attachments, edit, retry (message versions) ─────────────────
-- (identical to upgrade-v3.sql)

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
