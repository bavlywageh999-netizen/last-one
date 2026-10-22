-- =====================================================================
-- supabase_bookings_security.sql  --  ADDITIVE migration for the hardened submit-booking function.
-- Run AFTER supabase_quick_fix.sql and supabase_bookings.sql. Adds 3 columns + 1 index; deletes and rewrites nothing.
-- Not executed by Claude: review, then run once in the Supabase SQL Editor.
-- =====================================================================
do $$ begin
  if to_regclass('public.bookings') is null then raise exception 'public.bookings is missing - run supabase_bookings.sql first'; end if;
end $$;

-- hashed network address of the submitter (never the raw IP): lets the function limit abuse that changes email addresses or UUIDs
alter table public.bookings add column if not exists ip_hash text check (ip_hash is null or char_length(ip_hash) between 16 and 64);
-- how many times each notification was attempted (patients may retry only a few times; admins are not limited)
alter table public.bookings add column if not exists email_attempts    smallint not null default 0 check (email_attempts    between 0 and 100);
alter table public.bookings add column if not exists whatsapp_attempts smallint not null default 0 check (whatsapp_attempts between 0 and 100);
create index if not exists bookings_ip_idx on public.bookings (ip_hash, created_at desc);

-- No policy or grant changes are needed: RLS stays on, visitors/ordinary users still have no access, admins keep read + status-update,
-- and the Edge Function writes with the service role. (Admins can see ip_hash; it is a one-way hash.)
notify pgrst, 'reload schema';
select column_name from information_schema.columns where table_schema = 'public' and table_name = 'bookings' and column_name in ('ip_hash','email_attempts','whatsapp_attempts') order by 1;   -- expect 3 rows

-- ROLLBACK:  alter table public.bookings drop column ip_hash, drop column email_attempts, drop column whatsapp_attempts;   (the function then must not be used)
