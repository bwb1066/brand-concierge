import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  addLine,
  checkAvailability,
  getCart,
  getConfig,
  getProduct,
  resolveBuyer,
  resolveOpenCart,
  searchProducts,
  submitCart,
} from "../_shared/commerce.ts";

// commerce-mcp — a remote MCP server (JSON-RPC 2.0 / Streamable HTTP) exposing
// the commerce harness as GENERIC tools, so Claude (or any MCP client) can shop
// and request a quote. It reuses _shared/commerce.ts unchanged — a thin
// transport, not new logic.
//
// Tenant + buyer identity are baked into the connector URL (the demo shortcut,
// no OAuth): register the connector as
//   https://<proj>.supabase.co/functions/v1/commerce-mcp?site_key=eo-concept-3b&buyer=acme-photonics
// Every tool call is scoped to that site_key and resolves the buyer's shared
// cart — so an add_to_quote here lands in the same cart as the website.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, mcp-session-id",
};

// deno-lint-ignore no-explicit-any
function toolDefs(brand: string, facets: string[]) {
  const facetLine = facets.length ? ` Common filterable specs: ${facets.join(", ")}.` : "";
  return [
    {
      name: "search_products",
      description: `Search the ${brand} catalog by free-text query across name, category, and specifications.${facetLine}`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search, e.g. '25mm doublet 400-700nm'" },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_product",
      description: `Get the full spec sheet and pricing for one ${brand} product by stock number (SKU).`,
      inputSchema: {
        type: "object",
        properties: { sku: { type: "string" } },
        required: ["sku"],
      },
    },
    {
      name: "check_availability",
      description: "For a SKU and quantity, return stock, lead time, the resolved unit price, and the full quantity-break price table in one call.",
      inputSchema: {
        type: "object",
        properties: {
          sku: { type: "string" },
          qty: { type: "number", description: "Quantity to price (default 1)" },
        },
        required: ["sku"],
      },
    },
    {
      name: "add_to_quote",
      description: "Add a SKU and quantity to the buyer's draft quote (shared with their website cart).",
      inputSchema: {
        type: "object",
        properties: {
          sku: { type: "string" },
          qty: { type: "number", description: "Quantity (default 1)" },
        },
        required: ["sku"],
      },
    },
    {
      name: "get_quote",
      description: "Return the buyer's current draft quote: line items, quantities, unit prices, lead times, and estimated total.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "submit_quote",
      description: "Submit the draft quote for the seller to confirm pricing and lead times. No payment is taken. Returns a quote reference number.",
      inputSchema: {
        type: "object",
        properties: { note: { type: "string", description: "Optional note: target date, application, PO#" } },
      },
    },
  ];
}

// deno-lint-ignore no-explicit-any
async function callTool(sb: any, siteKey: string, buyer: any, name: string, args: any) {
  const currency = (await getConfig(sb, siteKey))?.currency || "USD";
  const slim = (p: any) => ({
    sku: p.sku, name: p.name, category: p.category, specs: p.specs,
    list_price: p.list_price, currency, in_stock: p.stock_qty > 0, lead_time_days: p.lead_time_days,
  });

  if (name === "search_products") {
    const products = await searchProducts(sb, siteKey, { query: args.query || "", limit: args.limit || 10 }, buyer);
    return { products: products.map(slim) };
  }
  if (name === "get_product") {
    const p = await getProduct(sb, siteKey, args.sku, buyer);
    return p ? { ...slim(p), description: p.description, price_breaks: p.price_breaks, restricted: p.restricted } : { error: "not found" };
  }
  if (name === "check_availability") {
    const a = await checkAvailability(sb, siteKey, args.sku, args.qty || 1, buyer);
    return a ? { ...a, currency } : { error: "not found" };
  }
  if (name === "add_to_quote") {
    const cart = await addLine(sb, siteKey, { buyer, sku: args.sku, qty: args.qty || 1, via: "mcp" });
    if (!cart) return { error: "product not available" };
    return { added: args.sku, quote_lines: cart.lines.length, lines: cart.lines.map((l: any) => ({ sku: l.sku, qty: l.qty, unit_price: l.unit_price })) };
  }
  if (name === "get_quote") {
    const open = await resolveOpenCart(sb, siteKey, buyer?.id);
    const cart = await getCart(sb, open.id);
    const total = (cart?.lines || []).reduce((s: number, l: any) => s + l.qty * l.unit_price, 0);
    return { currency, total, lines: (cart?.lines || []).map((l: any) => ({ sku: l.sku, name: l.name, qty: l.qty, unit_price: l.unit_price, lead_time_days: l.lead_time_days })) };
  }
  if (name === "submit_quote") {
    const open = await resolveOpenCart(sb, siteKey, buyer?.id);
    const quote = await submitCart(sb, open.id, args.note || "");
    return { quote_number: quote.quote_number, status: "submitted", message: "The seller will confirm pricing and lead times. No payment was taken." };
  }
  return { error: `unknown tool: ${name}` };
}

