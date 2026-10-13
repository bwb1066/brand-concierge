-- Make Conair's concierge products BUYABLE and add the one demo shopper.
-- conair's 100 brand_products rows were ingested for chat only (sku /
-- list_price NULL), so the commerce read path (_shared/commerce.ts
-- searchProducts filters `.not sku is null .not list_price is null`) returned
-- nothing. Backfill deterministic commerce data, mirroring the avkare /
-- eo-concept-3b pattern. Additive + gated to site_key 'conair' — no other
-- tenant is touched.
--
-- B2C retail: single-unit pricing (no volume breaks), list prices invented but
-- stable per product and kept in a realistic band per category.

-- 1. Enable commerce on the existing conair brand_configs row ------------------
update public.brand_configs set
  commerce_enabled = true,
  currency = 'USD',
  facet_hints = '["brand"]'::jsonb
where site_key = 'conair';

-- 2. Backfill the catalog -------------------------------------------------------
with d as (
  select
    id,
    upper((regexp_match(product_page_url, '/([^/?%]+)\.html(?:[?].*)?$'))[1]) as sku,
    coalesce(product_name, '') as nm,
    lower(coalesce(product_name, '') || ' ' || product_page_url) as hay,
    abs(hashtext(product_page_url)) as h,
    -- ~1 in 9 backordered (drives the lead-time demo)
    (abs(hashtext(product_page_url || 'stk')) % 9 = 0) as oos
  from public.brand_products
  where site_key = 'conair'
), c as (
  select d.*,
    case
      when hay ~ 'hair steamer|hair-steamer' then 'Hair Styling'
      when hay ~ 'garment|glidelite|ironing|steam & |steam-%26|steamstylist|power steam|fabric steamer|steaming mitt|fabric shaver|fabric-shaver' then 'Garment Care'
      when hay ~ 'mirror' then 'Lighted Mirrors'
      when hay ~ 'adapter|converter' then 'Travel'
      when hay ~ 'beard|mustache|clipper|haircut|shaver|trimmer|trim system' then 'Grooming'
      when hay ~ 'roller|setter|curler|waver' then 'Hot Rollers & Wavers'
      when hay ~ 'flat iron|flat-iron|straightener' then 'Flat Irons'
      when hay ~ 'hot brush|hot-brush|hot air|hot-air|dryer brush|dryer-brush|thermal brush|thermal-brush|styling wand|styling-wand|brush attachment|brush-attachment' then 'Hot Air Brushes & Stylers'
      when hay ~ 'curling|wand|curl secret|curl-secret' then 'Curling Irons & Wands'
      when hay ~ 'dryer' then 'Hair Dryers'
      else 'Hair Styling'
    end as cat
  from d
)
update public.brand_products bp set
  sku = c.sku,
  category = c.cat,
  currency = 'USD',
  active = true,
  uom = 'each',
  -- price band per category, ending in .99
  list_price = (case c.cat
      when 'Hair Dryers'                then 19 + (c.h % 7) * 10
      when 'Hot Air Brushes & Stylers'  then 29 + (c.h % 6) * 10
      when 'Curling Irons & Wands'      then 19 + (c.h % 5) * 8
      when 'Flat Irons'                 then 24 + (c.h % 5) * 10
      when 'Hot Rollers & Wavers'       then 24 + (c.h % 5) * 8
      when 'Garment Care'               then 19 + (c.h % 6) * 10
      when 'Lighted Mirrors'            then 24 + (c.h % 6) * 10
      when 'Grooming'                   then 19 + (c.h % 6) * 8
      when 'Travel'                     then 14 + (c.h % 3) * 5
      else 19 + (c.h % 5) * 5
    end) + 0.99,
  price_breaks = '[]'::jsonb,
  stock_qty = case when c.oos then 0 else 20 + (abs(hashtext(c.nm || 'qty')) % 480) end,
  lead_time_days = case when c.oos then 5 + (abs(hashtext(c.nm || 'lead')) % 10) else 0 end,
  min_order_qty = 1,
  restricted = false,
  restriction = null,
  specs = coalesce(bp.specs, '{}'::jsonb) || jsonb_build_object(
    'brand', case when c.hay ~ 'infinit[i]?[ -]?pro|infini-pro' then 'InfinitiPRO by Conair'
                  else 'Conair' end
  )
from c
where bp.id = c.id and c.sku is not null;

-- 3. The one signed-in demo shopper: a Conair Rewards Gold member -------------
-- price_book = member pricing (15% off list) on every conair SKU, so logging in
-- from the ?demo panel visibly re-prices cards, the PDP and the cart.
insert into public.commerce_buyers (site_key, email, company, price_book, entitlements)
select
  'conair',
  'jordan.rivera@example.com',
  'Jordan Rivera (Conair Rewards Gold)',
  coalesce(jsonb_object_agg(sku, round(list_price * 0.85, 2)), '{}'::jsonb),
  '{}'
from public.brand_products
where site_key = 'conair' and sku is not null and list_price is not null
on conflict (site_key, email) do update set
  company = excluded.company,
  price_book = excluded.price_book;
