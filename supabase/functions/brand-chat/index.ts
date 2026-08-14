import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, apikey, x-client-info",
};

interface BrandConfig {
  domains: string[];
  brand_name: string;
  instructions: string;
  vector_store_id: string | null;
  contact_url: string | null;
  open_search_context: string | null;
  disable_citations: boolean | null;
  persona: string | null;
  initial_prompt: string | null;
  chat_title: string | null;
  audience_type: string | null;
  product_advisory_context: string | null;
  product_advisory_rules: string | null;
  product_advisory_keywords: string | null;
  brand_expression: Record<string, string> | null;
  response_length: string | null;
  commerce_enabled: boolean | null;
}

interface Citation {
  url: string;
  title: string;
  description: string;
  image: string;
}

// ── Brand expression label map ──────────────────────────────────────────────
const EXPRESSION_LABELS: Record<string, Record<string, string>> = {
  formality: {
    formal: "Formal — Precise, polished, and businesslike.",
    "semi-formal": "Semi-formal — Balanced professionalism with warmth.",
    casual: "Casual — Conversational, approachable, and relaxed.",
  },
  warmth: {
    warm: "Warm — Empathetic and people-first.",
    neutral: "Neutral — Balanced and even-toned.",
    cool: "Cool — Minimal emotion and focused on clarity.",
  },
  playfulness: {
    playful: "Playful — Witty and humorous.",
    "semi-playful": "Semi-playful — Fact-focused with a touch of levity.",
    serious: "Serious — Sincere and no-nonsense.",
  },
  energy: {
    calm: "Calm — Steady and composed.",
    lively: "Lively — Upbeat and engaging, yet polished.",
    enthusiastic: "Enthusiastic — Energetic and expressive.",
  },
  sophistication: {
    premium: "Premium — Exclusive and aspirational.",
    elevated: "Elevated — Sophisticated but approachable.",
    accessible: "Accessible — Inclusive and down-to-earth.",
  },
  boldness: {
    bold: "Bold — Bold and highly confident.",
    assertive: "Assertive — Direct yet respectful.",
    modest: "Modest — Measured and reserved.",
  },
};

// ── Response length → max_output_tokens ────────────────────────────────────
// Every request MUST cap output: when max_output_tokens is unset, OpenAI reserves
// the model's full default output (~16K) against the org's TPM rate limit, so a
// single chat "Requests" ~20K of a 30K/min budget and the second request in a
// minute gets rate-limited (empty answer). Capping output slashes that reservation.
const RESPONSE_TOKEN_LIMITS: Record<string, number> = {
  concise: 400,
  moderate: 1200,
  detailed: 2000,
};
// Fallback cap when response_length is empty/unknown — never leave output unbounded.
const DEFAULT_MAX_OUTPUT_TOKENS = 1200;

// ── Product retrieval / recommendation-card tuning ──────────────────────────
// Cards are built deterministically from vector similarity (not the model's
// curation, which is inconsistent and was capped at whatever it chose to emit).
const CANDIDATE_TOP_N = 50; // vector matches pulled per query (the card candidate pool)
const INJECT_TOP_N = 12;    // how many of those are injected into the prompt for prose grounding
const REC_MAX = 15;         // max recommendation cards returned
const REC_REL_DELTA = 0.15; // keep matches within this similarity window below the top match
const REC_ABS_FLOOR = 0.30; // ...but never surface anything below this absolute similarity
const REC_REASON_MAX = 140; // max chars for a card's reason line (keeps cards compact)

// ── Helpers ─────────────────────────────────────────────────────────────────

async function fetchMeta(url: string): Promise<{ description: string; image: string; ok: boolean }> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return { description: "", image: "", ok: false };
    const html = await resp.text();
    const getTag = (name: string): string => {
      const re = new RegExp(
        `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["']`, "i",
      );
      const re2 = new RegExp(
        `<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`, "i",
      );
      return re.exec(html)?.[1] || re2.exec(html)?.[1] || "";
    };
    return {
      description: getTag("og:description") || getTag("description"),
      image: getTag("og:image"),
      ok: true,
    };
  } catch {
    return { description: "", image: "", ok: false };
  }
}