// ── OAuth shim (auto-approve, PKCE, stateless) ───────────────────────────────
// Claude.ai remote connectors require OAuth. Supabase owns the domain root, so
// we host discovery + registration + authorize + token entirely under this
// function's own path and point Claude here via WWW-Authenticate (RFC 9728).
// Real identity still rides in the connector URL (?buyer=), so this is a
// handshake shim: it auto-approves, verifies PKCE, and issues a bearer the MCP
// layer ignores. Auth codes are HMAC-signed + short-lived, so no storage needed.
const OAUTH_SECRET = Deno.env.get("OAUTH_SIGNING_SECRET") || SUPABASE_SERVICE_KEY;
const te = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToStr(s: string): string {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}
async function sha256b64url(input: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", te.encode(input));
  return b64url(new Uint8Array(d));
}
async function hmacB64url(input: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", te.encode(OAUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(input));
  return b64url(new Uint8Array(sig));
}
function randToken(): string {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return b64url(a);
}
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

/** Public base URL of this MCP resource. Derived from SUPABASE_URL because the
 * function only sees the internal scheme/path (http, no /functions/v1 prefix). */
function mcpBase(): string {
  return `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/commerce-mcp`;
}

async function makeCode(challenge: string, redirectUri: string): Promise<string> {
  const payload = b64url(te.encode(JSON.stringify({ cc: challenge, ru: redirectUri, exp: Date.now() + 300000 })));
  return `${payload}.${await hmacB64url(payload)}`;
}
async function verifyCode(code: string, verifier: string, redirectUri: string): Promise<boolean> {
  const [payload, sig] = (code || "").split(".");
  if (!payload || !sig || (await hmacB64url(payload)) !== sig) return false;
  // deno-lint-ignore no-explicit-any
  let data: any;
  try { data = JSON.parse(b64urlToStr(payload)); } catch { return false; }
  if (!data || Date.now() > data.exp) return false;
  if (redirectUri && data.ru && redirectUri !== data.ru) return false;
  return (await sha256b64url(verifier)) === data.cc;
}

