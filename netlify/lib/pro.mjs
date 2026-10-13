// Pro checkout and licensing. Stripe is the only record: a license key is the
// Stripe subscription id plus an HMAC, so nothing about students is stored here.
import { createHmac, timingSafeEqual } from "node:crypto";

export function env(name, fallback = "") {
  return (globalThis.Netlify?.env?.get?.(name) ?? process.env[name] ?? fallback).trim();
}

const publicUrl = () => env("PUBLIC_URL", "https://brightspacemcp.com").replace(/\/$/, "");

// ---------- license keys ----------

function signature(subscriptionId) {
  const secret = env("LICENSE_SECRET");
  if (secret.length < 32) throw new Error("LICENSE_SECRET is not set.");
  return createHmac("sha256", secret).update(subscriptionId).digest("base64url").slice(0, 24);
}

export function licenseKeyFor(subscriptionId) {
  if (!/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) throw new Error("Unexpected subscription id.");
  return `bmp_${subscriptionId.slice(4)}_${signature(subscriptionId)}`;
}

/** The subscription id inside a key, or null if the key is malformed or forged. */
export function subscriptionFromKey(key) {
  const match = /^bmp_([A-Za-z0-9]+)_([A-Za-z0-9_-]{16,})$/.exec(String(key ?? "").trim());
  if (!match) return null;
  const id = `sub_${match[1]}`;
  const expected = Buffer.from(signature(id));
  const given = Buffer.from(match[2]);
  return expected.length === given.length && timingSafeEqual(expected, given) ? id : null;
}

// ---------- Stripe ----------

function form(value, prefix = "", out = new URLSearchParams()) {
  if (value === undefined || value === null) return out;
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) form(v, prefix ? `${prefix}[${k}]` : k, out);
  } else {
    out.append(prefix, String(value));
  }
  return out;
}

export async function stripeCall(method, path, params) {
  const key = env("STRIPE_SECRET_KEY");
  if (!key) throw new Error("Payments aren't set up yet.");
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
    body: params ? form(params) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(json.error?.message || `Stripe error ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return json;
}

const periodEnd = (sub) => sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;

// ---------- responses ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...HEADERS } });

const redirect = (url) => new Response(null, { status: 303, headers: { location: url, ...HEADERS } });

function page(title, body, status = 200) {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/styles.css">
<script>document.documentElement.classList.add("js")</script>
</head>
<body>
<div class="wrap page">
  <header class="top">
    <a class="brand" href="/"><span class="brand-mark"><svg width="18" height="18" viewBox="0 0 64 64" aria-hidden="true"><path d="M14 33l11 11 25-27" stroke="#ff6a3d" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Brightspace MCP</a>
    <nav><a class="gh" href="/pro/">Pro</a></nav>
  </header>
  <main>
${body}
  </main>
  <footer><p>Brightspace D2L MCP Server. Not affiliated with D2L. · <a href="/privacy/">Privacy</a> · <a href="/terms/">Terms</a> · <a href="/contact/">Contact</a></p></footer>
</div>
<script src="/site.js" defer></script>
</body>
</html>`, { status, headers: { "content-type": "text/html; charset=utf-8", ...HEADERS } });
}

const problem = (title, message, status = 400) =>
  page(title, `<div class="hero"><h1>${esc(title)}</h1><p class="lede">${message}</p><a class="btn" href="/pro/">Back to Pro</a></div>`, status);

async function readBody(req) {
  const type = req.headers.get("content-type") || "";
  if (type.includes("application/json")) return req.json().catch(() => ({}));
  return Object.fromEntries(new URLSearchParams(await req.text()));
}

// ---------- routes ----------

export async function checkout() {
  try {
    const session = await stripeCall("POST", "checkout/sessions", {
      mode: "subscription",
      line_items: [{ price: env("STRIPE_PRICE_ID"), quantity: 1 }],
      success_url: `${publicUrl()}/pro/activate?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${publicUrl()}/pro/`,
      allow_promotion_codes: true,
    });
    return redirect(session.url);
  } catch (error) {
    return problem("Checkout isn't available", `${esc(error.message)} Please try again in a little while.`, 503);
  }
}

export async function activatePage(req) {
  const sessionId = new URL(req.url).searchParams.get("session_id") || "";
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return problem("Missing payment", "This page needs the link Stripe sent you back with.");
  let session;
  try {
    session = await stripeCall("GET", `checkout/sessions/${sessionId}`);
  } catch {
    return problem("Couldn't find that payment", "If you just paid, refresh this page in a few seconds.", 404);
  }
  if (session.status !== "complete" || !session.subscription) {
    return problem("Payment not finished", "Stripe hasn't confirmed the payment yet. Refresh this page in a few seconds.", 402);
  }
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
  const key = licenseKeyFor(subscriptionId);
  const command = `npx brightspace-d2l-mcp pro activate ${key}`;
  return page("Your Pro key", `
    <div class="hero">
      <p class="eyebrow enter" style="--i:0">Payment received</p>
      <h1 class="enter" style="--i:1">You're Pro. One last step.</h1>
      <p class="lede enter" style="--i:2">Run this on the computer where you set up the free version. It turns on deadline alerts, the daily digest, grade alerts and calendar sync.</p>
      <div class="cmd big enter" style="--i:3"><span class="p">$</span><span>${esc(command)}</span><button class="copy" type="button" data-copy="${esc(command)}"><span>Copy</span></button></div>
      <p class="note">Save your key somewhere safe. You'll need it to activate Pro on another computer: <code>${esc(key)}</code></p>
      <p class="note">Haven't set up the free version yet? <a href="/#setup">Do that first</a>, then run the command above.</p>
      <form method="POST" action="/api/manage" style="margin-top:24px"><input type="hidden" name="key" value="${esc(key)}"><button class="btn" type="submit">Manage or cancel subscription</button></form>
    </div>`);
}

export async function license(req) {
  const { key } = await readBody(req);
  let id;
  try {
    id = subscriptionFromKey(key);
  } catch {
    return json({ active: false, status: "unavailable" }, 503);
  }
  if (!id) return json({ active: false, status: "invalid" }, 404);
  try {
    const sub = await stripeCall("GET", `subscriptions/${id}`);
    return json({ active: ["active", "trialing"].includes(sub.status), status: sub.status, periodEnd: periodEnd(sub) });
  } catch (error) {
    if (error.status === 404) return json({ active: false, status: "invalid" }, 404);
    return json({ active: false, status: "unavailable" }, 503);
  }
}

export async function manage(req) {
  const { key } = await readBody(req);
  let id = null;
  try {
    id = subscriptionFromKey(key);
  } catch {
    // fall through to the error page
  }
  if (!id) return problem("That key isn't valid", "Check the key you saved after paying, or use the <a href=\"/contact/\">contact form</a>.");
  try {
    const sub = await stripeCall("GET", `subscriptions/${id}`);
    const portal = await stripeCall("POST", "billing_portal/sessions", { customer: sub.customer, return_url: `${publicUrl()}/pro/` });
    return redirect(portal.url);
  } catch (error) {
    return problem("Couldn't open billing", `${esc(error.message)} Use the <a href="/contact/">contact form</a> and we'll sort it out.`, 503);
  }
}