const EDITORIAL_SEGMENTS = new Set([
  "knowledge-center", "blog", "resources", "articles", "article",
  "guides", "guide", "news", "learn", "learning", "tutorial", "tutorials",
  "application-notes", "application-note", "whitepaper", "white-paper",
  "insights", "education", "library", "case-studies", "case-study",
]);

function isEditorialUrl(url: string): boolean {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    return segments.some((s) => EDITORIAL_SEGMENTS.has(s.toLowerCase()));
  } catch {
    return false;
  }
}

function cleanUrl(u: string): string {
  try {
    const parsed = new URL(u);
    [...parsed.searchParams.keys()]
      .filter((k) => k.startsWith("utm_") || k === "msockid" || k === "PrintPDF")
      .forEach((k) => parsed.searchParams.delete(k));
    return parsed.toString();
  } catch {
    return u;
  }
}

// Extract a usable URL from a model-authored field. The model sometimes appends
// its markdown citation syntax directly onto the URL, e.g.
//   https://…/2282/%20([edmundoptics.com](https://…/2282/?utm_source=openai))
// which otherwise gets stored as the card's href (broken link) and fails to match
// the catalog URL (no image). Grab the first http(s) token and cut it at the first
// whitespace, encoded space, or opening paren, then run cleanUrl.
function sanitizeUrl(raw: string): string {
  if (!raw) return raw;
  const match = raw.match(/https?:\/\/\S+/);
  let url = (match ? match[0] : raw.trim()).split(/[\s(]|%20/)[0];
  url = url.replace(/[.,)"'\]>]+$/, "");
  return cleanUrl(url);
}

// Resolve a model-emitted RECOMMENDATION product name to its canonical catalog
// URL. Exact (case-insensitive) match first, then a safe token-subsequence match
// so "5520 Series Universal Switches" still resolves to the catalog's "5520
// Series" — while "200 Series" will NOT spuriously match "8200 Series" (matched
// on whole tokens, not substrings). Resolving to the canonical URL is what lets
// the image lookup (keyed by product_page_url) attach a thumbnail to the card.
function resolveCatalogUrl(name: string, nameUrlMap: Map<string, string>): string | undefined {
  const exact = nameUrlMap.get(name.toLowerCase());
  if (exact) return exact;
  const toks = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  const isRun = (needle: string[], hay: string[]): boolean => {
    if (!needle.length || needle.length > hay.length) return false;
    for (let i = 0; i + needle.length <= hay.length; i++) {
      if (needle.every((t, j) => hay[i + j] === t)) return true;
    }
    return false;
  };
  const nameToks = toks(name);
  for (const [catName, url] of nameUrlMap) {
    const catToks = toks(catName);
    if (isRun(catToks, nameToks) || isRun(nameToks, catToks)) return url;
  }
  return undefined;
}


async function getConfig(
  sb: ReturnType<typeof createClient>,
  siteKey: string,
): Promise<BrandConfig | null> {
  const { data, error } = await sb
    .from("brand_configs")
    .select("*")
    .eq("site_key", siteKey)
    .single();
  if (error || !data) return null;
  return data as BrandConfig;
}

function isMainDomain(url: string, cleanDomains: string[]): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return cleanDomains.some((d) => hostname === d.replace(/^www\./, "").toLowerCase());
  } catch { return false; }
}

// ── System prompt builder ────────────────────────────────────────────────────

function defaultInstructions(brand: string, domains: string[], persona?: string | null): string {
  const domainList = domains.join(", ");
  const role = persona ? `${brand}'s ${persona}` : `a ${brand} brand assistant`;
  return (
    `You are ${role}. ` +
    `Answer questions using information from ${domainList}. ` +
    "Always cite your sources with links. " +
    "At the end of every response, suggest 2-3 follow-up prompts " +
    "phrased as the user would type them — never as questions directed at the user. " +
    `Good examples: 'Tell me about ${brand}'s key offerings', 'What are the pricing options?'. ` +
    "Format them on separate lines prefixed with 'SUGGESTED:'. " +
    "These must be the very last lines of your response."
  );
}

