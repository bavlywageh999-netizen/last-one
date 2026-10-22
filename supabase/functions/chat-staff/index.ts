const env = (name: string) => Deno.env.get(name) ?? "";
const MAX_BODY = 8192;
const MAX_MESSAGE = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ChatStaffError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "ChatStaffError";
  }
}

function headers() {
  return {
    "Access-Control-Allow-Origin": env("ALLOWED_ORIGIN") || "*",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function reply(status: number, value: Record<string, unknown>) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...headers(), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function originAllowed(request: Request) {
  const allowed = env("ALLOWED_ORIGIN");
  const origin = request.headers.get("origin");
  return !allowed || allowed === "*" || !origin || origin === allowed;
}

async function parseBody(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function authenticateAdmin(request: Request) {
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  const url = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!match || !url || !serviceKey) return null;

  const userResponse = await fetch(url + "/auth/v1/user", {
    headers: { apikey: serviceKey, Authorization: "Bearer " + match[1] },
  });
  if (userResponse.status === 401 || userResponse.status === 403) return null;
  if (!userResponse.ok) throw new ChatStaffError("chat_auth_unavailable");
  const user = await userResponse.json();
  if (!user || typeof user.id !== "string" || !UUID_RE.test(user.id)) return null;

  const adminResponse = await db(
    "admins?select=user_id&user_id=eq." + encodeURIComponent(user.id) + "&limit=1",
  );
  if (!adminResponse.ok) throw new ChatStaffError("chat_admin_lookup_failed");
  const admins = await adminResponse.json();
  return Array.isArray(admins) && admins.some((admin) => admin.user_id === user.id)
    ? { id: user.id as string }
    : null;
}

async function db(path: string, init: RequestInit = {}) {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const requestHeaders = new Headers(init.headers);
  requestHeaders.set("apikey", key);
  requestHeaders.set("Authorization", "Bearer " + key);
  requestHeaders.set("Content-Type", "application/json");
  return await fetch(url + "/rest/v1/" + path, {
    ...init,
    headers: requestHeaders,
  });
}

function validConversationId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

async function handleAction(body: Record<string, unknown>, adminId: string) {
  if (body.action === "ping") return reply(200, { ok: true });

  if (body.action === "list") {
    const status = body.status === "open" || body.status === "closed" ? body.status : null;
    const filter = status ? "&status=eq." + status : "";
    const response = await db(
      "chat_conversations?select=id,created_at,last_message_at,status,lang,unread_staff,last_sender,last_body" +
        filter + "&order=last_message_at.desc&limit=100",
    );
    if (!response.ok) throw new ChatStaffError("chat_conversations_unavailable");
    return reply(200, { ok: true, conversations: await response.json() });
  }

  if (!validConversationId(body.conversation_id)) {
    return reply(400, { ok: false, code: "bad_conversation_id" });
  }
  const conversationId = body.conversation_id;

  if (body.action === "messages") {
    const after = Math.max(0, Math.floor(Number(body.after) || 0));
    const response = await db(
      "chat_messages?select=id,sender,body,created_at&conversation_id=eq." +
        encodeURIComponent(conversationId) + "&id=gt." + after + "&order=id.asc&limit=100",
    );
    if (!response.ok) throw new ChatStaffError("chat_messages_unavailable");
    return reply(200, { ok: true, messages: await response.json() });
  }

  if (body.action === "reply") {
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!text || text.length > MAX_MESSAGE) {
      return reply(400, { ok: false, code: "bad_message" });
    }
    const response = await db("rpc/chat_staff_reply", {
      method: "POST",
      body: JSON.stringify({
        p_conversation: conversationId,
        p_body: text,
        p_staff: adminId,
      }),
    });
    if (!response.ok) throw new ChatStaffError("chat_reply_unavailable");
    return reply(200, { ok: true });
  }

  if (body.action === "read") {
    const response = await db(
      "chat_conversations?id=eq." + encodeURIComponent(conversationId),
      { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ unread_staff: 0 }) },
    );
    if (!response.ok) throw new ChatStaffError("chat_read_unavailable");
    return reply(200, { ok: true });
  }

  if (body.action === "status") {
    if (body.status !== "open" && body.status !== "closed") {
      return reply(400, { ok: false, code: "bad_status" });
    }
    const response = await db(
      "chat_conversations?id=eq." + encodeURIComponent(conversationId),
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: body.status }),
      },
    );
    if (!response.ok) throw new ChatStaffError("chat_status_unavailable");
    return reply(200, { ok: true });
  }

  return reply(400, { ok: false, code: "bad_action" });
}

async function handle(request: Request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers() });
  if (request.method !== "POST") return reply(405, { ok: false, code: "method_not_allowed" });
  if (!originAllowed(request)) return reply(403, { ok: false, code: "origin_not_allowed" });

  const body = await parseBody(request);
  if (!body) return reply(400, { ok: false, code: "bad_json" });
  if (!env("SUPABASE_URL") || !env("SUPABASE_SERVICE_ROLE_KEY")) {
    return reply(503, { ok: false, code: "not_configured" });
  }

  try {
    const admin = await authenticateAdmin(request);
    if (!admin) return reply(403, { ok: false, code: "admin_required" });
    return await handleAction(body, admin.id);
  } catch (error) {
    if (error instanceof ChatStaffError) {
      console.error("chat-staff request failed:", error.message);
      return reply(503, { ok: false, code: error.message });
    }
    console.error("chat-staff request failed:", error);
    return reply(503, { ok: false, code: "chat_backend_unavailable" });
  }
}

Deno.serve(handle);
