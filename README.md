# Forward P/E 河流圖工具

追蹤券商報告裡的預估EPS，隨時間累積，算出每次報告發布當下的 Forward P/E（NTM 或次一年度年度EPS備援），並可疊加每日股價走勢。

## 檔案結構

```
index.html   頁面骨架，載入 style.css 與 app.js
style.css    樣式（含 light/dark 兩種配色，跟隨系統設定）
app.js       全部邏輯：資料模型、計算、渲染、事件綁定
```

單純用瀏覽器打開 `index.html` 就能執行，不需要任何建置工具或伺服器（純靜態頁面）。也可以直接部署到 GitHub Pages：把這三個檔案 push 到 repo 後，在 Settings → Pages 選擇分支即可。

## 資料儲存

原本在 Claude.ai 版本裡用的是 `window.storage`（只存在於 Claude.ai 的 artifact 環境）。這個版本在 `app.js` 最上方加了一個 shim：如果 `window.storage` 不存在，就用瀏覽器的 `localStorage` 模擬同樣的 `get/set/delete/list` 介面，所以下面的程式碼幾乎不用改。

資料是**存在瀏覽器本機**的，換瀏覽器或換電腦不會同步，也跟 Claude.ai 版本的資料互不相通。

主要的 localStorage key：

| Key pattern | 內容 |
|---|---|
| `pe-river:stocks` | 追蹤的股票清單 `[{code, name}]` |
| `pe-river:snapshots:<code>` | 該股票所有券商報告快照 |
| `pe-river:price:<code>` | 該股票目前手動輸入的股價 |
| `pe-river:hist:<code>` | 該股票的每日股價歷史（見下方） |

## 串接股價 API

`kHist(code)` 這個 key 已經預留給「每日股價歷史」使用，格式是：

```js
[
  { date: '2026-01-20', close: 275.0 },
  { date: '2026-01-21', close: 278.5 },
  ...
]
```

`app.js` 裡已經寫好三個相關函式：

- `getPriceHistory(code)` — 讀取某股票已存的每日股價
- `savePriceHistory(code, arr)` — 存入每日股價（會自動過濾無效資料並按日期排序）
- `fetchPriceHistoryFromAPI(code, fromDate, toDate)` — **目前是空的 stub，丟出「尚未串接」的錯誤**。這是您要接自己股價API的地方：在這個函式裡打您的API，把回傳資料整理成上面的陣列格式 `return` 出來即可，之後可以在按鈕事件或 `selectStock()` 裡呼叫 `fetchPriceHistoryFromAPI()` → `savePriceHistory()` 來自動更新。

目前畫面上暫時提供一個「貼上CSV」的匯入框（`日期,收盤價` 一行一筆）當作過渡方案，串好 API 之後這個匯入框可以留著當手動備援，或拿掉。

只要 `pe-river:hist:<code>` 裡有超過1筆資料，「各報告發布當下 Forward P/E」那張圖就會自動改用連續的每日股價淺灰線，取代原本只有報告發布當天幾個點的呈現方式。

## 目前已有的資料

程式一啟動（`init()` 函式）就會把已經整理好的4檔股票、共20幾份券商報告的季度EPS資料寫入 localStorage（凱基、永豐、富邦、中信、元富、國泰等多家券商），包含：

- 3665 貿聯-KY
- 2481 強茂
- 2344 華邦電
- 2408 南亞科

這些都是寫死在 `app.js` 的 `seedIfEmpty()` / `backfill3665History()` / `backfill2408History()` 等函式裡，只在該股票第一次不存在時才會寫入（`seedStockIfMissing` / `addSnapshotsIfMissing` 都有防重複邏輯），所以您在瀏覽器裡新增的資料不會被覆蓋。之後要加新股票、新報告，直接在頁面上用「+ 新增股票」「+ 新增一份券商報告」操作即可，跟 Claude.ai 版本操作方式相同。