function buildSystemPrompt(config: BrandConfig, hasProducts: boolean): string {
  const parts: string[] = [];

  // Base instructions + persona
  const base = config.instructions
    || defaultInstructions(config.brand_name, config.domains, config.persona);
  if (config.instructions && config.persona) {
    parts.push(`Adopt the persona of ${config.persona}.\n\n${base}`);
  } else {
    parts.push(base);
  }

  // Always search — prevents AI from answering purely from training knowledge
  if (config.domains?.length) {
    parts.push(
      `Always search ${config.domains.join(", ")} before responding, even for general or educational topics. ` +
      "Do not answer from memory alone — ground every response in content found on the brand's website.",
    );
  }

  // Audience framing
  if (config.audience_type === "b2b") {
    parts.push(
      "Audience: You are speaking with business professionals. " +
      "Focus on ROI, operational efficiency, scalability, and procurement considerations. " +
      "Use professional, business-oriented language.",
    );
  } else if (config.audience_type === "b2c") {
    parts.push(
      "Audience: You are speaking with individual consumers. " +
      "Focus on personal benefits, ease of use, and how products or services improve their life.",
    );
  }

  // Product advisory
  const advisory: string[] = [];
  if (config.product_advisory_context) advisory.push(`Context: ${config.product_advisory_context}`);
  if (config.product_advisory_rules) advisory.push(`Business rules: ${config.product_advisory_rules}`);
  if (config.product_advisory_keywords) advisory.push(`Keyword guidelines: ${config.product_advisory_keywords}`);
  if (advisory.length) {
    parts.push("Product advisory:\n" + advisory.join("\n"));
  }

  // Brand expression
  const expr = config.brand_expression || {};
  const toneLines: string[] = [];
  for (const [dim, value] of Object.entries(expr)) {
    const label = EXPRESSION_LABELS[dim]?.[value];
    if (label) toneLines.push(`${dim.charAt(0).toUpperCase() + dim.slice(1)}: ${label}`);
  }
  if (toneLines.length) {
    parts.push("Brand voice and tone:\n" + toneLines.join("\n"));
  }

  // Response length
  if (config.response_length === "concise") {
    parts.push("Response length: Keep responses brief and to the point — 1-2 short paragraphs maximum.");
  } else if (config.response_length === "detailed") {
    parts.push("Response length: Provide comprehensive, detailed responses. Cover the topic thoroughly with relevant examples and context.");
  }

  // ── Machine-readable output contract ──────────────────────────────────────
  // This is appended last and is authoritative about how the response ends. It
  // supersedes any earlier persona wording (e.g. "SUGGESTED lines must be the
  // very last lines") that would otherwise stop the model before it emits the
  // product/resource cards the UI renders. Keep the three line types in a fixed
  // order — RECOMMENDATION → RESOURCE → SUGGESTED — so the parser and the widget
  // agree, with SUGGESTED genuinely last.
  const contract: string[] = [];
  contract.push(
    "RESPONSE OUTPUT CONTRACT (required — this overrides any earlier instruction about what must appear at the end of your response):\n" +
    "After your prose answer, append machine-readable lines in exactly this order, each on its own line, " +
    "with no heading, label, bullet, or blank-line preamble before them: first RECOMMENDATION lines, then RESOURCE lines, then SUGGESTED lines. " +
    "SUGGESTED lines are always the final lines of the whole response. These lines are parsed programmatically and rendered as cards — a product or article mentioned only in prose will NOT appear.",
  );

  if (hasProducts) {
    contract.push(
      "RECOMMENDATION lines: When the user's message begins with [Relevant catalog products:], those products were pre-selected as relevant to the query. " +
      "For every catalog product you mention or that clearly fits the user's need, you MUST emit a RECOMMENDATION line — this is required, not optional, whenever the query is about products, solutions, or what to buy/use (emit at least the 1-3 best matches). " +
      "Do NOT emit a RECOMMENDATION line for a purely informational, support, or troubleshooting question where no product fits.\n" +
      "RECOMMENDATION: <exact productName from the catalog list> | <one-sentence reason this fits the user's need> | | <productPageUrl from the catalog list>",
    );
    if (config.commerce_enabled) {
      contract.push(
        "CATALOG-ONLY MODE: Recommend, name, and link ONLY products from the [Relevant catalog products:] list in the user's message. " +
        "Do not introduce or reference products that are not in that list, and do not rely on outside web knowledge for product specifics. " +
        "If nothing in the list fits, say so plainly and offer to refine the search.",
      );
    }
  }

  contract.push(
    "RESOURCE lines: When your search returns educational articles, application notes, guides, knowledge-base entries, or blog posts " +
    "(URLs containing paths like /knowledge-center/, /blog/, /resources/, /guides/, /learn/), emit them as RESOURCE lines (up to 3), using the exact URL returned by your search:\n" +
    "RESOURCE: <articleTitle> | <one-sentence summary of why it is relevant> | <url>",
  );

  contract.push(
    "SUGGESTED lines: Always end with 2-3 suggested follow-up prompts phrased as the user would type them:\n" +
    "SUGGESTED: <follow-up prompt>\n" +
    "SUGGESTED: <follow-up prompt>",
  );

  parts.push(contract.join("\n\n"));

  return parts.filter(Boolean).join("\n\n");
}

