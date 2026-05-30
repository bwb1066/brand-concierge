import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAX_PRODUCTS = 500;
const EMBED_BATCH = 20;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function embedText(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.data[0].embedding;
}

interface Product {
  productName: string;
  productPageUrl: string;
  productDescription: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const url = new URL(req.url);
  const siteKey = url.searchParams.get("site_key");

  if (req.method === "GET") {
    if (!siteKey) return json({ error: "site_key required" }, 400);
    const { data, error, count } = await sb
      .from("brand_products")
      .select("id, product_page_url, product_description, created_at", { count: "exact" })
      .eq("site_key", siteKey)
      .order("id");
    if (error) return json({ error: error.message }, 500);
    return json({ count: count ?? 0, products: data });
  }

  if (req.method === "POST") {
    const body = await req.json();
    const { site_key, products } = body as { site_key: string; products: Product[] };

    if (!site_key) return json({ error: "site_key required" }, 400);
    if (!Array.isArray(products) || products.length === 0) {
      return json({ error: "products must be a non-empty array" }, 400);
    }
    if (products.length > MAX_PRODUCTS) {
      return json({ error: `Maximum ${MAX_PRODUCTS} products per upload` }, 400);
    }
    for (const p of products) {
      if (!p.productName || !p.productPageUrl || !p.productDescription) {
        return json({ error: "Each product needs productName, productPageUrl, and productDescription" }, 400);
      }
    }

    const { error: delErr } = await sb
      .from("brand_products")
      .delete()
      .eq("site_key", site_key);
    if (delErr) return json({ error: delErr.message }, 500);

    let inserted = 0;
    for (let i = 0; i < products.length; i += EMBED_BATCH) {
      const batch = products.slice(i, i + EMBED_BATCH);
      const rows = await Promise.all(
        batch.map(async (p) => ({
          site_key,
          product_name: p.productName,
          product_page_url: p.productPageUrl,
          product_description: p.productDescription,
          embedding: await embedText(`${p.productName}: ${p.productDescription}`),
        })),
      );
      const { error: insErr } = await sb.from("brand_products").insert(rows);
      if (insErr) return json({ error: insErr.message }, 500);
      inserted += rows.length;
    }

    return json({ inserted });
  }

  if (req.method === "DELETE") {
    const body = await req.json().catch(() => ({})) as { site_key?: string };
    const key = body.site_key || siteKey;
    if (!key) return json({ error: "site_key required" }, 400);
    const { error } = await sb.from("brand_products").delete().eq("site_key", key);
    if (error) return json({ error: error.message }, 500);
    return json({ deleted: true });
  }

  return json({ error: "Method not allowed" }, 405);
});
