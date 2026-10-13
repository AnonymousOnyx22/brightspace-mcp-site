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
<script>document.documentElement.classList.add("js");if(/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)||(/Macintosh/.test(navigator.userAgent)&&navigator.maxTouchPoints>1))document.documentElement.classList.add("phone")</script>
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

// ---------- personalized Claude extension ----------

export function cleanSchool(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
}

export const schoolFromSession = (session) =>
  cleanSchool(session?.custom_fields?.find?.((f) => f.key === "school")?.text?.value);

let baseExtension = null;
async function loadBaseExtension() {
  if (baseExtension) return baseExtension;
  const res = await fetch(`${publicUrl()}/pro/brightspace-mcp-pro.mcpb`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Couldn't load the extension (${res.status}).`);
  baseExtension = Buffer.from(await res.arrayBuffer());
  return baseExtension;
}

/** The extension with this student's key (and school, when known) already filled in. */
export async function personalizedExtension(key, school) {
  const { readEntry, replaceEntry } = await import("./zip.mjs");
  const zip = await loadBaseExtension();
  const manifest = JSON.parse(readEntry(zip, "manifest.json").toString("utf8"));
  manifest.user_config.license_key.default = key;
  if (school) manifest.user_config.school.default = school;
  return replaceEntry(zip, "manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
}

/** Sends the key email the first time the post-checkout page loads for a subscription. */
async function emailKeyOnce(session, subscriptionId, key, school) {
  const to = session.customer_details?.email;
  if (!to) return;
  try {
    const sub = typeof session.subscription === "object" ? session.subscription : await stripeCall("GET", `subscriptions/${subscriptionId}`);
    if (sub?.metadata?.key_emailed) return;
    const { sendKeyEmail } = await import("./email.mjs");
    if (await sendKeyEmail({ to, key, school })) {
      await stripeCall("POST", `subscriptions/${subscriptionId}`, { metadata: { key_emailed: new Date().toISOString() } });
    }
  } catch (error) {
    console.log(`Key email skipped: ${error.message}`);
  }
}

export async function claudeExtension(req) {
  const q = new URL(req.url).searchParams;
  let key = null;
  let school = cleanSchool(q.get("s"));
  try {
    const sessionId = q.get("session_id");
    if (sessionId && /^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
      const session = await stripeCall("GET", `checkout/sessions/${sessionId}`).catch(() => null);
      if (session?.status === "complete" && session.subscription) {
        key = licenseKeyFor(typeof session.subscription === "string" ? session.subscription : session.subscription.id);
        school = school || schoolFromSession(session);
      }
    } else if (q.get("k") && subscriptionFromKey(q.get("k"))) {
      key = q.get("k").trim();
    }
  } catch {
    key = null;
  }
  if (!key) return problem("Download not available", "This link needs a valid key. Use the link from the page you saw after checkout.", 404);
  try {
    const file = await personalizedExtension(key, school);
    // Streamed, because a buffered function response is capped near 6 MB.
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (sent >= file.length) return controller.close();
        controller.enqueue(new Uint8Array(file.subarray(sent, sent + 256 * 1024)));
        sent += 256 * 1024;
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="Brightspace MCP Pro.mcpb"',
        "content-length": String(file.length),
        ...HEADERS,
      },
    });
  } catch (error) {
    return problem("Download not available", `${esc(error.message)} Try again in a minute.`, 503);
  }
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
      payment_method_collection: "always",
      custom_fields: [{
        key: "school",
        label: { type: "custom", custom: "Your school's Brightspace address" },
        type: "text",
        optional: true,
        text: { maximum_length: 200 },
      }],
      subscription_data: { trial_period_days: 7 },
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
  const school = schoolFromSession(session);
  await emailKeyOnce(session, subscriptionId, key, school);
  const command = `curl -fsSL https://brightspacemcp.com/install.sh | bash -s -- ${key}`;
  return page("You're in", `
    <div class="hero">
      <p class="eyebrow enter" style="--i:0">Your 7-day free trial has started</p>
      <div class="only-phone">
        <h1 class="enter" style="--i:1">You're in. Finish on your laptop.</h1>
        <p class="lede enter" style="--i:2">Brightspace MCP works in the Claude app on your Mac or Windows laptop. Send yourself the setup link, then open it on your laptop. It takes about a minute.</p>
        <div class="cta-row enter" style="--i:3"><button class="btn primary" type="button" data-share="${publicUrl()}/start/#k=${esc(key)}${school ? `&s=${encodeURIComponent(school)}` : ""}">Send to my laptop</button></div>
        <p class="note">Or, on your laptop, go to <b>brightspacemcp.com/start</b> and paste your key:</p>
        <div class="cmd"><span>${esc(key)}</span><button class="copy" type="button" data-copy="${esc(key)}"><span>Copy</span></button></div>
        <p class="note">Nothing is charged for 7 days.</p>
      </div>
      <div class="only-laptop">
      <h1 class="enter" style="--i:1">Add it to Claude in one click.</h1>
      <p class="lede enter" style="--i:2">Works in the Claude app on Mac and Windows. No Terminal, nothing else to install.</p>
      <div class="setup enter" style="--i:3">
        <ol class="mini">
          <li>Open the <b>Claude app</b> on your computer. Don't have it? <a href="https://claude.ai/download" rel="noopener">Get it free</a>.</li>
          <li>Click <b>Add to Claude</b> below, then <b>drag the downloaded file into the Claude window</b>. Claude shows an <b>Install</b> screen.</li>
          <li>${school ? `Your key and school (<code>${esc(school)}</code>) are already filled in. Click <b>Install</b>.` : `Your key is already filled in. Add your school's Brightspace address (copy it from your browser, like <code>yourschool.brightspace.com</code>) and click <b>Install</b>.`}</li>
          <li>Ask Claude <i>"What should I work on right now?"</i> A window opens once so you can sign in to Brightspace.</li>
        </ol>
        <div class="cta-row"><a class="btn primary" href="/pro/claude.mcpb?session_id=${esc(sessionId)}" download>Add to Claude</a><a class="btn" href="/install/" target="_blank" rel="noopener">Step-by-step guide</a></div>
        <p class="note" style="margin-top:16px">Your key:</p>
        <div class="cmd"><span>${esc(key)}</span><button class="copy" type="button" data-copy="${esc(key)}"><span>Copy</span></button></div>
        <p class="note">We also emailed it to you. Save it somewhere safe: you need it on another computer or to manage billing.</p>
      </div>
      <details style="margin-top:24px">
        <summary>Using Cursor, VS Code, Windsurf or another AI app?</summary>
        <div class="setup" data-setup style="margin-top:14px">
          <div class="tabs" role="tablist" aria-label="Your computer">
            <button role="tab" type="button" data-os="win" aria-selected="true">Windows</button>
            <button role="tab" type="button" data-os="mac" aria-selected="false">Mac</button>
            <button role="tab" type="button" data-os="linux" aria-selected="false">Linux</button>
          </div>
          <div class="panel" data-panel="win">
            <ol class="mini"><li>Download your setup file and double-click it. Your key is already inside. If Node.js isn't installed, it opens the installer first: click through it, then double-click the setup file again.</li><li>If Windows shows "Windows protected your PC", click <b>More info</b>, then <b>Run anyway</b>.</li><li>Sign in to Brightspace in the window that opens.</li></ol>
            <div class="cta-row"><a class="btn" href="/pro/setup.cmd?session_id=${esc(sessionId)}" download>Download setup for Windows</a></div>
          </div>
          <div class="panel" data-panel="mac" hidden>
            <ol class="mini"><li>Tap <b>Copy</b> below.</li><li>Open <b>Terminal</b>: press <kbd>⌘</kbd> <kbd>Space</kbd>, type "Terminal", press Enter.</li><li>Paste with <kbd>⌘</kbd> <kbd>V</kbd>, press Enter, and sign in to Brightspace when the window opens.</li></ol>
            <div class="cmd big"><span class="p">$</span><span>${esc(command)}</span><button class="copy" type="button" data-copy="${esc(command)}"><span>Copy</span></button></div>
          </div>
          <div class="panel" data-panel="linux" hidden>
            <ol class="mini"><li>Open a terminal, paste this command and press Enter, then sign in to Brightspace.</li></ol>
            <div class="cmd big"><span class="p">$</span><span>${esc(command)}</span><button class="copy" type="button" data-copy="${esc(command)}"><span>Copy</span></button></div>
          </div>
        </div>
      </details>
      </div>
      <form method="POST" action="/api/manage" style="margin-top:24px"><input type="hidden" name="key" value="${esc(key)}"><button class="btn" type="submit">Manage or cancel subscription</button></form>
    </div>`);
}

async function completedKey(sessionId) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return null;
  const session = await stripeCall("GET", `checkout/sessions/${sessionId}`).catch(() => null);
  if (!session || session.status !== "complete" || !session.subscription) return null;
  return licenseKeyFor(typeof session.subscription === "string" ? session.subscription : session.subscription.id);
}

// A Windows setup file with the student's key built in, so setup is one double-click.
export async function windowsSetupFile(req) {
  const key = await completedKey(new URL(req.url).searchParams.get("session_id") || "");
  if (!key) return problem("Download not available", "This link only works after checkout.", 404);
  const lines = [
    "@echo off",
    "title Brightspace MCP setup",
    "echo.",
    "echo  Brightspace MCP setup",
    "echo  Connects D2L Brightspace to your AI apps and turns on alerts. It only reads, never changes anything.",
    "echo.",
    "where node >nul 2>nul",
    "if errorlevel 1 (",
    "  echo  Node.js is needed first. Opening the download page...",
    "  echo  Install it, then double-click this file again.",
    '  start "" https://nodejs.org/en/download',
    "  echo.",
    "  pause",
    "  exit /b 1",
    ")",
    `call npx -y https://brightspacemcp.com/pro/brightspace-mcp-pro.tgz setup --key ${key}`,
    "echo.",
    "pause",
  ];
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="brightspace-setup.cmd"',
      ...HEADERS,
    },
  });
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
    const portal = await stripeCall("POST", "billing_portal/sessions", {
      customer: sub.customer,
      return_url: `${publicUrl()}/pro/`,
      configuration: env("STRIPE_PORTAL_CONFIG") || undefined,
    });
    return redirect(portal.url);
  } catch (error) {
    return problem("Couldn't open billing", `${esc(error.message)} Use the <a href="/contact/">contact form</a> and we'll sort it out.`, 503);
  }
}
