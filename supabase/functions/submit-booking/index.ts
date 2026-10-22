const env = (name: string, fallback = "") => Deno.env.get(name) ?? fallback;
const MAX_BODY = 8192;
const MAX_MESSAGE = 2000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIMES = ["12:00 pm", "1:00 pm", "2:00 pm", "3:00 pm", "4:00 pm", "5:00 pm", "6:00 pm", "7:00 pm", "8:00 pm", "9:00 pm"];
const SERVICES = [
  "Check-up and cleaning",
  "Teeth whitening",
  "Fillings and repairs",
  "Crowns, bridges and dentures",
  "Root canal treatment",
  "Braces and aligners",
  "Dental implants",
  "Gum treatment and surgery",
  "Veneers and smile design",
  "Toothache or emergency",
];
const enc = new TextEncoder();

type Booking = {
  id: string;
  ref: string;
  created_at: string;
  name: string;
  email: string;
  phone: string;
  service: string;
  req_date: string;
  req_time: string;
  notes: string | null;
  lang: "ar" | "en";
  status: string;
  email_status: string;
  email_error: string | null;
  email_attempts: number;
  whatsapp_status: string;
  whatsapp_error: string | null;
  whatsapp_attempts: number;
  ip_hash: string | null;
};

function corsHeaders(request?: Request) {
  const configured = env("ALLOWED_ORIGIN").split(",").map((origin) => origin.trim()).filter(Boolean);
  const requestOrigin = request?.headers.get("origin") || "";
  const permitted = !requestOrigin || configured.length === 0 || configured.includes("*") ||
    configured.includes(requestOrigin);
  return {
    "Access-Control-Allow-Origin": requestOrigin && permitted
      ? requestOrigin
      : configured.includes("*") || configured.length === 0
      ? "*"
      : configured[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function response(status: number, value: Record<string, unknown>, request?: Request) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function allowedOrigin(request: Request) {
  const configured = env("ALLOWED_ORIGIN").split(",").map((origin) => origin.trim()).filter(Boolean);
  const origin = request.headers.get("origin");
  return !origin || configured.length === 0 || configured.includes("*") || configured.includes(origin);
}

async function readBody(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function timedFetch(url: string, init: RequestInit = {}, milliseconds = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), milliseconds);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function db(path: string, init: RequestInit = {}) {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const requestHeaders = new Headers(init.headers);
  requestHeaders.set("apikey", key);
  requestHeaders.set("Authorization", "Bearer " + key);
  requestHeaders.set("Content-Type", "application/json");
  return await timedFetch(url + "/rest/v1/" + path, { ...init, headers: requestHeaders });
}

async function getBooking(id: string) {
  const result = await db(
    "bookings?select=*&id=eq." + encodeURIComponent(id) + "&limit=1",
  );
  if (!result.ok) throw new Error("booking_read_failed");
  const rows = await result.json();
  return Array.isArray(rows) ? rows[0] as Booking | undefined : undefined;
}

async function patchBooking(id: string, values: Record<string, unknown>) {
  const result = await db("bookings?id=eq." + encodeURIComponent(id), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(values),
  });
  if (!result.ok) throw new Error("booking_update_failed");
}

async function hmacHex(message: string) {
  const secret = env("BOOKING_SECRET");
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message))),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function clientIp(request: Request) {
  return request.headers.get("cf-connecting-ip")?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || request.headers.get("x-forwarded-for")?.split(",").map((part) => part.trim()).filter(Boolean).at(-1)
    || "unknown";
}

async function ipHash(request: Request) {
  return (await hmacHex("booking-ip:" + clientIp(request))).slice(0, 32);
}

async function countRecent(filter: string, since: string, limit: number) {
  const result = await db(
    "bookings?select=id&created_at=gte." + encodeURIComponent(since) + filter + "&limit=" + limit,
  );
  if (!result.ok) throw new Error("rate_limit_check_failed");
  const rows = await result.json();
  return Array.isArray(rows) ? rows.length : limit;
}

async function rateLimited(email: string, hash: string) {
  const hour = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const day = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const ipHour = Number(env("RL_IP_HOUR", "10")) || 10;
  const ipDay = Number(env("RL_IP_DAY", "30")) || 30;
  const emailHour = Number(env("RL_EMAIL_HOUR", "3")) || 3;
  const emailDay = Number(env("RL_EMAIL_DAY", "6")) || 6;
  const globalHour = Number(env("RL_GLOBAL_HOUR", "100")) || 100;
  const globalDay = Number(env("RL_GLOBAL_DAY", "400")) || 400;
  const encodedIp = "&ip_hash=eq." + encodeURIComponent(hash);
  const encodedEmail = "&email=eq." + encodeURIComponent(email);
  return await countRecent(encodedIp, hour, ipHour) >= ipHour
    || await countRecent(encodedIp, day, ipDay) >= ipDay
    || await countRecent(encodedEmail, hour, emailHour) >= emailHour
    || await countRecent(encodedEmail, day, emailDay) >= emailDay
    || await countRecent("", hour, globalHour) >= globalHour
    || await countRecent("", day, globalDay) >= globalDay;
}