// Condense a written answer into a short, natural spoken summary for TTS.
// Only invoked when the client requests voice mode, so text-only requests are
// unaffected. Returns "" on any failure — the widget then falls back to its own
// client-side sanitizer.
async function summarizeForSpeech(answer: string): Promise<string> {
  const clipped = answer.slice(0, 4000);
  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        instructions:
          "Convert the assistant's written answer into a short spoken summary for text-to-speech. " +
          "1-2 conversational sentences. No markdown, no URLs, no bullet lists, no citations. " +
          "If the answer references products, articles, or resources shown on screen, briefly " +
          "acknowledge them (e.g. 'a few options are shown below') instead of listing details. " +
          "Do not read out follow-up suggestions.",
        input: clipped,
        max_output_tokens: 200,
      }),
    });
    const data = await res.json();
    const msg = data.output?.find((o: { type: string }) => o.type === "message");
    let out = "";
    if (msg?.content) {
      for (const c of msg.content) {
        if (c.type === "output_text") out += c.text;
      }
    }
    return out.trim();
  } catch {
    return "";
  }
}

// Parse OpenAI's "Please try again in 7.972s" / "256ms" hint into a wait (ms),
// with a small buffer and a sane clamp so a bad hint can't stall the function.
function parseRetryDelayMs(message: string): number {
  const m = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(message || "");
  if (!m) return 1500;
  const val = parseFloat(m[1]);
  const ms = m[2].toLowerCase() === "s" ? val * 1000 : val;
  return Math.min(Math.max(ms + 300, 500), 15000);
}

function webSearchInstructions(context: string): string {
  return (
    `You are finding brief supplementary content in the context of "${context}". ` +
    `The user's question has already been answered using the brand's own website. ` +
    `Only add information that is genuinely absent from the brand's site — local tips, destination guides, traveler insights. ` +
    `If the brand search already covered the topic fully, respond with a single short sentence or nothing at all. ` +
    `Do not repeat pricing, product details, or information already covered in the brand's response. ` +
    `Keep your response to 2-3 sentences maximum. Do not suggest follow-up questions.`
  );
}

// ── Product retrieval ────────────────────────────────────────────────────────

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
  return data.data[0].embedding;
}

