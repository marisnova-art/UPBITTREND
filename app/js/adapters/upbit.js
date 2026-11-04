// 업비트 어댑터 — 공개 시세 전용 (주문·잔고는 서버 쪽에서만, PHASE 5)
// 모든 거래소 어댑터는 같은 모양을 따릅니다:
//   listInstruments() getQuotes(symbols) getCandles(symbol, tf, opts) getOrderbook(symbol) stream(symbols, handlers)
// 심볼 표기는 'upbit:KRW-BTC'. 이 파일 안에서는 업비트 마켓 코드('KRW-BTC')를 씁니다.
import { CONFIG } from '../config.js';
import { sleep } from '../util.js';

export const EXCHANGE = 'upbit';
export const toSymbol = market => `${EXCHANGE}:${market}`;
export const toMarket = symbol => symbol.includes(':') ? symbol.split(':')[1] : symbol;

const net = { via: 'direct', gap: CONFIG.api.minGapMs, lastAt: 0, okStreak: 0, rateHits: 0, requests: 0 };
export const netStats = () => ({ ...net });

const canProxy = () => /^https?:$/.test(location.protocol) && CONFIG.api.mode !== 'direct';
if (CONFIG.api.mode === 'proxy' && canProxy()) net.via = 'proxy';

// 모든 요청은 최소 간격을 예약하고 실행 (업비트 초당 10회 제한 아래로 유지)
async function rateWait(){
  const now = performance.now();
  const t = Math.max(net.lastAt + net.gap, now);
  net.lastAt = t;
  if (t > now) await sleep(t - now);
}

// 직접 호출 → 실패(CORS 등) 시 같은 도메인 프록시(/api/upbit)로 자동 전환. 429는 간격을 넓혀 재시도.
export async function api(path){
  let lastErr;
  for (let attempt = 0; attempt <= CONFIG.api.retries; attempt++){
    await rateWait();
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), CONFIG.api.timeoutMs);
    try{
      net.requests++;
      const url = (net.via === 'proxy' ? CONFIG.api.proxyBase : CONFIG.api.base) + path;
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      clearTimeout(to);
      if (res.status === 429){
        net.rateHits++; net.okStreak = 0;
        net.gap = Math.min(CONFIG.api.maxGapMs, Math.round(net.gap * 1.6));
        lastErr = new Error('요청 제한(429)');
        await sleep(1000 + attempt * 800); continue;
      }
      if (!res.ok){
        lastErr = new Error('HTTP ' + res.status);
        if (res.status >= 400 && res.status < 500) break;
        await sleep(600 * (attempt + 1)); continue;
      }
      const rem = res.headers.get('Remaining-Req');
      if (rem){ const m = /sec=(\d+)/.exec(rem); if (m && +m[1] <= 1) await sleep(900); }
      const json = await res.json();
      if (++net.okStreak > 40 && net.gap > CONFIG.api.minGapMs){ net.gap = Math.max(CONFIG.api.minGapMs, Math.round(net.gap * 0.9)); net.okStreak = 0; }
      return json;
    }catch(e){
      clearTimeout(to);
      if (e.name !== 'AbortError' && net.via === 'direct' && canProxy()){ net.via = 'proxy'; attempt--; continue; }
      lastErr = e.name === 'AbortError' ? new Error('응답 시간 초과') : new Error('네트워크 오류');
      await sleep(700 * (attempt + 1));
    }
  }
  throw lastErr || new Error('요청 실패');
}

// ---------- 종목 목록 (원화 마켓 전체, 신규 상장 포함)
export async function listInstruments(){
  const list = await api('/market/all?is_details=true');
  return list.filter(x => x.market && x.market.startsWith('KRW-')).map(x => {
    const ev = x.market_event || {};
    const caution = ev.caution ? Object.entries(ev.caution).filter(([, v]) => v).map(([k]) => k) : [];
    return {
      symbol: toSymbol(x.market), exchange: EXCHANGE, market: x.market,
      base: x.market.slice(4), quote: 'KRW',
      name: x.korean_name, nameEn: x.english_name,
      warning: ev.warning === true || (x.market_warning && x.market_warning !== 'NONE'),
      caution
    };
  });
}

// ---------- 현재가 (원화 마켓 한 번에)
const mapTicker = t => ({
  symbol: toSymbol(t.market), market: t.market,
  price: t.trade_price, open: t.opening_price, high: t.high_price, low: t.low_price, prevClose: t.prev_closing_price,
  change: t.signed_change_price, changeRate: t.signed_change_rate * 100,
  volume24h: t.acc_trade_volume_24h, value24h: t.acc_trade_price_24h,
  high52w: t.highest_52_week_price, low52w: t.lowest_52_week_price,
  ts: t.trade_timestamp || t.timestamp,
  // 거래정지: 업비트가 주는 상태값이 있으면 사용 (없으면 정상으로 봄)
  suspended: t.is_trading_suspended === true || (t.market_state != null && t.market_state !== 'ACTIVE')
});
export async function getQuotes(markets){
  if (!markets){
    try { return (await api('/ticker/all?quote_currencies=KRW')).map(mapTicker); } catch(e){ /* 아래로 */ }
    markets = (await listInstruments()).map(i => i.market);
  }
  let out = [];
  for (let i = 0; i < markets.length; i += 100) out = out.concat(await api('/ticker?markets=' + markets.slice(i, i + 100).join(',')));
  return out.map(mapTicker);
}

