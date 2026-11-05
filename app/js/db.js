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

// ---------- 모의투자 (상태는 q_user_settings.prefs.paper, 체결은 q_trades source='paper')
let prefsCache = null, paperTimer = null;
async function loadPrefs(){
  if (prefsCache) return prefsCache;
  try { const rows = await q(() => db.client.from('q_user_settings').select('prefs').limit(1)); prefsCache = (rows[0] && rows[0].prefs) || {}; }
  catch(e){ prefsCache = {}; }
  return prefsCache;
}
export const paperRemote = {
  saveState(st){
    if (!online()) return;
    clearTimeout(paperTimer);
    paperTimer = setTimeout(async () => {
      try{
        const prefs = { ...(await loadPrefs()), paper: st }; prefsCache = prefs;
        await q(() => db.client.from('q_user_settings').upsert({ prefs, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }));
      }catch(e){ console.warn('모의 상태 저장 실패', e.message); }
    }, 1500);
  },
  async addTrade(t){
    if (!online()) return false;
    const row = { trade_no: t.trade_no, symbol: t.symbol, side: t.side, price: t.price, qty: t.qty, fee: t.fee, executed_at: t.executed_at,
      source: 'paper', strategy: t.strategy, reason: t.reason, guide: t.guide };
    try { await q(() => db.client.from('q_trades').insert(row)); return true; }
    catch(e){ return e && e.code === '23505'; }   // 다른 기기에서 이미 올린 기록
  },
  async load(){
    if (!online()) return null;
    try{
      const prefs = await loadPrefs();
      const trades = await q(() => db.client.from('q_trades').select('*').eq('source', 'paper').order('executed_at', { ascending: true }).limit(5000));
      return { state: prefs.paper || null, trades: (trades || []).filter(t => t.source === 'paper') };
    }catch(e){ return null; }
  }
};
export function resetPrefsCache(){ prefsCache = null; }
// 화면 설정(모의투자 켜기, 거래일지 그래프 기간 등): prefs.ui 에 저장해 기기끼리 맞춤
let uiTimer = null;
export const uiRemote = {
  async load(){ if (!online()) return null; try { const p = await loadPrefs(); return p.ui || null; } catch(e){ return null; } },
  save(ui){
    if (!online()) return;
    clearTimeout(uiTimer);
    uiTimer = setTimeout(async () => {
      try{
        const prefs = { ...(await loadPrefs()), ui }; prefsCache = prefs;
        await q(() => db.client.from('q_user_settings').upsert({ prefs, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }));
      }catch(e){ console.warn('설정 저장 실패', e.message); }
    }, 600);
  },
  // 모의 상태를 서버에서도 지움 (체결 기록 행은 쌓기만 하는 표라 남지만, 지운 시각 이전 것은 앱이 안 보여 줌)
  async clearPaper(st){
    if (!online()) return;
    try{
      const prefs = { ...(await loadPrefs()), paper: st }; prefsCache = prefs;
      await q(() => db.client.from('q_user_settings').upsert({ prefs, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }));
    }catch(e){}
  }
};

// ---------- 업비트 가져오기: 이미 올린 주문(external_id)은 건너뜀
export async function importTrades(rows){
  if (!online()) throw new Error('로그인이 필요해요.');
  const have = new Set();
  for (let from = 0; ; from += 1000){
    const r = await q(() => db.client.from('q_trades').select('external_id').eq('source', 'upbit_import').not('external_id', 'is', null).range(from, from + 999));
    (r || []).forEach(x => have.add(x.external_id));
    if (!r || r.length < 1000) break;
  }
  const fresh = rows.filter(x => !x.external_id || !have.has(x.external_id));
  for (let i = 0; i < fresh.length; i += 200) await q(() => db.client.from('q_trades').insert(fresh.slice(i, i + 200)));
  return { added: fresh.length, skipped: rows.length - fresh.length };
}

// ---------- 업비트 연결 코드 (PC 도우미가 이 코드로 거래일지에 바로 올림). 서버엔 코드의 SHA-256만 저장
export const upbitLinks = {
  async list(){ if (!online()) return null; try { return await q(() => db.client.from('q_upbit_links').select('id,created_at,last_used_at,last_added,revoked_at').is('revoked_at', null).order('created_at', { ascending: false })); } catch(e){ return e && /q_upbit_links/.test(e.message || '') ? 'missing' : null; } },
  async create(hash){ if (!online()) throw new Error('로그인이 필요해요.'); await q(() => db.client.from('q_upbit_links').insert({ code_hash: hash })); },
  async revokeAll(){ if (!online()) return; await q(() => db.client.from('q_upbit_links').update({ revoked_at: new Date().toISOString() }).is('revoked_at', null)); }
};

// ---------- 거래 기록: 직접 추가 · 숨김(무효 기록을 쌓아서 지움, 원래 기록은 남음)
export async function addTrade(row){
  if (!online()) throw new Error('로그인한 뒤에 기록할 수 있어요.');
  const r = await q(() => db.client.from('q_trades').insert(row).select('*'));
  return r && r[0];
}

// ---------- 종목 위키 메모 (쌓기만 함)
const NOTES_KEY = 'quantera:notes';
export async function loadNotes(symbol){
  const local = (LS.get(NOTES_KEY, {})[symbol] || []);
  if (!online()) return local;
  try { return await q(() => db.client.from('q_instrument_notes').select('id,body,created_at').eq('symbol', symbol).order('created_at', { ascending: false }).limit(200)); }
  catch(e){ return local; }
}
export async function addNote(symbol, body){
  const row = { body, created_at: new Date().toISOString() };
  if (online()){
    try { await q(() => db.client.from('q_instrument_notes').insert({ symbol, body })); return true; }
    catch(e){ console.warn('메모 저장 실패', e.message); }
  }
  const all = LS.get(NOTES_KEY, {}); all[symbol] = [row, ...(all[symbol] || [])].slice(0, 200); LS.set(NOTES_KEY, all);
  return true;
}
