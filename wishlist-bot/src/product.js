// 從商品網頁抓出：名稱、圖片、簡介、價格、網站

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const SITE_NAMES = {
  "pinkoi.com": "Pinkoi",
  "shopee.tw": "蝦皮",
  "momoshop.com.tw": "momo",
  "pchome.com.tw": "PChome",
  "coupang.com": "酷澎",
  "tw.coupang.com": "酷澎",
  "books.com.tw": "博客來",
  "rakuten.com.tw": "樂天",
  "yahoo.com": "Yahoo 購物",
  "amazon.com": "Amazon",
  "amazon.co.jp": "Amazon JP",
  "uniqlo.com": "UNIQLO",
  "ikea.com": "IKEA",
  "instagram.com": "Instagram",
  "taobao.com": "淘寶",
  "tmall.com": "天貓",
};

const URL_RE = /https?:\/\/[^\s<>"'，。！？、）)\]]+/gi;

export function extractUrls(text) {
  if (!text) return [];
  return [...new Set(text.match(URL_RE) || [])];
}

export function siteName(url) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "其他";
  }
  for (const [domain, name] of Object.entries(SITE_NAMES)) {
    if (host === domain || host.endsWith("." + domain)) return name;
  }
  return host.split(".").slice(-3).join(".");
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function clean(s) {
  if (s == null) return "";
  return decodeEntities(String(s)).replace(/\s+/g, " ").trim();
}

function metaTags(html) {
  const out = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attr = (name) => {
      const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
      return m ? (m[2] ?? m[3]) : null;
    };
    const key = (attr("property") || attr("name") || attr("itemprop") || "").toLowerCase();
    const content = attr("content");
    if (key && content != null && !(key in out)) out[key] = clean(content);
  }
  return out;
}

function jsonLdProduct(html) {
  const blocks = html.match(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || [];
  const stack = [];
  for (const b of blocks) {
    try {
      stack.push(JSON.parse(b.replace(/^<script[^>]*>|<\/script>$/gi, "")));
    } catch {
      /* 有些網站的 JSON-LD 格式壞掉，跳過 */
    }
  }
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    const type = [].concat(node["@type"] || []);
    if (type.includes("Product")) return node;
    if (node["@graph"]) stack.push(node["@graph"]);
  }
  return null;
}

function firstImage(img) {
  if (!img) return null;
  if (Array.isArray(img)) return firstImage(img[0]);
  if (typeof img === "object") return img.url || img.contentUrl || null;
  return img;
}

export function parsePrice(v) {
  if (v == null || v === "") return null;
  const m = String(v).replace(/,/g, "").match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function absolutize(src, base) {
  if (!src) return null;
  try {
    return new URL(src, base).href;
  } catch {
    return null;
  }
}

/** 解析 HTML，回傳 { title, image, description, price, currency } */
export function parseProductHtml(html, pageUrl) {
  const meta = metaTags(html);
  const ld = jsonLdProduct(html) || {};
  const offer = [].concat(ld.offers || [])[0] || {};
  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];

  const title = clean(ld.name) || meta["og:title"] || meta["twitter:title"] || clean(titleTag) || "";
  const image =
    absolutize(firstImage(ld.image), pageUrl) ||
    absolutize(meta["og:image"] || meta["og:image:url"] || meta["twitter:image"], pageUrl);
  const description = clean(ld.description) || meta["og:description"] || meta["description"] || "";
  const price = parsePrice(
    offer.price ?? offer.lowPrice ?? meta["product:price:amount"] ?? meta["og:price:amount"] ?? meta["price"],
  );
  const currency = offer.priceCurrency || meta["product:price:currency"] || meta["og:price:currency"] || null;

  return { title, image, description, price, currency };
}

/** 下載網頁並解析。失敗時仍回傳只有網址的結果，讓商品照樣能加進清單。 */
export async function fetchProduct(url, fetchImpl = fetch) {
  const base = { url, site: siteName(url), title: "", image: null, description: "", price: null, currency: null };
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": UA, "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8", Accept: "text/html" },
      redirect: "follow",
    });
    const finalUrl = res.url || url;
    const html = (await res.text()).slice(0, 2_000_000);
    return { ...base, url: finalUrl, site: siteName(finalUrl), ...parseProductHtml(html, finalUrl) };
  } catch (err) {
    console.log("fetchProduct failed", url, String(err));
    return base;
  }
}
