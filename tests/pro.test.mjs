import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

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
});

test("activation page shows the key only for a completed payment", async () => {
  stripe.responses["GET checkout/sessions/cs_done"] = [200, { status: "complete", subscription: "sub_9Zz" }];
  stripe.responses["GET checkout/sessions/cs_open"] = [200, { status: "open", subscription: null }];
  const ok = await handler(new Request("https://brightspacemcp.com/pro/activate?session_id=cs_done"));
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.ok(html.includes(`pro activate ${licenseKeyFor("sub_9Zz")}`));
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
