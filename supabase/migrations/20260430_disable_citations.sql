alter table public.brand_configs
  add column if not exists disable_citations boolean not null default false;
