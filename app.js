// ---------------------------------------------------------------
// Storage shim: uses browser localStorage so this app runs standalone
// (GitHub Pages, local file, etc.) without needing the Claude.ai
// artifact environment. Same async get/set/delete/list shape as
// window.storage in Claude.ai, so the rest of the app code below is
// unchanged from the Claude.ai artifact version.
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
    },
    async list(prefix) {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!prefix || k.startsWith(prefix)) keys.push(k);
      }
      return { keys, prefix };
    }
  };
}

// ---------------------------------------------------------------
// Daily price history — auto-fetched from FinMind (see CONFIG /
// fetchPriceHistoryFromAPI below). kHist(code) is the storage key.
// Shape saved under kHist(code): JSON array of
//   { date: 'YYYY-MM-DD', close: number }
// sorted ascending by date. Picked up automatically by the
// "各報告發布當下 Forward P/E" chart, which overlays a continuous
// price line when history data is present for the selected stock.
// ---------------------------------------------------------------
async function getPriceHistory(code){
  return await loadJSON(kHist(code), []);
}
async function savePriceHistory(code, arr){
  const cleaned = (arr || [])
    .filter(p => p && p.date && typeof p.close === 'number' && !isNaN(p.close))
    .sort((a,b)=> new Date(a.date) - new Date(b.date));
  await saveJSON(kHist(code), cleaned);
}
// TODO: 若日後改用其他資料源，改這裡即可。目前串的是 FinMind
// (https://finmindtrade.com)：GET https://api.finmindtrade.com/api/v4/data
// dataset=TaiwanStockPrice，免費額度有限（未帶token約120次/小時，
// 註冊後帶token可到600次/小時）。若瀏覽器端直接呼叫被CORS擋下，
// 這裡會拋出錯誤，UI會顯示訊息，屆時需要另外架代理伺服器。
const CONFIG = {
  FINMIND_TOKEN: '', // 選填：到 https://finmindtrade.com 註冊後貼上您的token可提高呼叫上限
  GOOGLE_CLIENT_ID: '112914558340-rum51lfa8b0dmodpj3ie99t8ep59vh5r.apps.googleusercontent.com',
  DRIVE_FOLDER_ID: '1JZhFdvWwXVtk8V3_86fkdvFcUo2U063K'
};

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
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error('無法連線到 FinMind（可能是瀏覽器CORS限制或網路問題）：' + e.message);
  }
  if (!res.ok) {
    throw new Error(`FinMind回應錯誤狀態碼 ${res.status}（可能是超過免費額度限制，或股票代碼錯誤）`);
  }
  const json = await res.json();
  if (json.status && json.status !== 200) {
    throw new Error('FinMind回傳錯誤：' + (json.msg || JSON.stringify(json)));
  }
  const rows = json.data || [];
  return rows
    .filter(r => r.close != null && r.close !== 0)
    .map(r => ({ date: r.date, close: Number(r.close) }));
}

// ---------------------------------------------------------------
// Google Drive 匯入（唯讀）
// 用 Google Identity Services 的 token flow 做純前端OAuth授權，
// 不需要伺服器、不需要用戶端密鑰。授權後用 Drive API v3 列出資料夾
// 內的PDF、下載內容，再用 pdf.js 擷取純文字讓您人工比對確認。
// ---------------------------------------------------------------
let driveTokenClient = null;
let driveAccessToken = null;
let driveFiles = [];
let driveFileTextCache = {}; // fileId -> extracted text

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
    driveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      callback: (resp)=>{
        if (resp.error){ reject(new Error(resp.error)); return; }
        driveAccessToken = resp.access_token;
        resolve(driveAccessToken);
      }
    });
    driveTokenClient.requestAccessToken();
  });
}

async function scanDriveFolder(){
  const q = encodeURIComponent(`'${CONFIG.DRIVE_FOLDER_ID}' in parents and trashed=false and mimeType='application/pdf'`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,modifiedTime)&pageSize=200&orderBy=name`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${driveAccessToken}` } });
  if (!res.ok){
    if (res.status === 401) throw new Error('授權過期，請重新按「連接 Google Drive」');
    throw new Error('Drive API 錯誤，狀態碼 ' + res.status);
  }
  const data = await res.json();
  driveFiles = data.files || [];
  return driveFiles;
}

