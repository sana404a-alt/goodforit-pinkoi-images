// 把商品寫進 Notion「🛍️ 想買的東西」資料庫

const NOTION_VERSION = "2022-06-28";

function notion(env, path, body, fetchImpl) {
  return fetchImpl(`https://api.notion.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const text = (s, max = 1900) => [{ type: "text", text: { content: String(s).slice(0, max) } }];

export async function alreadySaved(env, url, fetchImpl = fetch) {
  const res = await notion(
    env,
    `databases/${env.NOTION_DATABASE_ID}/query`,
    { filter: { property: "連結", url: { equals: url } }, page_size: 1 },
    fetchImpl,
  );
  if (!res.ok) return false;
  const data = await res.json();
  return data.results?.length > 0;
}

export function buildPage(env, p) {
  const properties = {
    商品: { title: text(p.title || p.url, 200) },
    連結: { url: p.url },
    網站: { select: { name: p.site.replace(/,/g, " ") } },
    狀態: { select: { name: "想買" } },
  };
  if (p.description) properties["簡介"] = { rich_text: text(p.description, 300) };
  if (p.price != null) properties["價格"] = { number: p.price };
  if (p.image) properties["圖片網址"] = { url: p.image };

  const children = [];
  if (p.image) children.push({ type: "image", image: { type: "external", external: { url: p.image } } });
  if (p.description) children.push({ type: "paragraph", paragraph: { rich_text: text(p.description) } });
  children.push({ type: "bookmark", bookmark: { url: p.url } });

  const page = { parent: { database_id: env.NOTION_DATABASE_ID }, properties, children };
  if (p.image) page.cover = { type: "external", external: { url: p.image } };
  return page;
}

/** 新增商品。回傳 "added" | "duplicate"，失敗時 throw。 */
export async function addProduct(env, p, fetchImpl = fetch) {
  if (await alreadySaved(env, p.url, fetchImpl)) return "duplicate";

  let res = await notion(env, "pages", buildPage(env, p), fetchImpl);
  if (!res.ok && p.image) {
    // 有些圖片網址 Notion 不接受，拿掉圖片再試一次
    console.log("Notion rejected page with image, retrying without", await res.text());
    res = await notion(env, "pages", buildPage(env, { ...p, image: null }), fetchImpl);
  }
  if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
  return "added";
}
