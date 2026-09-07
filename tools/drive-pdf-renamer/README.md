# Drive PDF 改名工具

把指定 Google Drive 資料夾裡的投顧報告 PDF，依內容重新命名成
`股票代碼-股票名稱-YYYYMM-券商名稱.pdf`，並搬到目的資料夾。

目前國泰期貨、華南投顧、富邦投顧、凱基投顧這四家的解析規則是拿實際報告驗證過
的；其他券商是先用常見排版猜的，還沒驗證。要支援新券商、或某家券商抓錯了，改
`brokers.yaml` 就好，不用動程式碼，細節看該檔案裡的說明。程式預設會讀 PDF 前
兩頁的文字來比對，因為有些券商的股票代碼/名稱標題其實印在第二頁。

## 第一次使用前的設定（只需要做一次）

這個工具是用 Google 的 **service account**（服務帳號）去存取 Drive，而不是用你
自己的 Google 帳號登入，所以第一次要花幾分鐘設定：

### 1. 建立 Google Cloud 專案並啟用 Drive API

1. 開啟 <https://console.cloud.google.com/>，用你平常的 Google 帳號登入。
2. 上方選一個現有專案，或按「新增專案」建一個（名稱隨意，例如 `pe-tool`）。
3. 左上「≡」選單 → 「APIs & Services」→「Library」，搜尋 `Google Drive API`，
   點進去按「Enable」。

### 2. 建立 service account 並下載金鑰

1. 左側選單「APIs & Services」→「Credentials」。
2. 「+ Create Credentials」→「Service account」。
3. 名稱隨意（例如 `pdf-renamer`），一路「Continue」/「Done」，不用另外設定角色。
4. 建立完成後，在 Service Accounts 清單點進剛剛那個帳號。
5. 上方分頁選「Keys」→「Add Key」→「Create new key」→ 選 **JSON** → 建立，
   瀏覽器會自動下載一個 `.json` 檔案，**這個檔案要保密**，等一下會整份貼到
   GitHub Secrets。
6. 記下這個 service account 的 email，格式類似
   `pdf-renamer@你的專案名稱.iam.gserviceaccount.com`（在 JSON 裡的
   `client_email` 欄位，或 Service Accounts 清單上也看得到）。

### 3. 把兩個 Google Drive 資料夾分享給這個 service account

因為 service account 不是你本人，所以要單獨把資料夾分享給它，跟分享給一般人的
Email 一樣：

1. 在 Google Drive 打開「未更名」（來源）資料夾 → 右鍵「共用」→ 貼上 step 2.6
   記下的 service account email → 權限選「編輯者」→ 傳送。
2. 對「投顧報告資料庫」（目的）資料夾重複一樣的動作。

### 4. 把金鑰放進 GitHub Secrets

1. 打開這個 repo 的 GitHub 網頁 → Settings → Secrets and variables → Actions。
2. 「New repository secret」，Name 填 `GDRIVE_SA_KEY`，Value 貼上 step 2.5
   下載的整份 JSON 檔案內容（原封不動貼進去，包含 `{ }`）。
3. 存檔。

到這裡設定就完成了，之後不用再重複做。

## 怎麼執行

1. 打開這個 repo 的 GitHub 網頁 → Actions 頁籤 → 左側選「Rename Drive PDFs」。
2. 按「Run workflow」，填：
   - **source_folder_id**：來源資料夾 ID（Google Drive 網址列
     `.../folders/`後面那一串，例如 `1ZZ6aTuPH4kz42NHgJI4HONGNEtvZd-xL`）
   - **target_folder_id**：目的資料夾 ID（同樣是網址列那串）
   - **dry_run**：第一次建議選 `true`，只會印出「哪個檔案會改成什麼名字」，
     不會真的動 Google Drive 上的檔案。確認結果沒問題後，再重新執行一次選
     `false` 才會真的改名+搬移。
3. 按下面的綠色「Run workflow」開始跑，跑完可以點進該次執行紀錄看 log。

## 有哪些限制

- 只認得出現在 `brokers.yaml` 裡設定過的券商格式；沒設定過的券商報告會被
  「略過」並印出提醒，不會亂猜檔名。
- 只讀 PDF 前兩頁的文字來判斷股票代碼/名稱/日期，如果某份報告排版跟平常不
  一樣、或代碼/名稱標題印在第三頁以後，可能抓錯或抓不到，建議先用
  `dry_run: true` 預覽過再正式執行。
- 若 PDF 是掃描圖檔、沒有可選取的文字層，會抓不到內容而被略過。
- `brokers.yaml` 裡目前國泰期貨、華南投顧、富邦投顧、凱基投顧是照實際報告
  驗證過的；其他券商（元大、統一、兆豐…等）是先用公開資訊猜測的公司全名
  關鍵字，套用「股票名稱 股票代碼 TT」+「YYYY/MM/DD」這種通用排版打底，
  **還沒拿這些券商的真實報告驗證過**。正式拿去用之前，請先用
  `dry_run: true` 跑一次看擷取結果對不對；如果某家券商完全沒被任何關鍵字
  命中、或抓出來的代碼/名稱/日期不對，照 `brokers.yaml` 檔案裡的說明調整
  該券商的 `match.contains` 或 `extract` 規則即可，不用改到
  `rename_pdfs.py`。
