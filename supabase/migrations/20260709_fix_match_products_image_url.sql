-- Fix: 20260532_product_name.sql's rename (from the 20260530 collision fix in
-- 335926e) made it run after 20260531_product_image_url.sql, and its
-- CREATE OR REPLACE omitted product_image_url from the return type — silently
-- dropping it from match_products. Restore the full column set (product_name
-- + product_image_url together) so brand-chat's vector-search path returns
-- images again, not just the direct-table-lookup fallback.
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
  product_image_url   TEXT,
  similarity          FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    bp.product_name,
    bp.product_page_url,
    bp.product_description,
    bp.product_image_url,
    1 - (bp.embedding <=> query_embedding) AS similarity
  FROM brand_products bp
  WHERE bp.site_key  = match_site_key
    AND bp.embedding IS NOT NULL
  ORDER BY bp.embedding <=> query_embedding
  LIMIT match_count;
$$;
