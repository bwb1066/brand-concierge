-- Commerce harness: multi-tenant catalog + draft-quote carts, scoped by
-- site_key. Additive to brand_configs; production Hugo (site_key
-- 'edmund-optics') is untouched. Tables are prefixed commerce_* to stay clear
-- of the shared public schema. Search is SQL/JSONB (no embeddings) — separate
-- from the vector brand_products table used by the chat.

-- 1. brand_configs commerce columns ---------------------------------------
alter table public.brand_configs
  add column if not exists commerce_enabled boolean not null default false,
  add column if not exists currency text not null default 'USD',
  add column if not exists facet_hints jsonb not null default '[]',
  add column if not exists tool_desc text;

-- 2. catalog --------------------------------------------------------------
create table if not exists public.commerce_catalog (
  id uuid primary key default gen_random_uuid(),
  site_key text not null,
  sku text not null,
  name text not null default '',
  description text not null default '',
  category text,
  image_url text,
  product_url text,
  list_price numeric not null default 0,
  uom text not null default 'each',
  specs jsonb not null default '{}',
  price_breaks jsonb not null default '[]',
  stock_qty integer not null default 0,
  lead_time_days integer not null default 0,
  min_order_qty integer not null default 1,
  restricted boolean not null default false,
  restriction text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_key, sku)
);
create index if not exists idx_commerce_catalog_site
  on public.commerce_catalog (site_key, active);
create index if not exists idx_commerce_catalog_specs
  on public.commerce_catalog using gin (specs);

-- 3. buyers (contract pricing + entitlements) -----------------------------
create table if not exists public.commerce_buyers (
  id uuid primary key default gen_random_uuid(),
  site_key text not null,
  email text not null,
  company text,
  price_book jsonb not null default '{}',
  entitlements text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (site_key, email)
);
create index if not exists idx_commerce_buyers_site
  on public.commerce_buyers (site_key, email);

-- 4. carts (a cart is a draft quote) --------------------------------------
create table if not exists public.commerce_carts (
  id uuid primary key default gen_random_uuid(),
  site_key text not null,
  buyer_id uuid references public.commerce_buyers(id) on delete set null,
  status text not null default 'open',
  source text,
  note text,
  quote_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One open cart per (site_key, buyer) — the Option-1 identity invariant.
create unique index if not exists uq_commerce_open_cart
  on public.commerce_carts (site_key, buyer_id)
  where status = 'open' and buyer_id is not null;
create index if not exists idx_commerce_carts_lookup
  on public.commerce_carts (site_key, buyer_id, status);

-- 5. cart items -----------------------------------------------------------
create table if not exists public.commerce_cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.commerce_carts(id) on delete cascade,
  sku text not null,
  name text,
  image_url text,
  qty integer not null default 1,
  unit_price numeric not null default 0,
  lead_time_days integer not null default 0,
  added_via text,
  created_at timestamptz not null default now(),
  unique (cart_id, sku)
);
create index if not exists idx_commerce_cart_items_cart
  on public.commerce_cart_items (cart_id);

-- updated_at triggers (update_updated_at() defined in 20260410_brand_configs)
create trigger commerce_catalog_updated_at before update on public.commerce_catalog
  for each row execute function public.update_updated_at();
create trigger commerce_carts_updated_at before update on public.commerce_carts
  for each row execute function public.update_updated_at();

-- RLS --------------------------------------------------------------------
alter table public.commerce_catalog enable row level security;
alter table public.commerce_buyers enable row level security;
alter table public.commerce_carts enable row level security;
alter table public.commerce_cart_items enable row level security;

-- Catalog: anon reads active rows; writes via service role.
create policy "read active catalog" on public.commerce_catalog
  for select using (active = true);
create policy "service manage catalog" on public.commerce_catalog
  for all using (auth.role() = 'service_role');

-- Carts/items: anon may READ (the site subscribes via Realtime with the anon
-- key); all writes go through the edge function using the service role.
create policy "read carts" on public.commerce_carts
  for select using (true);
create policy "service manage carts" on public.commerce_carts
  for all using (auth.role() = 'service_role');
create policy "read cart items" on public.commerce_cart_items
  for select using (true);
create policy "service manage cart items" on public.commerce_cart_items
  for all using (auth.role() = 'service_role');

