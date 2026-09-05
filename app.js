// ---------------------------------------------------------------
// index.html — 個股明細頁：股票選單、Forward P/E圖、股價圖、報告列表。
// 共用邏輯（storage、CSV、Drive、FinMind）在 shared.js。
// ---------------------------------------------------------------

let allRows = [];
let selectedCode = null;
let priceHistory = []; // 目前選定股票的每日股價（來自FinMind），格式 [{date, close}]

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

function renderStockOptions(){
  const sel = document.getElementById('stockSelect');
  const stocks = stockListFrom(allRows);
  sel.innerHTML = stocks.length
    ? stocks.map(s=>`<option value="${s.code}" ${s.code===selectedCode?'selected':''}>${s.code} ${s.name}</option>`).join('')
    : '<option value="">尚無資料</option>';
}

// 共用：畫X軸日期標籤（含防重疊），回傳SVG片段字串
function drawDateAxis(points, xOf, H, showLabels){
  let svg = '';
  if (!showLabels) return svg;
  const seen = new Set();
  const uniquePoints = [];
  points.forEach(p=>{
    if (!seen.has(p.reportDate)){ seen.add(p.reportDate); uniquePoints.push(p); }
  });
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

// 圖1：本益比比較（Forward P/E vs 報告給予之P/E），單一Y軸
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

// 圖2：股價與目標價，單一Y軸
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
  let mismatchCount = 0;
  const trs = sorted.map(r=>{
    const epsDisplay = r.epsThisYear != null || r.epsNextYear != null
      ? `${r.epsThisYear ?? '-'} / ${r.epsNextYear ?? '-'}`
      : '-';

    let forwardPECell = r.forwardPE || '-';
    const recomputed = computeForwardPEString(r.price, r.reportDate, r.epsThisYear, r.epsNextYear);
    const storedNum = parsePE(r.forwardPE);
    const recomputedNum = parsePE(recomputed);
    if (storedNum != null && recomputedNum != null){
      const diffPct = Math.abs(storedNum - recomputedNum) / Math.max(Math.abs(recomputedNum), 0.01);
      if (diffPct > 0.05){
        mismatchCount++;
        forwardPECell = `<span style="color:var(--warn)" title="用股價÷EPS重新換算應為 ${recomputed}，跟資料表存的 ${r.forwardPE} 對不起來，可能誤用了目標價或抓錯EPS年度">⚠ ${r.forwardPE}</span>`;
      }
    }

    return `<tr>
      <td>${r.reportDate}</td>
      <td>${r.broker}</td>
      <td>${r.price != null ? r.price.toLocaleString() : '-'}</td>
      <td>${r.target != null ? r.target.toLocaleString() : '-'}</td>
      <td>${epsDisplay}</td>
      <td>${forwardPECell}</td>
      <td>${r.reportPERaw || '-'}</td>
      <td>${r.link ? `<a href="${r.link}" target="_blank" rel="noopener">開啟</a>` : '-'}</td>
    </tr>`;
  }).join('');
  return `<table><thead><tr><th>報告日期</th><th>券商</th><th>當時股價</th><th>目標價</th><th>預估EPS(當年度/次年度)</th><th>發布當下Forward P/E</th><th>報告給予之本益比倍數</th><th>報告連結</th></tr></thead><tbody>${trs}</tbody></table>
  ${mismatchCount ? `<div class="hint" style="color:var(--warn)">⚠ 有 ${mismatchCount} 筆Forward P/E跟股價÷EPS重新換算的結果對不上，滑鼠移到⚠圖示上可看詳細數字，建議回頭核對原始報告。</div>` : ''}`;
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
  const found = stockListFrom(allRows).find(s=>s.code === code);
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