async function downloadAndExtractText(fileId){
  if (driveFileTextCache[fileId]) return driveFileTextCache[fileId];
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${driveAccessToken}` } });
  if (!res.ok) throw new Error('下載檔案失敗，狀態碼 ' + res.status);
  const buf = await res.arrayBuffer();
  if (!window.pdfjsLib){
    throw new Error('pdf.js 尚未載入，請確認 index.html 有引入 pdf.js 的 script');
  }
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc){
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it=>it.str).join(' ') + '\n\n';
  }
  driveFileTextCache[fileId] = text;
  return text;
}

// 檔名慣例：代碼-名稱-年月[-券商].pdf，例如 3665-貿聯-KY-202608.pdf
function parseDriveFilename(name){
  const m = name.match(/^(\d{4,6})-(.+?)-(\d{6})(?:-(.+?))?\.pdf$/i);
  if (!m) return null;
  const yyyymm = m[3];
  return {
    code: m[1],
    name: m[2],
    year: parseInt(yyyymm.slice(0,4)),
    month: parseInt(yyyymm.slice(4,6)),
    broker: m[4] || '',
    guessedDate: `${yyyymm.slice(0,4)}-${yyyymm.slice(4,6)}-01`
  };
}

// ---------------------------------------------------------------
// 一鍵匯入用的粗略解析器（best-effort，非精確）
// PDF格式差異很大，這裡只是嘗試抓出「看起來像」季度EPS表、年度EPS、
// 股價、目標價的數字，抓到後仍會開啟表單讓您確認/修改再儲存，
// 不會直接寫入資料庫。抓不到的欄位留空，不影響手動填寫。
// ---------------------------------------------------------------
function autoParseReportText(text){
  const norm = text.replace(/[ \t]+/g, ' ');
  const result = { quarters: [], annualEPS: [], price: null, target: null };

  // 容忍 pdf.js 抓字時Q前後多出來的空白，例如 "1 Q25F" 或 "1Q 25 F"
  const qTokenRe = /\b(\d{1,2})\s*Q\s*(\d{2})\s*F?\b|\b(\d{2})\s*Q\s*([1-4])\s*F?\b/g;
  const numRe = /-?\d+\.\d{1,2}/g;

  function findBestRun(re, text, maxGap){
    let m, runs = [];
    let lastEnd = -1, current = null;
    while ((m = re.exec(text))) {
      if (current && m.index - lastEnd < maxGap) {
        current.tokens.push(m);
        current.end = re.lastIndex;
      } else {
        current = { start: m.index, end: re.lastIndex, tokens: [m] };
        runs.push(current);
      }
      lastEnd = re.lastIndex;
    }
    runs.sort((a,b)=> b.tokens.length - a.tokens.length);
    return runs;
  }

  // 找季度標籤的一串（例如 "1Q25 2Q25F 3Q25F 4Q25F" 或 "24Q1F 24Q2F..."）。
  // pdf.js抓出來的順序不一定緊鄰在一起，所以放寬間距容忍度(maxGap)，
  // 從最寬鬆到最嚴格試好幾輪，找到第一個「標籤數=後面數字數」的組合就採用。
  for (const maxGap of [4, 20, 60]) {
    const qRuns = findBestRun(new RegExp(qTokenRe), norm, maxGap);
    let matched = false;
    for (const qRun of qRuns) {
      if (qRun.tokens.length < 4) break;
      const after = norm.slice(qRun.end, qRun.end + 600);
      const nums = [...after.matchAll(numRe)];
      if (nums.length >= qRun.tokens.length) {
        qRun.tokens.forEach((tok, i) => {
          let year, quarter;
          if (tok[1] !== undefined) { quarter = parseInt(tok[1]); year = 2000 + parseInt(tok[2]); }
          else { year = 2000 + parseInt(tok[3]); quarter = parseInt(tok[4]); }
          const isForecast = /F\s*$/.test(tok[0]);
          result.quarters.push({ year, q: quarter, eps: parseFloat(nums[i][0]), actual: !isForecast });
        });
        matched = true;
        break;
      }
    }
    if (matched) break;
  }

  // 年度EPS：找 "20xxF" 年份標籤串 + 附近數字，同樣放寬間距容忍度
  const yTokenRe = /\b20\d{2}F?\b/g;
  for (const maxGap of [4, 20, 60]) {
    const yRuns = findBestRun(yTokenRe, norm, maxGap);
    let matched = false;
    for (const yRun of yRuns) {
      if (yRun.tokens.length < 2 || yRun.tokens.length > 6) continue;
      const after = norm.slice(yRun.end, yRun.end + 400);
      const nums = [...after.matchAll(numRe)];
      if (nums.length >= yRun.tokens.length) {
        yRun.tokens.forEach((tok, i) => {
          result.annualEPS.push({ year: parseInt(tok[0]), eps: parseFloat(nums[i][0]) });
        });
        matched = true;
        break;
      }
    }
    if (matched) break;
  }

  // 股價/目標價：容忍千分位逗號（例如 "2,275"）也容忍沒有逗號的純數字（例如 "2850"）
  const priceNumPattern = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)';
  const priceKeywords = /(?:股價|收盤價|現價|前一日收盤|最新收盤)[：:\s]*(?:NT\$)?\s*/;
  const priceMatch = norm.match(new RegExp(priceKeywords.source + priceNumPattern));
  if (priceMatch) result.price = parseFloat(priceMatch[1].replace(/,/g, ''));
  const targetKeywords = /(?:目標價|合理股價|目標區間)[：:\s]*(?:NT\$)?\s*/;
  const targetMatch = norm.match(new RegExp(targetKeywords.source + priceNumPattern));
  if (targetMatch) result.target = parseFloat(targetMatch[1].replace(/,/g, ''));

  return result;
}

const KEY_STOCKS = 'pe-river:stocks';
const STOCK_DIRECTORY = [
  {code:'3665', name:'貿聯-KY'},
  {code:'2481', name:'強茂'},
  {code:'2344', name:'華邦電'},
  {code:'2408', name:'南亞科'},
  {code:'3081', name:'聯亞'},
  {code:'2327', name:'國巨'},
  {code:'4979', name:'華星光'}
];
const kSnap = c => 'pe-river:snapshots:' + c;
const kPrice = c => 'pe-river:price:' + c;
const kHist = c => 'pe-river:hist:' + c;

let stocks = [];
let selected = null;
let snapshots = [];
let currentPrice = null;
let histText = '';
let peChartConnect = false;
let priceHistory = [];

async function loadJSON(key, fallback){
  try{
    const r = await window.storage.get(key, false);
    return r ? JSON.parse(r.value) : fallback;
  }catch(e){ return fallback; }
}
async function saveJSON(key, val){
  try{ await window.storage.set(key, JSON.stringify(val), false); }catch(e){ console.error('save failed', key, e); }
}

function quarterOf(dateStr){
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const q = Math.floor(d.getMonth()/3)+1;
  return {y,q};
}
function qKey(y,q){ return y*4+q; }
function qLabel(y,q){ return y+'Q'+q; }
function qEndDate(y,q){
  const m = q*3;
  return new Date(y, m, 0);
}

function buildQuarterMap(snap){
  const map = {};
  snap.quarters.forEach(row=>{ map[qKey(row.year,row.q)] = row; });
  return map;
}

function ntmSeries(snap){
  const map = buildQuarterMap(snap);
  const keys = Object.keys(map).map(Number).sort((a,b)=>a-b);
  if(!keys.length) return [];
  const out = [];
  for(let i=0;i<keys.length;i++){
    const k = keys[i];
    const vals = [map[k], map[k+1], map[k+2], map[k+3]];
    if(vals.every(v=>v)){
      const sum = vals.reduce((s,v)=>s+Number(v.eps),0);
      const y = Math.floor((k-1)/4), q = k - y*4;
      out.push({ key:k, year:y, q:q, ntm: sum });
    }
  }
  return out;
}

function baseMultipleAt(snap, dateStr){
  const {y,q} = quarterOf(dateStr);
  const series = ntmSeries(snap);
  const hit = series.find(s=>s.year===y && s.q===q);
  if(!hit) return null;
  return { multiple: snap.priceAtReport / hit.ntm, ntm: hit.ntm };
}

function nextFYYear(dateStr){
  const d = new Date(dateStr);
  return d.getMonth() >= 6 ? d.getFullYear()+1 : d.getFullYear();
}

function annualFallback(snap, priceForCalc, dateStr){
  if(!snap.annualEPS || !snap.annualEPS.length) return null;
  const wantYear = nextFYYear(dateStr);
  let entry = snap.annualEPS.find(a=>a.year===wantYear);
  if(!entry){
    const future = snap.annualEPS.filter(a=>a.year >= wantYear).sort((a,b)=>a.year-b.year);
    entry = future[0];
  }
  if(!entry) return null;
  return { type:'annual', year:entry.year, eps:entry.eps, forwardPE: priceForCalc / entry.eps };
}

function forwardMetrics(snap, currentPrice, dateStr){
  const bm = baseMultipleAt(snap, dateStr);
  if(bm) return { type:'ntm', ntm:bm.ntm, multiple:bm.multiple, forwardPE: currentPrice / bm.ntm };
  return annualFallback(snap, currentPrice, dateStr);
}

function render(){
  const sel = document.getElementById('stockSelect');
  sel.innerHTML = '';
  if(!stocks.length){
    sel.innerHTML = '<option value="">尚無股票</option>';
    document.getElementById('btnDelStock').style.display='none';
    document.getElementById('mainArea').innerHTML = '<div class="card"><div class="empty">按上方「+ 新增股票」開始建立第一檔追蹤個股</div></div>';
    return;
  }
  document.getElementById('btnDelStock').style.display='inline-block';
  stocks.forEach(s=>{
    const o = document.createElement('option');
    o.value = s.code; o.textContent = s.code+' '+s.name;
    if(s.code===selected) o.selected = true;
    sel.appendChild(o);
  });
  renderMain();
}

function renderMain(){
  const area = document.getElementById('mainArea');
  const sortedSnaps = [...snapshots].sort((a,b)=> new Date(a.reportDate)-new Date(b.reportDate));
  const latest = sortedSnaps[sortedSnaps.length-1];

  let statusHtml = '';
  let chartHtml = '';
  let legendHtml = '';

  if(latest){
    const todayStr = new Date().toISOString().slice(0,10);
    const cp = currentPrice != null ? currentPrice : latest.priceAtReport;
    const fm = forwardMetrics(latest, cp, todayStr);
    if(fm && fm.type==='ntm'){
      const step = Math.max(1, Math.round((fm.multiple)/3));
      const bands = [-2,-1,0,1,2].map(m=> fm.multiple + m*step);
      let pillClass='neutral', pillText='正常區間';
      if(fm.forwardPE < bands[1]){ pillClass='good'; pillText='偏便宜'; }
      else if(fm.forwardPE > bands[3]){ pillClass='warn'; pillText='偏貴'; }
      statusHtml = `
        <div class="row">
          <div class="metric"><div class="v">${cp.toLocaleString()}</div><div class="l">目前股價 (NT$)</div></div>
          <div class="metric"><div class="v">${fm.ntm.toFixed(1)}</div><div class="l">最新 NTM 預估EPS</div></div>
          <div class="metric"><div class="v">${fm.forwardPE.toFixed(1)}x</div><div class="l">目前 Forward P/E (NTM)</div></div>
          <div class="metric"><div class="v"><span class="pill ${pillClass}">${pillText}</span></div><div class="l">相對於${latest.broker}預估區間</div></div>
        </div>`;
    } else if(fm && fm.type==='annual'){
      statusHtml = `
        <div class="row">
          <div class="metric"><div class="v">${cp.toLocaleString()}</div><div class="l">目前股價 (NT$)</div></div>
          <div class="metric"><div class="v">${fm.eps.toFixed(2)}</div><div class="l">FY${fm.year} 預估EPS(年度)</div></div>
          <div class="metric"><div class="v">${fm.forwardPE.toFixed(1)}x</div><div class="l">Forward P/E (年度估算)</div></div>
          <div class="metric"><div class="v"><span class="pill neutral">季度資料不足</span></div><div class="l">改用FY${fm.year}年度EPS估算,非NTM</div></div>
        </div>`;
    } else {
      statusHtml = '<div class="empty">目前資料無法計算Forward P/E(季度不足4季,也未提供年度EPS)</div>';
    }
    chartHtml = buildChartSVG(sortedSnaps, cp);
    legendHtml = buildLegend(sortedSnaps);
  } else {
    statusHtml = '<div class="empty">尚未輸入任何券商報告資料</div>';
  }

  area.innerHTML = `
    <div class="card">
      <h2>目前估值狀態</h2>
      ${statusHtml}
      <div class="row" style="margin-top:10px">
        <div><span class="label">目前股價 (可手動更新)</span>
          <input type="number" id="curPriceInput" value="${currentPrice != null ? currentPrice : (latest? latest.priceAtReport : '')}" style="width:110px"></div>
        <button class="small" id="btnUpdatePrice" style="margin-top:16px">更新</button>
      </div>
    </div>

    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2>各報告發布當下 Forward P/E</h2>
        <button class="small" id="btnToggleLine">${peChartConnect ? '只顯示點' : '連成線'}</button>
      </div>
      ${sortedSnaps.length ? (buildForwardPEHistorySVG(sortedSnaps, peChartConnect, priceHistory) || '<div class="empty">資料不足以繪圖</div>') : '<div class="empty">尚無資料可繪圖</div>'}
      <div class="hint">灰線(右側股價軸)為每份報告當時股價的走勢；藍點(左側P/E軸)是該份報告發布當下（用當時股價 ÷ 當時預估EPS）算出的Forward P/E，依報告日期排序${peChartConnect ? '並連成一條線' : ''}。紅點代表當下NTM或年度EPS估值為負，本益比無意義。${priceHistory.length>1 ? `已匯入 ${priceHistory.length} 筆每日股價，圖上改用淺灰連續線呈現。` : ''}</div>
    </div>

    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h2>每日股價 (FinMind)</h2>
        <button class="small primary" id="btnFetchHist">自動更新股價</button>
      </div>
      <div class="hint">從FinMind自動抓取這檔股票從最早一份報告日期到今天的每日收盤價，抓到後上方圖表會自動改用連續每日股價線。目前已有 ${priceHistory.length} 筆資料${priceHistory.length ? `（最新：${priceHistory[priceHistory.length-1].date}）` : ''}。</div>
      <div id="histStatus" class="hint" style="margin-top:6px"></div>
    </div>

    <div class="card">
      <h2>已輸入的券商報告 (${sortedSnaps.length})</h2>
      ${buildSnapTable(sortedSnaps)}
      <button class="small" id="btnAddSnap" style="margin-top:10px">+ 新增一份券商報告</button>
      <div id="addSnapForm" style="display:none;margin-top:12px;border-top:0.5px solid var(--border);padding-top:12px"></div>
    </div>
  `;

  document.getElementById('btnFetchHist').onclick = async ()=>{
    const statusEl = document.getElementById('histStatus');
    const btn = document.getElementById('btnFetchHist');
    const earliest = sortedSnaps.length ? sortedSnaps[0].reportDate : new Date().toISOString().slice(0,10);
    const today = new Date().toISOString().slice(0,10);
    btn.disabled = true;
    statusEl.textContent = `抓取中...（${earliest} ~ ${today}）`;
    try {
      const rows = await fetchPriceHistoryFromAPI(selected, earliest, today);
      if (!rows.length) {
        statusEl.textContent = 'FinMind回傳了資料，但沒有有效的收盤價（可能是股票代碼在FinMind裡對不上，或該區間沒有交易資料）。';
      } else {
        priceHistory = rows;
        await savePriceHistory(selected, rows);
        statusEl.textContent = `成功更新 ${rows.length} 筆每日股價（${rows[0].date} ~ ${rows[rows.length-1].date}）。`;
        renderMain();
        return;
      }
    } catch (e) {
      statusEl.textContent = '更新失敗：' + e.message;
    } finally {
      btn.disabled = false;
    }
  };

  document.getElementById('btnUpdatePrice').onclick = async ()=>{
    const v = parseFloat(document.getElementById('curPriceInput').value);
    if(isNaN(v)){ alert('請輸入有效股價'); return; }
    currentPrice = v;
    await saveJSON(kPrice(selected), v);
    renderMain();
  };
  document.getElementById('btnToggleLine').onclick = ()=>{
    peChartConnect = !peChartConnect;
    renderMain();
  };
  document.getElementById('btnAddSnap').onclick = ()=>{
    document.getElementById('addSnapForm').style.display='block';
    renderAddSnapForm();
  };
}

function fmtForwardPE(fm){
  if(!fm) return '<span style="color:var(--text3)">無法計算</span>';
  const eps = fm.type==='ntm' ? fm.ntm : fm.eps;
  if(eps <= 0) return '<span style="color:var(--text3)">EPS為負</span>';
  const label = fm.type==='ntm' ? 'NTM' : ('FY'+fm.year);
  return `${fm.forwardPE.toFixed(1)}x <span style="color:var(--text3)">(${label})</span>`;
}

function fmtEpsUsed(fm){
  if(!fm) return '-';
  const eps = fm.type==='ntm' ? fm.ntm : fm.eps;
  const label = fm.type==='ntm' ? 'NTM' : ('FY'+fm.year);
  return `${eps.toFixed(2)} <span style="color:var(--text3)">(${label})</span>`;
}

function buildSnapTable(sortedSnaps){
  if(!sortedSnaps.length) return '<div class="empty">尚未新增任何報告</div>';
  const displayOrder = [...sortedSnaps].reverse();
  let rows = displayOrder.map(s=>{
    const fm = forwardMetrics(s, s.priceAtReport, s.reportDate);
    return `<tr>
      <td>${s.reportDate}</td>
      <td>${s.broker}</td>
      <td>${Number(s.priceAtReport).toLocaleString()}</td>
      <td>${s.targetPrice != null ? Number(s.targetPrice).toLocaleString() : '-'}</td>
      <td>${fmtEpsUsed(fm)}</td>
      <td>${fmtForwardPE(fm)}</td>
    </tr>`;
  }).join('');
  return `<table><thead><tr><th>報告日期</th><th>券商</th><th>當時股價</th><th>目標價</th><th>預估EPS</th><th>發布當下Forward P/E</th></tr></thead><tbody>${rows}</tbody></table>`;
}

let pendingQuarters = [];
let pendingAnnual = [];
let prefillSnap = null;
function renderAddSnapForm(){
  const pf = prefillSnap;
  prefillSnap = null;
  if (pf){
    pendingQuarters = (pf.quarters && pf.quarters.length) ? pf.quarters.map(q=>({...q})) : [];
    pendingAnnual = (pf.annualEPS && pf.annualEPS.length) ? pf.annualEPS.map(a=>({...a})) : [];
  }
  pendingQuarters = pendingQuarters.length ? pendingQuarters : [
    {year:new Date().getFullYear(), q:1, eps:'', actual:true}
  ];
  pendingAnnual = pendingAnnual.length ? pendingAnnual : [
    {year:new Date().getFullYear()+1, eps:''}
  ];
  const f = document.getElementById('addSnapForm');
  f.innerHTML = `
    ${pf ? `<div class="hint">已從PDF自動解析，數字為AI粗略判讀結果，請務必核對後再儲存（尤其負數、小數點）。</div>` : ''}
    <div class="row">
      <div><span class="label">報告日期${pf ? '（從檔名猜測，請確認）' : ''}</span><input type="date" id="snapDate" value="${pf ? pf.guessedDate : new Date().toISOString().slice(0,10)}"></div>
      <div><span class="label">券商</span><input type="text" id="snapBroker" placeholder="凱基證券" value="${pf && pf.broker ? pf.broker : ''}" style="width:120px"></div>
      <div><span class="label">當時股價</span><input type="number" id="snapPrice" value="${pf && pf.price != null ? pf.price : ''}" style="width:100px"></div>
      <div><span class="label">目標價 (選填)</span><input type="number" id="snapTarget" value="${pf && pf.target != null ? pf.target : ''}" style="width:100px"></div>
    </div>
    <h3 style="margin-top:12px">季度EPS預估表 (有連續4季以上才能算NTM本益比)</h3>
    <div class="qgrid" style="font-weight:500;color:var(--text3)"><div>年</div><div>季</div><div>EPS</div><div>已公布</div><div></div></div>
    <div id="qRows"></div>
    <button class="small" id="btnAddQRow">+ 新增一列</button>
    <h3 style="margin-top:14px">年度EPS預估 (選填,季度不足4季時作為Forward P/E的備援算法)</h3>
    <div id="aRows"></div>
    <button class="small" id="btnAddARow">+ 新增一列</button>
    <div class="row" style="margin-top:12px">
      <button class="primary small" id="btnSaveSnap">儲存這份報告</button>
      <button class="small" id="btnCancelSnap">取消</button>
    </div>
  `;
  renderQRows();
  renderARows();
  document.getElementById('btnAddQRow').onclick = ()=>{
    const last = pendingQuarters[pendingQuarters.length-1];
    let ny=last.year, nq=last.q+1;
    if(nq>4){nq=1;ny++;}
    pendingQuarters.push({year:ny,q:nq,eps:'',actual:false});
    renderQRows();
  };
  document.getElementById('btnAddARow').onclick = ()=>{
    const last = pendingAnnual[pendingAnnual.length-1];
    pendingAnnual.push({year:(last.year||new Date().getFullYear())+1, eps:''});
    renderARows();
  };
  document.getElementById('btnCancelSnap').onclick = ()=>{
    document.getElementById('addSnapForm').style.display='none';
    pendingQuarters = []; pendingAnnual = [];
  };
  document.getElementById('btnSaveSnap').onclick = async ()=>{
    const date = document.getElementById('snapDate').value;
    const broker = document.getElementById('snapBroker').value.trim();
    const price = parseFloat(document.getElementById('snapPrice').value);
    const targetRaw = document.getElementById('snapTarget').value;
    const targetPrice = targetRaw !== '' && !isNaN(parseFloat(targetRaw)) ? parseFloat(targetRaw) : null;
    if(!date || !broker || isNaN(price)){ alert('請填寫報告日期、券商、股價'); return; }
    const quarters = pendingQuarters
      .filter(r=>r.eps!=='' && !isNaN(parseFloat(r.eps)))
      .map(r=>({year:parseInt(r.year), q:parseInt(r.q), eps:parseFloat(r.eps), actual:!!r.actual}));
    const annualEPS = pendingAnnual
      .filter(r=>r.eps!=='' && !isNaN(parseFloat(r.eps)))
      .map(r=>({year:parseInt(r.year), eps:parseFloat(r.eps)}));
    if(quarters.length < 4 && annualEPS.length === 0){
      alert('請至少提供連續4季EPS,或至少填一筆年度EPS作為備援');
      return;
    }
    const snap = { id: Date.now().toString(), reportDate:date, broker, priceAtReport:price, targetPrice, quarters, annualEPS };
    snapshots.push(snap);
    await saveJSON(kSnap(selected), snapshots);
    pendingQuarters = []; pendingAnnual = [];
    document.getElementById('addSnapForm').style.display='none';
    renderMain();
  };
}
function renderARows(){
  const c = document.getElementById('aRows');
  if(!c) return;
  c.innerHTML = pendingAnnual.map((r,i)=>`
    <div class="row" style="margin-bottom:4px">
      <input type="number" value="${r.year}" style="width:70px" onchange="pendingAnnual[${i}].year=this.value">
      <input type="number" step="0.01" value="${r.eps}" placeholder="年度EPS" style="width:90px" onchange="pendingAnnual[${i}].eps=this.value">
      <button class="small" onclick="pendingAnnual.splice(${i},1);renderARows()" style="padding:2px 6px">x</button>
    </div>
  `).join('');
}
function renderQRows(){
  const c = document.getElementById('qRows');
  c.innerHTML = pendingQuarters.map((r,i)=>`
    <div class="qgrid">
      <input type="number" value="${r.year}" style="width:60px" onchange="pendingQuarters[${i}].year=this.value">
      <select onchange="pendingQuarters[${i}].q=this.value">
        ${[1,2,3,4].map(q=>`<option value="${q}" ${q===r.q?'selected':''}>${q}</option>`).join('')}
      </select>
      <input type="number" step="0.01" value="${r.eps}" placeholder="EPS" style="width:80px" onchange="pendingQuarters[${i}].eps=this.value">
      <input type="checkbox" ${r.actual?'checked':''} onchange="pendingQuarters[${i}].actual=this.checked">
      <button class="small" onclick="pendingQuarters.splice(${i},1);renderQRows()" style="padding:2px 6px">x</button>
    </div>
  `).join('');
}

const palette = ['#2a78d6','#eb6834','#1baf7a','#eda100','#e87ba4','#4a3aa7'];

function buildLegend(sortedSnaps){
  const items = sortedSnaps.map((s,i)=>{
    const c = palette[i % palette.length];
    return `<span><span class="sw" style="background:${c}"></span>${s.reportDate} ${s.broker}</span>`;
  }).join('');
  return `<div class="legend">${items}<span><span class="sw" style="background:#ababa4"></span>最新報告本益比帶</span></div>`;
}

function buildForwardPEHistorySVG(sortedSnaps, connectLine, dailyHistory){
  dailyHistory = dailyHistory || [];
  const points = sortedSnaps.map(s=>{
    const fm = forwardMetrics(s, s.priceAtReport, s.reportDate);
    let pe = null;
    if(fm){
      const eps = fm.type==='ntm' ? fm.ntm : fm.eps;
      if(eps > 0) pe = fm.forwardPE;
    }
    return { date: new Date(s.reportDate), reportDate: s.reportDate, broker: s.broker, pe, price: s.priceAtReport, type: fm ? fm.type : null, year: fm ? fm.year : null };
  });
  const validPoints = points.filter(p=>p.pe != null);
  if(validPoints.length < 1) return '';

  const W = 640, H = 280, padL = 50, padR = 50, padT = 16, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const allDates = points.map(p=>p.date.getTime()).concat(dailyHistory.map(h=>new Date(h.date).getTime()));
  const minDate = Math.min(...allDates);
  const maxDate = Math.max(...allDates);
  const dateSpan = Math.max(1, maxDate - minDate);
  const xOf = d => padL + ((d.getTime()-minDate)/dateSpan) * plotW;

  const peVals = validPoints.map(p=>p.pe);
  const maxPE = Math.max(...peVals);
  const minPE = Math.min(...peVals);
  const useLog = maxPE / Math.max(0.5, minPE) > 20;
  const yMin = useLog ? Math.max(0.5, minPE*0.7) : Math.min(0, minPE*1.1);
  const yMax = maxPE * 1.15;
  const yOf = v => {
    if(useLog){
      const logMin = Math.log(yMin), logMax = Math.log(yMax);
      return padT + plotH - ((Math.log(Math.max(v,yMin))-logMin)/(logMax-logMin)) * plotH;
    }
    return padT + plotH - ((v-yMin)/(yMax-yMin)) * plotH;
  };

  const priceVals = points.map(p=>p.price).concat(dailyHistory.map(h=>h.close));
  const pMin = Math.min(...priceVals)*0.9;
  const pMax = Math.max(...priceVals)*1.1;
  const pyOf = v => padT + plotH - ((v-pMin)/(pMax-pMin)) * plotH;

  let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Forward PE與股價歷史圖">`;

  [0,0.25,0.5,0.75,1].forEach(f=>{
    const y = padT + plotH*f;
    svg += `<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
  });
  if(useLog){
    const logMin = Math.log(yMin), logMax = Math.log(yMax);
    [yMin, Math.sqrt(yMin*yMax), yMax].forEach(v=>{
      const y = padT + plotH - ((Math.log(v)-logMin)/(logMax-logMin)) * plotH;
      svg += `<text x="${padL-6}" y="${y+3}" text-anchor="end" font-size="10" fill="var(--text3)">${v.toFixed(1)}x</text>`;
    });
  } else {
    [0,0.5,1].forEach(f=>{
      const y = padT + plotH*(1-f);
      const val = yMin + (yMax-yMin)*f;
      svg += `<text x="${padL-6}" y="${y+3}" text-anchor="end" font-size="10" fill="var(--text3)">${val.toFixed(1)}x</text>`;
    });
  }
  [0,0.5,1].forEach(f=>{
    const y = padT + plotH*(1-f);
    const val = pMin + (pMax-pMin)*f;
    svg += `<text x="${W-padR+6}" y="${y+3}" text-anchor="start" font-size="10" fill="var(--text2)">${Math.round(val).toLocaleString()}</text>`;
  });
  svg += `<text x="${padL}" y="10" font-size="9" fill="var(--text3)">Forward P/E (x)</text>`;
  svg += `<text x="${W-padR}" y="10" text-anchor="end" font-size="9" fill="var(--text2)">股價 (NT$)</text>`;

  if(dailyHistory.length > 1){
    const dPts = dailyHistory.map(h=> `${xOf(new Date(h.date))},${pyOf(h.close)}`).join(' ');
    svg += `<polyline points="${dPts}" fill="none" stroke="var(--text3)" stroke-width="1" opacity="0.6"/>`;
  } else {
    const pricePts = points.map(p=> `${xOf(p.date)},${pyOf(p.price)}`).join(' ');
    svg += `<polyline points="${pricePts}" fill="none" stroke="var(--text2)" stroke-width="1.75" stroke-dasharray="0"/>`;
    points.forEach(p=>{
      svg += `<circle cx="${xOf(p.date)}" cy="${pyOf(p.price)}" r="2.5" fill="var(--text2)"/>`;
    });
  }

  let linePts = [];
  if(connectLine){
    points.forEach((p, i)=>{
      const x = xOf(p.date);
      if(p.pe != null){
        linePts.push(`${x},${yOf(p.pe)}`);
      } else {
        if(linePts.length > 1){
          svg += `<polyline points="${linePts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
        }
        linePts = [];
      }
    });
    if(linePts.length > 1){
      svg += `<polyline points="${linePts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2"/>`;
    }
  }

  points.forEach(p=>{
    const x = xOf(p.date);
    if(p.pe != null){
      const y = yOf(p.pe);
      svg += `<circle cx="${x}" cy="${y}" r="4" fill="var(--accent)" stroke="var(--bg)" stroke-width="1.5"/>`;
      svg += `<text x="${x}" y="${y-8}" text-anchor="middle" font-size="9" fill="var(--text2)">${p.pe.toFixed(1)}x</text>`;
    } else {
      svg += `<circle cx="${x}" cy="${padT+plotH}" r="3" fill="var(--warn)" />`;
      svg += `<text x="${x}" y="${padT+plotH-6}" text-anchor="middle" font-size="9" fill="var(--warn)">虧損</text>`;
    }
    svg += `<text x="${x}" y="${H-8}" text-anchor="middle" font-size="8" fill="var(--text3)" transform="rotate(0)">${p.reportDate.slice(2)}</text>`;
  });

  svg += `</svg>`;
  return svg;
}

