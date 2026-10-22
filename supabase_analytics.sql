-- =====================================================================
-- supabase_analytics.sql  --  ADDITIVE migration for real website analytics (anonymous visits).
-- Creates public.site_visits + public.analytics_overview(). Touches no existing table, deletes nothing.
-- Run AFTER supabase_quick_fix.sql (needs public.is_admin()). Not executed by Claude: review, then run once.
-- Tracking starts when the updated index.html is live; no historical data is invented.
-- =====================================================================

do $$ begin
  if to_regprocedure('public.is_admin()') is null then
    raise exception 'public.is_admin() is missing - run supabase_quick_fix.sql first';
  end if;
end $$;

create table if not exists public.site_visits (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),         -- server time: visitors cannot choose or fake it
  visitor_id  text not null check (char_length(visitor_id) between 16 and 64),   -- random id kept in the visitor's browser; not linked to any person
  session_id  text not null check (char_length(session_id) between 16 and 64),   -- new after 30 minutes of inactivity
  event_type  text not null check (event_type in ('page_view','session_start')),
  path        text not null check (char_length(path) between 1 and 120 and path ~ '^/[A-Za-z0-9/_#.~-]*$'),
  referrer    text check (referrer is null or (char_length(referrer) <= 200 and referrer !~ '[[:cntrl:]]'))   -- referring site host only
);
create index if not exists site_visits_created_idx      on public.site_visits (created_at desc);
create index if not exists site_visits_visitor_idx      on public.site_visits (visitor_id, created_at desc);
create index if not exists site_visits_path_idx         on public.site_visits (path, created_at desc);
create index if not exists site_visits_type_created_idx on public.site_visits (event_type, created_at desc);

alter table public.site_visits enable row level security;
revoke all on public.site_visits from anon, authenticated;
-- Visitors may ONLY add rows, and only these five columns (id and created_at are filled in by the database).
grant insert (visitor_id, session_id, event_type, path, referrer) on public.site_visits to anon, authenticated;
grant select on public.site_visits to authenticated;      -- rows are still hidden by the policy below unless the user is an admin

drop policy if exists "visitors add visits" on public.site_visits;
drop policy if exists "admin reads visits"  on public.site_visits;
create policy "visitors add visits" on public.site_visits
  for insert to anon, authenticated
  with check (event_type in ('page_view','session_start') and char_length(path) <= 120);
create policy "admin reads visits" on public.site_visits
  for select to authenticated using (public.is_admin());
-- No UPDATE or DELETE policy exists: nobody can change or erase analytics through the API.

-- One call returns everything the dashboard needs, computed in Alexandria time. It re-checks the admin
-- itself and runs with the caller's own rights, so row-level security also applies.
create or replace function public.analytics_overview(
  p_from timestamptz, p_to timestamptz, p_prev_from timestamptz, p_prev_to timestamptz, p_bucket text default 'day')
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare tz constant text := 'Africa/Cairo';
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_bucket not in ('hour','day') or p_to <= p_from or p_prev_to <= p_prev_from or p_to - p_from > interval '400 days' then
    raise exception 'invalid range' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'tz', tz,
    'first_event', (select min(created_at) from public.site_visits),
    'totals', (select jsonb_build_object('visitors', count(distinct visitor_id), 'page_views', count(*), 'sessions', count(distinct session_id))
                 from public.site_visits where event_type = 'page_view' and created_at >= p_from and created_at < p_to),
    'prev',   (select jsonb_build_object('visitors', count(distinct visitor_id), 'page_views', count(*))
                 from public.site_visits where event_type = 'page_view' and created_at >= p_prev_from and created_at < p_prev_to),
    'series', (select coalesce(jsonb_agg(jsonb_build_object('t', to_char(g.b, 'YYYY-MM-DD"T"HH24:MI'), 'visitors', coalesce(s.v, 0), 'page_views', coalesce(s.p, 0)) order by g.b), '[]'::jsonb)
                 from generate_series(date_trunc(p_bucket, p_from at time zone tz), date_trunc(p_bucket, (p_to - interval '1 second') at time zone tz), ('1 ' || p_bucket)::interval) as g(b)
                 left join (select date_trunc(p_bucket, created_at at time zone tz) as b, count(distinct visitor_id) as v, count(*) as p
                              from public.site_visits where event_type = 'page_view' and created_at >= p_from and created_at < p_to group by 1) s on s.b = g.b),
    'hours',  (select jsonb_agg(jsonb_build_object('hour', h, 'page_views', coalesce(c.p, 0), 'visitors', coalesce(c.v, 0)) order by h)
                 from generate_series(0, 23) as h
                 left join (select extract(hour from created_at at time zone tz)::int as hh, count(*) as p, count(distinct visitor_id) as v
                              from public.site_visits where event_type = 'page_view' and created_at >= p_from and created_at < p_to group by 1) c on c.hh = h),
    'pages',  (select coalesce(jsonb_agg(x order by (x->>'views')::int desc, x->>'path'), '[]'::jsonb)
                 from (select jsonb_build_object('path', path, 'views', count(*), 'visitors', count(distinct visitor_id)) as x
                         from public.site_visits where event_type = 'page_view' and created_at >= p_from and created_at < p_to
                        group by path order by count(*) desc, path limit 10) t)
  );
end $$;
revoke all on function public.analytics_overview(timestamptz, timestamptz, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.analytics_overview(timestamptz, timestamptz, timestamptz, timestamptz, text) to authenticated;

notify pgrst, 'reload schema';
select count(*) as site_visits_ready from public.site_visits;   -- expect 0 right after the first run

-- ---------------------------------------------------------------------
-- OPTIONAL SELF-TEST with synthetic rows (SQL Editor only; run each block separately, then clean up):
--   insert into public.site_visits (created_at, visitor_id, session_id, event_type, path) values
--     ('2026-01-05 10:05+02', 'zz-test-visitor-0000001', 'zz-test-session-0000001', 'page_view', '/'),
--     ('2026-01-05 10:20+02', 'zz-test-visitor-0000001', 'zz-test-session-0000001', 'page_view', '/#services'),
--     ('2026-01-05 21:10+02', 'zz-test-visitor-0000002', 'zz-test-session-0000002', 'page_view', '/');
--   -- run the function as your admin account (replace the uuid with your admin user id from Authentication > Users):
--   begin; set local role authenticated; set local request.jwt.claims = '{"sub":"ADMIN-USER-UUID","role":"authenticated"}';
--   select public.analytics_overview('2026-01-05 00:00+02','2026-01-06 00:00+02','2026-01-04 00:00+02','2026-01-05 00:00+02','day'); rollback;
--   -- expected: totals.visitors = 2, page_views = 3; hours[10].page_views = 2, hours[21].page_views = 1; pages: '/' = 2, '/#services' = 1
--   delete from public.site_visits where visitor_id like 'zz-test-visitor-%';        -- cleanup
-- ROLLBACK of the whole migration (deletes only analytics data):  drop function public.analytics_overview(timestamptz,timestamptz,timestamptz,timestamptz,text);  drop table public.site_visits;
-- Optional retention (manual): delete from public.site_visits where created_at < now() - interval '400 days';
