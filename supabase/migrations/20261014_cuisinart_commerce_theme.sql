-- Cuisinart concierge ("Hollis"): commerce settings + widget theme, matched to
-- the bwb1066/cuisinart site (Work Sans + Gelica, Cuisinart green #233C28,
-- yellow #FFC31A CTAs with green ink, cream user bubbles). Gated to
-- site_key 'cuisinart'; theme merged with `||` so other theme keys survive.
-- The catalog itself is loaded through the brand-products edge function
-- (it writes the embeddings), not here.
update public.brand_configs set
  commerce_enabled = true,
  currency = 'USD',
  contact_url = coalesce(contact_url, 'https://www.cuisinart.com/support/product-assistance.html'),
  -- Facets must be keys of brand_products.specs; cuisinart rows carry
  -- `department` (Appliances, Cookware, Cutlery, Bakeware, Kitchen Tools &
  -- Gadgets, Outdoors).
  facet_hints = '["department"]'::jsonb,
  tool_desc = 'Search, price-check and add to cart from Cuisinart''s catalog: coffee makers, '
    || 'espresso and grind & brew, air fryers and toaster ovens, Griddlers and indoor grills, '
    || 'slow and rice cookers, food processors, blenders, stand and hand mixers, ice cream makers, '
    || 'toasters and waffle makers, cookware sets, skillets, saucepans and stock pots, cutlery and '
    || 'knife blocks, bakeware, kitchen tools and outdoor grilling. Single-unit retail prices in USD; '
    || 'filter by department or search by product type, feature or model number (e.g. DCC-3200NAS).',
  theme = coalesce(theme, '{}'::jsonb) || jsonb_build_object(
    'font',         '"Work Sans", "Work Sans Fallback", Arial, sans-serif',
    'dialogRadius', '8px',
    'primary',      '#233c28',
    'primaryHover', '#45754e',
    'onPrimary',    '#ffffff',
    'link',         '#233c28',
    'userBg',       '#fffaee',
    'userInk',      '#1a1816',
    'cta',          '#ffc31a',
    'ctaInk',       '#233c28',
    'ctaAdded',     '#1a7f37',
    'ctaAddedInk',  '#ffffff'
  )
where site_key = 'cuisinart';
