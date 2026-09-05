let allRows = [];

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
      reportPE: latest.reportPE, currentPE, diff
    });
  }
  results.sort((a,b)=> b.diff - a.diff);
  return results;
}

function buildRankingTable(results){
  if (!results.length) return '<div class="empty">沒有符合條件的股票（需要有報告給予之P/E，且最新報告在9個月內）</div>';
  const trs = results.map(r=>`
    <tr>
      <td>${r.code} ${r.name}</td>
      <td>${r.latestReportDate}</td>
      <td>${r.latestBroker}</td>
      <td>${r.target != null ? r.target.toLocaleString() : '-'}</td>
      <td>${r.currentPrice != null ? r.currentPrice.toLocaleString() : '-'}</td>
      <td>${r.reportPE.toFixed(2)}x</td>
      <td>${r.currentPE.toFixed(2)}x</td>
      <td style="color:${r.diff>0?'var(--good)':'var(--warn)'}">${r.diff>0?'+':''}${r.diff.toFixed(2)}</td>
    </tr>`).join('');
  return `<table><thead><tr><th>股票</th><th>最新報告日期</th><th>券商</th><th>目標價</th><th>最新收盤價</th><th>報告給予之P/E</th><th>目前Forward P/E</th><th>差（報告P/E − 目前P/E）</th></tr></thead><tbody>${trs}</tbody></table>`;
}

async function renderRanking(){
  const area = document.getElementById('rankingArea');
  if (!allRows.length){
    area.innerHTML = `<div class="empty">尚無資料，請按上方「同步資料」從Google Drive讀取</div>`;
    return;
  }
  area.innerHTML = `<div id="rankingStatus" class="hint">計算中...</div><div id="rankingTableArea"></div>`;
  const statusEl = document.getElementById('rankingStatus');
  const results = await buildRankingData(statusEl);
  statusEl.textContent = `共 ${results.length} 檔符合條件（有報告給予之P/E，且最新報告在9個月內）。`;
  document.getElementById('rankingTableArea').innerHTML = buildRankingTable(results) +
    `<div class="hint" style="margin-top:8px">差 = 最新報告給予之P/E − 用今日股價換算的目前Forward P/E。差越大，代表股價相對報告當時假設的估值越便宜（正值可能是機會，負值可能是變貴）。</div>`;
}

document.getElementById('btnSync').onclick = syncFromDrive;

(async function init(){
  allRows = await loadJSON(KEY_ROWS, []);
  await renderRanking();
})();
