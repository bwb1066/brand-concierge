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
}

interface Citation {
  url: string;
  title: string;
  description: string;
  image: string;
}

// Fetch og:description and og:image from a URL
async function fetchMeta(
  url: string,
): Promise<{ description: string; image: string }> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
    const html = await resp.text();

    const getTag = (name: string): string => {
      const re = new RegExp(
        `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["']`,
        "i",
      );
      const re2 = new RegExp(
        `<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`,
        "i",
      );
      return re.exec(html)?.[1] || re2.exec(html)?.[1] || "";
    };

    return {
      description: getTag("og:description") || getTag("description"),
      image: getTag("og:image"),
    };
  } catch {
    return { description: "", image: "" };
  }
}

// Strip utm_ query params from a URL
function cleanUrl(u: string): string {
  try {
    const parsed = new URL(u);
    [...parsed.searchParams.keys()]
      .filter((k) => k.startsWith("utm_"))
      .forEach((k) => parsed.searchParams.delete(k));
    return parsed.toString();
  } catch {
    return u;
  }
}

// Look up config from Supabase by site_key
async function getConfig(siteKey: string): Promise<BrandConfig | null> {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data, error } = await sb
    .from("brand_configs")
    .select("*")
    .eq("site_key", siteKey)
    .single();
  if (error || !data) return null;
  return data as BrandConfig;
}

// Build default instructions with brand name
function defaultInstructions(brand: string, domains: string[]): string {
  const domainList = domains.join(", ");
  return (
    `You are a ${brand} brand assistant. ` +
    `Answer questions using information from ${domainList}. ` +
    "Always cite your sources with links. " +
    "Include appropriate investment disclaimers when discussing " +
    "funds or performance. " +
    "At the end of every response, suggest 2-3 related follow-up " +
    "questions the user might want to ask. Format them on separate " +
    "lines prefixed with 'SUGGESTED:' (e.g. 'SUGGESTED: What are " +
    `${brand}'s key strategies?'). ` +
    "These must be the very last lines of your response."
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const body = await req.json();
  const { message } = body;

  // Resolve config: inline config > site_key lookup > defaults
  let config: BrandConfig;

  if (body.config) {
    config = {
      domains: body.config.domains || [],
      brand_name: body.config.brand || "Brand",
      instructions: body.config.instructions || "",
      vector_store_id: body.config.vectorStoreId || null,
      contact_url: body.config.contactUrl || null,
    };
  } else if (body.site_key) {
    const looked = await getConfig(body.site_key);
    if (!looked) {
      return new Response(
        JSON.stringify({ error: `Unknown site_key: ${body.site_key}` }),
        { headers: { "Content-Type": "application/json", ...CORS } },
      );
    }
    config = looked;
  } else {
    // Backwards-compatible default
    config = {
      domains: ["lordabbett.com"],
      brand_name: "Lord Abbett",
      instructions: "",
      vector_store_id: null,
      contact_url: null,
    };
  }

  const instructions =
    config.instructions || defaultInstructions(config.brand_name, config.domains);

  // Build tools array
  const tools: Record<string, unknown>[] = [];

  if (config.domains.length) {
    tools.push({
      type: "web_search",
      filters: { allowed_domains: config.domains },
    });
  }

  if (config.vector_store_id) {
    tools.push({
      type: "file_search",
      vector_store_ids: [config.vector_store_id],
    });
  }

  // Call OpenAI Responses API
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      instructions,
      input: message,
      tools,
      include: ["web_search_call.action.sources"],
    }),
  });

  const data = await response.json();

  if (data.error) {
    return new Response(
      JSON.stringify({ text: "", citations: [], debug: data.error }),
      { headers: { "Content-Type": "application/json", ...CORS } },
    );
  }

  // Extract text and citation URLs
  const messageOutput = data.output?.find(
    (o: { type: string }) => o.type === "message",
  );
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

  // Clean and dedupe citation URLs
  const cleanMap = new Map<string, string>();
  for (const [url, title] of urlMap) {
    const clean = cleanUrl(url);
    if (!cleanMap.has(clean)) cleanMap.set(clean, title);
  }

  // Fetch metadata in parallel
  const citationEntries = [...cleanMap.entries()];
  const metaResults = await Promise.all(
    citationEntries.map(([url]) => fetchMeta(url)),
  );

  const citations: Citation[] = citationEntries.map(([url, title], i) => ({
    url,
    title,
    description: metaResults[i].description,
    image: metaResults[i].image,
  }));

  // Extract suggested follow-up questions
  const suggestions: string[] = [];
  const lines = text.split("\n");
  const cleanLines: string[] = [];

  const reversedLines = [...lines].reverse();
  const trailingQuestions: number[] = [];
  for (let i = 0; i < reversedLines.length; i++) {
    const trimmed = reversedLines[i].trim();
    if (!trimmed) continue;
    if (
      trimmed.startsWith("SUGGESTED:") ||
      (trimmed.endsWith("?") && trimmed.length > 20)
    ) {
      trailingQuestions.push(lines.length - 1 - i);
    } else {
      break;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trailingQuestions.includes(i)) {
      const q = trimmed
        .replace(/^SUGGESTED:\s*/, "")
        .replace(/^[-–•*]\s*/, "")
        .replace(/^\*\*(.+)\*\*$/, "$1");
      if (q) suggestions.push(q);
    } else {
      cleanLines.push(lines[i]);
    }
  }
  text = cleanLines.join("\n").trimEnd();

  // Strip utm params from inline URLs
  text = text.replace(/https?:\/\/[^\s)>\]]+/g, (match) => cleanUrl(match));

  return new Response(
    JSON.stringify({
      text,
      citations,
      suggestions,
      contactUrl: config.contact_url,
      debug: data.output ? null : data,
    }),
    { headers: { "Content-Type": "application/json", ...CORS } },
  );
});
