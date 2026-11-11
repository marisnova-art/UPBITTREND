// 해외 선행 감지 + 국프(국내 프리미엄) — 바이낸스(USDT 마켓) 실시간 시세와 업비트 원화 가격을 비교합니다.
// 환율은 업비트 KRW-USDT 가격(실제로 코인을 옮길 때의 환율)을 씁니다.
// 해외 선행: 최근 leadSec초 동안 해외가 leadPct% 이상 움직였는데 업비트가 덜 따라와 차이가 leadGap% 이상이면 잡음.
// 적중률: 잡힌 순간 업비트에서 샀다면(하락이면 팔았다면) leadCheckMin분 안에 차이를 얼마나 따라잡았는지 기록 (이 기기, 최근 300건).
import { LS } from '../util.js';

export const LEAD_DEFAULTS = {
  leadOn: true,         // 해외 선행 감지
  leadSec: 60,          // 이 시간(초) 동안의 움직임을 비교
  leadPct: 1.5,         // 해외가 이 % 이상 움직이면
  leadGap: 0.8,         // 업비트와의 차이가 이 % 이상이면 신호
  leadCheckMin: 5,      // 적중률: 이 시간(분) 안에 따라잡았는지
  kimpOn: true,         // 국프 표시
  swingPp: 2,           // 국프 급변: 이 %p 이상 변하면
  swingMin: 10,         //          이 시간(분) 안에
  sndLead: 'high'       // 알림음: 해외 선행
};
const WS_URL = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
const LOG_KEY = 'quantera:leadLog';

