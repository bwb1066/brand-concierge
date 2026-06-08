import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_TOKEN = Deno.env.get("ADMIN_TOKEN") || SUPABASE_SERVICE_KEY;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, apikey, x-client-info, x-admin-token",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const url = new URL(req.url);
  const siteKey = url.searchParams.get("site_key");
  const versionParam = url.searchParams.get("version");

  // GET — list versions for a site, or fetch one specific version
  if (req.method === "GET") {
    if (!siteKey) {
      // List all sites with their latest version number (no content)
      const { data, error } = await sb
        .from("script_versions")
        .select("site_key, version, widget_version, notes, created_at")
        .order("site_key")
        .order("version", { ascending: false });
      if (error) return json({ error: error.message }, 500);
      // Dedupe to latest per site
      const latest = new Map<string, typeof data[0]>();
      for (const row of data ?? []) {
        if (!latest.has(row.site_key)) latest.set(row.site_key, row);
      }
      return json(Object.fromEntries(latest));
    }

    if (versionParam) {
      // Single version with full script content
      const { data, error } = await sb
        .from("script_versions")
        .select("*")
        .eq("site_key", siteKey)
        .eq("version", Number(versionParam))
        .single();
      if (error) return json({ error: "Version not found" }, 404);
      return json(data);
    }

    // List all versions for site (no script_content for bandwidth)
    const { data, error } = await sb
      .from("script_versions")
      .select("id, site_key, version, widget_version, notes, created_at")
      .eq("site_key", siteKey)
      .order("version", { ascending: false });
    if (error) return json({ error: error.message }, 500);
    return json(data ?? []);
  }

  // POST — save a new script version (auto-increments version per site)
  if (req.method === "POST") {
    const token = (req.headers.get("x-admin-token") || "").trim();
    if (token !== ADMIN_TOKEN) return json({ error: "Unauthorized" }, 401);

    const body = await req.json();
    const { site_key, script_content, widget_version, notes } = body;

    if (!site_key || !script_content) {
      return json({ error: "site_key and script_content are required" }, 400);
    }

    // Find current max version for this site
    const { data: existing } = await sb
      .from("script_versions")
      .select("version")
      .eq("site_key", site_key)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextVersion = (existing?.version ?? 0) + 1;

    const { data, error } = await sb
      .from("script_versions")
      .insert({
        site_key,
        version: nextVersion,
        script_content,
        widget_version: widget_version || "unknown",
        notes: notes || null,
      })
      .select()
      .single();

    if (error) return json({ error: error.message }, 500);
    return json(data);
  }

  return json({ error: "Method not allowed" }, 405);
});
