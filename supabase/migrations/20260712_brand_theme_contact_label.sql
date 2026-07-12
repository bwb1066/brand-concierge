-- Per-brand theming + configurable contact-pill label
ALTER TABLE brand_configs
  ADD COLUMN IF NOT EXISTS theme JSONB;

ALTER TABLE brand_configs
  ADD COLUMN IF NOT EXISTS contact_label TEXT;
