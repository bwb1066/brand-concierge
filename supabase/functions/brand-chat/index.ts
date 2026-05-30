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
}

interface Citation {
  url: string;
  title: string;
  description: string;
  image: string;
}

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

function cleanUrl(u: string): string {
  try {
    const parsed = new URL(u);
    [...parsed.searchParams.keys()]
      .filter((k) => k.startsWith("utm_") || k === "msockid")
      .forEach((k) => parsed.searchParams.delete(k));
    return parsed.toString();
  } catch {
    return u;
  }
}

function buildAvisBookingUrl(params: Record<string, string>): string | null {
  const { pickup, return: ret, from, to } = params;
  if (!pickup || !ret || !from || !to) return null;
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) return null;
  const p = new URLSearchParams({
    dropoff_suggestion_type_code: "AIRPORT",
    pickup_hour: "12",
    pickup_location_region: "NAM",
    pickup_minute: "00",
    pickup_am_pm: "PM",
    pickup_suggestion_type_code: "AIRPORT",
    residency_value: "US",
    return_hour: "12",
    return_minute: "00",
    return_am_pm: "PM",
    age: "25",
    country: "us",
    locale: "en-US",
    brand: "avis",
    pickup_location_code: pickup.toUpperCase(),
    return_location_code: ret.toUpperCase(),
    pickup_day: String(fromDate.getUTCDate()),
    pickup_month: String(fromDate.getUTCMonth() + 1),
    pickup_year: String(fromDate.getUTCFullYear()),
    return_day: String(toDate.getUTCDate()),
    return_month: String(toDate.getUTCMonth() + 1),
    return_year: String(toDate.getUTCFullYear()),
  });
  return `https://www.avis.com/en/reservation/vehicle-availability?${p.toString()}`;
}

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

function isMainDomain(url: string, cleanDomains: string[]): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return cleanDomains.some((d) => hostname === d.replace(/^www\./, "").toLowerCase());
  } catch { return false; }
}

function defaultInstructions(brand: string, domains: string[], persona?: string | null): string {
  const domainList = domains.join(", ");
  const role = persona ? `${brand}'s ${persona}` : `a ${brand} brand assistant`;
  return (
    `You are ${role}. ` +
    `Answer questions using information from ${domainList}. ` +
    "Always cite your sources with links. " +
    "At the end of every response, suggest 2-3 follow-up prompts " +
    "phrased as the user would type them — never as questions directed at the user. " +
    `Good examples: 'Tell me about ${brand}\\'s key offerings', 'What are the pricing options?'. ` +
    "Format them on separate lines prefixed with 'SUGGESTED:'. " +
    "These must be the very last lines of your response."
  );
}

function webSearchInstructions(context: string): string {
  return (
    `You are finding brief supplementary content in the context of "${context}". ` +
    `The user's question has already been answered using the brand's own website. ` +
    `Only add information that is genuinely absent from the brand's site — local tips, destination guides, traveler insights. ` +
    `If the brand search already covered the topic fully, respond with a single short sentence or nothing at all. ` +
    `Do not repeat rental policies, pricing, vehicle availability, or location details already covered. ` +
    `Keep your response to 2-3 sentences maximum. Do not suggest follow-up questions.`
  );
}

