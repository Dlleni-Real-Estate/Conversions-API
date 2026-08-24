-- Facebook Login tokens last ~60 days. Recording when each connection's token
-- dies lets health warn BEFORE the account silently stops syncing. Null means
-- "never" (a system-user token) or "unknown" (a token our app cannot inspect);
-- neither triggers a warning.
alter table public.ad_accounts add column if not exists token_expires_at timestamptz;