// ---------- 캔들. tf: '1m' '5m' '15m' '1h' '1d' '1w' '1M'
const TF_PATH = { '1m':'minutes/1', '3m':'minutes/3', '5m':'minutes/5', '15m':'minutes/15', '30m':'minutes/30', '1h':'minutes/60', '4h':'minutes/240', '1d':'days', '1w':'weeks', '1M':'months' };
const toCandle = c => ({
  time: Math.floor(Date.parse(c.candle_date_time_utc + 'Z') / 1000),
  t: c.candle_date_time_utc.slice(0, 10),
  o: c.opening_price, h: c.high_price, l: c.low_price, c: c.trade_price, v: c.candle_acc_trade_volume, value: c.candle_acc_trade_price
});
// count가 200을 넘으면 'to'로 이어 받아 붙입니다(오래된 → 최신 순으로 반환).
export async function getCandles(market, tf = '1d', { count = 200, to = null } = {}){
  if (tf === '1y') return toYears(await getCandles(market, '1M', { count: 200, to }));
  const path = TF_PATH[tf]; if (!path) throw new Error('지원하지 않는 시간 단위: ' + tf);
  let out = [], cursor = to;
  while (out.length < count){
    const n = Math.min(200, count - out.length);
    const q = `/candles/${path}?market=${market}&count=${n}` + (cursor ? '&to=' + encodeURIComponent(cursor) : '');
    const raw = await api(q);
    if (!raw.length) break;
    out = out.concat(raw);
    cursor = raw[raw.length - 1].candle_date_time_utc + 'Z';
    if (raw.length < n) break;
  }
  // 같은 시각 중복 제거 + 오래된 → 최신 정렬 (차트 라이브러리 요구사항)
  const seen = new Map(); for (const c of out.map(toCandle)) seen.set(c.time, c);
  return [...seen.values()].sort((a, b) => a.time - b.time);
}

// 연봉: 월봉을 해(UTC 기준 1월)별로 합침. 업비트 원화 마켓은 2017년부터라 월봉 200개면 충분.
function toYears(months){
  const m = new Map();
  for (const c of months){
    const y = new Date(c.time * 1000).getUTCFullYear();
    const g = m.get(y);
    if (!g) m.set(y, { time: Date.UTC(y, 0, 1) / 1000, t: y + '-01-01', o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, value: c.value || 0 });
    else { g.h = Math.max(g.h, c.h); g.l = Math.min(g.l, c.l); g.c = c.c; g.v += c.v; g.value += c.value || 0; }
  }
  return [...m.values()].sort((a, b) => a.time - b.time);
}

// ---------- 호가
export async function getOrderbook(market){
  const [ob] = await api('/orderbook?markets=' + market);
  return mapOrderbook(ob);
}
const mapOrderbook = ob => ob && ({
  market: ob.market || ob.code, ts: ob.timestamp,
  totalAsk: ob.total_ask_size, totalBid: ob.total_bid_size,
  units: (ob.orderbook_units || []).map(u => ({ ask: u.ask_price, askSize: u.ask_size, bid: u.bid_price, bidSize: u.bid_size }))
});

// ---------- 실시간 (WebSocket). 연결이 끊기면 자동 재연결.
// handlers: { ticker(q), orderbook(ob), trade(t), status(state) }
export function stream(markets, handlers = {}){
  let ws = null, closed = false, timer = null, subs = { ticker: [...markets], orderbook: [], trade: [] };
  const setStatus = s => handlers.status && handlers.status(s);
  const send = () => {
    if (!ws || ws.readyState !== 1) return;
    const msg = [{ ticket: 'quantera-' + Math.random().toString(36).slice(2, 8) }];
    if (subs.ticker.length) msg.push({ type: 'ticker', codes: subs.ticker, is_only_realtime: true });
    if (subs.orderbook.length) msg.push({ type: 'orderbook', codes: subs.orderbook, is_only_realtime: true });
    if (subs.trade.length) msg.push({ type: 'trade', codes: subs.trade, is_only_realtime: true });
    msg.push({ format: 'DEFAULT' });
    ws.send(JSON.stringify(msg));
  };
  const open = () => {
    setStatus('connecting');
    try { ws = new WebSocket(CONFIG.ws.url); } catch(e){ return retry(); }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { setStatus('live'); send(); };
    ws.onmessage = async ev => {
      try{
        const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
        const d = JSON.parse(text);
        if (d.type === 'ticker' && handlers.ticker) handlers.ticker(mapTicker({ ...d, market: d.code }));
        else if (d.type === 'orderbook' && handlers.orderbook) handlers.orderbook(mapOrderbook(d));
        else if (d.type === 'trade' && handlers.trade) handlers.trade({ market: d.code, price: d.trade_price, size: d.trade_volume, side: d.ask_bid === 'BID' ? 'buy' : 'sell', ts: d.trade_timestamp });
      }catch(e){ /* 잘못된 메시지는 무시 */ }
    };
    ws.onclose = () => { if (!closed){ setStatus('reconnecting'); retry(); } };
    ws.onerror = () => { try { ws.close(); } catch(e){} };
  };
  const retry = () => { clearTimeout(timer); timer = setTimeout(open, CONFIG.ws.reconnectMs); };
  open();
  return {
    // 선택 종목이 바뀌면 호가·체결 구독만 바꿉니다(시세는 전체 유지)
    focus(market){ subs.orderbook = market ? [market] : []; subs.trade = market ? [market] : []; send(); },
    setTickers(list){ subs.ticker = [...list]; send(); },
    close(){ closed = true; clearTimeout(timer); try { ws && ws.close(); } catch(e){} setStatus('off'); }
  };
}
