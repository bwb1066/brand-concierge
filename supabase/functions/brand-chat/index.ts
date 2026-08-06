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
const RESPONSE_TOKEN_LIMITS: Record<string, number> = {
  concise: 400,
  detailed: 2000,
};

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

  // Product catalog usage (only when the brand has indexed products)
  if (hasProducts) {
    parts.push(
      "When the user message begins with [Relevant catalog products:], those products have been " +
      "pre-selected for relevance to the query. Recommend appropriate ones naturally in your response. " +
      "At the very end of your response output each recommended product as a bare RECOMMENDATION line with no heading, section label, or bullet before it:\n" +
      "RECOMMENDATION: <productName> | <one-sentence reason this fits the user's need> | | <productPageUrl>",
    );
  }

  // Long-form content surfacing
  parts.push(
    "When your search returns educational articles, application notes, guides, knowledge-base entries, or blog posts " +
    "(URLs containing paths like /knowledge-center/, /blog/, /resources/, /guides/, /learn/), " +
    "you MUST include them as bare RESOURCE lines at the very end — after RECOMMENDATION lines, no heading or bullet:\n" +
    "RESOURCE: <articleTitle> | <one-sentence summary of why it is relevant> | <url>\n" +
    "Use the exact URL returned by your search. Include up to 3.",
  );

  // Suggested follow-up format (always last so the parser can extract them cleanly)
  parts.push(
    "At the very end of every response, append 2-3 suggested follow-up questions as bare SUGGESTED: lines " +
    "with no header, label, or preamble before them:\n" +
    "SUGGESTED: <follow-up question>\n" +
    "SUGGESTED: <follow-up question>",
  );

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
): Promise<{ text: string; urlMap: Map<string, string>; debug: unknown; responseId: string | null }> {
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

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });

  const data = await response.json();
  if (data.error) {
    return { text: "", urlMap: new Map(), debug: data.error, responseId: null };
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

  return { text, urlMap, debug: data.output ? null : data, responseId: data.id ?? null };
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
  const maxOutputTokens = RESPONSE_TOKEN_LIMITS[config.response_length || ""] ?? undefined;

  // Retrieve relevant products, build image map, inject into query
  let queryInput = message;
  const productImageMap = new Map<string, string>();
  const productNameUrlMap = new Map<string, string>();
  const productByUrlMap = new Map<string, { name: string; description: string }>();
  let retrievedProducts: Awaited<ReturnType<typeof retrieveProducts>> = [];
  if (productCount > 0 && body.site_key) {
    retrievedProducts = await retrieveProducts(sb, body.site_key, message);
    const products = retrievedProducts;
    for (const p of products) {
      if (p.product_image_url) productImageMap.set(p.product_page_url, p.product_image_url);
      productNameUrlMap.set(p.product_name.toLowerCase(), p.product_page_url);
      productByUrlMap.set(p.product_page_url, { name: p.product_name, description: p.product_description });
    }
    if (products.length > 0) {
      const productBlock = products
        .map((p, i) => `${i + 1}. ${p.product_name}: ${p.product_description}\n   URL: ${p.product_page_url}`)
        .join("\n\n");
      queryInput = `[Relevant catalog products:]\n${productBlock}\n\n[User question:]\n${message}`;
    }
  }

  // Build brand tools
  const cleanDomains = config.domains
    .map((d: string) => d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim())
    .filter(Boolean);

  const brandTools: Record<string, unknown>[] = [];
  if (cleanDomains.length) {
    brandTools.push({ type: "web_search", filters: { allowed_domains: cleanDomains } });
  }
  if (config.vector_store_id && config.vector_store_id.startsWith("vs_")) {
    brandTools.push({ type: "file_search", vector_store_ids: [config.vector_store_id] });
  }

  // Brand call (threaded)
  let { text: brandText, urlMap: brandUrls, debug: brandDebug, responseId } =
    await callOpenAI(queryInput, instructions, brandTools, previous_response_id, maxOutputTokens);

  // Retry without stale thread ID if needed
  let threadReset = false;
  if (!brandText && brandDebug && previous_response_id) {
    ({ text: brandText, urlMap: brandUrls, debug: brandDebug, responseId } =
      await callOpenAI(queryInput, instructions, brandTools, undefined, maxOutputTokens));
    threadReset = true;
  }

  let combinedText = brandText;
  const combinedUrls = new Map(brandUrls);
  let lastDebug = brandDebug;

  // Optional open web search
  if (config.open_search_context) {
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
      // Parse RECOMMENDATION lines wherever they appear in the response
      const parts = trimmed.replace(/^RECOMMENDATION:\s*/, "").split("|").map((p) => p.trim());
      if (parts.length >= 4) {
        const realUrl = productNameUrlMap.get(parts[0].toLowerCase()) || sanitizeUrl(parts[3]);
        recommendations.push({ title: parts[0], reason: parts[1], price: parts[2], url: realUrl, image: productImageMap.get(realUrl) || "" });
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

  // Fill in missing images from DB for catalog products not in the top-5
  const recsNeedingImages = recommendations.filter((r) => !r.image && r.url);
  if (recsNeedingImages.length > 0 && body.site_key) {
    const { data: imgRows } = await sb
      .from("brand_products")
      .select("product_page_url, product_image_url")
      .eq("site_key", body.site_key)
      .in("product_page_url", recsNeedingImages.map((r) => r.url));
    if (imgRows) {
      const dbImageMap = new Map(imgRows.map((p) => [p.product_page_url, p.product_image_url]));
      for (const rec of recsNeedingImages) {
        const img = dbImageMap.get(rec.url);
        if (img) rec.image = img;
      }
    }
  }

  // Intent-gated recommendation fallback.
  // The model curates RECOMMENDATION cards, but a safety-oriented persona can
  // route a clear provider request to programs and emit no cards. When (a) the
  // user is explicitly asking for a person and (b) the model returned none, fill
  // from the top vector matches above a similarity floor. Both gates are required
  // — intent without a relevant match, or a relevant match without intent, won't
  // fire — which keeps off-topic and symptom-only queries from surfacing cards.
  const PROVIDER_INTENT = new RegExp(
    "\\b(specialists?|doctors?|physicians?|surgeons?|neurosurgeons?|providers?|clinicians?|practitioners?|orthopa?edists?)\\b"
    + "|\\bwho\\s+(can\\s+)?(treat|treats|see|sees|specializ\\w*)\\b"
    + "|\\b(recommend|refer|find|see)\\b[^.?!]{0,30}\\b(doctor|physician|specialist|surgeon|provider|clinician|someone)\\b",
    "i",
  );
  const RECOMMENDATION_SIMILARITY_FLOOR = 0.25;
  const RECOMMENDATION_FALLBACK_MAX = 10;
  if (
    recommendations.length === 0
    && typeof message === "string"
    && PROVIDER_INTENT.test(message)
    && retrievedProducts.length > 0
  ) {
    for (const p of retrievedProducts
      .filter((p) => (p.similarity ?? 0) >= RECOMMENDATION_SIMILARITY_FLOOR)
      .slice(0, RECOMMENDATION_FALLBACK_MAX)) {
      const reason = p.product_description.length > 200
        ? `${p.product_description.slice(0, 200).replace(/\s+\S*$/, "")}…`
        : p.product_description;
      recommendations.push({
        title: p.product_name,
        reason,
        price: "",
        url: p.product_page_url,
        image: p.product_image_url || "",
      });
    }
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
