import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const HEYGEN_API_KEY = Deno.env.get("HEYGEN_API_KEY")!;
const HEYGEN_BASE = "https://api.heygen.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function heygenPost(path: string, body: unknown) {
  const r = await fetch(`${HEYGEN_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": HEYGEN_API_KEY },
    body: JSON.stringify(body),
  });
  return r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = await req.json().catch(() => ({}));
  const { action } = body;

  // Create a new streaming session — returns session_id, SDP offer, ICE servers
  if (action === "start_session") {
    const { avatar_id, quality = "low" } = body;
    if (!avatar_id) return json({ error: "avatar_id required" }, 400);
    const data = await heygenPost("/v1/streaming.new", { avatar_name: avatar_id, quality });
    if (data.error) return json({ error: data.error }, 502);
    return json({
      session_id: data.data?.session_id,
      sdp: data.data?.sdp,
      ice_servers: data.data?.ice_servers2 || data.data?.ice_servers || [],
    });
  }

  // Complete WebRTC handshake — send browser's SDP answer
  if (action === "connect_session") {
    const { session_id, sdp } = body;
    if (!session_id || !sdp) return json({ error: "session_id and sdp required" }, 400);
    const data = await heygenPost("/v1/streaming.start", { session_id, sdp });
    if (data.error) return json({ error: data.error }, 502);
    return json({ ok: true });
  }

  // Send text for the avatar to speak
  if (action === "speak") {
    const { session_id, text } = body;
    if (!session_id || !text) return json({ error: "session_id and text required" }, 400);
    const data = await heygenPost("/v1/streaming.task", { session_id, text, task_type: "talk" });
    if (data.error) return json({ error: data.error }, 502);
    return json({ ok: true });
  }

  // Stop the session
  if (action === "stop_session") {
    const { session_id } = body;
    if (!session_id) return json({ error: "session_id required" }, 400);
    await heygenPost("/v1/streaming.stop", { session_id });
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
});