-- Buyers: no anon access (holds price books); service role only.
create policy "service manage buyers" on public.commerce_buyers
  for all using (auth.role() = 'service_role');

-- Realtime: push cart changes to subscribed site tabs (the cross-surface moment)
alter publication supabase_realtime add table public.commerce_carts;
alter publication supabase_realtime add table public.commerce_cart_items;

-- Enable commerce on the eo-concept-3b tenant (does not touch other columns).
insert into public.brand_configs (site_key, brand_name, commerce_enabled, currency, facet_hints)
values (
  'eo-concept-3b', 'Edmund Optics', true, 'USD',
  '["diameter","focal length","coating","wavelength","damage threshold"]'::jsonb
)
on conflict (site_key) do update set
  commerce_enabled = excluded.commerce_enabled,
  currency = excluded.currency,
  facet_hints = excluded.facet_hints;

-- Demo contract buyer (objections: negotiated pricing + restricted entitlement).
insert into public.commerce_buyers (site_key, email, company, price_book, entitlements)
values (
  'eo-concept-3b', 'acme-photonics', 'Acme Photonics (contract account)',
  '{"49278":82.5,"39751":199.0}'::jsonb, '{export-controlled}'
)
on conflict (site_key, email) do nothing;

-- === Catalog seed (generated from edmund-optics/drafts/data/eo-catalog.json) ===
insert into public.commerce_catalog (site_key, sku, name, description, category, image_url, product_url, list_price, uom, specs, price_breaks, stock_qty, lead_time_days, min_order_qty, restricted, restriction) values (
  'eo-concept-3b', '42722', '12.7mm Dia. x 50mm FL, Uncoated, Laser Grade PCX Lens', 'TECHSPEC Laser Grade Plano-Convex (PCX) lens with 10-5 surface quality for Nd:YAG, laser cutting, machining, and welding applications.', 'Laser Optics', '/drafts/images/eo-concept-1a/cat-laser-optics.jpg', '/drafts/pdp', 68.5, 'each', '{"diameter":"12.7 mm","focal length":"50 mm","coating":"Uncoated","wavelength":"N/A","damage threshold":"10 J/cm² @ 1064 nm"}'::jsonb, '[{"min_qty":10,"unit_price":61.65},{"min_qty":50,"unit_price":54.8}]'::jsonb, 340, 0, 1, false, null
) on conflict (site_key, sku) do update set name=excluded.name, description=excluded.description, category=excluded.category, image_url=excluded.image_url, product_url=excluded.product_url, list_price=excluded.list_price, specs=excluded.specs, price_breaks=excluded.price_breaks, stock_qty=excluded.stock_qty, lead_time_days=excluded.lead_time_days, restricted=excluded.restricted, restriction=excluded.restriction;

insert into public.commerce_catalog (site_key, sku, name, description, category, image_url, product_url, list_price, uom, specs, price_breaks, stock_qty, lead_time_days, min_order_qty, restricted, restriction) values (
  'eo-concept-3b', '49278', '25mm Dia. x 50mm FL, VIS 0° Coated, Achromatic Doublet Lens', 'TECHSPEC air-spaced achromatic doublet, VIS 0° AR-coated, color-corrected for high-resolution broadband imaging from 400–700 nm.', 'Optics', '/drafts/images/eo-concept-1a/cat-optics.jpg', '/drafts/pdp', 112, 'each', '{"diameter":"25 mm","focal length":"50 mm","coating":"VIS 0° (400–700 nm)","wavelength":"400–700 nm","damage threshold":"N/A"}'::jsonb, '[{"min_qty":10,"unit_price":100.8},{"min_qty":40,"unit_price":89.6}]'::jsonb, 28, 21, 1, false, null
) on conflict (site_key, sku) do update set name=excluded.name, description=excluded.description, category=excluded.category, image_url=excluded.image_url, product_url=excluded.product_url, list_price=excluded.list_price, specs=excluded.specs, price_breaks=excluded.price_breaks, stock_qty=excluded.stock_qty, lead_time_days=excluded.lead_time_days, restricted=excluded.restricted, restriction=excluded.restriction;

