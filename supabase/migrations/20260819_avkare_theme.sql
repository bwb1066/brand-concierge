-- AvKARE (B2B) concierge theme. Navy primary (#12417c) for contact / send
-- actions, with a yellow add-to-quote CTA that flips to green "Added" — the
-- same commerce CTA styling as the on-site AvKARE product surfaces.
--
-- Merged into the existing theme JSONB with `||` so any other theme keys on the
-- row are preserved. These same fields are editable in the Brand Chat Studio
-- theme editor (Edit — AvKARE), so this migration just codifies those values.
update public.brand_configs
set theme = coalesce(theme, '{}'::jsonb) || jsonb_build_object(
  'font',         'Poppins, sans-serif',
  'dialogRadius', '12px',
  'primary',      '#12417c',
  'primaryHover', '#0c2d56',
  'onPrimary',    '#ffffff',
  'link',         '#12417c',
  'userBg',       '#f5f5f5',
  'userInk',      '#242727',
  'cta',          '#ffcd00',
  'ctaInk',       '#131313',
  'ctaAdded',     '#1a7f37',
  'ctaAddedInk',  '#ffffff'
)
where site_key = 'avkare';
