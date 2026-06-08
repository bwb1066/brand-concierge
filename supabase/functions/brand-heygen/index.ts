import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const HEYGEN_API_KEY = Deno.env.get("HEYGEN_API_KEY")!;
const LIVEAVATAR_BASE = "https://api.liveavatar.com";

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

async function liveAvatarPost(path: string, body: unknown, sessionToken?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sessionToken) {
    headers["Authorization"] = `Bearer ${sessionToken}`;
  } else {
    headers["X-API-KEY"] = HEYGEN_API_KEY;
  }
  const r = await fetch(`${LIVEAVATAR_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await r.json();
  console.log(`[brand-heygen] ${path} http=${r.status}`, JSON.stringify(data));
  if (!r.ok || (data.code !== undefined && data.code !== 100)) {
    throw new Error(data.message || `LiveAvatar error ${data.code ?? r.status}`);
  }
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const body = await req.json().catch(() => ({}));
  const { action } = body;

  try {
    // Create session: token → start → return LiveKit credentials for frontend
    if (action === "start_session") {
      const { avatar_id, quality = "high" } = body;
      if (!avatar_id) return json({ error: "avatar_id required" }, 400);

      const tokenRes = await liveAvatarPost("/v1/sessions/token", {
        mode: "FULL",
        avatar_id,
        video_settings: { quality, encoding: "VP8" },
      });
      const sessionToken = tokenRes.data?.session_token;
      if (!sessionToken) throw new Error("No session_token from LiveAvatar");

      const startRes = await liveAvatarPost("/v1/sessions/start", {}, sessionToken);

      return json({
        session_id: startRes.data?.session_id ?? tokenRes.data?.session_id,
        livekit_url: startRes.data?.livekit_url,
        livekit_client_token: startRes.data?.livekit_client_token,
      });
    }

    // Stop the session
    if (action === "stop_session") {
      const { session_id } = body;
      if (!session_id) return json({ error: "session_id required" }, 400);
      await liveAvatarPost("/v1/sessions/stop", { session_id, reason: "USER_CLOSED" });
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[brand-heygen]", action, msg);
    return json({ error: msg }, 502);
  }
});
