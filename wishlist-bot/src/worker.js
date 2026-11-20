// Cloudflare Worker：接收 Instagram 私訊 → 抓商品資訊 → 加進 Notion「想買的東西」
//
// 路由：
//   GET  /webhook   Meta 驗證 webhook（hub.challenge）
//   POST /webhook   Instagram 私訊事件
//   POST /add       備用：直接送 {"url": "..."}（例如 iPhone 捷徑），需 Bearer ADD_TOKEN

import { extractUrls, fetchProduct, siteName } from "./product.js";
import { addProduct } from "./notion.js";

const enc = new TextEncoder();

async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifySignature(env, body, header) {
  if (!env.IG_APP_SECRET) return false;
  if (!header?.startsWith("sha256=")) return false;
  return safeEqual(header.slice(7), await hmacHex(env.IG_APP_SECRET, body));
}

/** 從一則私訊中找出所有連結（文字裡的網址 + 分享的貼文/連結附件） */
export function linksFromMessage(message) {
  const urls = extractUrls(message?.text);
  for (const a of message?.attachments || []) {
    const u = a?.payload?.url;
    if (u && /^https?:\/\//.test(u) && a.type !== "image" && a.type !== "video" && a.type !== "audio") urls.push(u);
  }
  return [...new Set(urls)];
}

async function reply(env, recipientId, textMsg) {
  if (!env.IG_ACCESS_TOKEN) return;
  const res = await fetch("https://graph.instagram.com/v21.0/me/messages", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.IG_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text: textMsg } }),
  });
  if (!res.ok) console.log("IG reply failed", res.status, await res.text());
}

function allowed(env, senderId) {
  const ids = (env.ALLOWED_SENDER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.includes(String(senderId));
}

export async function saveLinks(env, urls) {
  const results = [];
  for (const url of urls) {
    try {
      const product = await fetchProduct(url);
      const status = await addProduct(env, product);
      results.push({ url, status, title: product.title, price: product.price });
    } catch (err) {
      console.log("save failed", url, String(err));
      results.push({ url, status: "error", error: String(err) });
    }
  }
  return results;
}

// 機器人回覆的開頭。自我傳訊時，機器人的回覆也會送回 webhook，用這個記號略過，避免無限循環。
export const BOT_PREFIX = "🤖";

// 回覆裡刻意不放網址（同樣是為了避免自我傳訊時又被當成新連結）
export function summary(results) {
  const lines = results.map((r) => {
    const name = (r.title || siteName(r.url)).replace(/https?:\/\/\S+/g, "").trim() || "商品";
    if (r.status === "added") return `🛍️ 已加入「想買的東西」：${name}${r.price ? `（$${r.price}）` : ""}`;
    if (r.status === "duplicate") return `👌 這個已經在清單裡了：${name}`;
    return `⚠️ 加入失敗：${name}`;
  });
  return `${BOT_PREFIX} ${lines.join("\n")}`;
}

export async function handleEvent(env, event, deps = { saveLinks, reply }) {
  const senderId = event.sender?.id;
  const message = event.message;
  if (!senderId || !message || message.is_deleted) return;
  if (message.text?.startsWith(BOT_PREFIX)) return; // 機器人自己的回覆

  let replyTo;
  if (message.is_self) {
    // 自我傳訊：連結到 App 的帳號傳訊息給自己。webhook 已驗證簽章，只有本人做得到，不用白名單。
    replyTo = event.recipient?.id;
  } else if (message.is_echo) {
    return; // 帳號傳給別人的訊息，不處理
  } else if (allowed(env, senderId)) {
    replyTo = senderId;
  } else {
    // 還沒設定白名單時，告訴對方自己的 id，方便填進 ALLOWED_SENDER_IDS
    console.log("message from non-allowed sender", senderId);
    if (!env.ALLOWED_SENDER_IDS)
      await deps.reply(env, senderId, `${BOT_PREFIX} 你的 sender id 是：${senderId}\n請把它設定到 ALLOWED_SENDER_IDS`);
    return;
  }

  const urls = linksFromMessage(message);
  if (urls.length === 0) return;
  const results = await deps.saveLinks(env, urls);
  if (replyTo) await deps.reply(env, replyTo, summary(results));
}

async function handleWebhookPost(request, env, ctx) {
  const body = await request.text();
  if (!(await verifySignature(env, body, request.headers.get("X-Hub-Signature-256")))) {
    return new Response("bad signature", { status: 401 });
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const events = (payload.entry || []).flatMap((e) => e.messaging || []);
  // Meta 要求盡快回 200，實際處理放背景
  ctx.waitUntil(Promise.all(events.map((ev) => handleEvent(env, ev).catch((e) => console.log("event error", String(e))))));
  return new Response("EVENT_RECEIVED");
}

async function handleAdd(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.ADD_TOKEN || !safeEqual(auth, `Bearer ${env.ADD_TOKEN}`)) return new Response("unauthorized", { status: 401 });
  const ct = request.headers.get("Content-Type") || "";
  const raw = ct.includes("json") ? JSON.stringify(await request.json()) : await request.text();
  const urls = extractUrls(raw);
  if (urls.length === 0) return Response.json({ error: "no url" }, { status: 400 });
  const results = await saveLinks(env, urls);
  return Response.json({ message: summary(results), results });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "GET") {
      const ok =
        url.searchParams.get("hub.mode") === "subscribe" &&
        env.IG_VERIFY_TOKEN &&
        url.searchParams.get("hub.verify_token") === env.IG_VERIFY_TOKEN;
      return ok ? new Response(url.searchParams.get("hub.challenge")) : new Response("forbidden", { status: 403 });
    }
    if (url.pathname === "/webhook" && request.method === "POST") return handleWebhookPost(request, env, ctx);
    if (url.pathname === "/add" && request.method === "POST") return handleAdd(request, env);

    return new Response("wishlist-bot OK");
  },
};
