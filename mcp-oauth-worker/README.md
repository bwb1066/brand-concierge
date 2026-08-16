# eo-commerce-mcp — Cloudflare Worker (OAuth front door + MCP proxy)

Lets the **Claude.ai app** connect to the Edmund Optics commerce MCP server.

Claude.ai discovers a connector's OAuth server at the **domain root**, which we
can't serve on `*.supabase.co`. This Worker runs on a root-controlled
`*.workers.dev` domain: it serves the OAuth discovery + auto-approve/PKCE
endpoints at the root, and **proxies** the actual MCP tool calls to the Supabase
`commerce-mcp` function. Supabase stays the backend.

## Deploy

```bash
cd mcp-oauth-worker
npx wrangler login        # opens a browser — sign in as bwb1066@gmail.com
npx wrangler deploy
```

First deploy will register your `*.workers.dev` subdomain if you don't have one.
Wrangler prints the deployed URL, e.g.
`https://eo-commerce-mcp.<your-subdomain>.workers.dev`.

## Use in Claude.ai

Add a custom connector with **Remote MCP server URL**:

```
https://eo-commerce-mcp.<your-subdomain>.workers.dev/mcp?site_key=eo-concept-3b&buyer=acme-photonics
```

Leave the OAuth fields blank — the Worker auto-registers and auto-approves. Open
`localhost:3000/drafts/eo-concept-3b?buyer=acme-photonics` (or the live page) and
watch the cart badge react as Claude adds items.

## How it routes

- `GET /.well-known/oauth-protected-resource` / `oauth-authorization-server` — discovery
- `POST /register` — Dynamic Client Registration (accepts any client)
- `GET /authorize` — auto-approve, redirect with a signed PKCE-bound code
- `POST /token` — verify S256 PKCE, issue a bearer (ignored downstream)
- `POST /mcp?site_key=&buyer=` — 401 → WWW-Authenticate when unauth; otherwise
  proxies JSON-RPC to the Supabase `commerce-mcp` (identity from the query)

Change `SUPABASE_MCP` in `src/index.ts` to point at a different tenant/backend.