insert into public.commerce_catalog (site_key, sku, name, description, category, image_url, product_url, list_price, uom, specs, price_breaks, stock_qty, lead_time_days, min_order_qty, restricted, restriction) values (
  'eo-concept-3b', '33421', '25mm Dia., 400–700nm, Broadband Dielectric Mirror', 'High-reflectivity broadband dielectric mirror, Ravg > 99% across the visible, ideal for beam steering in imaging and metrology setups.', 'Optics', '/drafts/images/eo-concept-1a/hero-red-lens.jpg', '/drafts/pdp', 84, 'each', '{"diameter":"25 mm","focal length":"N/A","coating":"Broadband dielectric","wavelength":"400–700 nm","damage threshold":"0.25 J/cm² @ 532 nm"}'::jsonb, '[{"min_qty":10,"unit_price":75.6}]'::jsonb, 156, 0, 1, false, null
) on conflict (site_key, sku) do update set name=excluded.name, description=excluded.description, category=excluded.category, image_url=excluded.image_url, product_url=excluded.product_url, list_price=excluded.list_price, specs=excluded.specs, price_breaks=excluded.price_breaks, stock_qty=excluded.stock_qty, lead_time_days=excluded.lead_time_days, restricted=excluded.restricted, restriction=excluded.restriction;

insert into public.commerce_catalog (site_key, sku, name, description, category, image_url, product_url, list_price, uom, specs, price_breaks, stock_qty, lead_time_days, min_order_qty, restricted, restriction) values (
  'eo-concept-3b', '47509', '25mm Dia., 50R/50T, VIS Plate Beamsplitter', 'Broadband plate beamsplitter, 50R/50T for 400–700 nm, minimal transmitted wavefront distortion for interferometry and imaging.', 'Optics', '/drafts/images/eo-concept-1a/hero-array.jpg', '/drafts/pdp', 129, 'each', '{"diameter":"25 mm","focal length":"N/A","coating":"50R/50T beamsplitter","wavelength":"400–700 nm","damage threshold":"N/A"}'::jsonb, '[{"min_qty":10,"unit_price":116.1}]'::jsonb, 62, 0, 1, false, null
) on conflict (site_key, sku) do update set name=excluded.name, description=excluded.description, category=excluded.category, image_url=excluded.image_url, product_url=excluded.product_url, list_price=excluded.list_price, specs=excluded.specs, price_breaks=excluded.price_breaks, stock_qty=excluded.stock_qty, lead_time_days=excluded.lead_time_days, restricted=excluded.restricted, restriction=excluded.restriction;

insert into public.commerce_catalog (site_key, sku, name, description, category, image_url, product_url, list_price, uom, specs, price_breaks, stock_qty, lead_time_days, min_order_qty, restricted, restriction) values (
  'eo-concept-3b', '86112', '532nm CWL, 10nm FWHM, 25mm Dia. Hard-Coated Bandpass Filter', 'TECHSPEC hard-coated bandpass filter with deep out-of-band blocking (OD6) for fluorescence, Raman, and laser-line cleanup.', 'Optics', '/drafts/images/eo-concept-1a/hero-blue.webp', '/drafts/pdp', 195, 'each', '{"diameter":"25 mm","focal length":"N/A","coating":"Hard-coated bandpass","wavelength":"532 nm CWL, 10 nm FWHM","damage threshold":"N/A"}'::jsonb, '[{"min_qty":5,"unit_price":175.5},{"min_qty":25,"unit_price":156}]'::jsonb, 44, 0, 1, false, null
) on conflict (site_key, sku) do update set name=excluded.name, description=excluded.description, category=excluded.category, image_url=excluded.image_url, product_url=excluded.product_url, list_price=excluded.list_price, specs=excluded.specs, price_breaks=excluded.price_breaks, stock_qty=excluded.stock_qty, lead_time_days=excluded.lead_time_days, restricted=excluded.restricted, restriction=excluded.restriction;

