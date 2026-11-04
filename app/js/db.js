// Supabase — 로그인, 관심 목록, 거래 기록(쌓기만), 화면 배치.
// 테이블이 아직 없거나 로그인 전이면 이 브라우저(localStorage)에만 저장하고 앱은 그대로 동작합니다.
import { CONFIG } from './config.js';
import { LS, emitter } from './util.js';

const SB_SRC = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js';
export const db = { client: null, user: null, ready: false, tablesOk: null, events: emitter() };

const isMissing = e => !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|could not find the table/i.test(e.message || ''));
function loadScript(src){ return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('스크립트 로드 실패')); document.head.appendChild(s); }); }

export async function initDb(){
  try{
    await loadScript(SB_SRC);
    db.client = window.supabase.createClient(CONFIG.supabase.url, CONFIG.supabase.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
    const { data } = await db.client.auth.getSession();
    db.user = data && data.session ? data.session.user : null;
    db.client.auth.onAuthStateChange((_e, sess) => {
      const nu = sess ? sess.user : null;
      if ((nu && nu.id) === (db.user && db.user.id)) return;
      db.user = nu; setTimeout(() => db.events.emit('auth', db.user), 0);
    });
    db.ready = true;
  }catch(e){ db.ready = false; }
  db.events.emit('auth', db.user);
}
export async function login(email, password){
  const { error } = await db.client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(/invalid login/i.test(error.message) ? '이메일 또는 비밀번호가 맞지 않아요.' : error.message);
}
export async function logout(){ await db.client.auth.signOut(); }
const online = () => db.ready && db.user && db.tablesOk !== false;

async function q(fn){
  try{
    const { data, error } = await fn();
    if (error){ if (isMissing(error)){ db.tablesOk = false; db.events.emit('tables', false); } throw error; }
    if (db.tablesOk !== true){ db.tablesOk = true; db.events.emit('tables', true); }
    return data;
  }catch(e){ throw e; }
}

// ---------- 관심 목록
const WL_KEY = 'quantera:watchlist';
export async function loadWatchlist(){
  if (online()){
    try{
      const rows = await q(() => db.client.from('q_watchlist').select('symbol,sort').order('sort'));
      const list = rows.map(r => r.symbol); LS.set(WL_KEY, list); return list;
    }catch(e){ /* 아래로 */ }
  }
  return LS.get(WL_KEY, ['upbit:KRW-BTC', 'upbit:KRW-ETH', 'upbit:KRW-XRP', 'upbit:KRW-SOL']);
}
export async function setWatch(symbol, on){
  const list = LS.get(WL_KEY, []);
  const next = on ? [...new Set([...list, symbol])] : list.filter(s => s !== symbol);
  LS.set(WL_KEY, next);
  if (online()){
    try{
      if (on) await q(() => db.client.from('q_watchlist').upsert({ symbol, sort: next.length }, { onConflict: 'user_id,symbol' }));
      else await q(() => db.client.from('q_watchlist').delete().eq('symbol', symbol));
    }catch(e){ console.warn('관심 목록 저장 실패', e.message); }
  }
  return next;
}

// ---------- 거래 기록 (읽기 + 추가만)
export async function loadTrades(){
  if (!online()) return [];
  try { return await q(() => db.client.from('q_trades').select('*').order('executed_at', { ascending: true }).limit(5000)); }
  catch(e){ return []; }
}

// ---------- 화면 배치 (PC 패널 크기·접힘)
const LAYOUT_KEY = 'quantera:layout';
export function localLayout(){ return LS.get(LAYOUT_KEY, null); }
let layoutTimer = null;
export function saveLayout(layout){
  LS.set(LAYOUT_KEY, layout);
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(async () => {
    if (!online()) return;
    try { await q(() => db.client.from('q_user_settings').upsert({ layout, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })); } catch(e){}
  }, 1200);
}
export async function remoteLayout(){
  if (!online()) return null;
  try { const rows = await q(() => db.client.from('q_user_settings').select('layout').limit(1)); return rows[0] && Object.keys(rows[0].layout || {}).length ? rows[0].layout : null; }
  catch(e){ return null; }
}
