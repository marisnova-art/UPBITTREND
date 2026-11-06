// 매수 검토 신호 (v2) — 고점 추격을 막고 '눌림 매수'와 '바닥 반등' 두 가지만 찾습니다.
// 모든 판단은 일봉만으로 계산 → 과거 같은 날짜에 똑같이 적용해 결과를 검증(백테스트)할 수 있습니다.
import { LS } from '../util.js';

export const SCREEN_DEFAULTS = {
  btTp: 2,                 // 바닥 거래: 이 %에 팔고 손절 없이 기다림
  // 무조건 제외
  nearHighPct: 5,          // 60일 고점에서 이만큼(%) 안쪽이면 제외
  maxRise7d: 15,           // 7일 상승률(%)이 이보다 크면 제외
  maxRiseToday: 7,         // 오늘 상승률(%)이 이보다 크면 제외
  maxGap20: 8,             // 20일선보다 이만큼(%) 넘게 떠 있으면 제외
  minValue24h: 1e9,        // 24시간 거래대금(원) 미만 제외
  includeWarning: false,   // 투자유의(상장폐지 위험) 포함 여부
  // ① 눌림 매수
  pbMinDrop: 8, pbMaxDrop: 25,   // 최근 30일 고점 대비 하락폭(%)
  pbNearMa: 3,                   // 20·60일선에서 이만큼(%) 안쪽
  pbVolDry: 0.9,                 // 최근 5일 거래량 / 20일 평균 이하
  // ② 바닥 반등
  btMinDrop: 50,           // 1년(최대 400일) 고점 대비 하락폭(%)
  btLowerPct: 25,          // 1년 범위에서 아래쪽 이 % 안
  btNoNewLowDays: 45,      // 이 기간 동안 새 저점 없음
  btVolBurst: 1.5,         // 반등 신호: 거래량 배수
  // 검증
  minSamples: 20,          // 이보다 적으면 '검증 부족'
  holdDays: 10,            // 목표·손절에 안 닿으면 이 날 종가로 청산
  feePct: 0.1              // 왕복 수수료(%)
};
const KEY = 'quantera:screen';
export const screenCfg = () => ({ ...SCREEN_DEFAULTS, ...(LS.get(KEY, {}) || {}) });
export const saveScreenCfg = c => LS.set(KEY, c);

// ---------- 지표 (배열 전체를 한 번에)
function sma(a, n){ const r = new Array(a.length).fill(null); let s = 0; for (let i = 0; i < a.length; i++){ s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) r[i] = s / n; } return r; }
function atr(D, n = 14){ const r = new Array(D.length).fill(null); let s = 0; for (let i = 1; i < D.length; i++){ const tr = Math.max(D[i].h - D[i].l, Math.abs(D[i].h - D[i - 1].c), Math.abs(D[i].l - D[i - 1].c)); s += tr; if (i > n) s -= Math.max(D[i - n].h - D[i - n].l, Math.abs(D[i - n].h - D[i - n - 1].c), Math.abs(D[i - n].l - D[i - n - 1].c)); if (i >= n) r[i] = s / n; } return r; }
const maxH = (D, a, b) => { let v = -Infinity; for (let k = Math.max(0, a); k <= b; k++) if (D[k].h > v) v = D[k].h; return v; };
const minL = (D, a, b) => { let v = Infinity, at = -1; for (let k = Math.max(0, a); k <= b; k++) if (D[k].l < v){ v = D[k].l; at = k; } return { v, at }; };
const avgV = (D, a, b) => { let s = 0, n = 0; for (let k = Math.max(0, a); k <= b; k++){ s += D[k].v; n++; } return n ? s / n : 0; };

export function prep(D){
  const C = D.map(x => x.c);
  return { C, ma20: sma(C, 20), ma60: sma(C, 60), ma120: sma(C, 120), atr: atr(D) };
}

