// 급등 감지 — 갑자기 거래가 몰리는 코인을 초 단위로 잡습니다.
// 업비트 실시간 시세(웹소켓)의 '오늘 누적 거래대금'이 짧은 시간에 얼마나 늘었는지를
// 평소(24시간 평균) 같은 시간치와 비교합니다. 앱이 켜져 있는 동안만 동작해요.
//
// 적중률 기록: 잡힌 순간 가격에 샀다고 치고, 익절/손절 조합마다 어느 쪽에 먼저 닿았는지 기록합니다.
// (나중에 자동매매 조건을 숫자로 고르기 위한 자료. 이 기기에 최근 500건 저장)
import { LS } from '../util.js';

export const SURGE_DEFAULTS = {
  surgeSec: 60,          // 이 시간(초) 동안의 거래를 봄
  surgeVol: 5,           // 평소 같은 시간치보다 거래대금이 이 배수 이상
  surgePct: 1,           // 그 시간 동안 가격이 이 % 이상 오름 (0이면 가격은 안 봄)
  surgeMinValue: 2e7,    // 그 시간 거래대금이 최소 이만큼(원) — 아주 작은 코인 잡음 제거
  surgeKeepMin: 30,      // 잡힌 뒤 이 시간(분) 동안 목록에 남김
  surgeAlarm: true,      // 소리 알람
  surgeRepeat: 15,       // 확인 전까지 이 간격(초)으로 계속 울림
  alarmVol: 40,          // 알람 소리 크기 (0~100)
  dumpOn: true,          // 급락도 감지 (같은 기준, 가격이 그만큼 내림)
  surgeCombos: '1/1, 2/2, 2/5, 3/3',   // 익절%/손절% 조합
  surgeTimeoutMin: 30,   // 이 시간(분) 안에 둘 다 안 닿으면 '시간 종료'로 그때 가격 기록
  surgeFeePct: 0.1,      // 왕복 수수료(%)
  surgeTradeTp: 2,       // 급등 거래 주문 기본 익절(%)
  surgeTradeSl: 5        // 급등 거래 주문 기본 손절(%)
};

const LOG_KEY = 'quantera:surgeLog';
export const parseCombos = s => String(s || '').split(',').map(x => x.trim().split('/').map(Number))
  .filter(([tp, sl]) => tp > 0 && sl > 0).slice(0, 6);

