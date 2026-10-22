-- =====================================================================
-- supabase_bookings.sql  --  ADDITIVE migration: creates the bookings table used by the
-- submit-booking Edge Function and the Admin dashboard. It does not touch clinic_events,
-- does not delete anything, and can be rolled back by dropping the table (see bottom).
-- Run AFTER supabase_quick_fix.sql (it needs public.is_admin()).  Not executed by Claude: review, then run once.
-- =====================================================================

-- Safety check: stops with a clear error if the admin check from supabase_quick_fix.sql is missing.
do $$ begin
  if to_regprocedure('public.is_admin()') is null then
    raise exception 'public.is_admin() is missing - run supabase_quick_fix.sql first';
  end if;
end $$;

create table if not exists public.bookings (
  id            uuid primary key,                         -- created by the website; the same id on a retry can never create a second booking
  ref           text not null unique,                     -- human booking reference, e.g. TF-7K2M9Q
  created_at    timestamptz not null default now(),
  name          text not null check (char_length(name)  between 3 and 100),
  email         text not null check (char_length(email) between 3 and 254),
  phone         text not null check (char_length(phone) between 6 and 40),
  service       text not null check (char_length(service) between 2 and 80),
  req_date      date not null,
  req_time      text not null check (char_length(req_time) between 4 and 10),
  notes         text check (notes is null or char_length(notes) <= 500),
  lang          text not null default 'en' check (lang in ('en','ar')),
  -- what the CLINIC has done with the request (a submission is only "requested")
  status        text not null default 'requested' check (status in ('requested','confirmed','cancelled','completed')),
  status_changed_at timestamptz,
  -- what the notification providers did (accepted = the provider took the message; not proof of delivery)
  email_status     text not null default 'pending' check (email_status    in ('pending','sending','accepted','failed','not_configured')),
  email_error      text, email_at timestamptz,
  whatsapp_status  text not null default 'pending' check (whatsapp_status in ('pending','sending','accepted','failed','not_configured')),
  whatsapp_error   text, whatsapp_at timestamptz
);
create index if not exists bookings_created_idx on public.bookings (created_at desc);
create index if not exists bookings_email_idx   on public.bookings (email, created_at desc);

alter table public.bookings enable row level security;
revoke all on public.bookings from anon, authenticated;
grant select, insert, update on public.bookings to service_role;

-- Visitors and ordinary logged-in users: NO access at all (no policy, no grant).
-- Only the Edge Function inserts rows (it uses the service role, which the website never has).
-- Admins (public.admins) may read every booking and change ONLY its status.
grant select on public.bookings to authenticated;
grant update (status, status_changed_at) on public.bookings to authenticated;

drop policy if exists "admin reads bookings"   on public.bookings;
drop policy if exists "admin updates bookings" on public.bookings;
create policy "admin reads bookings"   on public.bookings for select to authenticated using (public.is_admin());
create policy "admin updates bookings" on public.bookings for update to authenticated using (public.is_admin()) with check (public.is_admin());
-- No INSERT or DELETE policy exists for any API role: bookings are never deleted, they are marked 'cancelled'.

notify pgrst, 'reload schema';
select count(*) as bookings_table_ready from public.bookings;

-- ROLLBACK (only if you must; the table is new, so nothing else depends on it):
--   drop table public.bookings;
-- Optional: let the dashboard receive bookings instantly instead of every 30 seconds
--   alter publication supabase_realtime add table public.bookings;   -- needs the Realtime client; the page uses polling by default
