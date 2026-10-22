// =====================================================================
// Supabase Edge Function: chat-visitor                         (Deno runtime)
// Public side of the website live chat. Two actions, both identified ONLY by the visitor's secret token:
//   "send": store a visitor message (the first message of a new conversation needs a CAPTCHA)
//   "poll": return the messages of that visitor's own conversation (including the clinic's replies)
// The token is a random 64-hex-character secret created in the visitor's browser. Only a keyed hash of it is stored.
// Deploy WITHOUT JWT verification (publishable keys are not JWTs):  supabase functions deploy chat-visitor --no-verify-jwt
// Provided by Supabase automatically: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// REQUIRED: CHAT_SECRET (random, 32+ characters)   TURNSTILE_SECRET_KEY (or REQUIRE_CAPTCHA=0 to run without a CAPTCHA: not recommended)
// Optional: ALLOWED_ORIGIN, RL_CHAT_TOKEN_MIN (6), RL_CHAT_TOKEN_HOUR (40), RL_CHAT_IP_HOUR (60), RL_CHAT_GLOBAL_HOUR (600)
// SQL needed: supabase_livechat.sql
// =====================================================================
const env = (k, d = "") => Deno.env.get(k) ?? d;
const num = (k, d) => { const n = Number(env(k)); return Number.isFinite(n) && n > 0 ? n : d; };
const MAX_BODY = 8192, MAX_MESSAGE = 2000, TOKEN_RE = /^[0-9a-f]{64}$/;
const LIMITS = () => ({ tokenMin: num("RL_CHAT_TOKEN_MIN", 6), tokenHour: num("RL_CHAT_TOKEN_HOUR", 40), ipHour: num("RL_CHAT_IP_HOUR", 60), globalHour: num("RL_CHAT_GLOBAL_HOUR", 600) });

const cors = () => ({ "Access-Control-Allow-Origin": env("ALLOWED_ORIGIN") || "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" });
const reply = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...cors(), "Content-Type": "application/json", "Cache-Control": "no-store" } });
const originOk = (req) => { const a = env("ALLOWED_ORIGIN"); if (!a || a === "*") return true; const o = req.headers.get("origin"); return !o || o === a; };
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").replace(/\r\n?/g, "\n").trim().slice(0, n);   // keeps line breaks, drops other control characters
const q = encodeURIComponent;

// ---------- keyed hashes (tokens and network addresses are never stored in clear) ----------
const enc = new TextEncoder();
const secretOk = () => env("CHAT_SECRET").length >= 32;
async function hmacHex(msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env("CHAT_SECRET")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg))), (x) => x.toString(16).padStart(2, "0")).join("");
}
const tokenHash = (token) => hmacHex("chat-token:" + token);
const ipHashOf = async (ip) => (await hmacHex("chat-ip:" + ip)).slice(0, 32);
function clientIp(req) {                       // Supabase runs behind Cloudflare, which sets cf-connecting-ip itself
  const h = req.headers, cf = h.get("cf-connecting-ip"); if (cf) return cf.trim();
  const real = h.get("x-real-ip"); if (real) return real.trim();
  const xf = h.get("x-forwarded-for"); if (xf) { const p = xf.split(",").map((s) => s.trim()).filter(Boolean); return p[p.length - 1] || "unknown"; }
  return "unknown";
}

