-- =====================================================================
-- supabase_livechat.sql  --  ADDITIVE migration for the website live chat.
-- Creates public.chat_conversations, public.chat_messages and two helper functions. Touches no existing table, deletes nothing.
-- Run AFTER supabase_quick_fix.sql (the chat-staff function checks public.admins). Not executed by Claude: review, then run once.
-- Security model: visitors and ordinary logged-in users have NO direct access to chat data (no grants, no policies).
-- Only the two Edge Functions (service role) read or write it: chat-visitor (public, with a secret visitor token) and chat-staff (admins only).
-- =====================================================================
do $$ begin
  if to_regclass('public.admins') is null then raise exception 'public.admins is missing - run supabase_quick_fix.sql first'; end if;
end $$;

create table if not exists public.chat_conversations (
  id              uuid primary key default gen_random_uuid(),
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),      -- HMAC of the visitor's secret token; the token itself is never stored
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  status          text not null default 'open' check (status in ('open','closed')),
  lang            text not null default 'ar' check (lang in ('ar','en')),
  unread_staff    integer not null default 0 check (unread_staff >= 0),            -- visitor messages the clinic has not opened yet
  last_sender     text check (last_sender is null or last_sender in ('visitor','staff')),
  last_body       text check (last_body is null or char_length(last_body) <= 200),  -- preview for the admin list
  ip_hash         text check (ip_hash is null or char_length(ip_hash) between 16 and 64)
);
create table if not exists public.chat_messages (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  sender          text not null check (sender in ('visitor','staff')),
  body            text not null check (char_length(body) between 1 and 2000),
  created_at      timestamptz not null default now(),
  ip_hash         text check (ip_hash is null or char_length(ip_hash) between 16 and 64),   -- hashed network address of visitor messages (abuse limits)
  staff_user      uuid references auth.users(id) on delete set null                          -- which admin replied
);
create index if not exists chat_messages_conv_idx    on public.chat_messages (conversation_id, id);
create index if not exists chat_messages_ip_idx      on public.chat_messages (ip_hash, created_at desc) where ip_hash is not null;
create index if not exists chat_messages_created_idx on public.chat_messages (created_at desc);
create index if not exists chat_conv_last_idx        on public.chat_conversations (last_message_at desc);
create index if not exists chat_conv_status_idx      on public.chat_conversations (status, last_message_at desc);

alter table public.chat_conversations enable row level security;
alter table public.chat_messages      enable row level security;
revoke all on public.chat_conversations from anon, authenticated;
revoke all on public.chat_messages      from anon, authenticated;
-- (no policies and no grants for anon/authenticated on purpose: the website and the admin page reach chat data only through the Edge Functions)
grant select, update on public.chat_conversations to service_role;
grant select on public.chat_messages to service_role;
grant select on public.admins to service_role;

-- Visitor sends a message: creates the conversation on first use, stores the message, counts it as unread. One atomic call.
create or replace function public.chat_visitor_send(p_token_hash text, p_body text, p_lang text, p_ip_hash text)
returns table(out_conversation uuid, out_message bigint, out_created boolean)
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_new boolean := false; v_msg bigint;
begin
  select c.id into v_id from public.chat_conversations c where c.token_hash = p_token_hash;
  if v_id is null then
    insert into public.chat_conversations (token_hash, lang, ip_hash) values (p_token_hash, p_lang, p_ip_hash)
      on conflict (token_hash) do nothing returning id into v_id;
    if v_id is null then select c.id into v_id from public.chat_conversations c where c.token_hash = p_token_hash; else v_new := true; end if;
  end if;
  insert into public.chat_messages (conversation_id, sender, body, ip_hash) values (v_id, 'visitor', p_body, p_ip_hash) returning id into v_msg;
  update public.chat_conversations
     set last_message_at = now(), status = 'open', unread_staff = unread_staff + 1, lang = p_lang, last_sender = 'visitor', last_body = left(p_body, 200)
   where id = v_id;
  return query select v_id, v_msg, v_new;
end $$;

-- An admin replies (called only by the chat-staff function after it verified the admin).
create or replace function public.chat_staff_reply(p_conversation uuid, p_body text, p_staff uuid)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_msg bigint;
begin
  if not exists (select 1 from public.chat_conversations c where c.id = p_conversation) then
    raise exception 'conversation not found' using errcode = 'P0002';
  end if;
  insert into public.chat_messages (conversation_id, sender, body, staff_user) values (p_conversation, 'staff', p_body, p_staff) returning id into v_msg;
  update public.chat_conversations
     set last_message_at = now(), status = 'open', unread_staff = 0, last_sender = 'staff', last_body = left(p_body, 200)
   where id = p_conversation;
  return v_msg;
end $$;

revoke all on function public.chat_visitor_send(text, text, text, text) from public, anon, authenticated;
revoke all on function public.chat_staff_reply(uuid, text, uuid)        from public, anon, authenticated;
grant execute on function public.chat_visitor_send(text, text, text, text) to service_role;
grant execute on function public.chat_staff_reply(uuid, text, uuid)        to service_role;

notify pgrst, 'reload schema';
select count(*) as chat_conversations_ready from public.chat_conversations;   -- expect 0 right after the first run

-- ---------------------------------------------------------------------
-- PRIVACY: chat messages can contain personal details. Suggested retention (run manually, e.g. every few months):
--   delete from public.chat_conversations where last_message_at < now() - interval '180 days';     -- messages are removed with them
-- ROLLBACK (deletes all chat data):  drop function public.chat_staff_reply(uuid,text,uuid); drop function public.chat_visitor_send(text,text,text,text);
--                                    drop table public.chat_messages; drop table public.chat_conversations;
