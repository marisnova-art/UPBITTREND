// 전략 검증(백테스트) — 일봉만으로, 과거 모든 날에 같은 규칙을 적용해 결과를 모읍니다.
// 바닥 거래: 바닥 반등 신호일 종가에 사서 +익절%에 팔기 (손절 없음이 기본).
// 눌림 매수: 눌림 신호일 종가에 사서 +익절% 또는 -손절%, 최대 보유일이 지나면 그날 종가에 청산.
// 같은 날 익절·손절 둘 다 닿으면 손절로 봄(보수적). 한 코인에 한 번에 한 포지션.
import { prep, detectAt, screenCfg } from './screen.js';
import { LS } from '../util.js';

export const STRAT_DEFAULTS = {
  bottom: { tp: 2, sl: 0, maxDays: 0 },
  pullback: { tp: 5, sl: 4, maxDays: 10 },
  amount: 1_000_000,       // 1회 매수 금액(원) — 손익을 원으로 보여 줄 때만 씀
  scope: 'all',            // all | mine(관심+보유)
  minValue: 1e9            // 24시간 거래대금 이 금액 미만 종목은 뺌 (스캐너 기준과 같게 시작)
};
const KEY = 'quantera:strat';
export function stratCfg(){ const s = LS.get(KEY, {}) || {}; return { ...STRAT_DEFAULTS, ...s, bottom: { ...STRAT_DEFAULTS.bottom, ...(s.bottom || {}) }, pullback: { ...STRAT_DEFAULTS.pullback, ...(s.pullback || {}) } }; }
export const saveStratCfg = c => LS.set(KEY, c);

export function strategyTrades(D, type, opt, cfg = screenCfg()){
  const X = prep(D), out = [], fee = cfg.feePct;
  for (let i = 120; i < D.length - 1; i++){
    const s = detectAt(D, X, i, cfg); if (s.type !== type) continue;
    const entry = s.ref, tp = entry * (1 + opt.tp / 100), sl = opt.sl > 0 ? entry * (1 - opt.sl / 100) : 0;
    let lo = entry, exit = null, why = null;
    const last = opt.maxDays > 0 ? Math.min(D.length - 1, i + opt.maxDays) : D.length - 1;
    for (let k = i + 1; k <= last; k++){
      lo = Math.min(lo, D[k].l);
      if (sl && D[k].l <= sl){ exit = k; why = 'sl'; break; }
      if (D[k].h >= tp){ exit = k; why = 'tp'; break; }
    }
    if (exit == null && opt.maxDays > 0 && i + opt.maxDays <= D.length - 1){ exit = last; why = 'time'; }
    const end = exit == null ? D.length - 1 : exit;
    const ret = why === 'tp' ? opt.tp - fee : why === 'sl' ? -opt.sl - fee : (D[end].c / entry - 1) * 100 - fee;
    out.push({ t: D[i].t, exitT: exit != null ? D[end].t : null, entry, days: end - i, dd: (lo / entry - 1) * 100, why, done: exit != null, ret });
    if (exit == null) break;
    i = end;
  }
  return out;
}

export function summarizeTrades(list, spanDays){
  const n = list.length; if (!n) return { n: 0 };
  const done = list.filter(t => t.done), open = list.filter(t => !t.done);
  const tp = done.filter(t => t.why === 'tp'), sl = done.filter(t => t.why === 'sl'), tm = done.filter(t => t.why === 'time');
  const days = done.map(t => t.days).sort((a, b) => a - b);
  const sum = done.reduce((a, t) => a + t.ret, 0);
  return {
    n, done: done.length, tp: tp.length, sl: sl.length, time: tm.length, open: open.length,
    hit: tp.length / n * 100, win: done.length ? done.filter(t => t.ret > 0).length / done.length * 100 : 0,
    avg: done.length ? sum / done.length : 0, sum,
    medDays: days.length ? days[Math.floor(days.length / 2)] : null,
    avgDd: list.reduce((a, t) => a + t.dd, 0) / n, worstDd: Math.min(...list.map(t => t.dd)),
    openAvg: open.length ? open.reduce((a, t) => a + t.ret, 0) / open.length : 0,
    openMaxDays: open.length ? Math.max(...open.map(t => t.days)) : 0,
    perMonth: spanDays ? n / (spanDays / 30) : null
  };
}
