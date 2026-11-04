// 차트 패널 — TradingView Lightweight Charts(무료, 출처 표시 필요)
// 캔들 + 거래량 + 이동평균(20·60) + 가이드 선(매수 구간, 1·2차 매도, 손절, 과거 매수가)
import { A } from '../analysis/trend.js';

const C = { up: '#F04452', down: '#4C8DFF', grid: '#141417', text: '#9A9AA3', accent: '#C6F432', warn: '#F5A524', white: '#EDEDEF', ma20: '#C9C9CF', ma60: '#7D7D86' };
const KST = 9 * 3600; // 분·시간봉은 한국 시간으로 보이게
const TF_SEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400, '1w': 604800 };

export function createChart(el, legendEl){
  const LW = window.LightweightCharts;
  const chart = LW.createChart(el, {
    autoSize: true,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: C.text, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: '#1F1F23', scaleMargins: { top: 0.08, bottom: 0.22 } },
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
    tf = timeframe; off = (tf === '1d' || tf === '1w') ? 0 : KST;
    data = rows.map(x => ({ ...x, time: x.time + off }));
    candles.setData(data.map(x => ({ time: x.time, open: x.o, high: x.h, low: x.l, close: x.c })));
    vol.setData(data.map(x => ({ time: x.time, value: x.v, color: x.c >= x.o ? 'rgba(240,68,82,.35)' : 'rgba(76,141,255,.35)' })));
    ma20.setData(maLine(data, 20)); ma60.setData(maLine(data, 60));
    chart.timeScale().fitContent();
    const n = Math.min(data.length, tf === '1d' ? 120 : 160);
    if (data.length > n) chart.timeScale().setVisibleLogicalRange({ from: data.length - n, to: data.length + 4 });
  }
  // 실시간 체결가로 마지막 봉 갱신(새 시간대면 새 봉 추가)
  function tick(price, tsMs){
    if (!data.length || price == null) return;
    const sec = TF_SEC[tf]; if (!sec) return;
    let t = Math.floor(tsMs / 1000);
    if (tf === '1d') t = Math.floor(t / 86400) * 86400;
    else if (tf === '1w'){ const d = Math.floor(t / 86400); const dow = (d + 3) % 7; t = (d - dow) * 86400; }
    else t = Math.floor(t / sec) * sec;
    t += off;
    const last = data[data.length - 1];
    if (t < last.time) return;
    if (t === last.time){ last.h = Math.max(last.h, price); last.l = Math.min(last.l, price); last.c = price; }
    else data.push({ time: t, o: price, h: price, l: price, c: price, v: 0 });
    const b = data[data.length - 1];
    candles.update({ time: b.time, open: b.o, high: b.h, low: b.l, close: b.c });
  }
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
  return { setData, tick, setGuide, chart };
}
