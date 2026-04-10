-- Brand configs table for multi-tenant brand chat
create table if not exists public.brand_configs (
  id uuid primary key default gen_random_uuid(),
  site_key text unique not null,
  domains text[] not null default '{}',
  brand_name text not null default 'Brand',
  instructions text not null default '',
  vector_store_id text,
  contact_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index for fast lookup by site_key
create index if not exists idx_brand_configs_site_key
  on public.brand_configs (site_key);

-- RLS: anon can read, service role can write
alter table public.brand_configs enable row level security;

create policy "Anyone can read brand configs"
  on public.brand_configs for select
  using (true);

create policy "Service role can manage brand configs"
  on public.brand_configs for all
  using (auth.role() = 'service_role');

-- Auto-update updated_at
create or replace function public.update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger brand_configs_updated_at
  before update on public.brand_configs
  for each row execute function public.update_updated_at();

-- Seed Lord Abbett config
insert into public.brand_configs (site_key, domains, brand_name, contact_url)
values (
  'lordabbett',
  '{lordabbett.com}',
  'Lord Abbett',
  'https://www.lordabbett.com/en-us/financial-advisor/about-us/contact-us.html'
) on conflict (site_key) do nothing;
