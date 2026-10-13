import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

process.env.LICENSE_SECRET = "test-secret-test-secret-test-secret-0123";
process.env.STRIPE_SECRET_KEY = "sk_test_x";
process.env.STRIPE_PRICE_ID = "price_123";
process.env.PUBLIC_URL = "https://brightspacemcp.com";

const { licenseKeyFor, subscriptionFromKey } = await import("../netlify/lib/pro.mjs");
const handler = (await import("../netlify/functions/pro.mjs")).default;

let stripe;
beforeEach(() => {
  stripe = { calls: [], responses: {} };
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/pro/brightspace-mcp-pro.mcpb")) return new Response(fs.readFileSync("pro/brightspace-mcp-pro.mcpb"));
    const path = new URL(url).pathname.replace("/v1/", "");
    stripe.calls.push({ path, method: init.method, body: init.body?.toString() });
    const [status, body] = stripe.responses[`${init.method} ${path}`] ?? [404, { error: { message: "No such thing" } }];
    return new Response(JSON.stringify(body), { status });
  };
});

const post = (path, body) =>
  handler(new Request(`https://brightspacemcp.com${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

test("keys round-trip and reject tampering", () => {
  const key = licenseKeyFor("sub_1ABCdef");
  assert.match(key, /^bmp_1ABCdef_[A-Za-z0-9_-]{24}$/);
  assert.equal(subscriptionFromKey(key), "sub_1ABCdef");
  assert.equal(subscriptionFromKey(key.replace("1ABCdef", "1ABCdeg")), null);
  assert.equal(subscriptionFromKey("bmp_x_short"), null);
  assert.equal(subscriptionFromKey(undefined), null);
});

test("checkout creates a subscription session and redirects to Stripe", async () => {
  stripe.responses["POST checkout/sessions"] = [200, { url: "https://checkout.stripe.com/c/pay/cs_1" }];
  const res = await handler(new Request("https://brightspacemcp.com/api/checkout", { method: "POST" }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "https://checkout.stripe.com/c/pay/cs_1");
  const body = new URLSearchParams(stripe.calls[0].body);
  assert.equal(body.get("mode"), "subscription");
  assert.equal(body.get("line_items[0][price]"), "price_123");
  assert.equal(body.get("success_url"), "https://brightspacemcp.com/pro/activate?session_id={CHECKOUT_SESSION_ID}");
  assert.equal(body.get("subscription_data[trial_period_days]"), "7");
  assert.equal(body.get("payment_method_collection"), "always");
});

test("activation page shows the key only for a completed payment", async () => {
  stripe.responses["GET checkout/sessions/cs_done"] = [200, { status: "complete", subscription: "sub_9Zz" }];
  stripe.responses["GET checkout/sessions/cs_open"] = [200, { status: "open", subscription: null }];
  const ok = await handler(new Request("https://brightspacemcp.com/pro/activate?session_id=cs_done"));
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.ok(html.includes(`install.sh | bash -s -- ${licenseKeyFor("sub_9Zz")}`));
  assert.ok(html.includes("/pro/setup.cmd?session_id=cs_done"));
  assert.ok(html.includes(`data-share="https://brightspacemcp.com/start/#k=${licenseKeyFor("sub_9Zz")}"`));
  assert.equal((await handler(new Request("https://brightspacemcp.com/pro/activate?session_id=cs_open"))).status, 402);
  assert.equal((await handler(new Request("https://brightspacemcp.com/pro/activate?session_id=<script>"))).status, 400);
});

test("license check reports the subscription status", async () => {
  stripe.responses["GET subscriptions/sub_9Zz"] = [200, { status: "active", current_period_end: 1790000000, customer: "cus_1" }];
  const res = await post("/api/license", { key: licenseKeyFor("sub_9Zz") });
  assert.deepEqual(await res.json(), { active: true, status: "active", periodEnd: 1790000000 });

  stripe.responses["GET subscriptions/sub_9Zz"] = [200, { status: "canceled", items: { data: [{ current_period_end: 5 }] } }];
  assert.deepEqual(await (await post("/api/license", { key: licenseKeyFor("sub_9Zz") })).json(), { active: false, status: "canceled", periodEnd: 5 });

  const forged = await post("/api/license", { key: "bmp_9Zz_AAAAAAAAAAAAAAAAAAAAAAAA" });
  assert.equal(forged.status, 404);
  assert.equal(stripe.calls.length, 2, "forged keys never reach Stripe");
});

test("manage opens the Stripe billing portal for a valid key", async () => {
  stripe.responses["GET subscriptions/sub_9Zz"] = [200, { status: "active", customer: "cus_1" }];
  stripe.responses["POST billing_portal/sessions"] = [200, { url: "https://billing.stripe.com/p/session/x" }];
  const res = await post("/api/manage", { key: licenseKeyFor("sub_9Zz") });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "https://billing.stripe.com/p/session/x");
  assert.equal((await post("/api/manage", { key: "nope" })).status, 400);
});

test("only POST is accepted on the API", async () => {
  assert.equal((await handler(new Request("https://brightspacemcp.com/api/license"))).status, 405);
});

test("the Windows setup file carries the key, only after checkout", async () => {
  stripe.responses["GET checkout/sessions/cs_done"] = [200, { status: "complete", subscription: "sub_9Zz" }];
  const res = await handler(new Request("https://brightspacemcp.com/pro/setup.cmd?session_id=cs_done"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /brightspace-setup\.cmd/);
  const text = await res.text();
  assert.ok(text.includes(`setup --key ${licenseKeyFor("sub_9Zz")}\r\n`));
  assert.ok(text.startsWith("@echo off\r\n"));
  assert.equal((await handler(new Request("https://brightspacemcp.com/pro/setup.cmd?session_id=cs_nope"))).status, 404);
});

test("checkout asks for the school", async () => {
  stripe.responses["POST checkout/sessions"] = [200, { url: "https://checkout.stripe.com/x" }];
  await handler(new Request("https://brightspacemcp.com/api/checkout", { method: "POST" }));
  const body = new URLSearchParams(stripe.calls[0].body);
  assert.equal(body.get("custom_fields[0][key]"), "school");
  assert.equal(body.get("custom_fields[0][optional]"), "true");
});

test("Add to Claude downloads the extension with key and school filled in", async () => {
  const { readEntry } = await import("../netlify/lib/zip.mjs");
  stripe.responses["GET checkout/sessions/cs_done"] = [200, {
    status: "complete", subscription: "sub_9Zz",
    custom_fields: [{ key: "school", text: { value: "  fleming.brightspace.com\u0007 " } }],
  }];
  const res = await handler(new Request("https://brightspacemcp.com/pro/claude.mcpb?session_id=cs_done"));
  assert.equal(res.status, 200);
  const manifest = JSON.parse(readEntry(Buffer.from(await res.arrayBuffer()), "manifest.json"));
  assert.equal(manifest.user_config.license_key.default, licenseKeyFor("sub_9Zz"));
  assert.equal(manifest.user_config.school.default, "fleming.brightspace.com");

  const page = await (await handler(new Request("https://brightspacemcp.com/pro/activate?session_id=cs_done"))).text();
  assert.ok(page.includes("/pro/claude.mcpb?session_id=cs_done"));
  assert.ok(page.includes("are already filled in"));

  const byKey = await handler(new Request(`https://brightspacemcp.com/pro/claude.mcpb?k=${licenseKeyFor("sub_9Zz")}&s=x.brightspace.com`));
  assert.equal(JSON.parse(readEntry(Buffer.from(await byKey.arrayBuffer()), "manifest.json")).user_config.school.default, "x.brightspace.com");
  assert.equal((await handler(new Request("https://brightspacemcp.com/pro/claude.mcpb?k=bmp_9Zz_AAAAAAAAAAAAAAAAAAAAAAAA"))).status, 404);
});