insert into public.commerce_catalog (site_key, sku, name, description, category, image_url, product_url, list_price, uom, specs, price_breaks, stock_qty, lead_time_days, min_order_qty, restricted, restriction) values (
  'eo-concept-3b', '58201', '1064nm, 25mm Dia. x 100mm FL, High-Power Nd:YAG Focusing Lens', 'Export-controlled high-damage-threshold focusing lens for high-power 1064 nm Nd:YAG systems. Sold subject to export screening.', 'Laser Optics', '/drafts/images/eo-concept-1a/cat-lasers.jpg', '/drafts/pdp', 420, 'each', '{"diameter":"25 mm","focal length":"100 mm","coating":"1064 nm V-coat","wavelength":"1064 nm","damage threshold":"20 J/cm² @ 1064 nm, 20 ns"}'::jsonb, '[{"min_qty":10,"unit_price":378}]'::jsonb, 12, 35, 1, true, 'EAR export-controlled — requires entitlement screening'
) on conflict (site_key, sku) do update set name=excluded.name, description=excluded.description, category=excluded.category, image_url=excluded.image_url, product_url=excluded.product_url, list_price=excluded.list_price, specs=excluded.specs, price_breaks=excluded.price_breaks, stock_qty=excluded.stock_qty, lead_time_days=excluded.lead_time_days, restricted=excluded.restricted, restriction=excluded.restriction;

insert into public.commerce_catalog (site_key, sku, name, description, category, image_url, product_url, list_price, uom, specs, price_breaks, stock_qty, lead_time_days, min_order_qty, restricted, restriction) values (
  'eo-concept-3b', '39751', '50mm Dia. x 200mm FL, MgF2 Coated, Achromatic Doublet Lens', 'Large-aperture achromatic doublet with single-layer MgF2 AR coating for broadband imaging and beam relay.', 'Optics', '/drafts/images/eo-concept-1a/cat-imaging.jpg', '/drafts/pdp', 268, 'each', '{"diameter":"50 mm","focal length":"200 mm","coating":"MgF2 (400–700 nm)","wavelength":"400–700 nm","damage threshold":"N/A"}'::jsonb, '[{"min_qty":5,"unit_price":241.2},{"min_qty":20,"unit_price":214.4}]'::jsonb, 0, 42, 1, false, null
) on conflict (site_key, sku) do update set name=excluded.name, description=excluded.description, category=excluded.category, image_url=excluded.image_url, product_url=excluded.product_url, list_price=excluded.list_price, specs=excluded.specs, price_breaks=excluded.price_breaks, stock_qty=excluded.stock_qty, lead_time_days=excluded.lead_time_days, restricted=excluded.restricted, restriction=excluded.restriction;

insert into public.commerce_catalog (site_key, sku, name, description, category, image_url, product_url, list_price, uom, specs, price_breaks, stock_qty, lead_time_days, min_order_qty, restricted, restriction) values (
  'eo-concept-3b', '45215', '1" Dia. Ø25.4mm, Right-Angle Prism, Uncoated N-BK7', 'Precision N-BK7 right-angle prism for beam folding and image rotation; 60-40 scratch-dig on all faces.', 'Optics', '/drafts/images/eo-concept-1a/hero-array.jpg', '/drafts/pdp', 57, 'each', '{"diameter":"25.4 mm","focal length":"N/A","coating":"Uncoated N-BK7","wavelength":"N/A","damage threshold":"N/A"}'::jsonb, '[{"min_qty":10,"unit_price":51.3},{"min_qty":50,"unit_price":45.6}]'::jsonb, 210, 0, 1, false, null
) on conflict (site_key, sku) do update set name=excluded.name, description=excluded.description, category=excluded.category, image_url=excluded.image_url, product_url=excluded.product_url, list_price=excluded.list_price, specs=excluded.specs, price_breaks=excluded.price_breaks, stock_qty=excluded.stock_qty, lead_time_days=excluded.lead_time_days, restricted=excluded.restricted, restriction=excluded.restriction;

insert into public.commerce_catalog (site_key, sku, name, description, category, image_url, product_url, list_price, uom, specs, price_breaks, stock_qty, lead_time_days, min_order_qty, restricted, restriction) values (
  'eo-concept-3b', '71833', 'Ø25mm, 0.65 NA, Plan Achromat Microscope Objective 40X', 'Infinity-corrected 40X plan achromat objective with flat field for brightfield microscopy and machine vision.', 'Microscopy', '/drafts/images/eo-concept-1a/cat-microscopy.jpg', '/drafts/pdp', 349, 'each', '{"diameter":"25 mm","focal length":"N/A","coating":"Broadband AR","wavelength":"Visible","damage threshold":"N/A"}'::jsonb, '[{"min_qty":5,"unit_price":314.1}]'::jsonb, 19, 14, 1, false, null
) on conflict (site_key, sku) do update set name=excluded.name, description=excluded.description, category=excluded.category, image_url=excluded.image_url, product_url=excluded.product_url, list_price=excluded.list_price, specs=excluded.specs, price_breaks=excluded.price_breaks, stock_qty=excluded.stock_qty, lead_time_days=excluded.lead_time_days, restricted=excluded.restricted, restriction=excluded.restriction;

