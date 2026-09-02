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
        iReportPE=idx('報告給予之本益比倍數');
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
  return [...map.entries()].map(([code,name])=>({code,name}));
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

function buildChartSVG(rows, dailyHistory){
  dailyHistory = dailyHistory || [];
  const points = rows.map(r=>({
    date: new Date(r.reportDate),
    reportDate: r.reportDate,
    broker: r.broker,
    price: r.price,
    target: r.target,
    pe: parsePE(r.forwardPE),
    reportPE: r.reportPE
  })).sort((a,b)=> a.date - b.date);

  const validPE = points.filter(p=>p.pe != null);
  if (!validPE.length) return '';

  const COLOR_FPE = 'var(--accent)';
  const COLOR_RPE = '#d97706';
  const COLOR_TARGET = '#7c3aed';

  const W = 640, H = 210, padL = 46, padR = 46, padT = 14, padB = 40;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const allDates = points.map(p=>p.date.getTime()).concat(dailyHistory.map(h=>new Date(h.date).getTime()));
  const minDate = Math.min(...allDates);
  const maxDate = Math.max(...allDates);
  const dateSpan = Math.max(1, maxDate - minDate);
  const xOf = d => padL + ((d.getTime()-minDate)/dateSpan) * plotW;

  const peVals = validPE.map(p=>p.pe).concat(points.filter(p=>p.reportPE!=null).map(p=>p.reportPE));
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

  const priceVals = points.filter(p=>p.price!=null).map(p=>p.price)
    .concat(points.filter(p=>p.target!=null).map(p=>p.target))
    .concat(dailyHistory.map(h=>h.close));
  const pMin = priceVals.length ? Math.min(...priceVals)*0.9 : 0;
  const pMax = priceVals.length ? Math.max(...priceVals)*1.1 : 1;
  const pyOf = v => padT + plotH - ((v-pMin)/(pMax-pMin)) * plotH;

  let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Forward PE歷史圖">`;
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
  if (priceVals.length){
    [0,0.5,1].forEach(f=>{
      const y = padT + plotH*(1-f);
      const val = pMin + (pMax-pMin)*f;
      svg += `<text x="${W-padR+5}" y="${y+3}" text-anchor="start" font-size="9" fill="var(--text2)">${Math.round(val).toLocaleString()}</text>`;
    });
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
  }
  // 目標價：小菱形標記，畫在股價軸上
  points.filter(p=>p.target!=null).forEach(p=>{
    const x = xOf(p.date), y = pyOf(p.target);
    svg += `<polygon points="${x},${y-4} ${x+4},${y} ${x},${y+4} ${x-4},${y}" fill="none" stroke="${COLOR_TARGET}" stroke-width="1.3"/>`;
  });

  svg += `<text x="${padL}" y="9" font-size="8" fill="var(--text3)">Forward P/E (x)</text>`;
  if (priceVals.length) svg += `<text x="${W-padR}" y="9" text-anchor="end" font-size="8" fill="var(--text2)">股價 (NT$)</text>`;

  // 點位標籤防重疊：同一個x位置附近，交錯上下偏移量
  function drawPeLabel(x, y, text, color, bump){
    svg += `<text x="${x}" y="${y-6-bump}" text-anchor="middle" font-size="8" fill="${color}">${text}</text>`;
  }

  let lastX = -Infinity, bumpToggle = 0;
  const minPointGap = 26;
  points.forEach(p=>{
    const x = xOf(p.date);
    const closeToLast = (x - lastX) < minPointGap;
    const bump = closeToLast ? (bumpToggle % 2 === 0 ? 10 : 0) : 0;
    if (closeToLast) bumpToggle++; else bumpToggle = 0;

    if (p.reportPE != null){
      const ry = yOf(p.reportPE);
      svg += `<circle cx="${x}" cy="${ry}" r="3.5" fill="${COLOR_RPE}" stroke="var(--bg)" stroke-width="1.2"/>`;
      drawPeLabel(x, ry, p.reportPE.toFixed(1)+'x', COLOR_RPE, bump ? 12 : 0);
    }
    if (p.pe != null){
      const y = yOf(p.pe);
      svg += `<circle cx="${x}" cy="${y}" r="4" fill="${COLOR_FPE}" stroke="var(--bg)" stroke-width="1.5"/>`;
      drawPeLabel(x, y, p.pe.toFixed(1)+'x', 'var(--text2)', bump);
    } else {
      svg += `<circle cx="${x}" cy="${padT+plotH}" r="3" fill="var(--warn)"/>`;
      svg += `<text x="${x}" y="${padT+plotH-6}" text-anchor="middle" font-size="8" fill="var(--warn)">N/A</text>`;
    }
    lastX = x;
  });

  let lastLabelX = -Infinity;
  const minLabelGap = 40;
  points.forEach(p=>{
    const x = xOf(p.date);
    if (x - lastLabelX >= minLabelGap){
      svg += `<text x="${x}" y="${H-8}" text-anchor="end" font-size="6.5" fill="var(--text3)" transform="rotate(-35 ${x} ${H-8})">${p.reportDate.slice(2)}</text>`;
      lastLabelX = x;
    }
  });
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
      <td>${r.reportPE != null ? r.reportPE.toFixed(2)+'x' : '-'}</td>
    </tr>`;
  }).join('');
  return `<table><thead><tr><th>報告日期</th><th>券商</th><th>當時股價</th><th>目標價</th><th>預估EPS(當年度/次年度)</th><th>發布當下Forward P/E</th><th>報告給予之本益比倍數</th></tr></thead><tbody>${trs}</tbody></table>`;
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
  const chart = buildChartSVG(rows, priceHistory);
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
      <h2>各報告發布當下 Forward P/E、報告給予之 P/E、目標價及股價</h2>
      ${chart || '<div class="empty">資料不足以繪圖</div>'}
      <div class="legend">
        <span><span class="sw" style="background:var(--accent)"></span>Forward P/E（自行換算，左軸）</span>
        <span><span class="sw" style="background:#d97706"></span>報告給予之 P/E（左軸）</span>
        <span><span class="sw" style="background:var(--warn)"></span>EPS為負/零，本益比無意義</span>
        <span><span class="sw" style="background:var(--text2)"></span>股價走勢（右軸）</span>
        <span>◇ <span style="color:#7c3aed">目標價</span>（右軸）</span>
      </div>
      <div class="hint">${priceHistory.length > 1 ? '灰線為FinMind抓取的每日實際股價走勢' : '灰線為每份報告當時股價（尚無每日股價資料）'}；點與點之間不連線，僅呈現各次報告發布當下的數值。</div>
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
