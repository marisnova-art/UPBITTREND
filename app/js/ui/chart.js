// 차트 패널 — TradingView Lightweight Charts(무료, 출처 표시 필요)
// 캔들 + 거래량 + 이동평균(20·60) + 가이드 선(매수 구간, 1·2차 매도, 손절, 과거 매수가)
import { A } from '../analysis/trend.js';

const C = { up: '#F04452', down: '#4C8DFF', grid: '#141417', text: '#9A9AA3', accent: '#C6F432', warn: '#F5A524', white: '#EDEDEF', ma20: '#C9C9CF', ma60: '#7D7D86' };
const KST = 9 * 3600; // 분·시간봉은 한국 시간으로 보이게
const LONG = new Set(['1d', '1w', '1M', '1y']); // 날짜 단위 봉 (한국 시간 보정 안 함)
const TF_SEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400, '1w': 604800, '1M': 2592000, '1y': 31536000 };

export function createChart(el, legendEl, infoEl){
  const LW = window.LightweightCharts;
  const chart = LW.createChart(el, {
    autoSize: true,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: C.text, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: '#1F1F23', scaleMargins: { top: 0.14, bottom: 0.2 } },
    timeScale: { borderColor: '#1F1F23', timeVisible: true, secondsVisible: false, rightOffset: 6 },
    crosshair: { mode: LW.CrosshairMode.Normal },
    localization: { locale: 'ko-KR', priceFormatter: p => fmt(p) }
  });
  const candles = chart.addCandlestickSeries({ upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down, priceLineColor: C.white });
  const vol = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
  const ma20 = chart.addLineSeries({ color: C.ma20, lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
  const ma60 = chart.addLineSeries({ color: C.ma60, lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
  // 매수 구간 띠: 위·아래 두 선 사이를 옅게 칠하는 대신, 두 선 + 라벨로 표시(라이브러리 기본 기능만 사용)
  let lines = [], data = [], tf = '1d', off = 0;

  function fmt(p){
    const a = Math.abs(p); const d = a >= 100 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
    return p.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function maLine(arr, n){
    const m = A.sma(arr.map(x => x.c), n);
    return arr.map((x, i) => m[i] == null ? null : { time: x.time, value: m[i] }).filter(Boolean);
  }
  function setData(rows, timeframe){
    tf = timeframe; off = LONG.has(tf) ? 0 : KST;
    data = rows.map(x => ({ ...x, time: x.time + off }));
    candles.setData(data.map(x => ({ time: x.time, open: x.o, high: x.h, low: x.l, close: x.c })));
    vol.setData(data.map(x => ({ time: x.time, value: x.v, color: x.c >= x.o ? 'rgba(240,68,82,.35)' : 'rgba(76,141,255,.35)' })));
    ma20.setData(maLine(data, 20)); ma60.setData(maLine(data, 60));
    chart.timeScale().fitContent();
    pinned = null; tip.hidden = true; // 종목·시간 단위가 바뀌면 고정 카드 해제
    showInfo(data.length - 1);
    refit();
  }
  // 최근 봉 위주로 보이기 (화면 폭에 맞춰 개수 조절)
  function refit(){
    if (!data.length) return;
    const w = el.clientWidth || 800;
    if (tf === '1M' || tf === '1y'){ chart.timeScale().fitContent(); return; } // 월·연봉은 전체
    const n = Math.min(data.length, Math.max(40, Math.round(w / 9)), tf === '1d' ? 120 : 160);
    chart.timeScale().setVisibleLogicalRange({ from: data.length - n, to: data.length + 3 });
  }
  // 실시간 체결가로 마지막 봉 갱신(새 시간대면 새 봉 추가)
  function tick(price, tsMs){
    if (!data.length || price == null) return;
    const sec = TF_SEC[tf]; if (!sec) return;
    let t = Math.floor(tsMs / 1000);
    if (tf === '1d') t = Math.floor(t / 86400) * 86400;
    else if (tf === '1w'){ const d = Math.floor(t / 86400); const dow = (d + 3) % 7; t = (d - dow) * 86400; }
    else if (tf === '1M'){ const d = new Date(t * 1000); t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; }
    else if (tf === '1y'){ const d = new Date(t * 1000); t = Date.UTC(d.getUTCFullYear(), 0, 1) / 1000; }
    else t = Math.floor(t / sec) * sec;
    t += off;
    const last = data[data.length - 1];
    if (t < last.time) return;
    if (t === last.time){ last.h = Math.max(last.h, price); last.l = Math.min(last.l, price); last.c = price; }
    else data.push({ time: t, o: price, h: price, l: price, c: price, v: 0 });
    const b = data[data.length - 1];
    candles.update({ time: b.time, open: b.o, high: b.h, low: b.l, close: b.c });
    if (hoverIdx == null) showInfo(pinned ? pinned.i : data.length - 1);
    if (pinned && pinned.i === data.length - 1) renderTip(pinned.i, pinned.x, pinned.y, true);
  }
  // 정보: (1) 왼쪽 위 고정 정보줄 (2) 커서를 따라다니는 시세 카드. 클릭하면 카드가 그 자리에 고정되고 ✕로 닫음.
  let hoverIdx = null, pinned = null; // pinned = { i, x, y }
  const tip = document.createElement('div'); tip.className = 'ctip'; tip.hidden = true;
  el.parentElement.appendChild(tip);
  tip.addEventListener('click', e => { if (e.target.closest('[data-unpin]')){ pinned = null; tip.hidden = true; tip.classList.remove('pinned'); } });
  const idxOf = t => { let lo = 0, hi = data.length - 1; while (lo <= hi){ const m = (lo + hi) >> 1; if (data[m].time === t) return m; if (data[m].time < t) lo = m + 1; else hi = m - 1; } return null; };
  function timeLabel(t){
    const d = new Date(t * 1000), p = n => String(n).padStart(2, '0');
    const day = `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}`;
    if (tf === '1y') return `${d.getUTCFullYear()}년`;
    if (tf === '1M') return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}`;
    return LONG.has(tf) ? day : `${day} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }
  function fmtVol(v){ return v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(2) + 'K' : v.toFixed(v < 10 ? 4 : 2); }
  function krw(v){ return v >= 1e12 ? (v / 1e12).toFixed(2) + '조' : v >= 1e8 ? Math.round(v / 1e8).toLocaleString('ko-KR') + '억' : v >= 1e4 ? Math.round(v / 1e4).toLocaleString('ko-KR') + '만' : Math.round(v).toLocaleString('ko-KR'); }
  const sign = v => (v > 0 ? '+' : '') + v.toFixed(2) + '%';
  const toneOf = v => v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
  function stats(i){
    const b = data[i]; if (!b) return null;
    const prev = i > 0 ? data[i - 1].c : b.o;
    return { b, prev, chg: b.c - prev, chgPct: (b.c / prev - 1) * 100, range: b.h - b.l, rangePct: (b.h / b.l - 1) * 100, hiPct: (b.h / b.o - 1) * 100, loPct: (b.l / b.o - 1) * 100 };
  }
  function showInfo(i){
    if (!infoEl) return;
    const s = stats(i); if (!s){ infoEl.innerHTML = ''; return; }
    const { b } = s, tone = toneOf(s.chgPct);
    const cell = (k, v, cls = '') => `<span><em>${k}</em><b class="${cls}">${v}</b></span>`;
    infoEl.innerHTML = `<span class="t">${timeLabel(b.time)}</span>` +
      cell('시', fmt(b.o)) + cell('고', fmt(b.h), 'up') + cell('저', fmt(b.l), 'down') + cell('종', fmt(b.c), tone) +
      cell('등락', sign(s.chgPct), tone) + cell('고저폭', sign(s.rangePct).replace('+', '')) +
      cell('거래량', fmtVol(b.v)) + (b.value ? cell('거래대금', krw(b.value)) : '');
  }
  function renderTip(i, x, y, isPinned){
    const s = stats(i); if (!s){ tip.hidden = true; return; }
    const { b } = s, tone = toneOf(s.chgPct);
    const row = (k, v, cls = '', sub = '') => `<div class="r"><span>${k}</span><b class="${cls}">${v}${sub ? `<i>${sub}</i>` : ''}</b></div>`;
    tip.innerHTML = `<div class="h"><span>${timeLabel(b.time)}</span>${isPinned ? '<button data-unpin aria-label="닫기">✕</button>' : '<span class="hint">클릭하면 고정</span>'}</div>` +
      row('시가', fmt(b.o)) +
      row('고가', fmt(b.h), 'up', sign(s.hiPct)) +
      row('저가', fmt(b.l), 'down', sign(s.loPct)) +
      row('종가', fmt(b.c), tone) +
      row('전봉 대비', (s.chg > 0 ? '+' : '') + fmt(s.chg), tone, sign(s.chgPct)) +
      row('최고·최저 폭', fmt(s.range), '', s.rangePct.toFixed(2) + '%') +
      row('거래량', fmtVol(b.v)) +
      (b.value ? row('거래대금', krw(b.value)) : '');
    tip.classList.toggle('pinned', !!isPinned);
    tip.hidden = false;
    // 커서 옆에 두되 차트 밖으로 나가지 않게
    const W = el.clientWidth, H = el.clientHeight, tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = x + 16, top = y + 16;
    if (left + tw > W - 70) left = x - tw - 16;
    if (top + th > H - 30) top = Math.max(4, y - th - 16);
    tip.style.left = Math.max(4, left) + 'px'; tip.style.top = Math.max(4, top) + 'px';
  }
  chart.subscribeCrosshairMove(p => {
    const i = p && p.time != null && p.point && p.point.x >= 0 ? idxOf(p.time) : null;
    hoverIdx = i;
    showInfo(i == null ? (pinned ? pinned.i : data.length - 1) : i);
    if (pinned) return;                     // 고정 중엔 카드가 움직이지 않음
    if (i == null) tip.hidden = true; else renderTip(i, p.point.x, p.point.y, false);
  });
  chart.subscribeClick(p => {
    const i = p && p.time != null && p.point ? idxOf(p.time) : null;
    if (i == null) return;
    pinned = { i, x: p.point.x, y: p.point.y };   // 다른 봉을 누르면 그 봉으로 옮겨 고정
    renderTip(i, p.point.x, p.point.y, true);
  });
  function setGuide(g, pastBuys = []){
    lines.forEach(l => candles.removePriceLine(l)); lines = [];
    const add = (price, title, color, style = 2, width = 1) => { if (price && isFinite(price)) lines.push(candles.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title })); };
    const legend = [];
    if (g && g.stance !== 'avoid'){
      add(g.buyHi, '매수 구간 상단', C.accent, 0); add(g.buyLo, '매수 구간 하단', C.accent, 0);
      add(g.sell1, '1차 매도', C.white); add(g.sell2, '2차 매도', C.white); add(g.stop, '손절', C.warn);
      legend.push(['매수 구간', C.accent], ['매도가', C.white], ['손절', C.warn]);
    }
    for (const b of pastBuys.slice(0, 3)) add(b.price, b.label, '#7D7D86', 3);
    if (pastBuys.length) legend.push(['과거 매수가', '#7D7D86']);
    legend.push(['20선', C.ma20], ['60선', C.ma60]);
    if (legendEl) legendEl.innerHTML = legend.map(([t, c]) => `<span style="color:${c}">${t}</span>`).join('');
  }
  return { setData, tick, setGuide, refit, chart };
}
