-- Enable pgvector (may already be on; CREATE EXTENSION is idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- New columns on brand_configs — all have defaults so existing rows are unaffected
ALTER TABLE brand_configs
  ADD COLUMN IF NOT EXISTS audience_type              TEXT    NOT NULL DEFAULT 'b2c',
  ADD COLUMN IF NOT EXISTS product_advisory_context  TEXT,
  ADD COLUMN IF NOT EXISTS product_advisory_rules    TEXT,
  ADD COLUMN IF NOT EXISTS product_advisory_keywords TEXT,
  ADD COLUMN IF NOT EXISTS brand_expression          JSONB   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS response_length           TEXT    NOT NULL DEFAULT 'moderate';

-- disable_citations was added in a prior migration; ensure it's present
ALTER TABLE brand_configs
  ADD COLUMN IF NOT EXISTS disable_citations BOOLEAN NOT NULL DEFAULT false;

-- Product catalog table
CREATE TABLE IF NOT EXISTS brand_products (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_key            TEXT   NOT NULL,
  product_page_url    TEXT   NOT NULL,
  product_description TEXT   NOT NULL,
  embedding           VECTOR(1536),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT fk_brand_products_site_key
    FOREIGN KEY (site_key) REFERENCES brand_configs(site_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS brand_products_site_key_idx ON brand_products(site_key);
-- Uncomment when catalog grows beyond ~500 rows for faster ANN search:
-- CREATE INDEX brand_products_embedding_idx ON brand_products USING hnsw (embedding vector_cosine_ops);

ALTER TABLE brand_products ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'brand_products' AND policyname = 'anon can read brand_products'
  ) THEN
    CREATE POLICY "anon can read brand_products" ON brand_products FOR SELECT TO anon USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'brand_products' AND policyname = 'service role can write brand_products'
  ) THEN
    CREATE POLICY "service role can write brand_products" ON brand_products FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Cosine similarity search function used by brand-chat
DROP FUNCTION IF EXISTS match_products(VECTOR(1536), TEXT, INT);
CREATE OR REPLACE FUNCTION match_products(
  query_embedding  VECTOR(1536),
  match_site_key   TEXT,
  match_count      INT DEFAULT 5
)
RETURNS TABLE (
  product_page_url    TEXT,
  product_description TEXT,
  similarity          FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    bp.product_page_url,
    bp.product_description,
    1 - (bp.embedding <=> query_embedding) AS similarity
  FROM brand_products bp
  WHERE bp.site_key  = match_site_key
    AND bp.embedding IS NOT NULL
  ORDER BY bp.embedding <=> query_embedding
  LIMIT match_count;
$$;
