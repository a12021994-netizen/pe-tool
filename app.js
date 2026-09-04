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

async function syncFromDrive(){
  const statusEl = document.getElementById('syncStatus');
  const btn = document.getElementById('btnSync');
  btn.disabled = true;
  try{
    if (!driveAccessToken){
      statusEl.textContent = '連接中...（請在跳出的Google視窗完成授權）';
      await connectDrive();
    }
    statusEl.textContent = '讀取資料表中...';
    const csvText = await fetchTrackingCSV();
    allRows = rowsFromCSV(csvText);
    await saveJSON(KEY_ROWS, allRows);
    const missingCount = allRows.filter(r => r.price == null).length;
    if (missingCount){
      statusEl.textContent = `讀取完成，正在用FinMind補${missingCount}筆缺少的股價...`;
      await fillMissingPrices(allRows, statusEl);
      await saveJSON(KEY_ROWS, allRows);
    }
    statusEl.textContent = `同步完成，共 ${allRows.length} 筆資料，最後同步時間 ${new Date().toLocaleString('zh-TW')}。`;
    if (!selectedCode && allRows.length) selectedCode = allRows[0].code;
    renderStockOptions();
    renderMain();
    loadPriceHistoryForSelected();
  }catch(e){
    statusEl.textContent = '同步失敗：' + e.message;
  }
  btn.disabled = false;
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
        // 補完股價後，若原本因缺股價而沒算出Forward P/E，這裡順便補算
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
// State + rendering
// ---------------------------------------------------------------
let allRows = [];
let selectedCode = null;
let priceHistory = []; // 目前選定股票的每日股價（來自FinMind），格式 [{date, close}]
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

async function loadPriceHistoryForSelected(){
  if (!selectedCode) return;
  if (priceHistoryCache[selectedCode]){ priceHistory = priceHistoryCache[selectedCode]; renderMain(); return; }
  const rows = allRows.filter(r=>r.code===selectedCode);
  if (!rows.length) return;
  const earliest = rows.map(r=>r.reportDate).sort()[0];
  const today = new Date().toISOString().slice(0,10);
  try{
    const hist = await fetchPriceHistoryFromAPI(selectedCode, earliest, today);
    priceHistoryCache[selectedCode] = hist;
    priceHistory = hist;
  }catch(e){
    console.warn('股價API抓取失敗，改用報告當天股價點:', e.message);
    priceHistory = [];
  }
  renderMain();
}

function stockList(){
  const map = new Map();
  allRows.forEach(r=>{ if (r.code && !map.has(r.code)) map.set(r.code, r.name); });
  return [...map.entries()]
    .map(([code,name])=>({code,name}))
    .sort((a,b)=> a.code.localeCompare(b.code, undefined, {numeric:true}));
}

function renderStockOptions(){
  const sel = document.getElementById('stockSelect');
  const stocks = stockList();
  sel.innerHTML = stocks.length
    ? stocks.map(s=>`<option value="${s.code}" ${s.code===selectedCode?'selected':''}>${s.code} ${s.name}</option>`).join('')
    : '<option value="">尚無資料</option>';
}

function parsePE(peStr){
  // "25.4x (24F)" -> 25.4 ; "N/A (24F)" -> null
  if (!peStr) return null;
  const m = peStr.match(/(-?[\d.]+)x/);
  return m ? parseFloat(m[1]) : null;
}

// 共用：畫X軸日期標籤（含防重疊），回傳SVG片段字串
function drawDateAxis(points, xOf, H, showLabels){
  let svg = '';
  if (!showLabels) return svg;
  // 同一天的報告只顯示一次日期標籤
  const seen = new Set();
  const uniquePoints = [];
  points.forEach(p=>{
    if (!seen.has(p.reportDate)){ seen.add(p.reportDate); uniquePoints.push(p); }
  });
  // 橫式文字，彼此太近時往下一行排，不重疊
  const LABEL_W = 32;
  const rows = [];
  uniquePoints.forEach(p=>{
    const x = xOf(p.date);
    const label = p.reportDate.slice(2).replace(/-/g, '/');
    let row = 0;
    while (rows[row] && rows[row].some(o => Math.abs(o - x) < LABEL_W)) row++;
    if (!rows[row]) rows[row] = [];
    rows[row].push(x);
    const y = H - 8 - row * 11;
    svg += `<text x="${x}" y="${y}" text-anchor="middle" font-size="7" fill="var(--text3)">${label}</text>`;
  });
  return svg;
}

function buildDatedPoints(rows){
  return rows.map(r=>({
    date: new Date(r.reportDate),
    reportDate: r.reportDate,
    broker: r.broker,
    price: r.price,
    target: r.target,
    pe: parsePE(r.forwardPE),
    reportPE: r.reportPE
  })).sort((a,b)=> a.date - b.date);
}

// 方案A - 圖1：本益比比較（Forward P/E vs 報告給予之P/E），單一Y軸
function buildPEChartSVG(rows, dailyHistory, currentStatus){
  const points = buildDatedPoints(rows).filter(p => p.pe != null || p.reportPE != null);
  if (!points.length) return '';

  const COLOR_FPE = 'var(--accent)';
  const COLOR_RPE = '#d97706';
  const COLOR_CURRENT = '#0f6e56';
  const hasCurrent = currentStatus && currentStatus.currentPE != null;
  const currentDate = new Date();

  const W = 640, H = 220, padL = 44, padR = 16, padT = 14, padB = 60;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const allDates = points.map(p=>p.date.getTime())
    .concat((dailyHistory||[]).map(h=>new Date(h.date).getTime()))
    .concat(hasCurrent ? [currentDate.getTime()] : []);
  const minDate = Math.min(...allDates);
  const maxDate = Math.max(...allDates);
  const dateSpan = Math.max(1, maxDate - minDate);
  const xOf = d => padL + ((d.getTime()-minDate)/dateSpan) * plotW;

  const peVals = points.filter(p=>p.pe!=null).map(p=>p.pe)
    .concat(points.filter(p=>p.reportPE!=null).map(p=>p.reportPE))
    .concat(hasCurrent ? [currentStatus.currentPE] : []);
  const maxPE = Math.max(...peVals), minPE = Math.min(...peVals);
  const useLog = maxPE / Math.max(0.5, Math.abs(minPE) || 0.5) > 20 && minPE > 0;
  const yMin = useLog ? Math.max(0.5, minPE*0.7) : Math.min(0, minPE*1.1);
  const yMax = maxPE * 1.15;
  const yOf = v => {
    if (useLog){
      const logMin = Math.log(yMin), logMax = Math.log(yMax);
      return padT + plotH - ((Math.log(Math.max(v,yMin))-logMin)/(logMax-logMin)) * plotH;
    }
    return padT + plotH - ((v-yMin)/(yMax-yMin)) * plotH;
  };

  let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="本益比比較圖">`;
  [0,0.25,0.5,0.75,1].forEach(f=>{
    const y = padT + plotH*f;
    svg += `<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
  });
  if (useLog){
    const logMin = Math.log(yMin), logMax = Math.log(yMax);
    [yMin, Math.sqrt(yMin*yMax), yMax].forEach(v=>{
      const y = padT + plotH - ((Math.log(v)-logMin)/(logMax-logMin)) * plotH;
      svg += `<text x="${padL-5}" y="${y+3}" text-anchor="end" font-size="9" fill="var(--text3)">${v.toFixed(1)}x</text>`;
    });
  } else {
    [0,0.5,1].forEach(f=>{
      const y = padT + plotH*(1-f);
      const val = yMin + (yMax-yMin)*f;
      svg += `<text x="${padL-5}" y="${y+3}" text-anchor="end" font-size="9" fill="var(--text3)">${val.toFixed(1)}x</text>`;
    });
  }
  svg += `<text x="${padL}" y="9" font-size="8" fill="var(--text3)">本益比 (x)</text>`;

  // 收集所有要畫的候選點（含標籤文字），再統一做碰撞閃避：
  // 依X排序後，若新標籤跟前面「已放置」的任一標籤垂直距離太近，就往下一層堆疊。
  const candidates = [];
  points.forEach(p=>{
    const x = xOf(p.date);
    if (p.reportPE != null) candidates.push({ x, y: yOf(p.reportPE), text: p.reportPE.toFixed(1)+'x', color: COLOR_RPE, dotColor: COLOR_RPE, dotR: 3.5, shape: 'circle' });
    if (p.pe != null) candidates.push({ x, y: yOf(p.pe), text: p.pe.toFixed(1)+'x', color: 'var(--text2)', dotColor: COLOR_FPE, dotR: 4, shape: 'circle' });
  });
  if (hasCurrent){
    const x = xOf(currentDate), y = yOf(currentStatus.currentPE);
    candidates.push({ x, y, text: `目前 ${currentStatus.currentPE.toFixed(1)}x`, color: COLOR_CURRENT, dotColor: COLOR_CURRENT, dotR: 5, shape: 'star' });
  }
  candidates.sort((a,b)=> a.x - b.x || a.y - b.y);
  const placedLabels = [];
  const LABEL_W = 30, LABEL_H = 11;
  function findFreeSlot(x, baseY){
    for (let level = 0; level < 6; level++){
      const y = baseY - 6 - level*LABEL_H;
      const overlaps = placedLabels.some(l => Math.abs(l.x - x) < LABEL_W && Math.abs(l.y - y) < LABEL_H*0.8);
      if (!overlaps){ placedLabels.push({x, y}); return y; }
    }
    const y = baseY - 6 - 6*LABEL_H;
    placedLabels.push({x, y});
    return y;
  }

  candidates.forEach(c=>{
    if (c.shape === 'star'){
      // 目前推估：用星形標記跟歷史報告的圓點區分
      const r1 = c.dotR + 2.5, r2 = (c.dotR + 2.5) * 0.45;
      let pts = [];
      for (let i = 0; i < 10; i++){
        const r = i % 2 === 0 ? r1 : r2;
        const ang = (Math.PI / 5) * i - Math.PI / 2;
        pts.push(`${c.x + r*Math.cos(ang)},${c.y + r*Math.sin(ang)}`);
      }
      svg += `<polygon points="${pts.join(' ')}" fill="${c.dotColor}" stroke="var(--bg)" stroke-width="1"/>`;
    } else {
      svg += `<circle cx="${c.x}" cy="${c.y}" r="${c.dotR}" fill="${c.dotColor}" stroke="var(--bg)" stroke-width="1.3"/>`;
    }
  });
  candidates.forEach(c=>{
    const ly = findFreeSlot(c.x, c.y);
    svg += `<text x="${c.x}" y="${ly}" text-anchor="${c.shape==='star'?'end':'middle'}" font-size="8" fill="${c.color}" font-weight="${c.shape==='star'?'600':'400'}">${c.text}</text>`;
  });

  svg += drawDateAxis(points, xOf, H, true);
  svg += `</svg>`;
  return svg;
}

