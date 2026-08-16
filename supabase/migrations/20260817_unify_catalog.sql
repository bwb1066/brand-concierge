-- Unify product data onto brand_products as the SINGLE SOURCE OF TRUTH for all
-- surfaces (concierge + on-site commerce + MCP).
--
-- SAFETY: purely additive + gated. Only new columns are added (with defaults),
-- match_products is NOT touched, and only eo-concept-3b rows are backfilled — so
-- every existing brand chat instance is unaffected.

-- 1. Additive commerce columns on brand_products -----------------------------
alter table public.brand_products
  add column if not exists sku text,
  add column if not exists category text,
  add column if not exists list_price numeric,
  add column if not exists currency text,
  add column if not exists uom text not null default 'each',
  add column if not exists specs jsonb not null default '{}',
  add column if not exists price_breaks jsonb not null default '[]',
  add column if not exists stock_qty integer not null default 0,
  add column if not exists lead_time_days integer not null default 0,
  add column if not exists min_order_qty integer not null default 1,
  add column if not exists restricted boolean not null default false,
  add column if not exists restriction text,
  add column if not exists active boolean not null default true;

-- Non-unique (a copied slice may repeat a URL id); commerce getProduct limit(1).
create index if not exists idx_brand_products_sku
  on public.brand_products (site_key, sku);

-- 2. Backfill eo-concept-3b's real products into buyable products -------------
-- SKU parsed from the product URL, category bucketed from the name, list price
-- invented deterministically (USD), with volume breaks + synthetic stock/lead.
with derived as (
  select id,
    product_page_url as url,
    product_name as nm,
    (regexp_match(product_page_url, '/(\d+)/?$'))[1] as sku,
    round((49 + (abs(hashtext(product_page_url)) % 951))::numeric, 2) as lp,
    (abs(hashtext(product_page_url || 'stk')) % 6 = 0) as oos
  from public.brand_products
  where site_key = 'eo-concept-3b'
)
update public.brand_products bp set
  sku = d.sku,
  currency = 'USD',
  restricted = false,
  restriction = null,
  active = true,
  list_price = d.lp,
  price_breaks = jsonb_build_array(
    jsonb_build_object('min_qty', 10, 'unit_price', round(d.lp * 0.90, 2)),
    jsonb_build_object('min_qty', 50, 'unit_price', round(d.lp * 0.82, 2))
  ),
  stock_qty = case when d.oos then 0 else 5 + (abs(hashtext(d.url || 'stk')) % 395) end,
  lead_time_days = case when d.oos then 21 + (abs(hashtext(d.url || 'lead')) % 21) else 0 end,
  category = case
    when d.nm ilike '%beamsplitter%' or d.nm ilike '%doublet%' or d.nm ilike '%prism%'
      or d.nm ilike '%mirror%' or d.nm ilike '%window%' or d.nm ilike '%polariz%'
      or d.nm ilike '%waveplate%' or d.nm ilike '%aspher%' then 'Optics'
    when d.nm ilike '%filter%' then 'Optics'
    when d.nm ilike '%objective%' or d.nm ilike '%microscop%' or d.nm ilike '%eyepiece%' then 'Microscopy'
    when d.nm ilike '%camera%' or d.nm ilike '%sensor%' then 'Cameras'
    when d.nm ilike '%laser%' then 'Laser Optics'
    when d.nm ilike '%target%' then 'Test Targets'
    when d.nm ilike '%zoom%' or d.nm ilike '%c-mount%' or d.nm ilike '%fixed focal%' then 'Imaging Lenses'
    when d.nm ilike '%mount%' or d.nm ilike '%stage%' or d.nm ilike '%holder%'
      or d.nm ilike '%ring%' or d.nm ilike '%rail%' or d.nm ilike '%post%'
      or d.nm ilike '%adapter%' or d.nm ilike '%barrel%' then 'Optomechanics'
    when d.nm ilike '%light%' or d.nm ilike '%illuminat%' or d.nm ilike '% led%' then 'Lights and Illumination'
    else 'Optics'
  end
from derived d
where bp.id = d.id and d.sku is not null;

-- 3. Bring the hand-curated (rich-spec) products into brand_products too, so the
-- Featured grid keeps working from the single table. embedding NULL = buyable
-- but not semantically indexed (the 427 cover concierge recall). Preserves the
-- one export-controlled demo SKU (58201) for the restricted-entitlement demo.
insert into public.brand_products
  (site_key, product_name, product_page_url, product_description, product_image_url,
   embedding, sku, category, list_price, currency, uom, specs, price_breaks,
   stock_qty, lead_time_days, min_order_qty, restricted, restriction, active)
select cc.site_key, cc.name, cc.product_url, cc.description, cc.image_url,
   null, cc.sku, cc.category, cc.list_price, 'USD', cc.uom, cc.specs, cc.price_breaks,
   cc.stock_qty, cc.lead_time_days, cc.min_order_qty, cc.restricted, cc.restriction, cc.active
from public.commerce_catalog cc
where cc.site_key = 'eo-concept-3b' and cc.product_url = '/drafts/pdp'
  and not exists (
    select 1 from public.brand_products b
    where b.site_key = 'eo-concept-3b' and b.sku = cc.sku
  );
