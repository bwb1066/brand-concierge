import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  addLine,
  checkAvailability,
  getCart,
  getProduct,
  removeLine,
  resolveBuyer,
  resolveOpenCart,
  searchProducts,
  setLineQty,
  submitCart,
} from "../_shared/commerce.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_TOKEN = Deno.env.get("ADMIN_TOKEN") || SUPABASE_SERVICE_KEY;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-admin-token",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// deno-lint-ignore no-explicit-any
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const idx = parts.indexOf("commerce");
  const route = "/" + parts.slice(idx + 1).join("/");
  const q = url.searchParams;

  try {
    // ---- Read endpoints (anon) ----
    if (req.method === "GET" && route === "/products") {
      const siteKey = q.get("site_key");
      if (!siteKey) return json({ error: "site_key required" }, 400);
      const buyer = await resolveBuyer(sb, siteKey, q.get("buyer"));
      const products = await searchProducts(sb, siteKey, {
        query: q.get("q") || "",
        limit: parseInt(q.get("limit") || "24", 10),
      }, buyer);
      return json({ products });
    }

    if (req.method === "GET" && route === "/product") {
      const siteKey = q.get("site_key");
      const sku = q.get("sku");
      if (!siteKey || !sku) return json({ error: "site_key and sku required" }, 400);
      const buyer = await resolveBuyer(sb, siteKey, q.get("buyer"));
      const product = await getProduct(sb, siteKey, sku, buyer);
      return product ? json({ product }) : json({ error: "not found" }, 404);
    }

    if (req.method === "GET" && route === "/availability") {
      const siteKey = q.get("site_key");
      const sku = q.get("sku");
      if (!siteKey || !sku) return json({ error: "site_key and sku required" }, 400);
      const buyer = await resolveBuyer(sb, siteKey, q.get("buyer"));
      const availability = await checkAvailability(sb, siteKey, sku, parseInt(q.get("qty") || "1", 10), buyer);
      return availability ? json({ availability }) : json({ error: "not found" }, 404);
    }

    if (req.method === "GET" && route === "/cart") {
      const cartId = q.get("cart_id");
      if (cartId) {
        const cart = await getCart(sb, cartId);
        return cart ? json({ cart }) : json({ error: "not found" }, 404);
      }
      const siteKey = q.get("site_key");
      if (!siteKey) return json({ error: "cart_id or site_key required" }, 400);
      const buyer = await resolveBuyer(sb, siteKey, q.get("buyer"));
      if (!buyer) return json({ error: "buyer required to resolve a shared cart" }, 400);
      const open = await resolveOpenCart(sb, siteKey, buyer.id);
      return json({ cart: await getCart(sb, open.id) });
    }

    // ---- Cart mutations (anon; server holds the service role) ----
    if (req.method === "POST" && route === "/cart") {
      const body = await req.json();
      const buyer = await resolveBuyer(sb, body.site_key, body.buyer);
      const open = await resolveOpenCart(sb, body.site_key, buyer?.id, body.source || "web");
      return json({ cart: await getCart(sb, open.id) });
    }

    if (req.method === "POST" && route === "/cart/items") {
      const body = await req.json();
      const buyer = await resolveBuyer(sb, body.site_key, body.buyer);
      const cart = await addLine(sb, body.site_key, {
        buyer,
        cartId: body.cart_id || null,
        sku: body.sku,
        qty: body.qty || 1,
        via: body.via || "web",
      });
      return cart ? json({ cart }) : json({ error: "product not available" }, 400);
    }

    if (req.method === "POST" && route === "/cart/line") {
      const body = await req.json();
      const buyer = await resolveBuyer(sb, body.site_key, body.buyer);
      const cart = await setLineQty(sb, body.site_key, body.cart_id, body.sku, body.qty, buyer);
      return json({ cart });
    }

    if (req.method === "POST" && route === "/cart/remove") {
      const body = await req.json();
      return json({ cart: await removeLine(sb, body.cart_id, body.sku) });
    }

    if (req.method === "POST" && route === "/cart/submit") {
      const body = await req.json();
      return json({ quote: await submitCart(sb, body.cart_id, body.note || "") });
    }

    // ---- Admin endpoints (x-admin-token) — onboarding a tenant catalog ----
    if (req.method === "POST" && (route === "/catalog" || route === "/buyers")) {
      const token = (req.headers.get("x-admin-token") || "").trim();
      if (token !== ADMIN_TOKEN) return json({ error: "Unauthorized" }, 401);
      const body = await req.json();
      const siteKey = body.site_key;
      if (!siteKey) return json({ error: "site_key required" }, 400);

      if (route === "/buyers") {
        const rows = (body.buyers || []).map((b: any) => ({ site_key: siteKey, ...b }));
        const { error } = await sb.from("commerce_buyers").upsert(rows, { onConflict: "site_key,email" });
        return error ? json({ error: error.message }, 500) : json({ upserted: rows.length });
      }

      // /catalog: upsert products and turn commerce on for the tenant
      const rows = (body.products || []).map((p: any) => ({ site_key: siteKey, ...p }));
      const { error } = await sb.from("commerce_catalog").upsert(rows, { onConflict: "site_key,sku" });
      if (error) return json({ error: error.message }, 500);
      await sb.from("brand_configs").upsert({
        site_key: siteKey,
        commerce_enabled: true,
        currency: body.currency || "USD",
        facet_hints: body.facet_hints || [],
      }, { onConflict: "site_key" });
      return json({ upserted: rows.length });
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
