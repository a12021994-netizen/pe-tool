let allRows = [];
let currentResults = [];
let sortState = { key: 'diff', dir: 'desc' };

const RANKING_COLUMNS = [
  { key: 'stock',      label: '股票',                    get: r => r.name },
  { key: 'reportDate', label: '最新報告日期',              get: r => r.latestReportDate },
  { key: 'broker',     label: '券商',                     get: r => r.latestBroker },
  { key: 'target',     label: '目標價',                   get: r => r.target },
  { key: 'price',      label: '最新收盤價',                get: r => r.currentPrice },
  { key: 'reportPE',   label: '報告給予之P/E',             get: r => r.reportPE },
  { key: 'currentPE',  label: '目前Forward P/E',          get: r => r.currentPE },
  { key: 'diff',       label: '差（報告P/E − 目前P/E）',    get: r => r.diff },
  { key: 'link',       label: '報告連結',                  get: null },
];

function sortRankingBy(key){
  if (sortState.key === key){
    sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
  } else {
    sortState.key = key;
    sortState.dir = 'asc';
  }
  document.getElementById('rankingTableArea').innerHTML = buildRankingTable(currentResults);
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
    statusEl.textContent = `資料同步完成，共 ${allRows.length} 筆。正在計算排行...`;
    await renderRanking();
  }catch(e){
    statusEl.textContent = '同步失敗：' + e.message;
  }
  btn.disabled = false;
}

// 差 = 最新報告給予之P/E − 用今日股價換算的目前Forward P/E，由大到小排序。
// 只納入「最新一份報告在9個月內」且有「報告給予之P/E」的股票。
async function buildRankingData(statusEl){
  const codes = stockListFrom(allRows);
  const nineMonthsAgo = new Date();
  nineMonthsAgo.setMonth(nineMonthsAgo.getMonth() - 9);
  const results = [];
  let done = 0;
  for (const s of codes){
    const rows = allRows.filter(r => r.code === s.code);
    const sorted = [...rows].sort((a,b)=> new Date(b.reportDate) - new Date(a.reportDate));
    const latest = sorted[0];
    done++;
    if (statusEl) statusEl.textContent = `計算排行中...${done}/${codes.length}`;
    if (!latest) continue;
    if (new Date(latest.reportDate) < nineMonthsAgo) continue;
    if (latest.reportPE == null) continue;

    let currentPrice = priceHistoryCache[s.code] && priceHistoryCache[s.code].length
      ? priceHistoryCache[s.code][priceHistoryCache[s.code].length - 1].close
      : null;
    if (currentPrice == null) currentPrice = await fetchLatestClose(s.code);
    if (currentPrice == null) currentPrice = latest.price;

    const today = new Date();
    const useNext = today.getMonth() >= 6;
    const eps = useNext ? latest.epsNextYear : latest.epsThisYear;
    if (eps == null || eps <= 0 || currentPrice == null) continue;
    const currentPE = currentPrice / eps;
    const diff = latest.reportPE - currentPE;

    results.push({
      code: s.code, name: s.name,
      latestReportDate: latest.reportDate, latestBroker: latest.broker,
      target: latest.target, currentPrice,
      reportPE: latest.reportPE, currentPE, diff,
      link: latest.link
    });
  }
  results.sort((a,b)=> b.diff - a.diff);
  return results;
}

function buildRankingTable(results){
  if (!results.length) return '<div class="empty">沒有符合條件的股票（需要有報告給予之P/E，且最新報告在9個月內）</div>';

  const col = RANKING_COLUMNS.find(c => c.key === sortState.key);
  const sorted = [...results].sort((a,b)=>{
    const va = col.get(a), vb = col.get(b);
    let cmp;
    if (va == null && vb == null) cmp = 0;
    else if (va == null) cmp = 1;
    else if (vb == null) cmp = -1;
    else if (typeof va === 'string') cmp = va.localeCompare(vb, 'zh-Hant');
    else cmp = va - vb;
    return sortState.dir === 'asc' ? cmp : -cmp;
  });

  const trs = sorted.map(r=>`
    <tr>
      <td><a href="index.html?code=${encodeURIComponent(r.code)}" target="_blank" rel="noopener">${r.code} ${r.name}</a></td>
      <td>${r.latestReportDate}</td>
      <td>${r.latestBroker}</td>
      <td>${r.target != null ? r.target.toLocaleString() : '-'}</td>
      <td>${r.currentPrice != null ? r.currentPrice.toLocaleString() : '-'}</td>
      <td>${r.reportPE.toFixed(2)}x</td>
      <td>${r.currentPE.toFixed(2)}x</td>
      <td style="color:${r.diff>0?'var(--good)':'var(--warn)'}">${r.diff>0?'+':''}${r.diff.toFixed(2)}</td>
      <td>${r.link ? `<a href="${r.link}" target="_blank" rel="noopener">開啟</a>` : '-'}</td>
    </tr>`).join('');

  const ths = RANKING_COLUMNS.map(c=>{
    if (!c.get) return `<th>${c.label}</th>`;
    const arrow = sortState.key === c.key ? (sortState.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th style="cursor:pointer;user-select:none" onclick="sortRankingBy('${c.key}')" title="點擊排序">${c.label}${arrow}</th>`;
  }).join('');

  return `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

async function renderRanking(){
  const area = document.getElementById('rankingArea');
  if (!allRows.length){
    area.innerHTML = `<div class="empty">尚無資料，請按上方「同步資料」從Google Drive讀取</div>`;
    return;
  }
  area.innerHTML = `<div id="rankingStatus" class="hint">計算中...</div><div id="rankingTableArea"></div>
    <div class="hint" style="margin-top:8px">差 = 最新報告給予之P/E − 用今日股價換算的目前Forward P/E。差越大，代表股價相對報告當時假設的估值越便宜（正值可能是機會，負值可能是變貴）。點欄位標題可依該欄排序。</div>`;
  const statusEl = document.getElementById('rankingStatus');
  const results = await buildRankingData(statusEl);
  currentResults = results;
  statusEl.textContent = `共 ${results.length} 檔符合條件（有報告給予之P/E，且最新報告在9個月內）。`;
  document.getElementById('rankingTableArea').innerHTML = buildRankingTable(results);
}

document.getElementById('btnSync').onclick = syncFromDrive;

(async function init(){
  allRows = await loadJSON(KEY_ROWS, []);
  await renderRanking();
})();
