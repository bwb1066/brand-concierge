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

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function liveAvatarPost(path: string, body: unknown, sessionToken?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sessionToken) {
    headers["Authorization"] = `Bearer ${sessionToken}`;
  } else {
    headers["X-API-KEY"] = HEYGEN_API_KEY;
  }

  // LiveAvatar intermittently returns HTML error pages (5xx / gateway / rate
  // limit) instead of JSON. Retry transient failures, and never blindly
  // JSON.parse the body — surface the real status + a snippet instead.
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(`${LIVEAVATAR_BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON (HTML error page) */ }

    console.log(`[brand-heygen] ${path} attempt=${attempt} http=${r.status} json=${data !== null}`);

    if (r.ok && data !== null) return data;

    // Prefer a structured message; otherwise report status + a short snippet.
    lastErr = data?.message || data?.error?.message ||
      `LiveAvatar HTTP ${r.status}${data === null ? " (non-JSON): " + text.slice(0, 120).replace(/\s+/g, " ").trim() : ""}`;

    // Retry only transient conditions (5xx / 429 / non-JSON body).
    const transient = r.status >= 500 || r.status === 429 || data === null;
    if (!transient || attempt === 3) break;
    await sleep(400 * attempt);
  }
  throw new Error(lastErr || "LiveAvatar request failed");
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
        avatar_persona: {},
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