test("the key is emailed once, through Resend, and marked on the subscription", async () => {
  process.env.RESEND_API_KEY = "re_test";
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) === "https://api.resend.com/emails") { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
    return realFetch(url, init);
  };
  stripe.responses["GET checkout/sessions/cs_done"] = [200, { status: "complete", subscription: "sub_9Zz", customer_details: { email: "student@example.com" } }];
  stripe.responses["GET subscriptions/sub_9Zz"] = [200, { id: "sub_9Zz", metadata: {} }];
  stripe.responses["POST subscriptions/sub_9Zz"] = [200, { id: "sub_9Zz" }];
  await handler(new Request("https://brightspacemcp.com/pro/activate?session_id=cs_done"));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["student@example.com"]);
  assert.ok(sent[0].text.includes(licenseKeyFor("sub_9Zz")));
  assert.ok(stripe.calls.some((c) => c.path === "subscriptions/sub_9Zz" && c.method === "POST" && c.body.includes("key_emailed")));

  stripe.responses["GET subscriptions/sub_9Zz"] = [200, { id: "sub_9Zz", metadata: { key_emailed: "2026-10-13" } }];
  await handler(new Request("https://brightspacemcp.com/pro/activate?session_id=cs_done"));
  assert.equal(sent.length, 1, "not sent twice");
  delete process.env.RESEND_API_KEY;
});
