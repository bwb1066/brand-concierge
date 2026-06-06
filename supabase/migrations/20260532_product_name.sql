-- Add product_name column to brand_products
ALTER TABLE brand_products
  ADD COLUMN IF NOT EXISTS product_name TEXT;

-- Drop and recreate because return type changed (product_name added)
DROP FUNCTION IF EXISTS match_products(vector, text, integer);
CREATE OR REPLACE FUNCTION match_products(
  query_embedding  VECTOR(1536),
  match_site_key   TEXT,
  match_count      INT DEFAULT 5
)
RETURNS TABLE (
  product_name        TEXT,
  product_page_url    TEXT,
  product_description TEXT,
  similarity          FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    bp.product_name,
    bp.product_page_url,
    bp.product_description,
    1 - (bp.embedding <=> query_embedding) AS similarity
  FROM brand_products bp
  WHERE bp.site_key  = match_site_key
    AND bp.embedding IS NOT NULL
  ORDER BY bp.embedding <=> query_embedding
  LIMIT match_count;
$$;
