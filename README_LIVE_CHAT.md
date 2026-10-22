# Live chat setup
The included HTML files add the visitor widget and an admin Messages tab. `supabase_livechat.sql` creates private tables. The UI intentionally fails closed until secure Supabase Edge Functions are configured. See `LIVE_CHAT_NEXT_STEPS.txt`. Never expose the service-role key or create permissive public RLS policies.
