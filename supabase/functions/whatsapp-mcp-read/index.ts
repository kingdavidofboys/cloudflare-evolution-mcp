const MAX_LIMIT = 100;

function equalSecret(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const expected = Deno.env.get("MCP_READ_SHARED_SECRET") ?? "";
  const supplied = request.headers.get("x-mcp-read-secret") ?? "";
  if (!expected || !equalSecret(supplied, expected)) return new Response("Unauthorized", { status: 401 });

  let input: Record<string, unknown>;
  try {
    input = await request.json();
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected JSON object");
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  let serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  let isNewSecretKey = false;
  if (!serviceKey) {
    try {
      const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
      if (typeof secretKeys.default === "string") {
        serviceKey = secretKeys.default;
        isNewSecretKey = true;
      }
    } catch {
      serviceKey = undefined;
    }
  } else if (serviceKey.startsWith("sb_secret_")) {
    isNewSecretKey = true;
  }
  if (!supabaseUrl || !serviceKey) return new Response("Storage is not configured", { status: 503 });

  const limitValue = Number(input.limit ?? 50);
  const limit = Number.isFinite(limitValue) ? Math.min(Math.max(Math.floor(limitValue), 1), MAX_LIMIT) : 50;
  const url = new URL("/rest/v1/whatsapp_messages", supabaseUrl);
  url.searchParams.set("select", "instance,message_id,sender_jid,sent_at,message_type,text_content,is_group,received_at");
  url.searchParams.set("order", "sent_at.desc");
  url.searchParams.set("limit", String(limit));
  if (typeof input.instance === "string" && input.instance.length > 0) url.searchParams.set("instance", `eq.${input.instance}`);
  if (typeof input.since === "string" && input.since.length > 0) {
    const date = new Date(input.since);
    if (!Number.isFinite(date.getTime())) return new Response("since must be a valid ISO date/time", { status: 400 });
    url.searchParams.set("sent_at", `gte.${date.toISOString()}`);
  }

  try {
    const headers = new Headers({ apikey: serviceKey, Accept: "application/json" });
    if (!isNewSecretKey) headers.set("Authorization", `Bearer ${serviceKey}`);
    const response = await fetch(url, { headers });
    if (!response.ok) {
      console.error("Message query failed; status:", response.status);
      return new Response("Could not read saved messages", { status: 502 });
    }
    const rows = await response.json();
    return Response.json({ ok: true, count: Array.isArray(rows) ? rows.length : 0, messages: rows });
  } catch {
    return new Response("Could not reach message storage", { status: 503 });
  }
});