// dir = 1 급등, -1 급락 (같은 거래대금 기준, 가격 방향만 반대). 급락은 적중률 추적 없음
export function createSurge(getCfg, dir = 1){
  const hist = new Map();      // market → [{ ts, acc, p }]  (1초에 한 칸)
  const events = new Map();    // market → { at, last, p0, pAt, pct, ratio, value }
  const tracking = new Map();  // market → 적중률 추적 중인 기록
  const logKey = dir > 0 ? LOG_KEY : 'quantera:dumpLog';
  let log = LS.get(logKey, []) || [];

  function push(q){
    if (q.accDay == null || !q.price) return;
    const now = Date.now();
    let h = hist.get(q.market); if (!h){ h = []; hist.set(q.market, h); }
    const tail = h[h.length - 1];
    if (tail && q.accDay < tail.acc) h.length = 0;          // 오전 9시 누적값 초기화
    if (h.length && Math.floor(tail.ts / 1000) === Math.floor(now / 1000)){ tail.acc = q.accDay; tail.p = q.price; tail.ts = now; }
    else h.push({ ts: now, acc: q.accDay, p: q.price });
    const cut = now - (getCfg().surgeSec + 10) * 1000;
    let k = 0; while (k < h.length - 1 && h[k + 1].ts <= cut) k++;
    if (k) h.splice(0, k);
    const r = tracking.get(q.market); if (r) follow(r, q.price, now);
  }

  // 체결가가 들어올 때마다 익절/손절 도달 여부 확인 (손절 먼저 = 보수적)
  function follow(r, p, now){
    const c = getCfg();
    r.hi = Math.max(r.hi, p); r.lo = Math.min(r.lo, p);
    const chg = (p / r.entry - 1) * 100;
    for (const t of r.trials){
      if (t.res) continue;
      if (chg <= -t.sl){ t.res = 'loss'; t.ret = -t.sl; t.sec = Math.round((now - r.at) / 1000); }
      else if (chg >= t.tp){ t.res = 'win'; t.ret = t.tp; t.sec = Math.round((now - r.at) / 1000); }
      else if (now - r.at > c.surgeTimeoutMin * 60000){ t.res = 'time'; t.ret = +chg.toFixed(2); t.sec = Math.round((now - r.at) / 1000); }
    }
    if (r.trials.every(t => t.res)) finish(r);
  }
  function finish(r){
    tracking.delete(r.m);
    log.push({ m: r.m, at: r.at, entry: r.entry, ratio: +r.ratio.toFixed(1), pct: +r.pct.toFixed(2),
      hi: +((r.hi / r.entry - 1) * 100).toFixed(2), lo: +((r.lo / r.entry - 1) * 100).toFixed(2),
      trials: r.trials.map(({ tp, sl, res, ret, sec }) => ({ tp, sl, res, ret, sec })) });
    if (log.length > 500) log = log.slice(-500);
    LS.set(logKey, log);
  }

  // 1초마다 호출. 새로 잡힌 코인 목록을 돌려줌.
  function check(quotes){
    const c = getCfg(), now = Date.now(), win = c.surgeSec * 1000;
    const fresh = [];
    for (const [m, h] of hist){
      if (h.length < 2) continue;
      const q = quotes.get(m); if (!q || q.suspended || !q.value24h) continue;
      let b = h[0]; for (const s of h){ if (s.ts <= now - win) b = s; else break; }
      const last = h[h.length - 1], el = now - b.ts;
      if (el < Math.min(win, 15000)) continue;                // 최소 15초는 지켜본 뒤 판단
      const value = last.acc - b.acc;
      const normal = q.value24h / 86400000 * el;
      const ratio = value / normal, pct = (last.p / b.p - 1) * 100;
      if (dir < 0 && !c.dumpOn) continue;
      const pOk = dir > 0 ? (c.surgePct <= 0 || pct >= c.surgePct) : pct <= -Math.max(c.surgePct, 0.5);
      if (!(ratio >= c.surgeVol && value >= c.surgeMinValue && pOk)) continue;
      const ev = events.get(m);
      if (!ev){
        events.set(m, { at: now, last: now, p0: b.p, pAt: last.p, pct, ratio, value }); fresh.push(m);
        if (dir > 0 && !tracking.has(m)) tracking.set(m, { m, at: now, entry: last.p, hi: last.p, lo: last.p, ratio, pct,
          trials: parseCombos(c.surgeCombos).map(([tp, sl]) => ({ tp, sl, res: null })) });
      }
      else { ev.last = now; ev.pct = dir > 0 ? Math.max(ev.pct, pct) : Math.min(ev.pct, pct); ev.ratio = Math.max(ev.ratio, ratio); ev.value = Math.max(ev.value, value); }
    }
    for (const [m, e] of events) if (now - e.last > c.surgeKeepMin * 60000) events.delete(m);
    // 거래가 끊긴 코인도 시간 종료 처리
    for (const r of [...tracking.values()]) if (now - r.at > c.surgeTimeoutMin * 60000){ const q = quotes.get(r.m); follow(r, q ? q.price : r.entry, now); }
    return fresh;
  }

  // 조합별 성적: 건수, 익절/손절/시간종료, 승률, 수수료 뺀 1건당 평균 수익
  function stats(){
    const fee = getCfg().surgeFeePct, by = new Map();
    for (const r of log) for (const t of r.trials){
      const k = `${t.tp}/${t.sl}`; let s = by.get(k);
      if (!s){ s = { tp: t.tp, sl: t.sl, n: 0, win: 0, loss: 0, time: 0, sum: 0 }; by.set(k, s); }
      s.n++; s[t.res]++; s.sum += t.ret - fee;
    }
    return [...by.values()].map(s => ({ ...s, winRate: s.n ? s.win / s.n * 100 : 0, exp: s.n ? s.sum / s.n : 0,
      need: (s.sl + fee) / (s.tp + s.sl) * 100 }));
  }

  return { push, check, events, get: m => events.get(m), stats, log: () => log, tracking,
    clearLog(){ log = []; LS.set(logKey, log); } };
}

export const agoKo = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}초 전` : s < 3600 ? `${Math.floor(s / 60)}분 전` : `${Math.floor(s / 3600)}시간 전`; };
