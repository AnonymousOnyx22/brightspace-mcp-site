// Emails a new subscriber their key, once per subscription, through Resend.
// Stripe is the record of whether it was sent (subscription metadata), so
// nothing about the student is stored on this site.
import { env } from "./pro.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function keyEmail({ key, school, site = "https://brightspacemcp.com" }) {
  const claude = `${site}/pro/claude.mcpb?k=${encodeURIComponent(key)}${school ? `&s=${encodeURIComponent(school)}` : ""}`;
  const start = `${site}/start/#k=${encodeURIComponent(key)}${school ? `&s=${encodeURIComponent(school)}` : ""}`;
  const subject = "Your Brightspace MCP key";
  const text = [
    "Thanks for starting your Brightspace MCP trial.",
    "",
    `Your key: ${key}`,
    "",
    "Set it up on your Mac or Windows laptop:",
    `1. Open this link on the laptop: ${start}`,
    "2. Open the Claude app, click Add to Claude, drag the downloaded file into the Claude window and click Install.",
    "3. Ask Claude \"What should I work on right now?\" and sign in to Brightspace once.",
    "",
    "Your trial is free for 7 days, then $4 CAD a month. Manage or cancel anytime:",
    `${site}/pro/#manage`,
    "",
    `Questions? ${site}/contact/`,
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f7f8fb;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#141a2e">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
  <p style="font-weight:700;font-size:18px;margin:0 0 24px">Brightspace MCP</p>
  <h1 style="font-size:24px;margin:0 0 12px">Your key is ready</h1>
  <p style="color:#5a6280;line-height:1.6;margin:0 0 20px">Thanks for starting your trial. Set it up on your Mac or Windows laptop in about a minute.</p>
  <p style="margin:0 0 6px;color:#5a6280;font-size:14px">Your key</p>
  <p style="font-family:Menlo,Consolas,monospace;background:#0f1528;color:#e8ecf8;padding:14px 16px;border-radius:10px;word-break:break-all;margin:0 0 24px">${esc(key)}</p>
  <p style="margin:0 0 24px"><a href="${esc(start)}" style="display:inline-block;background:#e8562b;color:#fff;text-decoration:none;font-weight:600;padding:14px 22px;border-radius:12px">Finish setup on your laptop</a></p>
  <ol style="color:#5a6280;line-height:1.7;padding-left:20px;margin:0 0 24px">
    <li>Open the button above on your laptop and click <b>Add to Claude</b>. <a href="${esc(claude)}" style="color:#e8562b">Direct download</a></li>
    <li>Drag the downloaded file into the Claude app and click <b>Install</b>.</li>
    <li>Ask Claude "What should I work on right now?" and sign in to Brightspace once.</li>
  </ol>
  <p style="color:#5a6280;font-size:14px;line-height:1.6;margin:0">Free for 7 days, then $4 CAD a month. <a href="${esc(site)}/pro/#manage" style="color:#e8562b">Manage or cancel</a> anytime. Questions? <a href="${esc(site)}/contact/" style="color:#e8562b">Contact us</a>.</p>
</div></body></html>`;
  return { subject, text, html };
}

export async function sendKeyEmail({ to, key, school }) {
  const apiKey = env("RESEND_API_KEY");
  if (!apiKey || !to) return false;
  const { subject, text, html } = keyEmail({ key, school });
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env("RESEND_FROM", "Brightspace MCP <hello@brightspacemcp.com>"), to: [to], subject, text, html }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.log(`Key email not sent (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return false;
  }
  return true;
}