async function handleOAuth(sub: string, req: Request, url: URL, base: string): Promise<Response | null> {
  if (req.method === "GET" && sub.endsWith("/.well-known/oauth-protected-resource")) {
    return jsonRes({ resource: base, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: ["mcp"] });
  }
  if (req.method === "GET" && sub.endsWith("/.well-known/oauth-authorization-server")) {
    return jsonRes({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  }
  if (req.method === "POST" && sub === "/register") {
    // deno-lint-ignore no-explicit-any
    const meta: any = await req.json().catch(() => ({}));
    return jsonRes({
      client_id: `eo-commerce-${randToken().slice(0, 16)}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "none",
      grant_types: meta.grant_types || ["authorization_code", "refresh_token"],
      response_types: meta.response_types || ["code"],
      redirect_uris: meta.redirect_uris || [],
    }, 201);
  }
  if (req.method === "GET" && sub === "/authorize") {
    const p = url.searchParams;
    const redirectUri = p.get("redirect_uri") || "";
    const state = p.get("state") || "";
    const challenge = p.get("code_challenge") || "";
    if (!redirectUri || !challenge) return jsonRes({ error: "invalid_request" }, 400);
    const code = await makeCode(challenge, redirectUri);
    const sep = redirectUri.includes("?") ? "&" : "?";
    const loc = `${redirectUri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ""}`;
    return new Response(null, { status: 302, headers: { ...CORS, Location: loc } });
  }
  if (req.method === "POST" && sub === "/token") {
    const raw = await req.text();
    const form: Record<string, string> = {};
    if ((req.headers.get("content-type") || "").includes("application/json")) {
      Object.assign(form, JSON.parse(raw || "{}"));
    } else {
      new URLSearchParams(raw).forEach((v, k) => { form[k] = v; });
    }
    if (form.grant_type === "refresh_token") {
      return jsonRes({ access_token: randToken(), token_type: "Bearer", expires_in: 3600, refresh_token: form.refresh_token || randToken(), scope: "mcp" });
    }
    if (form.grant_type !== "authorization_code") return jsonRes({ error: "unsupported_grant_type" }, 400);
    if (!(await verifyCode(form.code || "", form.code_verifier || "", form.redirect_uri || ""))) {
      return jsonRes({ error: "invalid_grant" }, 400);
    }
    return jsonRes({ access_token: randToken(), token_type: "Bearer", expires_in: 3600, refresh_token: randToken(), scope: "mcp" });
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const url = new URL(req.url);
  const base = mcpBase();
  const sub = url.pathname.split("/commerce-mcp")[1] || "";
  const siteKey = url.searchParams.get("site_key") || "eo-concept-3b";
  const buyerKey = url.searchParams.get("buyer") || "";

  // OAuth shim endpoints (discovery / register / authorize / token).
  const oauth = await handleOAuth(sub, req, url, base);
  if (oauth) return oauth;

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ name: "commerce-mcp", status: "ok" }), {
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  // Unauthenticated MCP call → 401 pointing Claude at our OAuth metadata (this
  // is what kicks off the connector's OAuth flow). Non-OAuth clients (curl,
  // Claude Code) can send any Authorization: Bearer to bypass.
  if (!req.headers.get("authorization")) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        ...CORS,
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      },
    });
  }

  const cfg = await getConfig(sb, siteKey);
  const brand = cfg?.brand_name || siteKey;
  const facets = Array.isArray(cfg?.facet_hints) ? cfg.facet_hints : [];

  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), {
      headers: { "Content-Type": "application/json", ...CORS },
    });
  }

  const { id, method, params } = msg;
  const reply = (result: unknown) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      headers: { "Content-Type": "application/json", ...CORS },
    });

  // Notifications (no id) — acknowledge without a body.
  if (id === undefined || id === null) {
    return new Response(null, { status: 202, headers: CORS });
  }

  if (method === "initialize") {
    return reply({
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: `${brand} Commerce`, version: "0.1.0" },
    });
  }

  if (method === "tools/list") {
    return reply({ tools: toolDefs(brand, facets) });
  }

  if (method === "tools/call") {
    try {
      const buyer = await resolveBuyer(sb, siteKey, buyerKey);
      const data = await callTool(sb, siteKey, buyer, params?.name, params?.arguments || {});
      return reply({
        content: [{ type: "text", text: JSON.stringify(data) }],
        isError: !!(data as any).error,
      });
    } catch (e) {
      return reply({
        content: [{ type: "text", text: `Error: ${String((e as Error).message || e)}` }],
        isError: true,
      });
    }
  }

  if (method === "ping") return reply({});

  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } }), {
    headers: { "Content-Type": "application/json", ...CORS },
  });
});
