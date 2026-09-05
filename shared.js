// ---------------------------------------------------------------
// Storage shim: uses browser localStorage so this app runs standalone
// (GitHub Pages, local file, etc.) without needing the Claude.ai
// artifact environment.
// ---------------------------------------------------------------
if (!window.storage) {
  window.storage = {
    async get(key) {
      const raw = localStorage.getItem(key);
      if (raw === null) return null;
      return { key, value: raw };
    },
    async set(key, value) {
      localStorage.setItem(key, value);
      return { key, value };
    },
    async delete(key) {
      localStorage.removeItem(key);
      return { key, deleted: true };
    }
  };
}

const CONFIG = {
  GOOGLE_CLIENT_ID: '112914558340-rum51lfa8b0dmodpj3ie99t8ep59vh5r.apps.googleusercontent.com',
  DRIVE_FOLDER_ID: '1JZhFdvWwXVtk8V3_86fkdvFcUo2U063K',
  TRACKING_CSV_NAME: '券商報告追蹤總表.csv',
  FINMIND_TOKEN: '' // 選填：到 https://finmindtrade.com 註冊後貼上您的token可提高呼叫上限
};

const KEY_ROWS = 'pe-tracker:rows';
const KEY_SELECTED = 'pe-tracker:selected';

async function loadJSON(key, fallback){
  try{
    const r = await window.storage.get(key);
    return r ? JSON.parse(r.value) : fallback;
  }catch(e){ return fallback; }
}
async function saveJSON(key, val){
  try{ await window.storage.set(key, JSON.stringify(val)); }catch(e){ console.error('save failed', key, e); }
}

// ---------------------------------------------------------------
// CSV parsing (handles quoted fields with embedded commas/quotes)
// ---------------------------------------------------------------
function parseCSV(text){
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++){
    const c = text[i];
    if (inQuotes){
      if (c === '"'){
        if (text[i+1] === '"'){ field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ','){ row.push(field); field = ''; }
      else if (c === '\n' || c === '\r'){
        if (c === '\r' && text[i+1] === '\n') i++;
        row.push(field); field = '';
        if (!(row.length === 1 && row[0] === '')) rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field !== '' || row.length){ row.push(field); rows.push(row); }
  return rows;
}

function rowsFromCSV(text){
  text = text.replace(/^\uFEFF/, ''); // 去掉檔案開頭可能出現的BOM，避免第一個欄位名稱比對不到
  const parsed = parseCSV(text);
  if (parsed.length < 2) return [];
  const header = parsed[0].map(h => h.trim().replace(/^\uFEFF/, ''));
  const idx = name => header.indexOf(name);
  const iCode=idx('代碼'), iName=idx('名稱'), iDate=idx('報告日期'), iBroker=idx('券商'),
        iTarget=idx('目標價'), iPrice=idx('報告當天股價'), iThis=idx('當年度EPS'),
        iNext=idx('次年度EPS'), iRecent=idx('最近兩季預估EPS(最近一季+預估下一季)'), iFPE=idx('Forward PE'),
        iReportPE=idx('報告給予之本益比倍數'), iLink=idx('報告連結');
  if (iCode === -1 || iName === -1 || iDate === -1){
    throw new Error('CSV欄位名稱對不上（找不到「代碼」「名稱」或「報告日期」欄），請確認資料表格式沒有跑掉');
  }
  const out = [];
  for (let r = 1; r < parsed.length; r++){
    const row = parsed[r];
    if (!row || row.length < header.length) continue;
    out.push({
      code: (row[iCode]||'').trim(),
      name: (row[iName]||'').trim(),
      reportDate: (row[iDate]||'').trim(),
      broker: (row[iBroker]||'').trim(),
      target: row[iTarget] !== '' ? parseFloat(row[iTarget]) : null,
      price: row[iPrice] !== '' ? parseFloat(row[iPrice]) : null,
      epsThisYear: row[iThis] !== '' ? parseFloat(row[iThis]) : null,
      epsNextYear: row[iNext] !== '' ? parseFloat(row[iNext]) : null,
      epsRecentTwoQ: row[iRecent] !== '' ? parseFloat(row[iRecent]) : null,
      reportPE: (() => {
        if (iReportPE === -1 || !row[iReportPE]) return null;
        const n = parseFloat(row[iReportPE]);
        return isNaN(n) ? null : n;
      })(),
      reportPERaw: (iReportPE !== -1 && row[iReportPE]) ? row[iReportPE].trim() : null,
      link: (iLink !== -1 && row[iLink]) ? row[iLink].trim() : null,
      forwardPE: (row[iFPE]||'').trim() // e.g. "25.4x (24F)" or "N/A (24F)"
    });
  }
  return out;
}

// ---------------------------------------------------------------
// Google Drive (read-only) — used only to fetch the tracking CSV.
// ---------------------------------------------------------------
let driveAccessToken = null;

function driveConfigured(){
  return CONFIG.GOOGLE_CLIENT_ID && !CONFIG.GOOGLE_CLIENT_ID.startsWith('YOUR_');
}

function connectDrive(){
  return new Promise((resolve, reject)=>{
    if (!driveConfigured()){ reject(new Error('尚未設定 CONFIG.GOOGLE_CLIENT_ID')); return; }
    if (!window.google || !google.accounts || !google.accounts.oauth2){
      reject(new Error('Google Identity Services 尚未載入完成，請稍後再試一次'));
      return;
    }
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      callback: (resp)=>{
        if (resp.error){ reject(new Error(resp.error)); return; }
        driveAccessToken = resp.access_token;
        resolve(driveAccessToken);
      }
    });
    tokenClient.requestAccessToken();
  });
}

