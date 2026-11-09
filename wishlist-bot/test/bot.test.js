import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { extractUrls, parseProductHtml, siteName, fetchProduct } from "../src/product.js";
import { buildPage, addProduct } from "../src/notion.js";
import worker, { linksFromMessage, verifySignature } from "../src/worker.js";

const OG_HTML = `<html><head>
<title>Fallback title</title>
<meta property="og:title" content="手工陶瓷馬克杯 &amp; 杯墊組">
<meta property="og:image" content="/img/mug.jpg">
<meta property="og:description" content="職人手作，每一個都獨一無二">
<meta property="product:price:amount" content="1,280">
</head></html>`;

const LD_HTML = `<html><head>
<meta property="og:title" content="OG name">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},
{"@type":"Product","name":"亞麻抱枕套","image":["https://cdn.example.com/p.jpg"],"description":"天然亞麻",
"offers":{"@type":"Offer","price":"590","priceCurrency":"TWD"}}]}</script>
</head></html>`;

test("extractUrls finds links inside Chinese text", () => {
  assert.deepEqual(extractUrls("好想要這個！https://www.pinkoi.com/product/abc123，好看"), [
    "https://www.pinkoi.com/product/abc123",
  ]);
  assert.deepEqual(extractUrls("沒有連結"), []);
});

test("siteName maps known shops", () => {
  assert.equal(siteName("https://www.pinkoi.com/product/x"), "Pinkoi");
  assert.equal(siteName("https://shopee.tw/x"), "蝦皮");
  assert.equal(siteName("https://www.momoshop.com.tw/goods"), "momo");
});

test("parses Open Graph tags", () => {
  const p = parseProductHtml(OG_HTML, "https://shop.example.com/item/1");
  assert.equal(p.title, "手工陶瓷馬克杯 & 杯墊組");
  assert.equal(p.image, "https://shop.example.com/img/mug.jpg");
  assert.equal(p.description, "職人手作，每一個都獨一無二");
  assert.equal(p.price, 1280);
});

test("prefers JSON-LD Product data", () => {
  const p = parseProductHtml(LD_HTML, "https://x.com");
  assert.equal(p.title, "亞麻抱枕套");
  assert.equal(p.image, "https://cdn.example.com/p.jpg");
  assert.equal(p.price, 590);
  assert.equal(p.currency, "TWD");
});

test("fetchProduct survives network errors", async () => {
  const p = await fetchProduct("https://www.pinkoi.com/x", async () => { throw new Error("boom"); });
  assert.equal(p.url, "https://www.pinkoi.com/x");
  assert.equal(p.site, "Pinkoi");
});

test("linksFromMessage reads text and shared attachments", () => {
  const urls = linksFromMessage({
    text: "看這個 https://a.com/1",
    attachments: [{ type: "share", payload: { url: "https://b.com/2" } }, { type: "image", payload: { url: "https://cdn/img.jpg" } }],
  });
  assert.deepEqual(urls, ["https://a.com/1", "https://b.com/2"]);
});

test("buildPage sets cover image and properties", () => {
  const page = buildPage({ NOTION_DATABASE_ID: "db" }, {
    url: "https://a.com", site: "Pinkoi", title: "杯子", image: "https://a.com/i.jpg", description: "d", price: 100,
  });
  assert.equal(page.cover.external.url, "https://a.com/i.jpg");
  assert.equal(page.properties["價格"].number, 100);
  assert.equal(page.properties["狀態"].select.name, "想買");
});

test("addProduct skips duplicates and creates new pages", async () => {
  const calls = [];
  const fake = (existing) => async (url, opts) => {
    calls.push(url);
    if (url.endsWith("/query")) return Response.json({ results: existing ? [{}] : [] });
    return Response.json({ id: "page" });
  };
  const env = { NOTION_TOKEN: "t", NOTION_DATABASE_ID: "db" };
  const p = { url: "https://a.com", site: "a.com", title: "x" };
  assert.equal(await addProduct(env, p, fake(true)), "duplicate");
  assert.equal(await addProduct(env, p, fake(false)), "added");
  assert.ok(calls.at(-1).endsWith("/pages"));
});

test("webhook verification and signature", async () => {
  const env = { IG_VERIFY_TOKEN: "secret", IG_APP_SECRET: "appsecret" };
  const ok = await worker.fetch(new Request("https://w/webhook?hub.mode=subscribe&hub.verify_token=secret&hub.challenge=42"), env, {});
  assert.equal(await ok.text(), "42");
  const bad = await worker.fetch(new Request("https://w/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42"), env, {});
  assert.equal(bad.status, 403);

  const body = '{"entry":[]}';
  const sig = "sha256=" + createHmac("sha256", "appsecret").update(body).digest("hex");
  assert.equal(await verifySignature(env, body, sig), true);
  assert.equal(await verifySignature(env, body, "sha256=00"), false);

  const res = await worker.fetch(new Request("https://w/webhook", { method: "POST", body, headers: { "X-Hub-Signature-256": sig } }), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  const rej = await worker.fetch(new Request("https://w/webhook", { method: "POST", body }), env, { waitUntil() {} });
  assert.equal(rej.status, 401);
});
