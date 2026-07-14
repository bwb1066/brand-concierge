import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Text-to-speech for the brand concierge voice mode.
// Accepts { text, voice? } and streams back audio/mpeg.
// Reuses the OpenAI key already configured for brand-chat.

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, apikey, x-client-info",
};

// OpenAI TTS voices; fall back to alloy for anything unrecognized.
const VALID_VOICES = new Set([
  "alloy", "ash", "ballad", "coral", "echo", "fable",
  "onyx", "nova", "sage", "shimmer", "verse",
]);

function err(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return err({ error: "Method not allowed" }, 405);
  if (!OPENAI_API_KEY) return err({ error: "Speech unavailable" }, 503);

  const body = await req.json().catch(() => ({}));
  const text = (body.text || "").toString().trim();
  if (!text) return err({ error: "No text provided" }, 400);

  const voice = VALID_VOICES.has(body.voice) ? body.voice : "alloy";
  // Guard against runaway costs — cap spoken input length.
  const input = text.slice(0, 1200);

  try {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        input,
        voice,
        response_format: "mp3",
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return err({ error: "Speech failed", detail }, 502);
    }
    return new Response(res.body, {
      headers: { "Content-Type": "audio/mpeg", ...CORS },
    });
  } catch (e) {
    return err({ error: String(e) }, 502);
  }
});