// ---------- database (service role: the browser never sees this key) ----------
function db(path, init = {}) {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return fetch(env("SUPABASE_URL") + "/rest/v1/" + path, { ...init, headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", ...(init.headers || {}) } });
}
async function withTimeout(url, init, ms = 10000) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...init, signal: c.signal }); } finally { clearTimeout(t); }
}
async function conversationOf(hash) {
  const r = await db(`chat_conversations?select=id,status&token_hash=eq.${q(hash)}`); if (!r.ok) throw new Error("db_read_" + r.status);
  return (await r.json())[0] || null;
}
async function verifyCaptcha(req, token) {
  const secret = env("TURNSTILE_SECRET_KEY");
  if (!secret) return env("REQUIRE_CAPTCHA", "1") === "0" ? { ok: true } : { ok: false, status: 503, code: "captcha_not_configured" };
  if (typeof token !== "string" || token.length < 10 || token.length > 2048) return { ok: false, status: 403, code: "captcha_required" };
  try {
    const f = new URLSearchParams({ secret, response: token, remoteip: clientIp(req) });
    const r = await withTimeout("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: f });
    const j = await r.json();
    return j && j.success === true ? { ok: true } : { ok: false, status: 403, code: "captcha_failed" };
  } catch (_) { return { ok: false, status: 503, code: "captcha_unavailable" }; }   // fail closed
}
// counts of recent visitor messages: per conversation (minute/hour), per network address, and for the whole site
async function count(filter, since, limit) {
  const r = await db(`chat_messages?select=id&sender=eq.visitor&created_at=gte.${q(since)}${filter}&limit=${limit}`);
  if (!r.ok) throw new Error("db_limit_" + r.status);                                // cannot check = refuse
  return (await r.json()).length;
}
async function rateLimited(convId, ipHash) {
  const L = LIMITS(), m = new Date(Date.now() - 60e3).toISOString(), h = new Date(Date.now() - 3600e3).toISOString();
  if (convId && (await count(`&conversation_id=eq.${convId}`, m, L.tokenMin)) >= L.tokenMin) return true;
  if (convId && (await count(`&conversation_id=eq.${convId}`, h, L.tokenHour)) >= L.tokenHour) return true;
  if ((await count(`&ip_hash=eq.${q(ipHash)}`, h, L.ipHour)) >= L.ipHour) return true;
  return (await count("", h, L.globalHour)) >= L.globalHour;
}

// ---------- actions ----------
async function send(req, body) {
  const text = clean(body.body, MAX_MESSAGE);
  if (!text) return reply(400, { ok: false, code: "empty" });
  const hash = await tokenHash(body.token), ipHash = await ipHashOf(clientIp(req)), conv = await conversationOf(hash);
  if (!conv) {                                    // a brand-new conversation must pass the CAPTCHA (existing ones are protected by the limits)
    const cap = await verifyCaptcha(req, body.captcha); if (!cap.ok) return reply(cap.status, { ok: false, code: cap.code });
  }
  if (await rateLimited(conv ? conv.id : null, ipHash)) return reply(429, { ok: false, code: "rate_limited" });
  const r = await db("rpc/chat_visitor_send", { method: "POST", body: JSON.stringify({ p_token_hash: hash, p_body: text, p_lang: body.lang === "en" ? "en" : "ar", p_ip_hash: ipHash }) });
  if (!r.ok) throw new Error("db_rpc_" + r.status);
  const row = (await r.json())[0];
  return reply(200, { ok: true, id: row ? row.out_message : null });
}
async function poll(body) {
  const hash = await tokenHash(body.token), conv = await conversationOf(hash);
  if (!conv) return reply(200, { ok: true, status: "none", messages: [] });                  // nothing yet: same answer for every unknown token
  const after = Math.max(0, Math.floor(Number(body.after) || 0));
  const r = await db(`chat_messages?select=id,sender,body,created_at&conversation_id=eq.${conv.id}&id=gt.${after}&order=id.asc&limit=100`);
  if (!r.ok) throw new Error("db_read_" + r.status);
  return reply(200, { ok: true, status: conv.status, messages: await r.json() });            // only this visitor's own conversation, no internal ids
}

async function readBody(req) {
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY) return { tooLarge: true };
  const t = await req.text(); if (t.length > MAX_BODY) return { tooLarge: true };
  try { const j = JSON.parse(t); return j && typeof j === "object" && !Array.isArray(j) ? { body: j } : { bad: true }; } catch (_) { return { bad: true }; }
}
async function handle(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (req.method !== "POST") return reply(405, { ok: false, code: "method" });
  if (!originOk(req)) return reply(403, { ok: false, code: "origin" });
  const rb = await readBody(req);
  if (rb.tooLarge) return reply(413, { ok: false, code: "too_large" });
  if (rb.bad) return reply(400, { ok: false, code: "bad_json" });
  const body = rb.body;
  if (typeof body.token !== "string" || !TOKEN_RE.test(body.token)) return reply(400, { ok: false, code: "bad_token" });
  if (!secretOk()) return reply(503, { ok: false, code: "not_configured" });
  try {
    if (body.action === "send") return await send(req, body);
    if (body.action === "poll") return await poll(body);
    return reply(400, { ok: false, code: "bad_action" });
  } catch (_) {
    return reply(503, { ok: false, code: "db_error" });                                     // no details, no secrets
  }
}
Deno.serve(handle);