async function verifyCaptcha(request: Request, token: unknown) {
  const secret = env("TURNSTILE_SECRET_KEY");
  if (!secret) return { ok: false, code: "captcha_not_configured" };
  if (typeof token !== "string" || token.length < 10 || token.length > 2048) {
    return { ok: false, code: "captcha_required" };
  }
  const form = new URLSearchParams({
    secret,
    response: token,
    remoteip: clientIp(request),
  });
  try {
    const result = await timedFetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form },
    );
    const value = await result.json();
    const expectedHostname = env("TURNSTILE_HOSTNAME");
    if (value?.success === true && (!expectedHostname || value.hostname === expectedHostname)) {
      return { ok: true, code: "" };
    }
    return { ok: false, code: "captcha_failed" };
  } catch {
    return { ok: false, code: "captcha_unavailable" };
  }
}

async function adminId(request: Request): Promise<string | null> {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!bearer) return null;
  const userResponse = await timedFetch(env("SUPABASE_URL") + "/auth/v1/user", {
    headers: { apikey: env("SUPABASE_SERVICE_ROLE_KEY"), Authorization: "Bearer " + bearer },
  });
  if (!userResponse.ok) return null;
  const user = await userResponse.json();
  if (typeof user?.id !== "string" || !UUID_RE.test(user.id)) return null;
  const result = await db(
    "admins?select=user_id&user_id=eq." + encodeURIComponent(user.id) + "&limit=1",
  );
  if (!result.ok) throw new Error("admin_check_failed");
  const admins = await result.json();
  return Array.isArray(admins) && admins.some((admin) => admin.user_id === user.id) ? user.id : null;
}

function clean(value: unknown, length: number) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim().slice(0, length)
    : "";
}

function validateBooking(body: Record<string, unknown>) {
  const errors: Record<string, string> = {};
  const name = clean(body.name, 101);
  const email = clean(body.email, 255).toLowerCase();
  const phone = clean(body.phone, 41);
  const service = clean(body.service, 81);
  const date = clean(body.date, 11);
  const time = clean(body.time, 11).toLowerCase();
  const notes = clean(body.notes, 501);
  const lang = body.lang === "ar" ? "ar" : "en";

  if (name.length < 3 || name.length > 100) errors.name = "Enter your full name.";
  if (email.length > 254 || !EMAIL_RE.test(email)) errors.email = "Enter a valid email address.";
  if (!/^(\+?20|0)?1[0125]\d{8}$/.test(phone.replace(/[\s\-()]/g, ""))) {
    errors.phone = "Enter a valid Egyptian mobile number.";
  }
  if (!SERVICES.includes(service)) errors.service = "Choose a treatment.";
  if (notes.length > 500) errors.notes = "Notes must be 500 characters or fewer.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    errors.date = "Choose a valid appointment date.";
  } else {
    const parsed = new Date(date + "T00:00:00Z");
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      errors.date = "Choose a valid appointment date.";
    } else {
      const cairoToday = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Cairo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const daysFromToday = (parsed.getTime() - Date.parse(cairoToday + "T00:00:00Z")) / 86400000;
      if (daysFromToday < 0) errors.date = "Choose today or a later date.";
      if (daysFromToday > 90) errors.date = "Choose a date within the next 90 days.";
      if ([4, 5].includes(parsed.getUTCDay())) {
        errors.date = "The clinic is closed on Thursdays and Fridays.";
      }
      if (date === cairoToday) {
        const cairoParts = new Intl.DateTimeFormat("en-US", {
          timeZone: "Africa/Cairo",
          hour: "numeric",
          hourCycle: "h23",
        }).formatToParts(new Date());
        const currentHour = Number(cairoParts.find((part) => part.type === "hour")?.value || 0);
        const timeParts = /^(\d{1,2}):00 (am|pm)$/.exec(time);
        if (timeParts) {
          let requestedHour = Number(timeParts[1]) % 12;
          if (timeParts[2] === "pm") requestedHour += 12;
          if (requestedHour <= currentHour) errors.time = "Choose a future appointment time.";
        }
      }
    }
  }
  if (!TIMES.includes(time)) errors.time = "Choose an available appointment time.";
  if (!UUID_RE.test(String(body.id || ""))) errors.id = "The booking request is invalid.";
  return {
    errors,
    booking: {
      id: String(body.id || ""),
      name,
      email,
      phone,
      service,
      date,
      time,
      notes: notes || null,
      lang,
    },
  };
}

function bookingToken(id: string) {
  return hmacHex("booking-access:" + id);
}

