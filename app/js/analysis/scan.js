// 전체 종목 스캔 — 기존 업비트트랜드의 loadDaily / loadPeriod / analyzeOne / patchPeriod 를 옮긴 것.
// 캔들은 브라우저 IndexedDB에만 캐시합니다(Supabase에 원본 캔들 저장 안 함 → 무료 용량 보호).
import { CONFIG } from '../config.js';
import { clamp, utcDay } from '../util.js';
import { A } from './trend.js';
import { screen } from './screen.js';
import * as upbit from '../adapters/upbit.js';

const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
export function weekKey(t){ const d = new Date(t + 'T00:00:00Z'); const back = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - back); return utcDay(d); }
const monthKey = t => t.slice(0, 7) + '-01';
function weekFrac(ref){ const now = new Date(ref || Date.now()); const start = Date.parse(weekKey(utcDay(now)) + 'T00:00:00Z'); return clamp((now - start) / (7 * 86400000), 0, 1); }
function monthFrac(ref){ const now = new Date(ref || Date.now()); const y = now.getUTCFullYear(), m = now.getUTCMonth(); const s = Date.UTC(y, m, 1), e = Date.UTC(y, m + 1, 1); return clamp((now - s) / (e - s), 0, 1); }
function mergeCandles(oldC, newC, limit){
  const map = new Map(); for (const c of oldC) map.set(c.t, c); for (const c of newC) map.set(c.t, c);
  return [...map.values()].sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : 0).slice(-limit);
}

// ---------- IndexedDB 캐시 (기존 사이트와 다른 DB 이름 사용)
const IDB = {
  db: null, ok: true,
  async open(){
    if (this.db || !this.ok) return this.db;
    try{
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open('quantera-candles', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('candles');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    }catch(e){ this.ok = false; }
    return this.db;
  },
  async get(key){
    const db = await this.open(); if (!db) return null;
    return new Promise(res => { const q = db.transaction('candles').objectStore('candles').get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); });
  },
  async put(key, val){ const db = await this.open(); if (!db) return; try { db.transaction('candles', 'readwrite').objectStore('candles').put(val, key); } catch(e){} }
};
const mem = new Map();
async function cacheGet(k){ if (mem.has(k)) return mem.get(k); const v = await IDB.get(k); if (v) mem.set(k, v); return v; }
function cachePut(k, v){ mem.set(k, v); IDB.put(k, v); }

// 오늘(UTC) 일봉을 실시간 시세로 보정
function patchDailyWithQuote(c, q){
  if (!q || !c.length || !q.ts) return c;
  const td = utcDay(new Date(q.ts));
  const out = c.slice(), last = out[out.length - 1];
  const cur = { t: td, o: q.open, h: q.high, l: q.low, c: q.price, v: last.t === td ? last.v : 0 };
  if (last.t === td) out[out.length - 1] = cur; else if (td > last.t) out.push(cur);
  return out;
}
// 진행 중인 주봉/월봉을 일봉 합산으로 보정
function patchPeriod(pc, daily, keyFn){
  if (!pc.length || !daily.length) return pc;
  const lastT = pc[pc.length - 1].t;
  if (keyFn(lastT) !== lastT) return pc;
  const groups = new Map();
  for (const c of daily){
    const k = keyFn(c.t); if (k < lastT) continue;
    let g = groups.get(k);
    if (!g){ g = { t: k, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, first: c.t }; groups.set(k, g); }
    else { g.h = Math.max(g.h, c.h); g.l = Math.min(g.l, c.l); g.c = c.c; g.v += c.v; }
  }
  const out = pc.slice();
  for (const g of [...groups.values()].sort((a, b) => a.t < b.t ? -1 : 1)){
    const idx = out.length - 1;
    const cand = { t: g.t, o: g.o, h: g.h, l: g.l, c: g.c, v: g.v };
    if (out[idx].t === g.t){
      if (g.first !== g.t && daily[0].t > g.t){ const o = out[idx]; out[idx] = { t: g.t, o: o.o, h: Math.max(o.h, g.h), l: Math.min(o.l, g.l), c: g.c, v: Math.max(o.v, g.v) }; }
      else out[idx] = cand;
    } else if (g.t > out[idx].t) out.push(cand);
  }
  const lastKey = keyFn(daily[daily.length - 1].t);
  while (out.length > 1 && out[out.length - 1].t > lastKey) out.pop();
  return out;
}