// 方案A - 圖2：股價與目標價，單一Y軸
function buildPriceChartSVG(rows, dailyHistory){
  dailyHistory = dailyHistory || [];
  const points = buildDatedPoints(rows);
  const priceVals = points.filter(p=>p.price!=null).map(p=>p.price)
    .concat(points.filter(p=>p.target!=null).map(p=>p.target))
    .concat(dailyHistory.map(h=>h.close));
  if (!priceVals.length) return '';

  const COLOR_TARGET = '#7c3aed';
  const W = 640, H = 170, padL = 44, padR = 16, padT = 14, padB = 60;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const allDates = points.map(p=>p.date.getTime()).concat(dailyHistory.map(h=>new Date(h.date).getTime()));
  const minDate = Math.min(...allDates);
  const maxDate = Math.max(...allDates);
  const dateSpan = Math.max(1, maxDate - minDate);
  const xOf = d => padL + ((d.getTime()-minDate)/dateSpan) * plotW;

  const pMin = Math.min(...priceVals)*0.9;
  const pMax = Math.max(...priceVals)*1.1;
  const pyOf = v => padT + plotH - ((v-pMin)/(pMax-pMin)) * plotH;

  let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="股價與目標價圖">`;
  [0,0.5,1].forEach(f=>{
    const y = padT + plotH*f;
    svg += `<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
    const val = pMax - (pMax-pMin)*f;
    svg += `<text x="${padL-5}" y="${y+3}" text-anchor="end" font-size="9" fill="var(--text3)">${Math.round(val).toLocaleString()}</text>`;
  });
  svg += `<text x="${padL}" y="9" font-size="8" fill="var(--text3)">股價 (NT$)</text>`;

  if (dailyHistory.length > 1){
    const dPts = dailyHistory.map(h=> `${xOf(new Date(h.date))},${pyOf(h.close)}`).join(' ');
    svg += `<polyline points="${dPts}" fill="none" stroke="var(--text3)" stroke-width="1" opacity="0.65"/>`;
  } else {
    const pricePts = points.filter(p=>p.price!=null).map(p=> `${xOf(p.date)},${pyOf(p.price)}`).join(' ');
    svg += `<polyline points="${pricePts}" fill="none" stroke="var(--text2)" stroke-width="1.5"/>`;
    points.filter(p=>p.price!=null).forEach(p=>{
      svg += `<circle cx="${xOf(p.date)}" cy="${pyOf(p.price)}" r="2" fill="var(--text2)"/>`;
    });
  }
  const targetPts = points.filter(p=>p.target!=null);
  let lastTx = -Infinity;
  targetPts.forEach(p=>{
    const x = xOf(p.date), y = pyOf(p.target);
    svg += `<polygon points="${x},${y-4} ${x+4},${y} ${x},${y+4} ${x-4},${y}" fill="none" stroke="${COLOR_TARGET}" stroke-width="1.3"/>`;
    // 目標價數值標籤，太密集時交錯上下避免疊字
    const bump = (x - lastTx) < 24 ? 11 : 0;
    svg += `<text x="${x}" y="${y-8-bump}" text-anchor="middle" font-size="8" fill="${COLOR_TARGET}">${Math.round(p.target).toLocaleString()}</text>`;
    lastTx = x;
  });

  svg += drawDateAxis(points, xOf, H, true);
  svg += `</svg>`;
  return svg;
}