function makeReference() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const part = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
  return "TF-" + part;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] || char);
}

function emailContent(booking: Booking) {
  const ar = booking.lang === "ar";
  const clinicName = env("CLINIC_NAME", "Dr. Tamer Fayez Dental Clinic");
  const date = booking.req_date;
  const time = booking.req_time;
  const details = [
    [ar ? "رقم الطلب" : "Request reference", booking.ref],
    [ar ? "الاسم" : "Name", booking.name],
    [ar ? "العلاج" : "Treatment", booking.service],
    [ar ? "التاريخ المطلوب" : "Requested date", date],
    [ar ? "الوقت المطلوب" : "Requested time", time],
    [ar ? "الهاتف" : "Phone", booking.phone],
  ];
  const htmlRows = details.map(([label, value]) =>
    `<tr><th style="padding:8px;text-align:start">${escapeHtml(label)}</th><td style="padding:8px">${escapeHtml(value)}</td></tr>`
  ).join("");
  const message = ar
    ? "استلمنا طلب موعدك. هذا الطلب ليس تأكيدًا للموعد؛ ستتواصل معك العيادة لتأكيده."
    : "We received your appointment request. This is not a confirmed appointment; the clinic will contact you to confirm it.";
  const text = [message, ...details.map(([label, value]) => `${label}: ${value}`)].join("\n");
  return {
    subject: ar ? `استلمنا طلب موعدك ${booking.ref}` : `Appointment request received ${booking.ref}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#173b3b"><h2>${escapeHtml(clinicName)}</h2><p>${escapeHtml(message)}</p><table style="border-collapse:collapse">${htmlRows}</table></div>`,
    text,
  };
}

function normalizedClinicNumber(value: string) {
  return value.replace(/\D/g, "");
}

async function sendEmail(booking: Booking) {
  const apiKey = env("RESEND_API_KEY");
  const from = env("EMAIL_FROM");
  if (!apiKey || !from) return { status: "not_configured", error: null };
  const content = emailContent(booking);
  try {
    const result = await timedFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env("EMAIL_FROM_NAME", "Dr. Tamer Fayez Clinic") + " <" + from + ">",
        to: [booking.email],
        subject: content.subject,
        html: content.html,
        text: content.text,
      }),
    });
    if (result.ok) return { status: "accepted", error: null };
    const value = await result.json().catch(() => null);
    return { status: "failed", error: clean(value?.message || "Email provider rejected the request.", 300) };
  } catch {
    return { status: "failed", error: "Email provider could not be reached." };
  }
}

async function sendWhatsApp(booking: Booking) {
  const token = env("WA_TOKEN");
  const phoneNumberId = env("WA_PHONE_NUMBER_ID");
  const template = env("WA_TEMPLATE");
  const to = normalizedClinicNumber(env("WA_TO", env("CLINIC_WHATSAPP", "201556277801")));
  if (!token || !phoneNumberId || !template || !to) return { status: "not_configured", error: null };
  const components = [{
    type: "body",
    parameters: [
      booking.ref,
      booking.name,
      booking.service,
      booking.req_date,
      booking.req_time,
      booking.phone,
    ].map((text) => ({ type: "text", text })),
  }];
  try {
    const result = await timedFetch(
      "https://graph.facebook.com/" + encodeURIComponent(env("WA_GRAPH_VERSION", "v22.0")) +
        "/" + encodeURIComponent(phoneNumberId) + "/messages",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "template",
          template: {
            name: template,
            language: { code: env("WA_TEMPLATE_LANG", "ar") },
            components,
          },
        }),
      },
    );
    if (result.ok) return { status: "accepted", error: null };
    const value = await result.json().catch(() => null);
    return { status: "failed", error: clean(value?.error?.message || "WhatsApp provider rejected the request.", 300) };
  } catch {
    return { status: "failed", error: "WhatsApp provider could not be reached." };
  }
}

async function runNotification(id: string, channel: "email" | "whatsapp") {
  const booking = await getBooking(id);
  if (!booking) throw new Error("booking_not_found");
  const statusKey = channel + "_status";
  const attemptsKey = channel + "_attempts";
  const errorKey = channel + "_error";
  const atKey = channel + "_at";
  const currentStatus = booking[statusKey] as string;
  if (currentStatus === "accepted") return;
  if (currentStatus === "sending") return;
  const attempts = Number(booking[attemptsKey] || 0);
  if (attempts >= 6) {
    await patchBooking(id, { [statusKey]: "failed", [errorKey]: "Maximum delivery attempts reached." });
    return;
  }
  await patchBooking(id, { [statusKey]: "sending", [errorKey]: null, [attemptsKey]: attempts + 1 });
  const result = channel === "email" ? await sendEmail(booking) : await sendWhatsApp(booking);
  await patchBooking(id, {
    [statusKey]: result.status,
    [errorKey]: result.error,
    [atKey]: result.status === "accepted" ? new Date().toISOString() : null,
  });
}

