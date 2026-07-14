-- Voice-to-voice support for the brand concierge.
-- Backwards compatible: every existing brand defaults to voice_enabled=false,
-- so no widget shows the mic/voice UI until a brand explicitly opts in.
alter table brand_configs
  add column if not exists voice_enabled boolean not null default false,
  add column if not exists voice text;

comment on column brand_configs.voice_enabled is
  'When true, the widget exposes the voice-mode toggle (mic input + spoken replies).';
comment on column brand_configs.voice is
  'OpenAI TTS voice id for spoken replies (e.g. alloy, echo, shimmer). Null = alloy.';