// 일봉: 오늘 이미 받은 것은 재요청하지 않고, 날짜가 바뀌면 빠진 만큼만 받습니다.
export async function loadDaily(market, quote){
  const key = 'D400:' + market, cached = await cacheGet(key), today = utcDay();
  let candles;
  if (cached && cached.day === today && cached.c.length) candles = cached.c;
  else {
    let count = CONFIG.candles.daily, incremental = false;
    if (cached && (cached.full || cached.c.length >= CONFIG.candles.daily - 5)){ const diff = dayDiff(cached.c[cached.c.length - 1].t, today); if (diff >= 0 && diff < 150){ count = Math.min(CONFIG.candles.daily, diff + 3); incremental = true; } }
    const fresh = await upbit.getCandles(market, '1d', { count });
    candles = incremental ? mergeCandles(cached.c, fresh, CONFIG.candles.daily) : fresh;
    cachePut(key, { t: Date.now(), day: today, c: candles, full: incremental ? cached.full : fresh.length < count });
  }
  return patchDailyWithQuote(candles, quote);
}
async function loadPeriod(market, type, daily){
  const isW = type === 'W', key = type + ':' + market, cached = await cacheGet(key);
  const limit = isW ? CONFIG.candles.weekly : CONFIG.candles.monthly;
  let candles;
  if (cached && cached.c.length && Date.now() - cached.t < 24 * 3600000) candles = cached.c;
  else {
    let count = limit, incremental = false;
    if (cached && cached.c.length >= (isW ? CONFIG.minBars.weekly : CONFIG.minBars.monthly)){
      const diff = dayDiff(cached.c[cached.c.length - 1].t, utcDay());
      const periods = isW ? Math.ceil(diff / 7) : Math.ceil(diff / 28);
      if (periods < limit - 5){ count = Math.min(limit, periods + 3); incremental = true; }
    }
    const fresh = await upbit.getCandles(market, isW ? '1w' : '1M', { count });
    candles = incremental ? mergeCandles(cached.c, fresh, limit) : fresh;
    cachePut(key, { t: Date.now(), day: utcDay(), c: candles });
  }
  return patchPeriod(candles, daily, isW ? weekKey : monthKey);
}

// 한 종목 분석. basis='confirmed' → 오늘 진행 중인 일봉 제외(KST 09:00 마감 확정봉만)
export async function analyzeOne(inst, quote, basis = 'confirmed'){
  const today = utcDay(), confirmed = basis === 'confirmed';
  const ref = confirmed ? Date.parse(today + 'T00:00:00Z') : Date.now();
  const ctx = { fracW: weekFrac(ref), fracM: monthFrac(ref), tradeValue: quote ? quote.value24h : null, price: quote ? quote.price : null, change: quote ? quote.changeRate : null, warning: inst.warning, basis };
  let D = await loadDaily(inst.market, quote);
  if (confirmed) D = D.filter(c => c.t < today);
  const D200 = D.slice(-200); // 기존 추세 분석은 예전과 같은 200개로
  if (D200.length < CONFIG.minBars.daily) return withPeter(A.analyze(inst.market, inst.name, null, null, D200, ctx), D, inst, quote);
  const W = await loadPeriod(inst.market, 'W', D200);
  const M = await loadPeriod(inst.market, 'M', D200);
  const res = A.analyze(inst.market, inst.name, M, W, D200, ctx);
  delete res._int;
  return withPeter(res, D, inst, quote);
}