function buildTable(rows){
  if (!rows.length) return '<div class="empty">尚無資料</div>';
  const sorted = [...rows].sort((a,b)=> new Date(b.reportDate) - new Date(a.reportDate));
  const trs = sorted.map(r=>{
    const epsDisplay = r.epsThisYear != null || r.epsNextYear != null
      ? `${r.epsThisYear ?? '-'} / ${r.epsNextYear ?? '-'}`
      : '-';
    return `<tr>
      <td>${r.reportDate}</td>
      <td>${r.broker}</td>
      <td>${r.price != null ? r.price.toLocaleString() : '-'}</td>
      <td>${r.target != null ? r.target.toLocaleString() : '-'}</td>
      <td>${epsDisplay}</td>
      <td>${r.forwardPE || '-'}</td>
      <td>${r.reportPERaw || '-'}</td>
      <td>${r.link ? `<a href="${r.link}" target="_blank" rel="noopener">開啟</a>` : '-'}</td>
    </tr>`;
  }).join('');
  return `<table><thead><tr><th>報告日期</th><th>券商</th><th>當時股價</th><th>目標價</th><th>預估EPS(當年度/次年度)</th><th>發布當下Forward P/E</th><th>報告給予之本益比倍數</th><th>報告連結</th></tr></thead><tbody>${trs}</tbody></table>`;
}