insert into public.commerce_catalog (site_key, sku, name, description, category, image_url, product_url, list_price, uom, specs, price_breaks, stock_qty, lead_time_days, min_order_qty, restricted, restriction) values (
  'eo-concept-3b', '60427', 'Ø25.4mm, Ø200mm FL, UV Fused Silica PCX Lens, Uncoated', 'UV-grade fused silica plano-convex lens for deep-UV through NIR transmission and high laser damage resistance.', 'Laser Optics', '/drafts/images/eo-concept-1a/cat-laser-optics.jpg', '/drafts/pdp', 96, 'each', '{"diameter":"25.4 mm","focal length":"200 mm","coating":"Uncoated UVFS","wavelength":"185–2100 nm","damage threshold":"15 J/cm² @ 1064 nm"}'::jsonb, '[{"min_qty":10,"unit_price":86.4},{"min_qty":50,"unit_price":76.8}]'::jsonb, 88, 0, 1, false, null
) on conflict (site_key, sku) do update set name=excluded.name, description=excluded.description, category=excluded.category, image_url=excluded.image_url, product_url=excluded.product_url, list_price=excluded.list_price, specs=excluded.specs, price_breaks=excluded.price_breaks, stock_qty=excluded.stock_qty, lead_time_days=excluded.lead_time_days, restricted=excluded.restricted, restriction=excluded.restriction;

insert into public.commerce_catalog (site_key, sku, name, description, category, image_url, product_url, list_price, uom, specs, price_breaks, stock_qty, lead_time_days, min_order_qty, restricted, restriction) values (
  'eo-concept-3b', '52940', 'USAF 1951 Resolution Test Target, 2" x 2", Positive', 'Chrome-on-glass USAF 1951 positive resolution target for characterizing imaging system MTF and alignment.', 'Test Targets', '/drafts/images/eo-concept-1a/cat-testtargets.jpg', '/drafts/pdp', 205, 'each', '{"diameter":"50.8 x 50.8 mm","focal length":"N/A","coating":"Chrome-on-glass","wavelength":"N/A","damage threshold":"N/A"}'::jsonb, '[{"min_qty":5,"unit_price":184.5}]'::jsonb, 33, 0, 1, false, null
) on conflict (site_key, sku) do update set name=excluded.name, description=excluded.description, category=excluded.category, image_url=excluded.image_url, product_url=excluded.product_url, list_price=excluded.list_price, specs=excluded.specs, price_breaks=excluded.price_breaks, stock_qty=excluded.stock_qty, lead_time_days=excluded.lead_time_days, restricted=excluded.restricted, restriction=excluded.restriction;

insert into public.commerce_catalog (site_key, sku, name, description, category, image_url, product_url, list_price, uom, specs, price_breaks, stock_qty, lead_time_days, min_order_qty, restricted, restriction) values (
  'eo-concept-3b', '38119', 'Ø1" Broadband Polarizing Cube Beamsplitter, 420–680nm', 'High-extinction polarizing beamsplitter cube (Tp:Ts > 1000:1) for visible-band polarization control and analysis.', 'Optics', '/drafts/images/eo-concept-1a/hero-blue.webp', '/drafts/pdp', 178, 'each', '{"diameter":"25.4 mm","focal length":"N/A","coating":"Polarizing beamsplitter","wavelength":"420–680 nm","damage threshold":"N/A"}'::jsonb, '[{"min_qty":10,"unit_price":160.2}]'::jsonb, 41, 0, 1, false, null
) on conflict (site_key, sku) do update set name=excluded.name, description=excluded.description, category=excluded.category, image_url=excluded.image_url, product_url=excluded.product_url, list_price=excluded.list_price, specs=excluded.specs, price_breaks=excluded.price_breaks, stock_qty=excluded.stock_qty, lead_time_days=excluded.lead_time_days, restricted=excluded.restricted, restriction=excluded.restriction;

