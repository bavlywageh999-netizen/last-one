# Website analytics - setup and verification

## What it does
* `index.html` records anonymous visits: a random visitor id (browser storage), a session id (new after 30 min idle), the page or section
  (`/`, `/#services`, `/#doctor`, `/#reviews`, `/#book-section`, `/#find`, `/#visit`), and the referring site's host. Nothing about patients, logins or bookings.
* It does not count: reloads in the same session, scrolling back to a section, bots, Do Not Track / Global Privacy Control visitors, local previews, `localhost`, or `admin.html`.
* `admin.html` > **Analytics** reads the numbers from the database (one call, computed in Alexandria time). Tracking starts when the new `index.html` is live; nothing is back-filled.

## Apply (about 10 minutes)
1. Make sure `supabase_quick_fix.sql` was already run (it creates `public.is_admin()`; `supabase_analytics.sql` stops with a clear error if not).
2. Supabase > **SQL Editor** > New query > paste all of `supabase_analytics.sql` > **Run**. Expected last result: `site_visits_ready = 0`.
3. Upload the new `index.html` and `admin.html` to GitHub (same names, same place). Wait 1-2 minutes for GitHub Pages.
4. Open your public site once with `?notrack=1` on YOUR devices (e.g. `https://yoursite/?notrack=1`) so your own visits are never counted.

## Verify that real tracking works
1. On a phone using mobile data (not your admin browser), open the public website normally (not a private window with Do Not Track on).
2. Supabase > Table Editor > `site_visits`: you should see a `session_start` and a `page_view` row with path `/`. Scroll to Services and Booking and wait a second: rows for `/#services`, `/#book-section` appear. Reload the page: no new rows.
3. Admin > Analytics > refresh: Total visitors = number of different devices, Page views = rows with `page_view`. Peak/quietest times fill in as hours pass.
4. Anonymous visitors must not be able to read: in Terminal run
   `curl -s "https://YOUR-PROJECT.supabase.co/rest/v1/site_visits?select=*&limit=1" -H "apikey: YOUR_PUBLISHABLE_KEY"` -> expect an error or `[]`, never rows.

## Know the limits
* Anyone who has the public key could still submit fake visit rows (the same is true of any browser analytics). The table only accepts well-formed rows. For stronger protection add a CAPTCHA or an Edge Function with rate limiting later.
* "Quietest time" only counts hours that tracking has fully covered; the card says how many of the 24 hours are tracked so far.
* Optional self-test with synthetic rows and rollback SQL are at the bottom of `supabase_analytics.sql`.