// ---------- i번째 날 종가 기준 판단 (i 이후 데이터는 보지 않음)
export function detectAt(D, X, i, cfg){
  if (i < 120) return { type: null, why: ['캔들 부족'] };
  const c = D[i].c, ma20 = X.ma20[i], ma60 = X.ma60[i], ma120 = X.ma120[i], A = X.atr[i] || c * 0.03;
  const hi60 = maxH(D, i - 59, i);
  const rise7 = (c / D[i - 7].c - 1) * 100, today = (c / D[i - 1].c - 1) * 100, gap20 = (c / ma20 - 1) * 100;
  // 무조건 제외 (고점 구간·급등·이격 과다)
  const ex = [];
  if (c >= hi60 * (1 - cfg.nearHighPct / 100)) ex.push(`60일 고점에서 ${cfg.nearHighPct}% 안쪽`);
  if (rise7 > cfg.maxRise7d) ex.push(`7일 +${rise7.toFixed(1)}% 급등`);
  if (today > cfg.maxRiseToday) ex.push(`하루 +${today.toFixed(1)}% 급등`);
  if (gap20 > cfg.maxGap20) ex.push(`20일선보다 +${gap20.toFixed(1)}% 떠 있음`);
  if (ex.length) return { type: null, excluded: ex };

  const v5 = avgV(D, i - 4, i), v20 = avgV(D, i - 19, i);
  // ① 눌림 매수: 오르는 흐름 + 최근 고점 대비 8~25% 조정 + 20/60일선 지지 + 거래량 감소
  const up = ma60 > X.ma60[i - 10] && (ma120 == null || c > ma120);
  const hi30 = maxH(D, i - 29, i), drop = (1 - c / hi30) * 100;
  const nearMa = [ma20, ma60].find(m => m && Math.abs(c / m - 1) * 100 <= cfg.pbNearMa);
  if (up && drop >= cfg.pbMinDrop && drop <= cfg.pbMaxDrop && nearMa && v5 <= v20 * cfg.pbVolDry){
    const support = nearMa, swing = minL(D, i - 9, i).v;
    let stop = Math.min(support, swing) * 0.97;
    stop = clampStop(c, stop, A);
    const t1 = hi30, t2 = Math.max(hi60, c + 2.5 * (c - stop));
    return { type: 'pullback', entryLo: Math.min(support, c) * 0.99, entryHi: c * 1.01, ref: c, stop, t1, t2,
      why: [`최근 30일 고점보다 ${drop.toFixed(1)}% 조정`, `${nearMa === ma20 ? '20' : '60'}일선 지지 근처`, `조정 중 거래량 감소(${(v5 / v20).toFixed(2)}배)`, '60일선 상승 중'] };
  }
  // ② 바닥 반등: 1년 고점 대비 50%↓ + 범위 하단 25% + 45일 새 저점 없음 + 반등 첫 신호
  const look = Math.min(i, 399);
  const hiY = maxH(D, i - look, i), loY = minL(D, i - look, i).v;
  const dropY = (1 - c / hiY) * 100, posY = hiY > loY ? (c - loY) / (hiY - loY) * 100 : 50;
  const low90 = minL(D, i - 89, i), quietDays = i - low90.at;
  if (dropY >= cfg.btMinDrop && posY <= cfg.btLowerPct && quietDays >= cfg.btNoNewLowDays){
    const reclaim = c > ma20 && D[i - 5].c < X.ma20[i - 5];
    const higherLow = minL(D, i - 9, i).v > low90.v * 1.03;
    const volBurst = v5 >= v20 * cfg.btVolBurst && c > D[i].o;
    if (reclaim || (higherLow && volBurst) || (volBurst && c > ma20)){
      let stop = Math.min(low90.v, minL(D, i - 9, i).v) * 0.97;
      stop = clampStop(c, stop, A);
      const R = c - stop;
      const t1 = Math.max(ma60 || 0, c + 1.5 * R), t2 = c + 3 * R;
      return { type: 'bottom', entryLo: Math.max(stop * 1.02, ma20 * 0.98), entryHi: c * 1.01, ref: c, stop, t1, t2,
        why: [`1년 고점보다 ${dropY.toFixed(0)}% 낮음 (범위 하단 ${posY.toFixed(0)}%)`, `${quietDays}일째 새 저점 없음`,
          reclaim ? '20일선 회복' : higherLow ? '저점이 높아짐' : '양봉', volBurst ? `거래량 ${(v5 / v20).toFixed(1)}배` : ''].filter(Boolean) };
    }
  }
  return { type: null };
}
// 손절폭은 3%~12% 사이, 그리고 최소 ATR 1배
function clampStop(c, stop, A){
  const maxStop = c * 0.97, minStop = c * 0.88;
  stop = Math.min(stop, c - A);
  return Math.max(minStop, Math.min(maxStop, stop));
}

