-- Give the eo-concept-3b concierge the same commerce CTA styling as the on-site
-- product cards: yellow "Add to quote" (dark text) -> green "Added" (white text).
-- Merged into the existing theme JSONB so other theme keys (navy primary, etc.)
-- are preserved. These are also editable in the Brand Chat Studio theme fields.
update public.brand_configs
set theme = coalesce(theme, '{}'::jsonb) || jsonb_build_object(
  'cta', '#ffcd00',
  'ctaInk', '#131313',
  'ctaAdded', '#1a7f37',
  'ctaAddedInk', '#ffffff'
)
where site_key = 'eo-concept-3b';
