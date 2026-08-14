-- Make brand_products (site_key 'edmund-optics') the single source of truth for
-- the eo-concept-3b demo, so the concierge and the commerce surfaces share one
-- product universe.
--
-- A) Copy the indexed catalog (incl. embeddings) to site_key 'eo-concept-3b' so
--    the concept-3b concierge recommends from the same products that are
--    buyable (previously it had zero indexed products).
-- B) Derive commerce_catalog rows from those products, synthesizing commercial
--    attributes (price, volume breaks, stock, lead time) deterministically from
--    the product URL. The hand-curated 12 SKUs (which carry real specs) are kept
--    via ON CONFLICT DO NOTHING.

-- A) brand_products: edmund-optics -> eo-concept-3b (idempotent) --------------
insert into public.brand_products
  (site_key, product_page_url, product_description, product_name, product_image_url, embedding)
select
  'eo-concept-3b', b.product_page_url, b.product_description, b.product_name, b.product_image_url, b.embedding
from public.brand_products b
where b.site_key = 'edmund-optics'
  and not exists (
    select 1 from public.brand_products e
    where e.site_key = 'eo-concept-3b' and e.product_page_url = b.product_page_url
  );

-- B) commerce_catalog derived from those products ----------------------------
with src as (
  select
    b.product_page_url as url,
    b.product_name as name,
    b.product_description as descr,
    b.product_image_url as img,
    (regexp_match(b.product_page_url, '/(\d+)/?$'))[1] as sku
  from public.brand_products b
  where b.site_key = 'edmund-optics'
),
dedup as (
  select distinct on (sku) url, name, descr, img, sku
  from src
  where sku is not null
  order by sku, url
),
priced as (
  select
    sku, name, descr, img, url,
    round((49 + (abs(hashtext(url)) % 951))::numeric, 2) as list_price,
    case when abs(hashtext(url || 'stk')) % 6 = 0 then 0
         else 5 + (abs(hashtext(url || 'stk')) % 395) end as stock_qty
  from dedup
)
insert into public.commerce_catalog
  (site_key, sku, name, description, category, image_url, product_url,
   list_price, uom, specs, price_breaks, stock_qty, lead_time_days,
   min_order_qty, restricted, active)
select
  'eo-concept-3b',
  p.sku,
  coalesce(p.name, 'Edmund Optics product'),
  coalesce(p.descr, ''),
  null,
  p.img,
  p.url,
  p.list_price,
  'each',
  '{}'::jsonb,
  jsonb_build_array(
    jsonb_build_object('min_qty', 10, 'unit_price', round(p.list_price * 0.90, 2)),
    jsonb_build_object('min_qty', 50, 'unit_price', round(p.list_price * 0.82, 2))
  ),
  p.stock_qty,
  case when p.stock_qty = 0 then 21 + (abs(hashtext(p.url || 'lead')) % 21) else 0 end,
  1,
  false,
  true
from priced p
on conflict (site_key, sku) do nothing;
