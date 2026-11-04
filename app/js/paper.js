// 모의투자 엔진 — 가상 돈으로 주문·체결·예약 매도(익절/손절)를 돌립니다.
// 상태(잔고·미체결·예약 매도)는 이 기기(localStorage)에 저장하고, 로그인하면 Supabase(q_user_settings.prefs.paper)에도 저장.
// 체결 기록은 거래일지(q_trades, source='paper')에 쌓기만 합니다.
// 체결 규칙: 지정가 매수는 현재가가 지정가 이하가 되면 지정가로, 지정가 매도는 이상이 되면 지정가로 체결.
//           시장가는 현재가로 즉시 체결. 수수료 0.05%(업비트 원화 마켓). 부분 체결은 없음(모의라 단순화).
// 예약 매도: 매수 체결가 기준 익절가 / 손절가. 먼저 닿는 쪽으로 전량 매도하고 다른 쪽은 취소.
import { LS, emitter } from './util.js';
import { FEE_RATE } from './analysis/ledger.js';

const KEY = 'quantera:paper', TKEY = 'quantera:paperTrades';
export const PAPER_START = 10_000_000;

const fresh = () => ({ v: 1, start: PAPER_START, cash: PAPER_START, seq: 0, orders: [], brackets: [], lastCheck: Date.now(), halted: false });