// ---------- 검증: 과거의 모든 날에 같은 규칙을 적용하고 결과를 기록
// 다음 날부터 holdDays 동안: 손절가를 먼저 건드리면 손실, 1차 목표가에 닿으면 이익, 둘 다 아니면 마지막 날 종가 청산.
// 같은 날 둘 다 닿으면 손실로 봅니다(보수적). 신호 후 holdDays 동안은 새 신호를 세지 않습니다(중복 방지).
export function backtest(D, cfg){
  const X = prep(D), out = { pullback: [], bottom: [] };
  for (let i = 120; i < D.length - 1; i++){
    const s = detectAt(D, X, i, cfg);
    if (!s.type) continue;
    let ret = null;
    const last = Math.min(D.length - 1, i + cfg.holdDays);
    for (let k = i + 1; k <= last; k++){
      if (D[k].l <= s.stop){ ret = s.stop / s.ref - 1; break; }
      if (D[k].h >= s.t1){ ret = s.t1 / s.ref - 1; break; }
    }
    if (ret == null){ if (last < i + cfg.holdDays) continue; ret = D[last].c / s.ref - 1; } // 아직 끝나지 않은 신호는 제외
    out[s.type].push(ret * 100 - cfg.feePct);
    i += cfg.holdDays;
  }
  return out;
}
// 바닥 거래 검증: 바닥 신호일 종가에 사서 +btTp%에 팜. 손절 없음, 한 코인에 한 번에 한 포지션.
// 기다리는 동안 가장 많이 빠진 폭(dd)과, 아직 못 빠져나온 거래(done=false)를 같이 기록.
export function bottomTrades(D, cfg, X = prep(D)){
  const out = [], tp = 1 + cfg.btTp / 100;
  for (let i = 120; i < D.length - 1; i++){
    const s = detectAt(D, X, i, cfg); if (s.type !== 'bottom') continue;
    const entry = s.ref, target = entry * tp;
    let lo = entry, exit = null;
    for (let k = i + 1; k < D.length; k++){
      lo = Math.min(lo, D[k].l);                       // 같은 날 먼저 빠졌을 수도 있으니 보수적으로 포함
      if (D[k].h >= target){ exit = k; break; }
    }
    const last = exit == null ? D.length - 1 : exit;
    out.push({ t: D[i].t, entry, days: last - i, dd: (lo / entry - 1) * 100, done: exit != null,
      ret: exit != null ? cfg.btTp - cfg.feePct : (D[last].c / entry - 1) * 100 - cfg.feePct });
    if (exit == null) break;
    i = exit;
  }
  return { trades: out, days: Math.max(0, D.length - 121) };
}
export function summarizeBottom(list, spanDays){
  const n = list.length; if (!n) return { n: 0 };
  const done = list.filter(t => t.done), open = list.filter(t => !t.done);
  const days = done.map(t => t.days).sort((a, b) => a - b);
  const med = days.length ? days[Math.floor(days.length / 2)] : null;
  return {
    n, done: done.length, hit: done.length / n * 100,
    medDays: med, slow: done.filter(t => t.days > 30).length,
    avgDd: list.reduce((a, t) => a + t.dd, 0) / n, worstDd: Math.min(...list.map(t => t.dd)),
    deep: list.filter(t => t.dd <= -10).length,
    open: open.length, openAvg: open.length ? open.reduce((a, t) => a + t.ret, 0) / open.length : 0,
    openMaxDays: open.length ? Math.max(...open.map(t => t.days)) : 0,
    profit: done.reduce((a, t) => a + t.ret, 0),
    perMonth: spanDays ? n / (spanDays / 30) : null
  };
}
export function summarize(rets){
  const n = rets.length; if (!n) return { n: 0 };
  const wins = rets.filter(r => r > 0);
  return { n, win: wins.length / n * 100, exp: rets.reduce((a, b) => a + b, 0) / n };
}

// ---------- 종목 하나의 현재 판단
// inst: 종목 정보(유의·주의), quote: 현재가(거래정지 여부, 거래대금), D: 확정 일봉
export function screen(inst, quote, D, cfg = screenCfg()){
  const block = [];
  if (!quote || quote.suspended) block.push('거래정지');
  if (inst.warning && !cfg.includeWarning) block.push('투자유의');
  if (quote && quote.value24h < cfg.minValue24h) block.push(`거래대금 ${Math.round(quote.value24h / 1e8)}억 (기준 ${Math.round(cfg.minValue24h / 1e8)}억 미만)`);
  const X = prep(D);
  const sig = D.length > 120 ? detectAt(D, X, D.length - 1, cfg) : { type: null, why: ['캔들 부족'] };
  const bt = D.length > 160 ? backtest(D, cfg) : { pullback: [], bottom: [] };
  const bt2 = D.length > 160 ? bottomTrades(D, cfg, X) : { trades: [], days: 0 };
  return { block, sig, bt, bt2, caution: inst.caution || [] };
}
