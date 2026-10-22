-- =====================================================================
-- supabase_quick_fix.sql  --  run ONCE in Supabase > SQL Editor > New query > Run
-- Safe and additive: it creates the admin check and registers your account.
-- It does NOT delete or change any patient rows and does NOT remove any existing policy.
-- (The full lock-down is the second file, supabase_security.sql, STEP 1 and STEP 3.)
-- =====================================================================

-- 1) Who is an admin is kept in the database (the website cannot change it)
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;     -- no policies: not readable or editable through the API
revoke all on public.admins from anon, authenticated;

-- 2) The check the admin page calls
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.admins a where a.user_id = (select auth.uid())) $$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- 3) Register your account (it must exist and be confirmed under Authentication > Users)
insert into public.admins (user_id)
select id from auth.users
 where lower(email) = lower('bavlywageh8@gmail.com') and email_confirmed_at is not null
on conflict do nothing;

-- 4) Let admins read the patient events (adds a rule; removes nothing)
drop policy if exists "admin reads events" on public.clinic_events;
create policy "admin reads events" on public.clinic_events
  for select to authenticated using (public.is_admin());
grant select on public.clinic_events to authenticated;

-- 5) Make the API see the new function right away
notify pgrst, 'reload schema';

-- Expect: admins_registered = 1   (0 means the email is not an existing confirmed user)
select count(*) as admins_registered from public.admins;
