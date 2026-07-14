import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Speech-to-text for the brand concierge voice mode.
// Accepts an audio blob (multipart form field "file") and returns { text }.
// Reuses the OpenAI key already configured for brand-chat.

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, apikey, x-client-info",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!OPENAI_API_KEY) return json({ error: "Transcription unavailable" }, 503);

  let audio: Blob | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f && typeof f !== "string") audio = f as Blob;
  } catch {
    // Not multipart — treat the raw body as the audio bytes.
    const buf = await req.arrayBuffer();
    if (buf.byteLength) {
      audio = new Blob([buf], { type: req.headers.get("content-type") || "audio/webm" });
    }
  }
  if (!audio || audio.size === 0) return json({ error: "No audio provided" }, 400);

  const upstream = new FormData();
  const type = audio.type || "audio/webm";
  const ext = type.includes("mp4") ? "mp4" : type.includes("mpeg") ? "mp3" : type.includes("wav") ? "wav" : "webm";
  upstream.append("file", audio, `audio.${ext}`);
  upstream.append("model", "whisper-1");
  upstream.append("response_format", "json");

  try {
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: upstream,
    });
    const data = await res.json();
    if (data.error) return json({ error: data.error.message || "Transcription failed" }, 502);
    return json({ text: (data.text || "").trim() });
  } catch (e) {
    return json({ error: String(e) }, 502);
  }
});
