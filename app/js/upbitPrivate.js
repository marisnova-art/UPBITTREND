// 업비트 실제 거래 가져오기 (조회 전용 키)
// 키는 이 기기(localStorage)에만 두고, 서명(JWT HS512)도 브라우저에서 합니다. 서버로 보내지 않아요.
// 업비트는 키마다 허용 IP를 등록해야 해서, 등록한 IP의 기기(보통 집 PC)에서만 동작합니다.
import { LS } from './util.js';

const KEY = 'quantera:upbitKey';
const META = 'quantera:upbitImport';
const API = 'https://api.upbit.com/v1';

export const keys = {
  get(){ return LS.get(KEY, null); },
  set(access, secret){ LS.set(KEY, { access: access.trim(), secret: secret.trim() }); },
  clear(){ try { localStorage.removeItem(KEY); } catch(e){} }
};
export const importMeta = { get: () => LS.get(META, {}), set: v => LS.set(META, { ...LS.get(META, {}), ...v }) };

const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const b64urlStr = s => b64url(enc.encode(s));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

async function token(k, query){
  const payload = { access_key: k.access, nonce: crypto.randomUUID() };
  if (query){ payload.query_hash = hex(await crypto.subtle.digest('SHA-512', enc.encode(query))); payload.query_hash_alg = 'SHA512'; }
  const head = b64urlStr(JSON.stringify({ alg: 'HS512', typ: 'JWT' })) + '.' + b64urlStr(JSON.stringify(payload));
  const key = await crypto.subtle.importKey('raw', enc.encode(k.secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  return head + '.' + b64url(await crypto.subtle.sign('HMAC', key, enc.encode(head)));
}

const ERR_KO = {
  no_authorization_ip: '허용되지 않은 IP예요. 업비트 Open API 관리에서 지금 이 기기의 공인 IP를 등록해 주세요.',
  out_of_scope: '키 권한이 부족해요. 자산조회·주문조회 권한을 켠 키가 필요해요.',
  invalid_access_key: 'Access Key가 맞지 않아요.',
  expired_access_key: '키가 만료됐어요. 업비트에서 새로 발급해 주세요.',
  jwt_verification: 'Secret Key가 맞지 않아요.',
  invalid_query_payload: '요청 서명이 맞지 않아요.',
  too_many_requests: '요청이 너무 많아요. 잠시 뒤 다시 해 주세요.'
};
export class UpbitError extends Error { constructor(msg, code){ super(msg); this.code = code; } }

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(path, query = ''){
  const k = keys.get(); if (!k || !k.access || !k.secret) throw new UpbitError('업비트 키를 먼저 넣어 주세요.', 'no_key');
  for (let attempt = 0; attempt < 3; attempt++){
    let res;
    try { res = await fetch(`${API}/${path}${query ? '?' + query : ''}`, { headers: { Authorization: 'Bearer ' + await token(k, query), accept: 'application/json' } }); }
    catch(e){ throw new UpbitError('업비트에 연결하지 못했어요. 브라우저가 직접 연결을 막았거나 인터넷이 끊겼어요.', 'network'); }
    if (res.status === 429){ await sleep(1000 * (attempt + 1)); continue; }
    const body = await res.json().catch(() => null);
    if (!res.ok){
      const name = body && body.error && body.error.name;
      throw new UpbitError(ERR_KO[name] || (body && body.error && body.error.message) || `업비트 오류 ${res.status}`, name || res.status);
    }
    return body;
  }
  throw new UpbitError(ERR_KO.too_many_requests, 'too_many_requests');
}

// 키 확인: 잔고 조회 (자산조회 권한)
export const accounts = () => call('accounts');

// 체결된 주문 → 기록 한 줄씩 (주문 하나 = 기록 하나, 평균 체결가)
const WEEK = 7 * 864e5;
export async function fetchFilled(fromMs, toMs, onProgress = () => {}){
  const orders = [];
  const spans = Math.ceil((toMs - fromMs) / WEEK);
  for (let i = 0, s = fromMs; s < toMs; i++, s += WEEK){
    const e = Math.min(s + WEEK - 1, toMs);
    let start = s;
    for (;;){
      const q = `states[]=done&states[]=cancel&start_time=${start}&end_time=${e}&limit=1000&order_by=asc`;
      const page = await call('orders/closed', q);
      orders.push(...page.filter(o => +o.executed_volume > 0));
      if (page.length < 1000) break;
      start = new Date(page[page.length - 1].created_at).getTime() + 1;
      await sleep(120);
    }
    onProgress(`주문 목록 ${i + 1}/${spans}주`);
    await sleep(120);
  }
  const seen = new Set(), out = [];
  const uniq = orders.filter(o => !seen.has(o.uuid) && seen.add(o.uuid));
  const list = uniq.filter(o => o.market.startsWith('KRW-'));   // 원화 마켓만 (BTC·USDT 마켓은 손익 단위가 달라 제외)
  out.skipped = uniq.length - list.length;
  for (let i = 0; i < list.length; i++){
    let o = list[i];
    if (!o.trades || !o.trades.length){ o = await call('order', `uuid=${o.uuid}`); await sleep(80); }
    out.push(o);
    if (i % 5 === 0) onProgress(`체결 내역 ${i + 1}/${list.length}건`);
  }
  return out;
}

// 업비트 주문 → q_trades 행
export function toRow(o, toSymbol){
  const tr = o.trades || [];
  const vol = tr.reduce((s, t) => s + +t.volume, 0) || +o.executed_volume;
  const funds = tr.reduce((s, t) => s + +t.funds, 0);
  const price = funds > 0 ? funds / vol : +o.price;
  const last = tr.length ? tr[tr.length - 1].created_at : o.created_at;
  return {
    trade_no: 'U-' + o.uuid.slice(0, 13), external_id: o.uuid, source: 'upbit_import',
    symbol: toSymbol(o.market), side: o.side === 'bid' ? 'buy' : 'sell',
    price, qty: +o.executed_volume, fee: +o.paid_fee || 0,
    executed_at: new Date(last).toISOString(),
    reason: null, strategy: null, guide: { upbit: { ord_type: o.ord_type, trades: tr.length || +o.trades_count || 0 } }
  };
}