// 피터 한 줄 의견 (규칙 기반, AI 호출 없음). 신규 상장처럼 캔들이 부족하면 신뢰도 낮음으로 표시.
function withPeter(res, D, inst, quote){
  const v = res.insufficient ? null : A.verdict(res);
  res.listedDays = D.length;
  res.profile = rangeProfile(D.slice(-200));
  res.scr = screen(inst, quote, D);       // 매수 검토 v2 (눌림 매수 / 바닥 반등 + 검증)
  res.guide = makeGuide(res);
  res.isNew = D.length < 30;
  res.peter = res.insufficient
    ? (res.isNew ? `신규 상장 ${D.length}일차. 데이터가 부족해 신뢰도가 낮아요.` : '데이터가 부족해 판단을 보류해요.')
    : v.t;
  const sg = res.scr.sig;
  if (sg.type) res.peter = (sg.type === 'pullback' ? '눌림 매수 신호 — ' : '바닥 반등 신호 — ') + sg.why.slice(0, 2).join(', ');
  else if (sg.excluded) res.peter = '고점 구간이라 매수 검토에서 제외 — ' + sg.excluded[0];
  res.peterTone = res.insufficient ? 'muted' : (res.status === 'ENTRY ZONE' ? 'accent' : res.stage === 'DOWN' || res.status === 'EXTENDED' ? 'warn' : 'muted');
  return res;
}

// 전체 스캔. 첫 실행은 종목당 3요청(일·주·월), 같은 날 재실행은 캐시라 요청 0.
export async function scanAll(instruments, quotes, { onProgress, onResult, signal, basis } = {}){
  const qmap = quotes instanceof Map ? quotes : new Map(quotes.map(q => [q.market, q]));
  let done = 0; const errors = [];
  for (const inst of instruments){
    if (signal && signal.aborted) break;
    try { onResult && onResult(await analyzeOne(inst, qmap.get(inst.market), basis)); }
    catch(e){ errors.push({ market: inst.market, error: e.message }); }
    onProgress && onProgress(++done, instruments.length);
  }
  return { done, errors };
}

// 변동폭 프로필: 최근 90일 일봉·주봉의 (고가/저가-1) 평균·중앙값(보통)·최대·최소
export function rangeProfile(D, lookback = 90){
  const d = D.slice(-lookback);
  const stat = arr => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    return { avg: arr.reduce((a, b) => a + b, 0) / arr.length, typical: s[Math.floor(s.length / 2)], max: s[s.length - 1], min: s[0], n: arr.length };
  };
  const day = d.map(c => (c.h / c.l - 1) * 100);
  const weeks = new Map();
  for (const c of d){ const k = weekKey(c.t); const w = weeks.get(k); if (!w) weeks.set(k, { h: c.h, l: c.l }); else { w.h = Math.max(w.h, c.h); w.l = Math.min(w.l, c.l); } }
  const wk = [...weeks.values()].map(w => (w.h / w.l - 1) * 100);
  return { lookback, '1d': stat(day), '1w': stat(wk.slice(0, -1)) };
}

// 매매 가이드: 피터의 차트 분석(지지·눌림 구간, 저항, 무효화 가격)이 기준.
// 하락 추세면 '관망'. 내 매매 기록 보정은 PHASE 2에서 더함.
export function makeGuide(res){
  if (res.insufficient || !res.up) return { stance: 'none' };
  const u = res.up;
  const stance = res.stage === 'DOWN' ? 'avoid' : (u.inZone && res.trendScore >= 55 ? 'buy_zone' : 'watch');
  const ref = u.entryRef;
  const pct = v => v && ref ? (v / ref - 1) * 100 : null;
  return {
    stance, buyLo: u.entryLo, buyHi: u.entryHi, ref,
    sell1: u.t1, sell2: u.t2, stop: u.stop,
    sell1Pct: pct(u.t1), sell2Pct: pct(u.t2), stopPct: pct(u.stop), rr: u.rr,
    hitRate: u.setupHit20, setups: u.setupN, median: u.setupMedian
  };
}
