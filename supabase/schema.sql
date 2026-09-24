-- ─────────────────────────────────────────────────────────────────────────────
-- Minimal Chat — database schema
-- Fresh project? Run this once: Supabase Dashboard → SQL Editor → paste everything → Run.
-- (Upgrading a project that already ran the old schema.sql? Run upgrade-v2.sql instead.)
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

commit;