function buildChartSVG(sortedSnaps, currentPrice){
  const latest = sortedSnaps[sortedSnaps.length-1];
  const latestSeries = ntmSeries(latest);
  if(latestSeries.length < 2) return '';

  let minK = Infinity, maxK = -Infinity;
  sortedSnaps.forEach(s=>{
    ntmSeries(s).forEach(pt=>{ if(pt.key<minK)minK=pt.key; if(pt.key>maxK)maxK=pt.key; });
  });
  const todayQ = quarterOf(new Date().toISOString().slice(0,10));
  const todayKey = qKey(todayQ.y, todayQ.q);
  if(todayKey > maxK) maxK = todayKey;
  if(todayKey < minK) minK = todayKey;

  const W = 640, H = 320, padL = 55, padR = 20, padT = 16, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const nK = maxK - minK;
  const xOf = k => padL + ( (k-minK) / Math.max(1,nK) ) * plotW;

  const bm = baseMultipleAt(latest, new Date().toISOString().slice(0,10)) || baseMultipleAt(latest, latest.reportDate);
  const step = bm ? Math.max(1, Math.round(bm.multiple/3)) : 5;
  const bandMultiples = bm ? [-2,-1,0,1,2].map(m=> bm.multiple + m*step) : [];

  let allVals = [currentPrice];
  bandMultiples.forEach(m=>{
    latestSeries.forEach(pt=> allVals.push(pt.ntm*m));
  });
  sortedSnaps.forEach((s,i)=>{
    const b = baseMultipleAt(s, s.reportDate);
    if(b){ ntmSeries(s).forEach(pt=> allVals.push(pt.ntm*b.multiple)); }
  });
  const yMin = Math.min(...allVals)*0.9;
  const yMax = Math.max(...allVals)*1.1;
  const yOf = v => padT + plotH - ( (v-yMin)/(yMax-yMin) ) * plotH;

  let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Forward PE河流圖">`;

  [0,0.25,0.5,0.75,1].forEach(f=>{
    const y = padT + plotH*f;
    const val = yMax - (yMax-yMin)*f;
    svg += `<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
    svg += `<text x="${padL-6}" y="${y+3}" text-anchor="end" font-size="10" fill="var(--text3)">${Math.round(val).toLocaleString()}</text>`;
  });

  bandMultiples.forEach(m=>{
    const pts = latestSeries.map(pt=> `${xOf(pt.key)},${yOf(pt.ntm*m)}`).join(' ');
    svg += `<polyline points="${pts}" fill="none" stroke="#ababa4" stroke-width="1" opacity="0.7"/>`;
    const last = latestSeries[latestSeries.length-1];
    svg += `<text x="${xOf(last.key)+4}" y="${yOf(last.ntm*m)+3}" font-size="9" fill="var(--text3)">${m.toFixed(0)}x</text>`;
  });

  sortedSnaps.forEach((s,i)=>{
    const b = baseMultipleAt(s, s.reportDate);
    if(!b) return;
    const series = ntmSeries(s);
    const pts = series.map(pt=> `${xOf(pt.key)},${yOf(pt.ntm*b.multiple)}`).join(' ');
    const c = palette[i % palette.length];
    svg += `<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="2"/>`;
  });

  const cx = xOf(todayKey), cy = yOf(currentPrice);
  svg += `<circle cx="${cx}" cy="${cy}" r="4" fill="var(--text)" stroke="var(--bg)" stroke-width="2"/>`;
  svg += `<text x="${cx}" y="${cy-8}" text-anchor="middle" font-size="10" fill="var(--text)" font-weight="500">目前 ${currentPrice.toLocaleString()}</text>`;

  const labelStep = Math.max(1, Math.round(nK/8));
  for(let k=minK; k<=maxK; k+=labelStep){
    const y = Math.floor((k-1)/4), q = k - y*4;
    svg += `<text x="${xOf(k)}" y="${H-10}" text-anchor="middle" font-size="9" fill="var(--text3)">${qLabel(y,q)}</text>`;
  }

  svg += `</svg>`;
  return svg;
}

async function selectStock(code){
  selected = code;
  snapshots = await loadJSON(kSnap(code), []);
  currentPrice = await loadJSON(kPrice(code), null);
  priceHistory = await getPriceHistory(code);
  render();
}

function populateQuickPick(){
  const qp = document.getElementById('quickPick');
  const addedCodes = new Set(stocks.map(s=>s.code));
  const available = STOCK_DIRECTORY.filter(d=>!addedCodes.has(d.code));
  qp.innerHTML = '<option value="">-- 手動輸入 --</option>' +
    available.map(d=>`<option value="${d.code}">${d.code} ${d.name}</option>`).join('');
  qp.onchange = ()=>{
    const hit = STOCK_DIRECTORY.find(d=>d.code===qp.value);
    document.getElementById('newCode').value = hit ? hit.code : '';
    document.getElementById('newName').value = hit ? hit.name : '';
  };
}

document.getElementById('btnAddStock').onclick = ()=>{
  const f = document.getElementById('addStockForm');
  f.style.display = f.style.display==='none' ? 'block' : 'none';
  if(f.style.display==='block') populateQuickPick();
};
document.getElementById('btnSaveStock').onclick = async ()=>{
  const code = document.getElementById('newCode').value.trim();
  const name = document.getElementById('newName').value.trim();
  if(!code || !name){ alert('請輸入代碼與名稱'); return; }
  if(stocks.find(s=>s.code===code)){ alert('這檔股票已存在'); return; }
  stocks.push({code,name});
  await saveJSON(KEY_STOCKS, stocks);
  document.getElementById('newCode').value=''; document.getElementById('newName').value='';
  document.getElementById('addStockForm').style.display='none';
  await selectStock(code);
  render();
};
document.getElementById('btnDelStock').onclick = async ()=>{
  if(!selected) return;
  if(!confirm('刪除此股票與所有相關報告資料?')) return;
  stocks = stocks.filter(s=>s.code!==selected);
  await saveJSON(KEY_STOCKS, stocks);
  try{ await window.storage.delete(kSnap(selected), false); }catch(e){}
  try{ await window.storage.delete(kPrice(selected), false); }catch(e){}
  selected = stocks.length ? stocks[0].code : null;
  if(selected) await selectStock(selected); else render();
};
document.getElementById('stockSelect').onchange = (e)=> selectStock(e.target.value);

async function runOneClickImport(){
  const statusEl = document.getElementById('driveStatus');
  const btn = document.getElementById('btnOneClickImport');
  if (!driveAccessToken){
    statusEl.textContent = '請先按「連接 Google Drive」完成授權，再按一次「一鍵匯入」。';
    return;
  }
  btn.disabled = true;
  statusEl.textContent = '掃描資料夾中...';
  let files;
  try{ files = await scanDriveFolder(); }
  catch(e){ statusEl.textContent = '掃描失敗：' + e.message; btn.disabled = false; return; }

  const imported = [], skipped = [], failed = [];
  const snapCache = {}; // code -> snapshots array（避免同一檔股票重複讀寫storage）

  for (let i = 0; i < files.length; i++){
    const file = files[i];
    statusEl.textContent = `處理中 (${i+1}/${files.length})... 已匯入 ${imported.length}，跳過 ${skipped.length}，失敗 ${failed.length}`;
    const parsed = parseDriveFilename(file.name);
    if (!parsed){ skipped.push(`${file.name}（檔名不符命名規則）`); continue; }

    if (!snapCache[parsed.code]) snapCache[parsed.code] = await loadJSON(kSnap(parsed.code), []);
    const existing = snapCache[parsed.code];
    if (existing.find(s => s.sourceFileId === file.id)){ skipped.push(`${file.name}（已匯入過）`); continue; }

    try{
      const text = await downloadAndExtractText(file.id);
      const pd = autoParseReportText(text);
      if (!pd.quarters.length && !pd.annualEPS.length){ failed.push(`${file.name}（解析不到季度或年度EPS資料，需手動新增）`); continue; }
      if (pd.price == null){ failed.push(`${file.name}（抓不到股價，需手動新增）`); continue; }

      await ensureStockRegistered(parsed.code, parsed.name);
      const snap = {
        id: 'drive-' + file.id,
        sourceFileId: file.id,
        reportDate: parsed.guessedDate,
        broker: parsed.broker || '（未知券商）',
        priceAtReport: pd.price,
        targetPrice: pd.target,
        quarters: pd.quarters,
        annualEPS: pd.annualEPS
      };
      existing.push(snap);
      snapCache[parsed.code] = existing;
      imported.push(`${file.name} → ${parsed.code} ${parsed.name}`);
    }catch(e){
      failed.push(`${file.name}（${e.message}）`);
    }
  }

  for (const code in snapCache){
    await saveJSON(kSnap(code), snapCache[code]);
  }

  statusEl.innerHTML = `完成：匯入 ${imported.length} 筆，跳過 ${skipped.length} 筆，失敗 ${failed.length} 筆（共 ${files.length} 個檔案）。` +
    (imported.length ? `<br><br>✅ 已匯入：<br>${imported.join('<br>')}` : '') +
    (skipped.length ? `<br><br>⏭ 已跳過：<br>${skipped.join('<br>')}` : '') +
    (failed.length ? `<br><br>⚠️ 失敗（建議手動新增）：<br>${failed.join('<br>')}` : '') +
    (imported.length ? `<br><br>提醒：自動解析的數字未逐一人工確認，麻煩到下方報告列表核對重要數字。` : '');

  btn.disabled = false;
  if (selected) await selectStock(selected); else render();
}

document.getElementById('btnDriveConnect').onclick = async ()=>{
  const statusEl = document.getElementById('driveStatus');
  statusEl.textContent = '連接中...（請在跳出的Google視窗完成授權）';
  try{
    await connectDrive();
    statusEl.textContent = '已連接 Google Drive，可以按「一鍵匯入」了。';
  }catch(e){
    statusEl.textContent = '連接失敗：' + e.message;
  }
};
document.getElementById('btnOneClickImport').onclick = runOneClickImport;

async function seedStockIfMissing(code, name, snaps){
  let list = await loadJSON(KEY_STOCKS, []);
  if(list.find(s=>s.code===code)) return;
  list.push({code, name});
  await saveJSON(KEY_STOCKS, list);
  await saveJSON(kSnap(code), snaps);
}

async function ensureStockRegistered(code, name){
  let list = await loadJSON(KEY_STOCKS, []);
  if(!list.find(s=>s.code===code)){
    list.push({code, name});
    await saveJSON(KEY_STOCKS, list);
  }
}

async function seedIfEmpty(){
  await seedStockIfMissing('3665', '貿聯-KY', [{
    id:'seed-3665-1', reportDate:'2026-08-21', broker:'凱基證券', priceAtReport:2275, targetPrice:2850,
    quarters:[
      {year:2025,q:1,eps:8.41,actual:true},
      {year:2025,q:2,eps:10.54,actual:true},
      {year:2025,q:3,eps:13.51,actual:true},
      {year:2025,q:4,eps:14.06,actual:true},
      {year:2026,q:1,eps:11.66,actual:true},
      {year:2026,q:2,eps:15.28,actual:false},
      {year:2026,q:3,eps:19.91,actual:false},
      {year:2026,q:4,eps:23.69,actual:false},
      {year:2027,q:1,eps:24.36,actual:false},
      {year:2027,q:2,eps:28.23,actual:false},
      {year:2027,q:3,eps:31.60,actual:false},
      {year:2027,q:4,eps:33.50,actual:false}
    ]
  }]);
  await seedStockIfMissing('2481', '強茂', [{
    id:'seed-2481-1', reportDate:'2026-08-27', broker:'元富投顧', priceAtReport:150.5, targetPrice:190,
    quarters:[
      {year:2026,q:1,eps:0.75,actual:true},
      {year:2026,q:2,eps:1.28,actual:true},
      {year:2026,q:3,eps:1.46,actual:false},
      {year:2026,q:4,eps:1.58,actual:false}
    ],
    annualEPS:[
      {year:2026, eps:5.07},
      {year:2027, eps:7.60}
    ]
  }]);
  await seedStockIfMissing('2344', '華邦電', [
    {
      id:'seed-2344-1', reportDate:'2023-08-08', broker:'富邦投顧', priceAtReport:27.70,
      quarters:[
        {year:2023,q:1,eps:-0.26,actual:true},
        {year:2023,q:2,eps:0.09,actual:true},
        {year:2023,q:3,eps:0.04,actual:false},
        {year:2023,q:4,eps:0.14,actual:false}
      ],
      annualEPS:[
        {year:2023, eps:0.02},
        {year:2024, eps:1.61}
      ]
    },
    {
      id:'seed-2344-2', reportDate:'2025-02-20', broker:'中信投顧', priceAtReport:19.20, targetPrice:20.30,
      quarters:[
        {year:2024,q:1,eps:-0.10,actual:true},
        {year:2024,q:2,eps:0.38,actual:true},
        {year:2024,q:3,eps:0.00,actual:true},
        {year:2024,q:4,eps:-0.14,actual:true},
        {year:2025,q:1,eps:-0.09,actual:false},
        {year:2025,q:2,eps:-0.03,actual:false},
        {year:2025,q:3,eps:0.03,actual:false},
        {year:2025,q:4,eps:0.04,actual:false}
      ],
      annualEPS:[
        {year:2025, eps:-0.05},
        {year:2026, eps:0.57}
      ]
    }
  ]);
}

async function seedPriceIfMissing(code, price){
  const existing = await loadJSON(kPrice(code), null);
  if(existing !== null) return;
  await saveJSON(kPrice(code), price);
}

async function addSnapshotsIfMissing(code, newSnaps){
  const existing = await loadJSON(kSnap(code), []);
  const existingIds = new Set(existing.map(s=>s.id));
  const toAdd = newSnaps.filter(s=>!existingIds.has(s.id));
  if(!toAdd.length) return;
  await saveJSON(kSnap(code), existing.concat(toAdd));
}

async function backfill2408History(){
  await addSnapshotsIfMissing('2408', [
    {
      id:'seed-2408-2023-07', reportDate:'2023-07-11', broker:'富邦投顧', priceAtReport:69.70,
      quarters:[],
      annualEPS:[{year:2023,eps:-1.91},{year:2024,eps:2.74}]
    },
    {
      id:'seed-2408-2023-10', reportDate:'2023-10-12', broker:'永豐投顧', priceAtReport:70.70, targetPrice:82,
      quarters:[
        {year:2023,q:1,eps:-0.54,actual:true},
        {year:2023,q:2,eps:-0.25,actual:true},
        {year:2023,q:3,eps:-0.81,actual:false},
        {year:2023,q:4,eps:-1.02,actual:false},
        {year:2024,q:1,eps:-0.80,actual:false},
        {year:2024,q:2,eps:-0.39,actual:false},
        {year:2024,q:3,eps:0.07,actual:false},
        {year:2024,q:4,eps:0.77,actual:false}
      ],
      annualEPS:[{year:2023,eps:-2.62},{year:2024,eps:-0.34}]
    },
    {
      id:'seed-2408-2024-04-syp', reportDate:'2024-04-11', broker:'永豐投顧', priceAtReport:70.20, targetPrice:82,
      quarters:[
        {year:2024,q:1,eps:-0.39,actual:true},
        {year:2024,q:2,eps:-0.19,actual:false},
        {year:2024,q:3,eps:0.22,actual:false},
        {year:2024,q:4,eps:0.44,actual:false}
      ],
      annualEPS:[{year:2024,eps:0.08}]
    },
    {
      id:'seed-2408-2024-04-fb', reportDate:'2024-04-17', broker:'富邦投顧', priceAtReport:65.50,
      quarters:[],
      annualEPS:[{year:2024,eps:0.62},{year:2025,eps:5.73}]
    },
    {
      id:'seed-2408-2024-06', reportDate:'2024-06-21', broker:'富邦投顧', priceAtReport:72.70,
      quarters:[],
      annualEPS:[{year:2024,eps:0.00},{year:2025,eps:7.15}]
    },
    {
      id:'seed-2408-2024-07', reportDate:'2024-07-11', broker:'永豐投顧', priceAtReport:72.30, targetPrice:91,
      quarters:[
        {year:2024,q:1,eps:-0.39,actual:true},
        {year:2024,q:2,eps:-0.26,actual:true},
        {year:2024,q:3,eps:0.01,actual:false},
        {year:2024,q:4,eps:0.30,actual:false}
      ],
      annualEPS:[{year:2024,eps:-0.34},{year:2025,eps:2.33}]
    },
    {
      id:'seed-2408-2025-10', reportDate:'2025-10-14', broker:'永豐投顧', priceAtReport:95.60,
      quarters:[
        {year:2025,q:1,eps:-0.63,actual:true},
        {year:2025,q:2,eps:-1.32,actual:true},
        {year:2025,q:3,eps:0.50,actual:true},
        {year:2025,q:4,eps:1.87,actual:false}
      ],
      annualEPS:[{year:2025,eps:0.42},{year:2026,eps:9.93}]
    },
    {
      id:'seed-2408-2026-01-syp', reportDate:'2026-01-20', broker:'永豐投顧', priceAtReport:275.00, targetPrice:370,
      quarters:[],
      annualEPS:[{year:2026,eps:37.00}]
    },
    {
      id:'seed-2408-2026-01-fb', reportDate:'2026-01-20', broker:'富邦投顧', priceAtReport:275.00, targetPrice:305,
      quarters:[
        {year:2026,q:1,eps:5.24,actual:false},
        {year:2026,q:2,eps:6.36,actual:false},
        {year:2026,q:3,eps:8.85,actual:false},
        {year:2026,q:4,eps:8.39,actual:false},
        {year:2027,q:1,eps:7.96,actual:false},
        {year:2027,q:2,eps:7.60,actual:false},
        {year:2027,q:3,eps:9.47,actual:false},
        {year:2027,q:4,eps:9.38,actual:false}
      ],
      annualEPS:[{year:2025,eps:2.13},{year:2026,eps:28.83},{year:2027,eps:34.41}]
    },
    {
      id:'seed-2408-2026-04', reportDate:'2026-04-14', broker:'永豐投顧', priceAtReport:225.50,
      quarters:[
        {year:2026,q:1,eps:8.41,actual:true},
        {year:2026,q:2,eps:11.75,actual:false},
        {year:2026,q:3,eps:13.01,actual:false},
        {year:2026,q:4,eps:13.19,actual:false}
      ],
      annualEPS:[{year:2026,eps:46.37}]
    }
  ]);
}

async function backfill3665History(){
  await addSnapshotsIfMissing('3665', [
    {
      id:'seed-3665-2025-03', reportDate:'2025-03-12', broker:'中信投顧', priceAtReport:541, targetPrice:625,
      quarters:[
        {year:2024,q:4,eps:8.48,actual:true},
        {year:2025,q:1,eps:7.92,actual:false},
        {year:2025,q:2,eps:7.58,actual:false},
        {year:2025,q:3,eps:8.82,actual:false},
        {year:2025,q:4,eps:11.24,actual:false},
        {year:2026,q:1,eps:9.98,actual:false},
        {year:2026,q:2,eps:11.12,actual:false},
        {year:2026,q:3,eps:11.36,actual:false}
      ],
      annualEPS:[{year:2024,eps:23.97},{year:2025,eps:35.56},{year:2026,eps:45.04}]
    },
    {
      id:'seed-3665-2025-07', reportDate:'2025-07-02', broker:'中信投顧', priceAtReport:848, targetPrice:950,
      quarters:[
        {year:2025,q:1,eps:8.47,actual:true},
        {year:2025,q:2,eps:10.38,actual:false},
        {year:2025,q:3,eps:10.71,actual:false},
        {year:2025,q:4,eps:12.26,actual:false},
        {year:2026,q:1,eps:10.88,actual:false},
        {year:2026,q:2,eps:10.91,actual:false},
        {year:2026,q:3,eps:12.79,actual:false},
        {year:2026,q:4,eps:14.79,actual:false}
      ],
      annualEPS:[{year:2025,eps:41.82},{year:2026,eps:49.37}]
    },
    {
      id:'seed-3665-2025-08', reportDate:'2025-08-21', broker:'永豐投顧', priceAtReport:925, targetPrice:1234,
      quarters:[
        {year:2025,q:1,eps:8.31,actual:true},
        {year:2025,q:2,eps:10.38,actual:true},
        {year:2025,q:3,eps:11.03,actual:false},
        {year:2025,q:4,eps:13.69,actual:false}
      ],
      annualEPS:[{year:2025,eps:43.36},{year:2026,eps:53.65}]
    },
    {
      id:'seed-3665-2025-11', reportDate:'2025-11-10', broker:'永豐投顧', priceAtReport:1415, targetPrice:2026,
      quarters:[
        {year:2025,q:1,eps:8.26,actual:true},
        {year:2025,q:2,eps:10.37,actual:true},
        {year:2025,q:3,eps:13.47,actual:true},
        {year:2025,q:4,eps:15.16,actual:false}
      ],
      annualEPS:[{year:2025,eps:47.26},{year:2026,eps:72.03},{year:2027,eps:90.03}]
    }
  ]);
}
async function backfillTargetPrices(){
  const knownTargets = {
    'seed-3665-1': 2850,
    'seed-2481-1': 190,
    'seed-2344-2': 20.30
  };
  const list = await loadJSON(KEY_STOCKS, []);
  for(const s of list){
    const snaps = await loadJSON(kSnap(s.code), []);
    let changed = false;
    snaps.forEach(sn=>{
      if(sn.targetPrice == null && knownTargets[sn.id] != null){
        sn.targetPrice = knownTargets[sn.id];
        changed = true;
      }
    });
    if(changed) await saveJSON(kSnap(s.code), snaps);
  }
}

(async function init(){
  await seedIfEmpty();
  await seedPriceIfMissing('3665', 2005);
  await seedPriceIfMissing('2481', 146.5);
  await seedPriceIfMissing('2344', 181.5);
  await backfillTargetPrices();
  await backfill3665History();
  await ensureStockRegistered('2408', '南亞科');
  await backfill2408History();
  await seedPriceIfMissing('2408', 517);
  stocks = await loadJSON(KEY_STOCKS, []);
  if(stocks.length){
    selected = stocks[0].code;
    snapshots = await loadJSON(kSnap(selected), []);
    currentPrice = await loadJSON(kPrice(selected), null);
    priceHistory = await getPriceHistory(selected);
  }
  render();
})();