function publicBooking(booking: Booking, token: string) {
  return {
    ok: true,
    saved: true,
    ref: booking.ref,
    token,
    email: { status: booking.email_status },
    whatsapp: { status: booking.whatsapp_status },
  };
}

async function create(request: Request, body: Record<string, unknown>) {
  const captcha = await verifyCaptcha(request, body.captcha);
  if (!captcha.ok) return response(captcha.code === "captcha_not_configured" ? 503 : 403, { ok: false, code: captcha.code }, request);
  const validated = validateBooking(body);
  if (Object.keys(validated.errors).length) return response(400, { ok: false, errors: validated.errors }, request);
  if (env("BOOKING_SECRET").length < 32) return response(503, { ok: false, code: "not_configured" }, request);
  const bookingData = validated.booking;
  const hash = await ipHash(request);
  if (await rateLimited(bookingData.email, hash)) {
    return response(429, { ok: false, code: "rate_limited" }, request);
  }
  let booking = await getBooking(bookingData.id);
  if (booking) {
    if (booking.email !== bookingData.email || booking.phone !== bookingData.phone ||
      booking.service !== bookingData.service || booking.req_date !== bookingData.date ||
      booking.req_time.toLowerCase() !== bookingData.time) {
      return response(409, { ok: false, code: "booking_id_conflict" }, request);
    }
  } else {
    const reference = makeReference();
    const inserted = await db("bookings", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        id: bookingData.id,
        ref: reference,
        name: bookingData.name,
        email: bookingData.email,
        phone: bookingData.phone,
        service: bookingData.service,
        req_date: bookingData.date,
        req_time: bookingData.time,
        notes: bookingData.notes,
        lang: bookingData.lang,
        ip_hash: hash,
      }),
    });
    if (inserted.status === 409) booking = await getBooking(bookingData.id);
    else if (!inserted.ok) return response(inserted.status === 429 ? 429 : 503, { ok: false, code: "save_failed" }, request);
    else {
      const rows = await inserted.json();
      booking = Array.isArray(rows) ? rows[0] as Booking | undefined : undefined;
    }
    if (!booking) return response(503, { ok: false, code: "save_failed" }, request);
  }

  await Promise.all([
    runNotification(booking.id, "email"),
    runNotification(booking.id, "whatsapp"),
  ]);
  booking = await getBooking(booking.id);
  if (!booking) return response(503, { ok: false, code: "save_failed" }, request);
  return response(200, publicBooking(booking, await bookingToken(booking.id)), request);
}

async function retry(request: Request, body: Record<string, unknown>) {
  const id = String(body.id || "");
  if (!UUID_RE.test(id)) return response(400, { ok: false, code: "bad_id" }, request);
  const booking = await getBooking(id);
  if (!booking) return response(404, { ok: false, code: "not_found" }, request);
  const token = typeof body.token === "string" ? body.token : "";
  const authenticatedAdmin = token ? null : await adminId(request);
  const expected = await bookingToken(id);
  if (!constantTimeEqual(token, expected) && !authenticatedAdmin) {
    return response(403, { ok: false, code: "forbidden" }, request);
  }
  const channel = body.channel === "email" || body.channel === "whatsapp" ? body.channel : "all";
  if (channel === "all" || channel === "email") await runNotification(id, "email");
  if (channel === "all" || channel === "whatsapp") await runNotification(id, "whatsapp");
  const updated = await getBooking(id);
  if (!updated) return response(503, { ok: false, code: "booking_read_failed" }, request);
  return response(200, {
    ok: true,
    saved: true,
    ref: updated.ref,
    token: authenticatedAdmin ? undefined : token,
    email: { status: updated.email_status },
    whatsapp: { status: updated.whatsapp_status },
  }, request);
}

async function handle(request: Request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: allowedOrigin(request) ? 204 : 403,
      headers: corsHeaders(request),
    });
  }
  if (request.method !== "POST") return response(405, { ok: false, code: "method_not_allowed" }, request);
  if (!allowedOrigin(request)) return response(403, { ok: false, code: "origin_not_allowed" }, request);
  const body = await readBody(request);
  if (!body) return response(400, { ok: false, code: "bad_json" }, request);
  if (!env("SUPABASE_URL") || !env("SUPABASE_SERVICE_ROLE_KEY")) {
    return response(503, { ok: false, code: "not_configured" }, request);
  }

  try {
    if (body.action === "create") return await create(request, body);
    if (body.action === "retry") return await retry(request, body);
    return response(400, { ok: false, code: "bad_action" }, request);
  } catch {
    return response(503, { ok: false, code: "service_unavailable" }, request);
  }
}

Deno.serve(handle);
