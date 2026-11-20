# 🛍️ wishlist-bot：Instagram 傳連結 → Notion「想買的東西」

在 Instagram 私訊傳商品連結，機器人會抓商品的**圖片、名稱、簡介、價格**，加進 Notion
[每月錢的分配表 › 🛍️ 想買的東西](https://app.notion.com/p/fb114b862f19483db32f22e7849a7c38)。
連結傳越多，「商品牆」上的卡片越多（新的排最前面）。

```
你的 IG 帳號 ──私訊連結──▶ 機器人 IG 帳號（專業帳號）
                              │ Meta webhook
                              ▼
                     Cloudflare Worker（這個資料夾）
                       ├─ 抓網頁：og:image / og:title / 價格
                       └─ Notion API 新增一張卡片 ──▶ 🛍️ 想買的東西
                              │
                              └─ 回覆你「已加入：xxx（$590）」
```

## Notion 欄位

| 欄位 | 說明 |
| --- | --- |
| 商品 | 商品名稱（抓不到就放網址） |
| 價格 | 數字，可以拿來加總「想買的東西總共要多少錢」 |
| 簡介 | 網頁上的商品描述 |
| 連結 / 網站 | 原始連結、Pinkoi / 蝦皮 / momo… |
| 狀態 | 想買 → 存錢中 → 已買 / 不買了（預設「想買」） |
| 圖片網址 | 商品圖，同時設成卡片封面 |
| 加入時間 | 自動 |

同一個連結傳兩次不會重複加入。

## 兩種用法

Instagram 不讓程式讀「個人帳號」的私訊，所以至少要有一個**專業帳號（創作者或商業，免費）**。

- **A. 傳給自己（推薦）**：把你自己的帳號切成專業帳號，在 IG 傳訊息給**自己**。
  Meta 稱為 self messaging，webhook 會帶 `is_self: true`，不用設定白名單。
- **B. 另開機器人帳號**：開一個專業帳號當機器人，你用個人帳號傳連結給它，
  要做下面第 4 步的白名單綁定。

機器人回覆都以 🤖 開頭、不含網址，所以自我傳訊時不會自己觸發自己。

## 設定步驟

### 1. Notion integration
1. 到 <https://www.notion.so/profile/integrations> 建立 Internal integration，複製 secret。
2. 打開「🛍️ 想買的東西」頁面 → 右上 `⋯` → **連線** → 加入剛剛的 integration。

### 2. 部署 Worker（免費）
```bash
cd wishlist-bot
npm install
npx wrangler login
npx wrangler secret put NOTION_TOKEN      # 貼上 Notion secret
npx wrangler secret put IG_VERIFY_TOKEN   # 自己取一串亂碼，等一下 Meta 要填一樣的
npx wrangler secret put ADD_TOKEN         # （可選）備用 /add 用的密碼
npx wrangler deploy                       # 會得到 https://wishlist-bot.<你>.workers.dev
```

### 3. Meta / Instagram
1. 開一個 IG **專業帳號**當機器人。
2. 到 <https://developers.facebook.com/apps> 建立 App → 加入 **Instagram** 產品 →
   「API setup with Instagram login」→ 連結機器人帳號，產生 **access token**。
3. Webhooks：
   - Callback URL：`https://wishlist-bot.<你>.workers.dev/webhook`
   - Verify token：跟 `IG_VERIFY_TOKEN` 一樣
   - 訂閱欄位：`messages`
4. 把 App Secret 和 access token 存進 Worker：
   ```bash
   npx wrangler secret put IG_APP_SECRET
   npx wrangler secret put IG_ACCESS_TOKEN
   ```
5. App 保持「開發模式」即可（只有你自己用）；在 App 角色裡把你自己的 IG 帳號加為測試人員。

### 4. 綁定你的帳號（只有用法 B 需要，防止陌生人亂加）
1. 用你的個人 IG 傳任何一則訊息給機器人帳號。
2. 機器人會回覆 `你的 sender id 是：1234…`。
3. 填進 `wrangler.toml` 的 `ALLOWED_SENDER_IDS`，再 `npx wrangler deploy`。

之後就可以一直丟連結了 🎉

## 備用：不用 IG 也能加
`POST /add` 接受任何含網址的文字，可以做成 iPhone「捷徑」放進分享選單：
```bash
curl -X POST https://wishlist-bot.<你>.workers.dev/add \
  -H "Authorization: Bearer <ADD_TOKEN>" -H "Content-Type: application/json" \
  -d '{"url":"https://www.pinkoi.com/product/xxxx"}'
```

## 已知限制
- 蝦皮、淘寶等用 JavaScript 產生頁面的網站，有時只抓得到名稱、抓不到圖或價格——卡片還是會加，可以在 Notion 手動補。
- Instagram 貼文分享過來時，IG 常常擋爬蟲，可能只有連結。

## 測試
```bash
npm test
```