function computeCurrentStatus(rows, dailyHistory){
  if (!rows.length) return null;
  const sorted = [...rows].sort((a,b)=> new Date(b.reportDate) - new Date(a.reportDate));
  const latest = sorted[0];
  let currentPrice = null, priceDate = null;
  if (dailyHistory.length){
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
  return { currentPrice, priceDate, eps, epsYear, currentPE, isLiveData: dailyHistory.length > 0 };
}

function renderMain(){
  const area = document.getElementById('mainArea');
  const rows = allRows.filter(r=>r.code === selectedCode);
  if (!selectedCode || !rows.length){
    area.innerHTML = `<div class="card"><div class="empty">${allRows.length ? '請選擇一檔股票' : '尚無資料，請按上方「同步資料」從Google Drive讀取'}</div></div>`;
    return;
  }
  const status = computeCurrentStatus(rows, priceHistory);
  const peChart = buildPEChartSVG(rows, priceHistory, status);
  const priceChart = buildPriceChartSVG(rows, priceHistory);
  const statusHtml = status ? `
    <div class="card">
      <h2>目前狀態</h2>
      <div class="row">
        <div class="metric"><div class="v">${status.currentPrice != null ? status.currentPrice.toLocaleString() : '-'}</div><div class="l">最新收盤價${status.isLiveData ? `（${status.priceDate}）` : '（來自最新報告，非即時）'}</div></div>
        <div class="metric"><div class="v">${status.currentPE != null ? status.currentPE.toFixed(1)+'x' : '無法計算'}</div><div class="l">目前 Forward P/E（用${status.epsYear}EPS ${status.eps ?? '-'}）</div></div>
      </div>
    </div>
  ` : '';
  area.innerHTML = `
    ${statusHtml}
    <div class="card">
      <h2>本益比比較：Forward P/E vs 報告給予之 P/E</h2>
      ${peChart || '<div class="empty">資料不足以繪圖（此股票尚無Forward P/E或報告給予之P/E數值）</div>'}
      <div class="legend">
        <span><span class="sw" style="background:var(--accent)"></span>Forward P/E（自行換算）</span>
        <span><span class="sw" style="background:#d97706"></span>報告給予之 P/E</span>
        <span><span class="sw" style="background:var(--warn)"></span>EPS為負/零，本益比無意義</span>
        <span><span class="sw" style="background:#0f6e56"></span>★ 目前推估Forward P/E</span>
      </div>
      <div class="hint">點與點之間不連線，僅呈現各次報告發布當下的數值。</div>
    </div>
    <div class="card">
      <h2>股價與目標價</h2>
      ${priceChart || '<div class="empty">資料不足以繪圖</div>'}
      <div class="legend">
        <span><span class="sw" style="background:var(--text2)"></span>股價走勢</span>
        <span>◇ <span style="color:#7c3aed">目標價</span></span>
      </div>
      <div class="hint">${priceHistory.length > 1 ? '灰線為FinMind抓取的每日實際股價走勢' : '灰線為每份報告當時股價（尚無每日股價資料）'}。</div>
    </div>
    <div class="card">
      <h2>已收錄的券商報告 (${rows.length})</h2>
      ${buildTable(rows)}
    </div>
  `;
}

document.getElementById('stockSelect').onchange = (e)=>{
  selectedCode = e.target.value;
  saveJSON(KEY_SELECTED, selectedCode);
  document.getElementById('stockTypeIn').value = '';
  priceHistory = [];
  renderMain();
  loadPriceHistoryForSelected();
};
document.getElementById('stockTypeIn').addEventListener('input', (e)=>{
  const code = e.target.value.trim();
  if (!code) return;
  const found = stockList().find(s=>s.code === code);
  if (found){
    selectedCode = code;
    saveJSON(KEY_SELECTED, selectedCode);
    document.getElementById('stockSelect').value = code;
    priceHistory = [];
    renderMain();
    loadPriceHistoryForSelected();
  }
});
document.getElementById('btnSync').onclick = syncFromDrive;

(async function init(){
  allRows = await loadJSON(KEY_ROWS, []);
  selectedCode = await loadJSON(KEY_SELECTED, null);
  if (!selectedCode && allRows.length) selectedCode = allRows[0].code;
  renderStockOptions();
  renderMain();
  loadPriceHistoryForSelected();
})();