export function createOverseas(getCfg, getQuote){
  const px = new Map();        // 'BTC' → 바이낸스 USDT 가격
  const hist = new Map();      // 업비트 market → [{t, o: 해외 원화 환산, u: 업비트}]
  const events = new Map();    // market → { at, dir, ov, up, gap, pAt, kimp }
  const tracking = new Map();  // market → 적중률 추적 중
  let log = LS.get(LOG_KEY, []) || [];
  let ws = null, status = 'off', lastMsg = 0, timer = null;
  // 국프 기록: 15초마다 한 번씩, 65분치 (1시간 변화·급변 계산용)
  const kHist = new Map();     // market → [{t, k}]
  const swings = new Map();    // market → { at, last, dir, from, to, delta }
  let lastSample = 0, swingFresh = [];

  function connect(){
    if (!getCfg().leadOn && !getCfg().kimpOn) return;
    try { ws = new WebSocket(WS_URL); } catch(e){ return retry(); }
    status = 'connecting';
    ws.onopen = () => { status = 'live'; };
    ws.onmessage = ev => {
      try {
        const arr = JSON.parse(ev.data); lastMsg = Date.now();
        for (const x of arr) if (x.s && x.s.endsWith('USDT')) px.set(x.s.slice(0, -4), +x.c);
      } catch(e){}
    };
    ws.onclose = () => { status = 'reconnecting'; retry(); };
    ws.onerror = () => { try { ws.close(); } catch(e){} };
  }
  const retry = () => { clearTimeout(timer); timer = setTimeout(connect, 5000); };
  connect();

  const usdt = () => { const q = getQuote('KRW-USDT'); return q && q.price ? q.price : null; };
  // 해외 가격을 원화로 (없으면 null)
  function overseasKrw(market){
    const p = px.get(market.slice(4)), fx = usdt();
    return p && fx ? p * fx : null;
  }
  function kimp(market){
    if (market === 'KRW-USDT') return null;
    const o = overseasKrw(market), q = getQuote(market);
    return o && q && q.price ? (q.price / o - 1) * 100 : null;
  }

  // 1초마다: 기록을 쌓고 신호를 찾음. 새로 잡힌 market 목록을 돌려줌
  function check(markets){
    const c = getCfg(), now = Date.now(), fresh = [];
    if (!px.size || Date.now() - lastMsg > 15000) return fresh;
    if (!c.leadOn){ if (now - lastSample >= 15000){ lastSample = now; sampleKimp(markets, now, c); } return fresh; }
    const win = c.leadSec * 1000;
    for (const m of markets){
      if (m === 'KRW-USDT') continue;
      const o = overseasKrw(m), q = getQuote(m); if (!o || !q || !q.price) continue;
      let h = hist.get(m); if (!h){ h = []; hist.set(m, h); }
      h.push({ t: now, o, u: q.price });
      while (h.length && now - h[0].t > win + 5000) h.shift();
      const r = tracking.get(m); if (r) follow(r, q.price, now, c);
      if (h.length < 2 || now - h[0].t < win * 0.8) continue;   // 충분히 지켜본 뒤 판단
      const b = h[0], ov = (o / b.o - 1) * 100, up = (q.price / b.u - 1) * 100;
      const dir = ov >= c.leadPct ? 1 : ov <= -c.leadPct ? -1 : 0; if (!dir) continue;
      const gap = (ov - up) * dir;
      if (gap < c.leadGap) continue;
      const e = events.get(m);
      if (!e || e.dir !== dir){
        events.set(m, { at: now, last: now, dir, ov, up, gap, pAt: q.price, kimp: kimp(m) });
        fresh.push(m);
        if (!tracking.has(m)) tracking.set(m, { m, at: now, dir, gap, entry: q.price, best: 0, end: 0 });
      } else { e.last = now; e.gap = Math.max(e.gap, gap); e.ov = ov; e.up = up; }
    }
    const keep = (getCfg().surgeKeepMin || 30) * 60000;
    for (const [m, e] of events) if (now - e.last > keep) events.delete(m);
    if (now - lastSample >= 15000){ lastSample = now; sampleKimp(markets, now, c); }
    for (const [m, e] of swings) if (now - e.last > keep) swings.delete(m);
    for (const r of [...tracking.values()]) if (now - r.at > c.leadCheckMin * 60000 + 30000){ const q = getQuote(r.m); finish(r, q ? q.price : r.entry, c); }
    return fresh;
  }
  function sampleKimp(markets, now, c){
    const win = (c.swingMin || 10) * 60000;
    for (const m of markets){
      const k = kimp(m); if (k == null) continue;
      let h = kHist.get(m); if (!h){ h = []; kHist.set(m, h); }
      h.push({ t: now, k });
      while (h.length && now - h[0].t > 65 * 60000) h.shift();
      // 급변: 최근 swingMin분 안의 가장 낮은(높은) 국프에서 지금까지 swingPp%p 이상
      const w = h.filter(x => now - x.t <= win); if (w.length < 3) continue;
      const lo = Math.min(...w.map(x => x.k)), hi = Math.max(...w.map(x => x.k));
      const up = k - lo, dn = k - hi;
      const dir = up >= c.swingPp ? 1 : dn <= -c.swingPp ? -1 : 0; if (!dir) continue;
      const from = dir > 0 ? lo : hi, e = swings.get(m);
      if (!e || e.dir !== dir){ swings.set(m, { at: now, last: now, dir, from, to: k, delta: k - from }); swingFresh.push(m); }
      else { e.last = now; e.to = k; if (Math.abs(k - e.from) > Math.abs(e.delta)) e.delta = k - e.from; }
    }
  }
  // 국프 변화: 지금 - min분 전 (기록이 모자라면 null)
  function kimpChange(m, min = 60){
    const h = kHist.get(m); if (!h || h.length < 2) return null;
    const now = h[h.length - 1], target = now.t - min * 60000;
    if (h[0].t > target + 60000) return null;
    let old = h[0]; for (const x of h){ if (x.t <= target) old = x; else break; }
    return now.k - old.k;
  }
  function follow(r, p, now, c){
    const mv = (p / r.entry - 1) * 100 * r.dir;   // 신호 방향으로 움직인 %
    r.best = Math.max(r.best, mv); r.end = mv;
    if (now - r.at >= c.leadCheckMin * 60000) finish(r, p, c);
  }
  function finish(r){
    tracking.delete(r.m);
    log.push({ m: r.m, at: r.at, dir: r.dir, gap: +r.gap.toFixed(2), best: +r.best.toFixed(2), end: +r.end.toFixed(2) });
    if (log.length > 300) log = log.slice(-300);
    LS.set(LOG_KEY, log);
  }
  // 성적: 따라잡음 = 신호 방향으로 차이의 절반 이상 움직임. 평균 = 5분 뒤 위치(수수료 0.1% 뺌)
  function stats(){
    const n = log.length; if (!n) return { n: 0 };
    const caught = log.filter(x => x.best >= x.gap / 2).length;
    return { n, caught, rate: caught / n * 100, avgBest: log.reduce((a, x) => a + x.best, 0) / n, avgEnd: log.reduce((a, x) => a + x.end, 0) / n - 0.1, up: log.filter(x => x.dir > 0).length };
  }
  const takeSwing = () => { const f = swingFresh; swingFresh = []; return f; };
  return { check, kimp, kimpChange, swings, takeSwing, getSwing: m => swings.get(m), overseasKrw, events, get: m => events.get(m), stats, log: () => log, tracking, status: () => status, has: m => px.has(m.slice(4)) };
}
