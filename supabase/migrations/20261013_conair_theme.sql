-- Conair concierge: commerce settings + widget theme, matched to the
-- bwb1066/conair site (Figtree, black pill buttons that hover to Conair
-- purple, purple accents, cream/lilac surfaces). Gated to site_key 'conair';
-- theme merged with `||` so any other theme keys are preserved. These are the
-- same fields as the Brand Chat Studio commerce + Widget Theme editor.
update public.brand_configs set
  commerce_enabled = true,
  currency = 'USD',
  -- Facets must be keys of brand_products.specs (filters match on specs);
  -- conair rows carry `brand` (Conair / InfinitiPRO by Conair).
  facet_hints = '["brand"]'::jsonb,
  tool_desc = 'Search, price-check and add to cart from Conair''s consumer catalog: hair dryers, '
    || 'hot air brushes and stylers, curling irons and wands, flat irons, hot rollers and wavers, '
    || 'garment steamers and irons, lighted makeup mirrors, men''s and women''s grooming '
    || '(trimmers, clippers, shavers, haircut kits) and travel adapters. Brands: Conair and '
    || 'InfinitiPRO by Conair. Single-unit retail prices in USD; filter by brand or search by '
    || 'product type, feature (ionic, tourmaline, infrared, cordless) or model number.',
  theme = coalesce(theme, '{}'::jsonb) || jsonb_build_object(
    'font',         'figtree, "Figtree Fallback", Arial, sans-serif',
    'dialogRadius', '16px',
    'primary',      '#1a1816',
    'primaryHover', '#9b4fd8',
    'onPrimary',    '#ffffff',
    'link',         '#843ccb',
    'userBg',       '#f4edfb',
    'userInk',      '#1a1816',
    'cta',          '#ba78ed',
    'ctaInk',       '#1a1816',
    'ctaAdded',     '#1a7f37',
    'ctaAddedInk',  '#ffffff'
  )
where site_key = 'conair';
