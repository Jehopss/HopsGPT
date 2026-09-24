-- ─────────────────────────────────────────────────────────────────────────────
-- Minimal Chat — database schema
-- Run this once: Supabase Dashboard → SQL Editor → paste everything → Run.
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

commit;
