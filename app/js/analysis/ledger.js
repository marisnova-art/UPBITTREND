// 거래 기록 계산 — 실현손익, 현재가 대비, 재매수 기회. 저장하지 않고 기록에서 매번 계산합니다.
export const FEE_RATE = 0.0005; // 업비트 원화 마켓 0.05%

// 시간순 기록 → 각 매도에 실현손익(수수료 포함), 각 매수에 현재가 대비 %
export function computeLedger(trades, priceOf){
  const voided = new Set(trades.filter(t => t.voids_trade_id).map(t => t.voids_trade_id));
  const live = trades.filter(t => !t.voids_trade_id && !voided.has(t.id));
  const pos = new Map(); // symbol → { qty, cost }
  const rows = [];
  for (const t of live){
    const p = pos.get(t.symbol) || { qty: 0, cost: 0 };
    const fee = t.fee != null ? +t.fee : 0;
    const row = { ...t, fee, value: t.price * t.qty };
    if (t.side === 'buy'){
      p.qty += t.qty; p.cost += t.price * t.qty + fee;
    } else {
      const avg = p.qty > 0 ? p.cost / p.qty : null;
      const q = Math.min(t.qty, p.qty);
      if (avg != null && q > 0){
        const basis = avg * q;
        row.avgCost = avg;
        row.realized = t.price * q - fee - basis;
        row.realizedPct = row.realized / basis * 100;
        p.cost -= basis; p.qty -= q;
      }
      if (p.qty < 1e-12){ p.qty = 0; p.cost = 0; }
    }
    pos.set(t.symbol, p);
    const cur = priceOf(t.symbol);
    if (cur != null) row.vsNow = (cur / t.price - 1) * 100;
    rows.push(row);
  }
  const positions = [...pos.entries()].filter(([, p]) => p.qty > 0).map(([symbol, p]) => {
    const cur = priceOf(symbol), avg = p.cost / p.qty;
    return { symbol, qty: p.qty, avg, cost: p.cost, value: cur != null ? cur * p.qty : null, pnl: cur != null ? cur * p.qty * (1 - FEE_RATE) - p.cost : null };
  });
  return { rows, positions, rebuy: rebuyCandidates(rows, pos, priceOf) };
}

// 재매수 기회: 이익을 내고 판 적이 있는 종목인데 지금 가격이 그때 매수가보다 낮음
function rebuyCandidates(rows, pos, priceOf){
  const out = new Map();
  for (const r of rows){
    if (r.side !== 'sell' || !(r.realized > 0) || !r.avgCost) continue;
    const cur = priceOf(r.symbol); if (cur == null) continue;
    if (cur < r.avgCost){
      const prev = out.get(r.symbol);
      if (!prev || r.avgCost > prev.buyPrice) out.set(r.symbol, { symbol: r.symbol, buyPrice: r.avgCost, soldAt: r.price, gapPct: (cur / r.avgCost - 1) * 100, held: (pos.get(r.symbol) || {}).qty > 0 });
    }
  }
  return [...out.values()];
}

// 종목별 과거 매수가 (차트 선 표시용, 최근 순)
export function pastBuys(rows, symbol){
  return rows.filter(r => r.symbol === symbol && r.side === 'buy').slice(-3).reverse()
    .map(r => ({ price: r.price, label: `${r.trade_no} 매수` }));
}
