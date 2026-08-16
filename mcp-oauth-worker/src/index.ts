// Cloudflare Worker — OAuth front door + MCP reverse proxy for the Edmund Optics
// commerce MCP server.
//
// Why this exists: Claude.ai remote connectors discover the OAuth authorization
// server at the DOMAIN ROOT (RFC 8414). Supabase owns the *.supabase.co root, so
// an OAuth-gated MCP server hosted there can't be discovered. This Worker runs on
// a domain whose root we control (*.workers.dev), serving the OAuth discovery +
// auto-approve/PKCE endpoints at the root, and proxying the actual MCP JSON-RPC to
// the Supabase commerce-mcp function. Supabase stays the system of record.
//
// Identity rides in the connector URL query (?site_key & ?buyer), which the Worker
// forwards to Supabase. The issued bearer is a handshake formality (auto-approve),
// so the Worker sends a fixed bearer to Supabase to bypass its 401 gate.

const SUPABASE_MCP = "https://cyjquwhkmzyedkwuaffc.supabase.co/functions/v1/commerce-mcp";
// HMAC key for signing short-lived auth codes. The access token itself is ignored
// downstream (identity is URL-based), so this only prevents code forgery.
const SIGNING_SECRET = "eo-commerce-oauth-shim-v1";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
};

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
  const key = await crypto.subtle.importKey("raw", te.encode(SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
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

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const base = url.origin; // worker root — we control this
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // ── OAuth discovery ──
    if (path === "/.well-known/oauth-protected-resource") {
      return jsonRes({ resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: ["mcp"] });
    }
    if (path === "/.well-known/oauth-authorization-server") {
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

    // ── Dynamic Client Registration ──
    if (request.method === "POST" && path === "/register") {
      // deno-lint-ignore no-explicit-any
      const meta: any = await request.json().catch(() => ({}));
      return jsonRes({
        client_id: `eo-commerce-${randToken().slice(0, 16)}`,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: "none",
        grant_types: meta.grant_types || ["authorization_code", "refresh_token"],
        response_types: meta.response_types || ["code"],
        redirect_uris: meta.redirect_uris || [],
      }, 201);
    }

    // ── Authorize (auto-approve, PKCE) ──
    if (request.method === "GET" && path === "/authorize") {
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

    // ── Token (verify PKCE, issue ignored bearer) ──
    if (request.method === "POST" && path === "/token") {
      const raw = await request.text();
      const form: Record<string, string> = {};
      if ((request.headers.get("content-type") || "").includes("application/json")) {
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

    // ── MCP endpoint: proxy JSON-RPC to Supabase commerce-mcp ──
    if (path === "/mcp") {
      if (request.method !== "POST") {
        return jsonRes({ name: "eo-commerce-mcp", status: "ok" });
      }
      if (!request.headers.get("authorization")) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            ...CORS,
            "Content-Type": "application/json",
            "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
          },
        });
      }
      const siteKey = url.searchParams.get("site_key") || "eo-concept-3b";
      const buyer = url.searchParams.get("buyer") || "";
      const target = `${SUPABASE_MCP}?site_key=${encodeURIComponent(siteKey)}&buyer=${encodeURIComponent(buyer)}`;
      const body = await request.text();
      const upstream = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer proxy" },
        body,
      });
      const text = await upstream.text();
      return new Response(text, { status: upstream.status, headers: { "Content-Type": "application/json", ...CORS } });
    }

    // ── Health / root ──
    return jsonRes({ name: "eo-commerce-mcp", status: "ok", mcp: `${base}/mcp` });
  },
};