async function retrieveProducts(
  sb: ReturnType<typeof createClient>,
  siteKey: string,
  query: string,
  topN = 10,
): Promise<Array<{ product_name: string; product_page_url: string; product_description: string; product_image_url: string | null; similarity: number }>> {
  try {
    const embedding = await embedText(query);
    const { data, error } = await sb.rpc("match_products", {
      query_embedding: embedding,
      match_site_key: siteKey,
      match_count: topN,
    });
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}

// ── OpenAI Responses API call ────────────────────────────────────────────────

async function callOpenAI(
  message: string,
  instructions: string,
  tools: Record<string, unknown>[],
  previousResponseId?: string | null,
  maxOutputTokens?: number,
): Promise<{ text: string; urlMap: Map<string, string>; debug: unknown; responseId: string | null; rateLimited: boolean }> {
  const requestBody: Record<string, unknown> = {
    model: "gpt-4.1",
    instructions,
    input: message,
    tools,
    include: ["web_search_call.action.sources"],
  };
  if (tools.length > 0) requestBody.tool_choice = "required";
  if (previousResponseId) requestBody.previous_response_id = previousResponseId;
  if (maxOutputTokens) requestBody.max_output_tokens = maxOutputTokens;

  // Retry transient TPM rate limits: OpenAI tells us how long to wait, so back
  // off that long and retry once before giving up. Without this a burst of two
  // requests in one minute returns an empty answer to the user.
  const MAX_RATE_LIMIT_RETRIES = 2;
  const postResponses = async () => {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });
    return await response.json();
  };
  let data = await postResponses();
  for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
    if (data.error?.code !== "rate_limit_exceeded") break;
    await new Promise((r) => setTimeout(r, parseRetryDelayMs(data.error.message)));
    data = await postResponses();
  }

  if (data.error) {
    return {
      text: "", urlMap: new Map(), debug: data.error, responseId: null,
      rateLimited: data.error.code === "rate_limit_exceeded",
    };
  }

  const messageOutput = data.output?.find((o: { type: string }) => o.type === "message");
  let text = "";
  const urlMap = new Map<string, string>();

  if (messageOutput?.content) {
    for (const c of messageOutput.content) {
      if (c.type === "output_text") {
        text += c.text;
        if (c.annotations) {
          for (const a of c.annotations) {
            if (a.type === "url_citation" && a.url && !urlMap.has(a.url)) {
              urlMap.set(a.url, a.title || a.url);
            }
          }
        }
      }
    }
  }

  return { text, urlMap, debug: data.output ? null : data, responseId: data.id ?? null, rateLimited: false };
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const body = await req.json();
  const { message, previous_response_id } = body;

  // Resolve config: inline > site_key lookup > hardcoded fallback
  let config: BrandConfig;

  if (body.config) {
    config = {
      domains: body.config.domains || [],
      brand_name: body.config.brand || "Brand",
      instructions: body.config.instructions || "",
      vector_store_id: body.config.vectorStoreId || null,
      contact_url: body.config.contactUrl || null,
      open_search_context: body.config.openSearchContext || null,
      disable_citations: body.config.disableCitations ?? null,
      persona: body.config.persona || null,
      initial_prompt: body.config.initialPrompt || null,
      chat_title: body.config.chatTitle || null,
      audience_type: null,
      product_advisory_context: null,
      product_advisory_rules: null,
      product_advisory_keywords: null,
      brand_expression: null,
      response_length: null,
      commerce_enabled: null,
    };
  } else if (body.site_key) {
    const looked = await getConfig(sb, body.site_key);
    if (!looked) {
      return new Response(
        JSON.stringify({ error: `Unknown site_key: ${body.site_key}` }),
        { headers: { "Content-Type": "application/json", ...CORS } },
      );
    }
    config = looked;
  } else {
    config = {
      domains: ["lordabbett.com"],
      brand_name: "Lord Abbett",
      instructions: "",
      vector_store_id: null,
      contact_url: null,
      open_search_context: null,
      disable_citations: null,
      persona: null,
      initial_prompt: null,
      chat_title: null,
      audience_type: null,
      product_advisory_context: null,
      product_advisory_rules: null,
      product_advisory_keywords: null,
      brand_expression: null,
      response_length: null,
      commerce_enabled: null,
    };
  }

  // Check for indexed products (site_key lookups only)
  let productCount = 0;
  if (body.site_key) {
    const { count } = await sb
      .from("brand_products")
      .select("*", { count: "exact", head: true })
      .eq("site_key", body.site_key);
    productCount = count ?? 0;
  }

  const instructions = buildSystemPrompt(config, productCount > 0);
  const maxOutputTokens = RESPONSE_TOKEN_LIMITS[config.response_length || ""] ?? DEFAULT_MAX_OUTPUT_TOKENS;

  // Retrieve relevant products, build image map, inject into query
  let queryInput = message;
  const productImageMap = new Map<string, string>();
  const productNameUrlMap = new Map<string, string>();
  const productByUrlMap = new Map<string, { name: string; description: string }>();
  let retrievedProducts: Awaited<ReturnType<typeof retrieveProducts>> = [];
  if (productCount > 0 && body.site_key) {
    retrievedProducts = await retrieveProducts(sb, body.site_key, message, body.top_n || CANDIDATE_TOP_N);
    const products = retrievedProducts;
    for (const p of products) {
      if (p.product_image_url) productImageMap.set(p.product_page_url, p.product_image_url);
      productNameUrlMap.set(p.product_name.toLowerCase(), p.product_page_url);
      productByUrlMap.set(p.product_page_url, { name: p.product_name, description: p.product_description });
    }
    if (products.length > 0) {
      // Cap each description so the injected block stays token-lean (the whole
      // system prompt is already large; unbounded descriptions add up fast). Only
      // the top INJECT_TOP_N ground the model's prose — the card set is built from
      // the full candidate pool separately, so we don't need to inject all of it.
      const clip = (s: string) => (s.length > 280 ? `${s.slice(0, 280).replace(/\s+\S*$/, "")}…` : s);
      const productBlock = products
        .slice(0, INJECT_TOP_N)
        .map((p, i) => `${i + 1}. ${p.product_name}: ${clip(p.product_description)}\n   URL: ${p.product_page_url}`)
        .join("\n\n");
      queryInput = `[Relevant catalog products:]\n${productBlock}\n\n[User question:]\n${message}`;
    }
  }

  // Build brand tools
  const cleanDomains = config.domains
    .map((d: string) => d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim())
    .filter(Boolean);

  // Commerce brands answer deterministically from their indexed catalog only:
  // skip live web_search (recommendation cards are already built from the vector
  // matches). Non-commerce brands are unchanged.
  const catalogOnly = config.commerce_enabled === true;
  const brandTools: Record<string, unknown>[] = [];
  if (cleanDomains.length && !catalogOnly) {
    brandTools.push({ type: "web_search", filters: { allowed_domains: cleanDomains } });
  }
  if (config.vector_store_id && config.vector_store_id.startsWith("vs_")) {
    brandTools.push({ type: "file_search", vector_store_ids: [config.vector_store_id] });
  }

  // Brand call (threaded)
  let { text: brandText, urlMap: brandUrls, debug: brandDebug, responseId, rateLimited: brandRateLimited } =
    await callOpenAI(queryInput, instructions, brandTools, previous_response_id, maxOutputTokens);

  // Retry without stale thread ID if needed — but not when the failure was a rate
  // limit (callOpenAI already backed off and retried; a stale-thread retry here
  // would just burn another throttled request).
  let threadReset = false;
  if (!brandText && brandDebug && !brandRateLimited && previous_response_id) {
    ({ text: brandText, urlMap: brandUrls, debug: brandDebug, responseId, rateLimited: brandRateLimited } =
      await callOpenAI(queryInput, instructions, brandTools, undefined, maxOutputTokens));
    threadReset = true;
  }

  let combinedText = brandText;
  const combinedUrls = new Map(brandUrls);
  let lastDebug = brandDebug;

  // Optional open web search (never for catalog-only commerce brands)
  if (config.open_search_context && !catalogOnly) {
    const webInstr = webSearchInstructions(config.open_search_context);
    const { text: webText, urlMap: webUrls, debug: webDebug } =
      await callOpenAI(message, webInstr, [{ type: "web_search" }], undefined, maxOutputTokens);
    if (webText) combinedText += "\n\n**Related information from the web:**\n\n" + webText;
    for (const [url, title] of webUrls) {
      if (!combinedUrls.has(url)) combinedUrls.set(url, title);
    }
    if (webDebug) lastDebug = webDebug;
  }

  // Citations — split into editorial (→ resources) and non-editorial
  let citations: Citation[] = [];
  const autoResourceUrls: Map<string, string> = new Map(); // url → title
  if (!config.disable_citations) {
    const cleanMap = new Map<string, string>();
    for (const [url, title] of combinedUrls) {
      const clean = cleanUrl(url);
      if (!cleanMap.has(clean) && (cleanDomains.length === 0 || isMainDomain(clean, cleanDomains))) {
        cleanMap.set(clean, title);
      }
    }
    const nonEditorialEntries: [string, string][] = [];
    for (const [url, title] of cleanMap) {
      if (isEditorialUrl(url)) {
        autoResourceUrls.set(url, title);
      } else {
        nonEditorialEntries.push([url, title]);
      }
    }
    const citationEntries = nonEditorialEntries.slice(0, 3);
    const metaResults = await Promise.all(citationEntries.map(([url]) => fetchMeta(url)));
    citations = citationEntries.map(([url, title], i) => ({
      url, title, description: metaResults[i].description,
      image: metaResults[i].image || productImageMap.get(url) || "",
    }));
  }

  // Extract SUGGESTED / RECOMMENDATION / RESOURCE from trailing lines
  const suggestions: string[] = [];
  interface Recommendation { title: string; reason: string; price: string; url: string; image: string; }
  interface ResourceRaw { title: string; teaser: string; url: string; }
  const recommendations: Recommendation[] = [];
  const resourceRaws: ResourceRaw[] = [];
  const normalizedLines: string[] = [];
  let inSuggestedBlock = false;
  for (const line of combinedText.split("\n")) {
    const trimmed = line.trim();
    if (/^SUGGESTED:?\s*$/i.test(trimmed)) { inSuggestedBlock = true; continue; }
    if (inSuggestedBlock) {
      if (!trimmed) continue;
      if (trimmed.startsWith("RECOMMENDATION:") || trimmed.startsWith("RESOURCE:") || trimmed.startsWith("SUGGESTED:")) {
        inSuggestedBlock = false; normalizedLines.push(line);
      } else {
        normalizedLines.push(`SUGGESTED: ${trimmed}`);
      }
    } else {
      normalizedLines.push(line);
    }
  }

  const lines = normalizedLines;
  const cleanLines: string[] = [];
  const reversedLines = [...lines].reverse();
  const trailingIndices: number[] = [];
  for (let i = 0; i < reversedLines.length; i++) {
    const trimmed = reversedLines[i].trim();
    if (!trimmed) continue;
    if (
      trimmed.startsWith("SUGGESTED:") || trimmed.startsWith("RECOMMENDATION:") ||
      (trimmed.endsWith("?") && trimmed.length > 20)
    ) {
      trailingIndices.push(lines.length - 1 - i);
    } else { break; }
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("RECOMMENDATION:")) {
      // Parse RECOMMENDATION lines wherever they appear in the response. The model
      // formats these inconsistently: sometimes the documented 4-field form
      // (name | reason | price | url) and sometimes 3 fields (name | reason | url),
      // dropping the usually-empty price. Locate the URL field rather than assuming
      // a fixed index, so both forms produce a card (a strict length check here was
      // silently dropping every 3-field line — e.g. all access-point recs).
      const parts = trimmed.replace(/^RECOMMENDATION:\s*/, "").split("|").map((p) => p.trim());
      if (parts.length >= 3) {
        let urlIdx = -1;
        for (let j = parts.length - 1; j >= 0; j--) { if (/https?:\/\//.test(parts[j])) { urlIdx = j; break; } }
        if (urlIdx === -1) urlIdx = parts.length - 1;
        const title = parts[0];
        const reason = urlIdx > 1 ? parts[1] : "";
        const price = urlIdx >= 3 ? parts[2] : "";
        const realUrl = resolveCatalogUrl(title, productNameUrlMap) || sanitizeUrl(parts[urlIdx]);
        recommendations.push({ title, reason, price, url: realUrl, image: productImageMap.get(realUrl) || "" });
      }
    } else if (trimmed.startsWith("RESOURCE:")) {
      // Parse RESOURCE lines wherever they appear in the response
      const parts = trimmed.replace(/^RESOURCE:\s*/, "").split("|").map((p) => p.trim());
      if (parts.length >= 3) {
        resourceRaws.push({ title: parts[0], teaser: parts[1], url: sanitizeUrl(parts[2]) });
      }
    } else if (trailingIndices.includes(i)) {
      const q = trimmed
        .replace(/^SUGGESTED:\s*/, "")
        .replace(/^[-–•*]\s*/, "")
        .replace(/^\*\*(.+)\*\*$/, "$1");
      if (q) suggestions.push(q);
    } else {
      cleanLines.push(lines[i]);
    }
  }
  let text = cleanLines.join("\n").trimEnd();
  text = text.replace(/https?:\/\/[^\s)>\]]+/g, (match) => cleanUrl(match));

  // Promote citation URLs that match known products into recommendation cards
  if (productByUrlMap.size > 0) {
    const recommendedUrls = new Set(recommendations.map((r) => r.url));
    citations = citations.filter((c) => {
      const product = productByUrlMap.get(c.url);
      if (!product || recommendedUrls.has(c.url)) return true;
      recommendations.push({ title: product.name, reason: product.description, price: "", url: c.url, image: productImageMap.get(c.url) || c.image });
      recommendedUrls.add(c.url);
      return false;
    });
  }

  // Comprehensive recommendation cards (deterministic, similarity-driven).
  // The model's RECOMMENDATION lines are inconsistent and self-capped, so instead
  // of trusting them for the card SET we build it from the vector matches: keep
  // every product within REC_REL_DELTA of the top match (and above REC_ABS_FLOOR),
  // sorted by similarity, capped at REC_MAX. A named-drug query whose exact
  // strengths sit in a similarity gap (e.g. aripiprazole) stays tight; a broad
  // category (e.g. blood pressure) fills up to the cap. We reuse the model's
  // one-line reason when it wrote one for that product, else the catalog blurb.
  if (retrievedProducts.length > 0) {
    const reasonByUrl = new Map(recommendations.map((r) => [r.url, r.reason]));
    const topSim = retrievedProducts[0].similarity ?? 0;
    const floor = Math.max(REC_ABS_FLOOR, topSim - REC_REL_DELTA);
    // Build a short, human card reason. Catalog descriptions front-load a
    // "Label: value | … | Label: value. " attribute block (strength, NDC, brand
    // ref, unit size) for embedding signal — strip that so the card shows what the
    // product actually is/treats (strength is already in the title), then clip.
    const cardReason = (s: string) => {
      const stripped = s.replace(
        /^(?:[A-Za-z][A-Za-z ]*:\s*[^|]*\|\s*)+[A-Za-z][A-Za-z ]*:\s*[^.]*\.\s*/,
        "",
      ).trim();
      const t = stripped || s.trim();
      return t.length > REC_REASON_MAX ? `${t.slice(0, REC_REASON_MAX).replace(/\s+\S*$/, "")}…` : t;
    };
    const comprehensive = retrievedProducts
      .filter((p) => (p.similarity ?? 0) >= floor)
      .slice(0, REC_MAX)
      .map((p) => ({
        title: p.product_name,
        reason: cardReason(reasonByUrl.get(p.product_page_url) || p.product_description),
        price: "",
        url: p.product_page_url,
        image: p.product_image_url || "",
      }));
    recommendations.length = 0;
    recommendations.push(...comprehensive);
  }

  // Merge AI-output RESOURCE: lines with auto-detected editorial citation URLs
  // AI-explicit resources take priority; fill remaining slots from auto-detected ones
  interface Resource { title: string; teaser: string; url: string; image: string; }
  const explicitResourceUrls = new Set(resourceRaws.map((r) => r.url));
  const autoEntries = [...autoResourceUrls.entries()]
    .filter(([url]) => !explicitResourceUrls.has(url))
    .slice(0, 3);

  const resourceCandidates = await Promise.all([
    ...resourceRaws.slice(0, 3).map(async (r) => {
      const meta = await fetchMeta(r.url);
      return meta.ok ? { title: r.title, teaser: r.teaser, url: r.url, image: meta.image } : null;
    }),
    ...autoEntries.map(async ([url, title]) => {
      const meta = await fetchMeta(url);
      return meta.ok ? { title, teaser: meta.description, url, image: meta.image } : null;
    }),
  ]);
  const resources: Resource[] = resourceCandidates
    .filter((r): r is Resource => r !== null)
    .slice(0, 3);

  // Spoken summary (voice mode only). Generated from the final cleaned prose,
  // which already has cards/suggestions stripped, so it never reads out URLs.
  let spokenSummary: string | undefined;
  if (body.voice === true && text) {
    const summary = await summarizeForSpeech(text);
    if (summary) spokenSummary = summary;
  }

  // If the brand call was rate-limited and produced nothing, tell the user it's a
  // transient throttle (retryable) rather than letting the widget show the generic
  // "couldn't find an answer" message, which misleadingly implies no content exists.
  if (!text && brandRateLimited) {
    text = "I'm getting a lot of questions right now and briefly hit my limit. Please try that again in a few seconds.";
  }

  return new Response(
    JSON.stringify({
      text,
      citations,
      suggestions,
      recommendations,
      resources,
      spoken_summary: spokenSummary,
      contactUrl: config.contact_url,
      initialPrompt: config.initial_prompt || undefined,
      chatTitle: config.chat_title || undefined,
      response_id: responseId,
      thread_reset: threadReset || undefined,
      debug: lastDebug,
      retrieved: body.debug
        ? retrievedProducts.map((p) => ({ name: p.product_name, sim: p.similarity }))
        : undefined,
    }),
    { headers: { "Content-Type": "application/json", ...CORS } },
  );
});
