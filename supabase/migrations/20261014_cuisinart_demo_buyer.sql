-- Cuisinart AEP demo: one signed-in shopper (Sam Patel, Cuisinart member).
-- price_book = member pricing (15% off list) on every cuisinart SKU, so logging
-- in from the ?demo panel visibly re-prices cards, the PDP and the cart.
insert into public.commerce_buyers (site_key, email, company, price_book, entitlements)
select
  'cuisinart',
  'sam.patel@example.com',
  'Sam Patel (Cuisinart Member)',
  coalesce(jsonb_object_agg(sku, round(list_price * 0.85, 2)), '{}'::jsonb),
  '{}'
from public.brand_products
where site_key = 'cuisinart' and sku is not null and list_price is not null
on conflict (site_key, email) do update set
  company = excluded.company,
  price_book = excluded.price_book;
