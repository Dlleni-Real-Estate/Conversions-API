-- The wording of each lead form.
--
-- The lead payload from Meta carries machine keys, not the text the customer
-- actually read: payment_method = "still_exploring", never "تحب تدفع إزاي؟" /
-- "لسه بستكشف وبسأل". That wording exists only on the form definition, so we
-- store it separately and use it purely for display.
--
-- raw_fields keeps the keys on purpose: keys are stable, so analytics can group
-- by them even if the Arabic wording is edited later.
--
-- Already applied to project yrmgwbufaaiaioqvabon.

create table if not exists public.lead_forms (
  form_id    text primary key,
  name       text,
  locale     text,
  questions  jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.lead_forms enable row level security;
