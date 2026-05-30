ALTER TABLE brand_configs
  ADD COLUMN IF NOT EXISTS persona text,
  ADD COLUMN IF NOT EXISTS initial_prompt text,
  ADD COLUMN IF NOT EXISTS chat_title text;