async function callOpenAI(
  message: string,
  instructions: string,
  tools: Record<string, unknown>[],
  previousResponseId?: string | null,
): Promise<{ text: string; urlMap: Map<string, string>; debug: unknown; responseId: string | null }> {
  const requestBody: Record<string, unknown> = {
    model: "gpt-4.1",
    instructions,
    input: message,
    tools,
    include: ["web_search_call.action.sources"],
  };

  if (previousResponseId) {
    requestBody.previous_response_id = previousResponseId;
  }

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

  return { text, urlMap, debug: data.output ? null : data, responseId: data.id ?? null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const body = await req.json();
  const { message, previous_response_id } = body;

  // Resolve config: inline config > site_key lookup > defaults
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
    config = {
      domains: ["lordabbett.com"],
      brand_name: "Lord Abbett",
      instructions: "",
      vector_store_id: null,
      contact_url: null,
      open_search_context: null,
      disable_citations: null,
    };
  }

  let instructions =
    config.instructions || defaultInstructions(config.brand_name, config.domains, config.persona);
  if (config.instructions && config.persona) {
    instructions = `Adopt the persona of ${config.persona}.\n\n${instructions}`;
  }

  // Build brand tools
  const brandTools: Record<string, unknown>[] = [];

  const cleanDomains = config.domains
    .map((d: string) => d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim())
    .filter(Boolean);

  if (cleanDomains.length) {
    brandTools.push({
      type: "web_search",
      filters: { allowed_domains: cleanDomains },
    });
  }

  if (config.vector_store_id && config.vector_store_id.startsWith("vs_")) {
    brandTools.push({
      type: "file_search",
      vector_store_ids: [config.vector_store_id],
    });
  }

  // Sequential search: brand domain first (threaded via previous_response_id)
  let { text: brandText, urlMap: brandUrls, debug: brandDebug, responseId } =
    await callOpenAI(message, instructions, brandTools, previous_response_id);

  // Graceful degradation: if the threaded call failed, retry without the stale ID
  let threadReset = false;
  if (!brandText && brandDebug && previous_response_id) {
    ({ text: brandText, urlMap: brandUrls, debug: brandDebug, responseId } =
      await callOpenAI(message, instructions, brandTools));
    threadReset = true;
  }

  let combinedText = brandText;
  const combinedUrls = new Map(brandUrls);
  let lastDebug = brandDebug;

  // Open web search second, if configured
  if (config.open_search_context) {
    const webInstr = webSearchInstructions(config.open_search_context);
    const { text: webText, urlMap: webUrls, debug: webDebug } =
      await callOpenAI(message, webInstr, [{ type: "web_search" }]);

    if (webText) {
      combinedText += "\n\n**Related information from the web:**\n\n" + webText;
    }
    for (const [url, title] of webUrls) {
      if (!combinedUrls.has(url)) combinedUrls.set(url, title);
    }
    if (webDebug) lastDebug = webDebug;
  }

  // Surface citations unless explicitly disabled for this brand
  let citations: Citation[] = [];
  if (!config.disable_citations) {
    const cleanMap = new Map<string, string>();
    for (const [url, title] of combinedUrls) {
      const clean = cleanUrl(url);
      if (!cleanMap.has(clean) && (cleanDomains.length === 0 || isMainDomain(clean, cleanDomains))) {
        cleanMap.set(clean, title);
      }
    }
    const citationEntries = [...cleanMap.entries()].slice(0, 3);
    const metaResults = await Promise.all(
      citationEntries.map(([url]) => fetchMeta(url)),
    );
    citations = citationEntries.map(([url, title], i) => ({
      url,
      title,
      description: metaResults[i].description,
      image: metaResults[i].image,
    }));
  }

  // Extract suggested questions, upsells, and booking link from trailing lines
  const suggestions: string[] = [];
  interface Upsell { title: string; reason: string; price: string; url: string; }
  const upsells: Upsell[] = [];
  let bookingUrl: string | null = null;
  // Normalize block-style "SUGGESTED:\nline1\nline2" → per-line "SUGGESTED: line1" prefixes
  const normalizedLines: string[] = [];
  let inSuggestedBlock = false;
  for (const line of combinedText.split("\n")) {
    const trimmed = line.trim();
    if (/^SUGGESTED:?\s*$/i.test(trimmed)) { inSuggestedBlock = true; continue; }
    if (inSuggestedBlock) {
      if (!trimmed) continue;
      if (trimmed.startsWith("UPSELL:") || trimmed.startsWith("BOOKING:") || trimmed.startsWith("SUGGESTED:")) {
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
      trimmed.startsWith("SUGGESTED:") ||
      trimmed.startsWith("UPSELL:") ||
      trimmed.startsWith("BOOKING:") ||
      (trimmed.endsWith("?") && trimmed.length > 20)
    ) {
      trailingIndices.push(lines.length - 1 - i);
    } else {
      break;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trailingIndices.includes(i)) {
      if (trimmed.startsWith("UPSELL:")) {
        const parts = trimmed.replace(/^UPSELL:\s*/, "").split("|").map((p) => p.trim());
        if (parts.length >= 4) {
          upsells.push({ title: parts[0], reason: parts[1], price: parts[2], url: parts[3] });
        }
      } else if (trimmed.startsWith("BOOKING:")) {
        const raw = trimmed.replace(/^BOOKING:\s*/, "");
        const params = Object.fromEntries(
          raw.split("|").flatMap((seg) => {
            const eq = seg.indexOf("=");
            if (eq === -1) return [];
            return [[seg.slice(0, eq).trim(), seg.slice(eq + 1).trim()]];
          }),
        );
        bookingUrl = buildAvisBookingUrl(params);
      } else {
        const q = trimmed
          .replace(/^SUGGESTED:\s*/, "")
          .replace(/^[-–•*]\s*/, "")
          .replace(/^\*\*(.+)\*\*$/, "$1");
        if (q) suggestions.push(q);
      }
    } else {
      cleanLines.push(lines[i]);
    }
  }
  let text = cleanLines.join("\n").trimEnd();

  // Strip utm params from inline URLs
  text = text.replace(/https?:\/\/[^\s)>\]]+/g, (match) => cleanUrl(match));

  return new Response(
    JSON.stringify({
      text,
      citations,
      suggestions,
      upsells,
      booking_url: bookingUrl || undefined,
      contactUrl: config.contact_url,
      initialPrompt: config.initial_prompt || undefined,
      chatTitle: config.chat_title || undefined,
      response_id: responseId,
      thread_reset: threadReset || undefined,
      debug: lastDebug,
    }),
    { headers: { "Content-Type": "application/json", ...CORS } },
  );
});
