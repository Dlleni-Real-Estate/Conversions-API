-- Which Meta Business each connected ad account belongs to. One Facebook
-- login can manage several Businesses; the name on the row is what keeps
-- two same-named accounts from different Businesses tellable apart.
alter table public.ad_accounts add column if not exists business_id text;
alter table public.ad_accounts add column if not exists business_name text;
