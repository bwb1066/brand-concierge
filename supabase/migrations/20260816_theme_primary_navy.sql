-- Revert eo-concept-3b theme.primary to navy. It was set to #ffcd00 as a
-- workaround to color the add-to-quote button before that button had its own
-- CTA token (--bc-cta). Now that CTA is separate, primary goes back to navy so
-- the contact / book-now buttons render navy again. Other theme keys untouched.
update public.brand_configs
set theme = coalesce(theme, '{}'::jsonb) || jsonb_build_object('primary', '#1e3a6b')
where site_key = 'eo-concept-3b';
