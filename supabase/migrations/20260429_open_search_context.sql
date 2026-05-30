alter table public.brand_configs
  add column if not exists open_search_context text;
