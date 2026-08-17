-- Make AvKARE's concierge products BUYABLE. avkare's brand_products rows were
-- ingested for chat only (sku / list_price NULL), so the commerce read path
-- (_shared/commerce.ts searchProducts filters `.not sku is null .not list_price
-- is null`) returned nothing. Backfill invented but deterministic commerce data
-- so every avkare product renders as a buyable card. Mirrors the eo-concept-3b
-- unify backfill pattern; additive + gated to site_key 'avkare'.
--
-- commerce_catalog is deprecated (brand_products is the single source of truth),
-- so drop the redundant avkare rows the earlier seed wrote there.
delete from public.commerce_catalog where site_key = 'avkare';

with d as (
  select
    id,
    coalesce(product_name, id::text) as nm,
    row_number() over (order by id) as rn,
    -- generics: $3.00–$85.00 list, deterministic from the name
    round((3 + (abs(hashtext(coalesce(product_name, id::text))) % 8200) / 100.0)::numeric, 2) as lp,
    -- ~1 in 7 out of stock (drives the lead-time demo)
    (abs(hashtext(coalesce(product_name, '') || 'stk')) % 7 = 0) as oos,
    -- ~1 in 18 is a controlled substance (drives the entitlement-gating demo)
    (abs(hashtext(coalesce(product_name, '') || 'rx')) % 18 = 0) as ctrl
  from public.brand_products
  where site_key = 'avkare'
)
update public.brand_products bp set
  sku = 'AV-' || lpad(d.rn::text, 5, '0'),
  currency = 'USD',
  active = true,
  uom = (array['bottle', 'bottle', 'carton', 'case'])[1 + abs(hashtext(d.nm || 'uom')) % 4],
  list_price = d.lp,
  price_breaks = jsonb_build_array(
    jsonb_build_object('min_qty', 24, 'unit_price', round(d.lp * 0.90, 2)),
    jsonb_build_object('min_qty', 144, 'unit_price', round(d.lp * 0.80, 2))
  ),
  stock_qty = case when d.oos then 0 else 100 + (abs(hashtext(d.nm || 'qty')) % 9000) end,
  lead_time_days = case when d.oos then 3 + (abs(hashtext(d.nm || 'lead')) % 19) else 0 end,
  min_order_qty = 1,
  restricted = d.ctrl,
  restriction = case when d.ctrl
    then 'Controlled substance — requires a valid DEA account and controlled-substance entitlement'
    else null end,
  category = case
    when bp.product_name ilike '%amoxicill%' or bp.product_name ilike '%cephalexin%'
      or bp.product_name ilike '%azithromy%' or bp.product_name ilike '%doxycyclin%'
      or bp.product_name ilike '%penicillin%' or bp.product_name ilike '%antibiotic%' then 'Anti-Infectives'
    when bp.product_name ilike '%ibuprofen%' or bp.product_name ilike '%acetaminophen%'
      or bp.product_name ilike '%naproxen%' or bp.product_name ilike '%aspirin%'
      or bp.product_name ilike '%analgesic%' or bp.product_name ilike '%pain%' then 'Analgesics'
    when bp.product_name ilike '%lisinopril%' or bp.product_name ilike '%atorvastat%'
      or bp.product_name ilike '%losartan%' or bp.product_name ilike '%amlodipine%'
      or bp.product_name ilike '%metoprolol%' or bp.product_name ilike '%statin%' then 'Cardiovascular'
    when bp.product_name ilike '%metformin%' or bp.product_name ilike '%insulin%'
      or bp.product_name ilike '%glipizide%' or bp.product_name ilike '%prednison%'
      or bp.product_name ilike '%levothyrox%' then 'Endocrine / Metabolic'
    when bp.product_name ilike '%omeprazole%' or bp.product_name ilike '%pantoprazole%'
      or bp.product_name ilike '%ranitidine%' or bp.product_name ilike '%famotidine%' then 'Gastrointestinal'
    when bp.product_name ilike '%sertraline%' or bp.product_name ilike '%fluoxetine%'
      or bp.product_name ilike '%alprazolam%' or bp.product_name ilike '%diazepam%'
      or bp.product_name ilike '%lorazepam%' or bp.product_name ilike '%gabapentin%' then 'CNS / Mental Health'
    when bp.product_name ilike '%albuterol%' or bp.product_name ilike '%montelukast%'
      or bp.product_name ilike '%fluticasone%' or bp.product_name ilike '%inhal%' then 'Respiratory'
    else 'Pharmaceuticals'
  end,
  specs = coalesce(bp.specs, '{}'::jsonb) || jsonb_build_object(
    'form', (array['Tablet', 'Capsule', 'Oral Solution', 'Injectable', 'Topical'])[1 + abs(hashtext(d.nm || 'form')) % 5],
    'pack size', (array['30 count', '60 count', '90 count', '100 count', '500 count'])[1 + abs(hashtext(d.nm || 'pack')) % 5],
    'NDC', lpad((abs(hashtext(d.nm || 'n1')) % 100000)::text, 5, '0')
      || '-' || lpad((abs(hashtext(d.nm || 'n2')) % 10000)::text, 4, '0')
      || '-' || lpad((abs(hashtext(d.nm || 'n3')) % 100)::text, 2, '0')
  )
from d
where bp.id = d.id;