export function createPaper({ priceOf, remote }){
  const ev = emitter();
  let st = LS.get(KEY, null) || fresh();
  let trades = LS.get(TKEY, []) || [];
  let lastLocal = 0;
  const save = () => { st.savedAt = Date.now(); lastLocal = st.savedAt; LS.set(KEY, st); LS.set(TKEY, trades); remote && remote.saveState(st); ev.emit('change'); };
  const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const nextNo = () => { st.seq = Math.max(st.seq, ...trades.map(t => +String(t.trade_no || '').replace(/\D/g, '') || 0)) + 1; return 'P-' + String(st.seq).padStart(4, '0'); };

  // ---------- 보유 (체결 기록에서 계산)
  const active = () => st.resetAt ? trades.filter(t => Date.parse(t.executed_at) >= st.resetAt) : trades;  // 초기화 이후 기록만
  function holding(sym){
    let q = 0; for (const t of active()) if (t.symbol === sym && !t.voids_trade_id) q += t.side === 'buy' ? t.qty : -t.qty;
    return Math.max(0, q);
  }
  const reservedSell = sym => st.orders.filter(o => o.status === 'open' && o.side === 'sell' && o.symbol === sym).reduce((a, o) => a + o.qty, 0);
  const reservedCash = () => st.orders.filter(o => o.status === 'open' && o.side === 'buy').reduce((a, o) => a + o.price * o.qty * (1 + FEE_RATE), 0);
  const available = () => st.cash - reservedCash();
  const availableQty = sym => Math.max(0, holding(sym) - reservedSell(sym));

  // ---------- 체결
  function fill(o, price, at = Date.now(), why = ''){
    const value = price * o.qty, fee = value * FEE_RATE;
    if (o.side === 'buy'){
      if (st.cash + 1e-6 < value + fee){ o.status = 'rejected'; o.note = '잔고 부족'; return null; }
      st.cash -= value + fee;
    } else {
      const q = Math.min(o.qty, holding(o.symbol));
      if (q <= 0){ o.status = 'cancelled'; o.note = '보유 없음'; return null; }
      o.qty = q; st.cash += price * q * (1 - FEE_RATE);
    }
    o.status = 'filled'; o.filledAt = at; o.fillPrice = price;
    const t = { trade_no: nextNo(), symbol: o.symbol, side: o.side, price, qty: o.qty, fee: price * o.qty * FEE_RATE,
      executed_at: new Date(at).toISOString(), source: 'paper', strategy: o.strategy || null, reason: why || o.reason || null,
      guide: o.side === 'buy' && (o.tpPct || o.slPct) ? { tpPct: o.tpPct || null, slPct: o.slPct || null } : null, synced: false };
    trades.push(t);
    if (o.side === 'buy' && (o.tpPct > 0 || o.slPct > 0)){
      st.brackets.push({ id: uid('b'), symbol: o.symbol, qty: o.qty, entry: price, at,
        tpPct: o.tpPct || null, slPct: o.slPct || null,
        tp: o.tpPct > 0 ? price * (1 + o.tpPct / 100) : null, sl: o.slPct > 0 ? price * (1 - o.slPct / 100) : null,
        strategy: o.strategy || null, active: true });
    }
    remote && remote.addTrade(t).then(ok => { if (ok){ t.synced = true; LS.set(TKEY, trades); } });
    ev.emit('fill', { order: o, trade: t });
    return t;
  }

  // 예약 매도 실행: 남은 보유 수량 안에서만 판다
  function fireBracket(b, kind, price, at){
    b.active = false;
    const q = Math.min(b.qty, Math.max(0, holding(b.symbol) - reservedSell(b.symbol)));
    if (q <= 0){ b.note = '보유 없음'; return; }
    const o = { id: uid('o'), symbol: b.symbol, side: 'sell', type: kind === 'tp' ? 'limit' : 'market', price, qty: q, status: 'open', at, strategy: b.strategy, kind };
    st.orders.push(o);
    const t = fill(o, price, at, kind === 'tp' ? `익절 +${b.tpPct}%` : `손절 -${b.slPct}%`);
    if (t) ev.emit('bracket', { bracket: b, kind, trade: t });
  }

  // 시세 한 번(또는 캔들 하나)에 대해 미체결·예약 매도 확인. hi/lo가 있으면 캔들(손절 먼저 = 보수적).
  function touch(sym, { price, hi = price, lo = price, at = Date.now() }){
    if (st.halted) return false;
    let changed = false;
    for (const o of st.orders){
      if (o.status !== 'open' || o.symbol !== sym || o.type !== 'limit' || o.at > at) continue;
      if (o.side === 'buy' && lo <= o.price){ fill(o, o.price, at); changed = true; }
      else if (o.side === 'sell' && hi >= o.price){ fill(o, o.price, at); changed = true; }
    }
    for (const b of st.brackets){
      if (!b.active || b.symbol !== sym || b.at >= at) continue;
      if (b.sl && lo <= b.sl){ fireBracket(b, 'sl', Math.min(b.sl, hi), at); changed = true; }
      else if (b.tp && hi >= b.tp){ fireBracket(b, 'tp', b.tp, at); changed = true; }
    }
    return changed;
  }

  return {
    on: ev.on, get state(){ return st; }, get trades(){ return active(); }, get allTrades(){ return trades; },
    holding, available, availableQty,
    openOrders: () => st.orders.filter(o => o.status === 'open'),
    activeBrackets: () => st.brackets.filter(b => b.active),
    hasWork: () => st.orders.some(o => o.status === 'open') || st.brackets.some(b => b.active),

    // 주문 넣기. buy: { symbol, type, price?, amount?, qty?, tpPct?, slPct?, strategy?, reason? }
    place(p){
      if (st.halted) throw new Error('긴급 정지 중이에요. 해제한 뒤 주문할 수 있어요.');
      const cur = priceOf(p.symbol); if (!cur) throw new Error('현재가를 아직 못 받았어요.');
      const price = p.type === 'market' ? cur : +p.price;
      if (!(price > 0)) throw new Error('가격을 넣어 주세요.');
      let qty = +p.qty || (p.amount ? +p.amount / price : 0);
      if (!(qty > 0)) throw new Error(p.side === 'buy' ? '금액이나 수량을 넣어 주세요.' : '수량을 넣어 주세요.');
      if (p.side === 'buy'){
        if (price * qty * (1 + FEE_RATE) > available() + 1) throw new Error('주문 가능 금액이 부족해요.');
        if (price * qty < 5000) throw new Error('최소 주문 금액은 5,000원이에요.');
      } else {
        if (qty > availableQty(p.symbol) + 1e-12) throw new Error('매도 가능 수량이 부족해요.');
      }
      const o = { id: uid('o'), symbol: p.symbol, side: p.side, type: p.type, price, qty, status: 'open', at: Date.now(),
        tpPct: p.side === 'buy' ? (+p.tpPct || null) : null, slPct: p.side === 'buy' ? (+p.slPct || null) : null,
        strategy: p.strategy || null, reason: p.reason || null };
      st.orders.push(o);
      if (p.type === 'market') fill(o, cur);
      else touch(p.symbol, { price: cur });   // 이미 지정가에 닿아 있으면 바로 체결
      save(); return o;
    },
    cancel(id){ const o = st.orders.find(x => x.id === id); if (o && o.status === 'open'){ o.status = 'cancelled'; save(); } },
    amend(id, price){ const o = st.orders.find(x => x.id === id); if (o && o.status === 'open' && price > 0){
      if (o.side === 'buy' && (price - o.price) * o.qty * (1 + FEE_RATE) > available() + 1) throw new Error('주문 가능 금액이 부족해요.');
      o.price = price; o.at = Date.now(); touch(o.symbol, { price: priceOf(o.symbol) || price }); save(); } },
    cancelAll(){ for (const o of st.orders) if (o.status === 'open') o.status = 'cancelled'; save(); },
    bracketOff(id){ const b = st.brackets.find(x => x.id === id); if (b){ b.active = false; b.note = '끔'; save(); } },
    bracketSet(id, tpPct, slPct){ const b = st.brackets.find(x => x.id === id); if (!b) return;
      b.tpPct = tpPct > 0 ? tpPct : null; b.slPct = slPct > 0 ? slPct : null;
      b.tp = b.tpPct ? b.entry * (1 + b.tpPct / 100) : null; b.sl = b.slPct ? b.entry * (1 - b.slPct / 100) : null;
      b.active = !!(b.tp || b.sl); save(); },
    // 보유분에 예약 매도 새로 걸기 (평단 기준)
    bracketAdd(symbol, entry, qty, tpPct, slPct, strategy){
      if (!(qty > 0)) return;
      st.brackets.push({ id: uid('b'), symbol, qty, entry, at: Date.now(), tpPct: tpPct || null, slPct: slPct || null,
        tp: tpPct > 0 ? entry * (1 + tpPct / 100) : null, sl: slPct > 0 ? entry * (1 - slPct / 100) : null, strategy, active: true });
      save(); },
    halt(on){ st.halted = on; if (on){ for (const o of st.orders) if (o.status === 'open') o.status = 'cancelled'; for (const b of st.brackets) if (b.active){ b.active = false; b.note = '긴급 정지'; } } save(); },
    reset(start = PAPER_START){ st = { ...fresh(), start, cash: start }; // 체결 기록은 남기고 잔고·주문만 새로
      st.resetAt = Date.now(); st.seq = Math.max(0, ...trades.map(t => +String(t.trade_no || '').replace(/\D/g, '') || 0)); save(); },
    // 실시간 시세
    tick(sym, price){ st.lastCheck = Date.now(); if (touch(sym, { price, at: Date.now() })) save(); else if (st.lastCheck - lastLocal > 20000){ lastLocal = st.lastCheck; LS.set(KEY, st); } },
    // 앱이 꺼져 있던 동안: 캔들로 확인. getCandles(market, tf, {count}) → 오래된→최신
    async catchUp(getCandles, toMarket){
      const since = st.lastCheck || Date.now();
      const syms = [...new Set([...st.orders.filter(o => o.status === 'open'), ...st.brackets.filter(b => b.active)].map(x => x.symbol))];
      const gapMin = (Date.now() - since) / 60000;
      if (!syms.length || gapMin < 1){ st.lastCheck = Date.now(); return 0; }
      const tf = gapMin <= 400 ? '1m' : gapMin <= 6000 ? '15m' : gapMin <= 24000 ? '1h' : '1d';
      const unit = { '1m': 60e3, '15m': 900e3, '1h': 3600e3, '1d': 86400e3 }[tf];
      let n = 0;
      for (const sym of syms){
        try{
          const C = await getCandles(toMarket(sym), tf, { count: Math.min(400, Math.ceil((Date.now() - since) / unit) + 2) });
          for (const c of C){
            const end = c.time * 1000 + unit;
            if (end < since) continue;
            if (touch(sym, { price: c.c, hi: c.h, lo: c.l, at: Math.max(since, c.time * 1000) })) n++;
          }
        }catch(e){ /* 다음에 다시 */ }
      }
      st.lastCheck = Date.now(); save(); return n;
    },
    // 로그인 후: 서버에 있는 모의 기록·상태와 합치기
    merge(remoteState, remoteTrades){
      if (remoteState && (remoteState.savedAt || 0) > (st.savedAt || 0)) st = remoteState;
      if (remoteTrades && remoteTrades.length){
        const have = new Set(remoteTrades.map(t => t.trade_no));
        const local = trades.filter(t => !have.has(t.trade_no));
        trades = [...remoteTrades.map(t => ({ ...t, synced: true })), ...local].sort((a, b) => Date.parse(a.executed_at) - Date.parse(b.executed_at));
        for (const t of local) remote && remote.addTrade(t).then(ok => { if (ok){ t.synced = true; LS.set(TKEY, trades); } });
      }
      save();
    },
  };
}
