# Brand Concierge

AI-powered brand assistant that searches a configured domain and optional PDF vector store using the OpenAI Responses API. Deployable as a Supabase Edge Function with an embeddable frontend widget.

## Architecture

- **`supabase/functions/brand-chat`** — Main chat endpoint. Accepts `site_key` or inline config. Uses `web_search` (domain-restricted) and optionally `file_search` (vector store) tools.
- **`supabase/functions/brand-config`** — CRUD API for managing brand configurations.
- **`supabase/migrations`** — `brand_configs` table schema.
- **`widget/`** — Embeddable JS/CSS concierge UI with settings panel.

## Setup

1. Link to your Supabase project: `supabase link --project-ref <ref>`
2. Set secrets: `supabase secrets set OPENAI_API_KEY=sk-...`
3. Push the database migration: `supabase db push`
4. Deploy functions: `supabase functions deploy brand-chat && supabase functions deploy brand-config`

## Usage

### API

```bash
curl -X POST https://<ref>.supabase.co/functions/v1/brand-chat \
  -H "Content-Type: application/json" \
  -H "apikey: <anon-key>" \
  -H "Authorization: Bearer <anon-key>" \
  -d '{"message": "tell me about your products", "site_key": "mybrand"}'
```

### Inline config (no database lookup)

```json
{
  "message": "what funds do you offer?",
  "config": {
    "domains": ["example.com"],
    "brand": "Example Corp",
    "vectorStoreId": "vs_abc123",
    "instructions": "Custom system prompt...",
    "contactUrl": "https://example.com/contact"
  }
}
```

### Widget embed

```html
<link rel="stylesheet" href="brand-concierge.css">
<script type="module">
  import openConcierge from './brand-concierge.js';
  document.querySelector('#chat-btn').addEventListener('click', () => openConcierge());
</script>
```

## Config fields

| Field | Description |
|-------|-------------|
| `site_key` | Unique identifier for the brand |
| `domains` | Array of domains to restrict web search |
| `brand_name` | Brand display name |
| `instructions` | Custom system prompt (optional, auto-generated if empty) |
| `vector_store_id` | OpenAI vector store ID for PDF search (optional) |
| `contact_url` | URL for "have a rep reach out" CTA (optional) |
