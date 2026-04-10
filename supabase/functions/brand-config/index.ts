import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, apikey, x-client-info",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const url = new URL(req.url);
  const siteKey = url.searchParams.get("site_key");

  // GET — read config by site_key
  if (req.method === "GET") {
    if (!siteKey) {
      // List all configs
      const { data, error } = await sb
        .from("brand_configs")
        .select("*")
        .order("created_at");
      if (error) return json({ error: error.message }, 500);
      return json(data);
    }

    const { data, error } = await sb
      .from("brand_configs")
      .select("*")
      .eq("site_key", siteKey)
      .single();
    if (error) return json({ error: "Config not found" }, 404);
    return json(data);
  }

  // POST/PUT — upsert config
  if (req.method === "POST" || req.method === "PUT") {
    const body = await req.json();

    if (!body.site_key) {
      return json({ error: "site_key is required" }, 400);
    }

    const record = {
      site_key: body.site_key,
      domains: body.domains || [],
      brand_name: body.brand_name || "Brand",
      instructions: body.instructions || "",
      vector_store_id: body.vector_store_id || null,
      contact_url: body.contact_url || null,
    };

    const { data, error } = await sb
      .from("brand_configs")
      .upsert(record, { onConflict: "site_key" })
      .select()
      .single();

    if (error) return json({ error: error.message }, 500);
    return json(data);
  }

  return json({ error: "Method not allowed" }, 405);
});
