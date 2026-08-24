-- Ad accounts from OTHER Meta Businesses.
--
-- The environment token belongs to one Business and can only see the assets
-- assigned to it. An ad account that lives in a different Business needs its
-- own token -- one generated in THAT Business, with the account, its Page and
-- its dataset assigned. Stored per row; null means "use the deployment token".
-- Disconnecting the account deletes the row and forgets the token with it.
alter table public.ad_accounts add column if not exists access_token text;
comment on column public.ad_accounts.access_token is
  'Token used for every Meta call about this account. Null = deployment token. Never returned by the API.';