async function fetchTrackingCSV(){
  const q = encodeURIComponent(`'${CONFIG.DRIVE_FOLDER_ID}' in parents and trashed=false and name='${CONFIG.TRACKING_CSV_NAME}'`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${driveAccessToken}` } });
  if (!res.ok){
    if (res.status === 401) throw new Error('授權過期，請重新按「同步資料」');
    throw new Error('Drive API 錯誤，狀態碼 ' + res.status);
  }
  const data = await res.json();
  const file = (data.files || [])[0];
  if (!file) throw new Error(`Drive資料夾裡找不到 ${CONFIG.TRACKING_CSV_NAME}`);
  const dl = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, { headers: { Authorization: `Bearer ${driveAccessToken}` } });
  if (!dl.ok) throw new Error('下載資料表失敗，狀態碼 ' + dl.status);
  return await dl.text();
}

// 幫沒有股價的報告，用FinMind抓「報告日期」當天（或之後最近交易日）的收盤價補上
function computeForwardPEString(price, reportDateStr, epsThisYear, epsNextYear){
  if (price == null) return null;
  const d = new Date(reportDateStr);
  const useNext = d.getMonth() >= 6; // 7月(含)起用次年度EPS，否則用當年度EPS
  const eps = useNext ? epsNextYear : epsThisYear;
  const yr = useNext ? d.getFullYear()+1 : d.getFullYear();
  const yrLabel = String(yr % 100).padStart(2,'0') + 'F';
  if (eps == null) return null;
  if (eps <= 0) return `N/A (${yrLabel})`;
  return `${(price/eps).toFixed(1)}x (${yrLabel})`;
}

async function fillMissingPrices(rows, statusEl){
  const missing = rows.filter(r => r.price == null);
  let filled = 0, failed = 0;
  for (const r of missing){
    try{
      const from = r.reportDate;
      const toD = new Date(r.reportDate);
      toD.setDate(toD.getDate() + 6); // 抓報告日起算一週內，避開非交易日
      const to = toD.toISOString().slice(0,10);
      const hist = await fetchPriceHistoryFromAPI(r.code, from, to);
      if (hist.length){
        r.price = hist[0].close;
        r.priceEstimated = true;
        r.priceEstimatedDate = hist[0].date;
        filled++;
        if (!r.forwardPE || !r.forwardPE.trim()){
          const computed = computeForwardPEString(r.price, r.reportDate, r.epsThisYear, r.epsNextYear);
          if (computed){ r.forwardPE = computed; r.forwardPEEstimated = true; }
        }
      } else {
        failed++;
      }
    }catch(e){
      failed++;
    }
    if (statusEl) statusEl.textContent = `用FinMind補股價中...已完成 ${filled+failed}/${missing.length}`;
  }
  return { filled, failed };
}

// ---------------------------------------------------------------
// FinMind 股價 API
// ---------------------------------------------------------------
const priceHistoryCache = {}; // code -> array，記憶體快取避免同一次session重複打API

async function fetchPriceHistoryFromAPI(code, fromDate, toDate){
  const params = new URLSearchParams({
    dataset: 'TaiwanStockPrice',
    data_id: code,
    start_date: fromDate,
    end_date: toDate
  });
  if (CONFIG.FINMIND_TOKEN) params.set('token', CONFIG.FINMIND_TOKEN);
  const url = `https://api.finmindtrade.com/api/v4/data?${params.toString()}`;
  let res;
  try{ res = await fetch(url); }
  catch(e){ throw new Error('無法連線到FinMind（可能是瀏覽器CORS限制或網路問題）：' + e.message); }
  if (!res.ok) throw new Error(`FinMind回應錯誤狀態碼 ${res.status}`);
  const json = await res.json();
  if (json.status && json.status !== 200) throw new Error('FinMind回傳錯誤：' + (json.msg || JSON.stringify(json)));
  const rows = json.data || [];
  return rows
    .filter(r => r.close != null && r.close !== 0)
    .map(r => ({ date: r.date, close: Number(r.close) }));
}

async function fetchLatestClose(code){
  const toDate = new Date().toISOString().slice(0,10);
  const fromD = new Date();
  fromD.setDate(fromD.getDate() - 14);
  const fromDate = fromD.toISOString().slice(0,10);
  try{
    const hist = await fetchPriceHistoryFromAPI(code, fromDate, toDate);
    if (hist.length) return hist[hist.length - 1].close;
  }catch(e){ /* 忽略，呼叫端會自行退回備援值 */ }
  return null;
}

// ---------------------------------------------------------------
// 共用小工具
// ---------------------------------------------------------------
function stockListFrom(allRows){
  const map = new Map();
  allRows.forEach(r=>{ if (r.code && !map.has(r.code)) map.set(r.code, r.name); });
  return [...map.entries()]
    .map(([code,name])=>({code,name}))
    .sort((a,b)=> a.code.localeCompare(b.code, undefined, {numeric:true}));
}

function parsePE(peStr){
  // "25.4x (24F)" -> 25.4 ; "N/A (24F)" -> null
  if (!peStr) return null;
  const m = peStr.match(/(-?[\d.]+)x/);
  return m ? parseFloat(m[1]) : null;
}

function computeCurrentStatus(rows, dailyHistory){
  if (!rows.length) return null;
  const sorted = [...rows].sort((a,b)=> new Date(b.reportDate) - new Date(a.reportDate));
  const latest = sorted[0];
  let currentPrice = null, priceDate = null;
  if (dailyHistory && dailyHistory.length){
    const last = dailyHistory[dailyHistory.length - 1];
    currentPrice = last.close;
    priceDate = last.date;
  } else {
    currentPrice = latest.price;
    priceDate = latest.reportDate;
  }
  const today = new Date();
  const useNext = today.getMonth() >= 6; // 7月(含)以後用次年度EPS，否則用當年度EPS
  const eps = useNext ? latest.epsNextYear : latest.epsThisYear;
  const epsYear = useNext ? '次年度' : '當年度';
  let currentPE = null;
  if (eps != null && eps > 0 && currentPrice != null) currentPE = currentPrice / eps;
  return { currentPrice, priceDate, eps, epsYear, currentPE, isLiveData: !!(dailyHistory && dailyHistory.length) };
}
