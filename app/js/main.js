// QUANTERA — 앱 진입점. 상태 → 렌더. 거래소는 어댑터로만 접근합니다.
import { CONFIG } from './config.js';
import { $, $$, esc, fmtPrice, fmtPct, fmtKrwShort, toneOf, LS, utcDay } from './util.js';
import * as upbit from './adapters/upbit.js';
import { analyzeOne, scanAll, loadDaily } from './analysis/scan.js';
import { stratCfg, saveStratCfg, strategyTrades, summarizeTrades } from './analysis/strategy.js';
import { STAGE_KO } from './analysis/trend.js';
import { screenCfg, saveScreenCfg, SCREEN_DEFAULTS, summarize, summarizeBottom } from './analysis/screen.js';
import { computeLedger, pastBuys } from './analysis/ledger.js';
import { createSurge, SURGE_DEFAULTS, agoKo } from './analysis/surge.js';
import { loadNews, newsFor, newsHtml } from './news.js';
import { createChart } from './ui/chart.js';
import { initTips, BAR_TIPS } from './ui/tips.js';
import { initLayout, apply as applyLayout } from './ui/layout.js';
import { db, initDb, login, logout, loadWatchlist, setWatch, loadTrades, lastTradeId, loadBalances, importTrades, loadNotes, addNote, localLayout, saveLayout, remoteLayout, paperRemote, resetPrefsCache, uiRemote, upbitLinks, addTrade } from './db.js';
import { createPaper } from './paper.js';
import { importMeta, toRow } from './upbitPrivate.js';
import { FEE_RATE } from './analysis/ledger.js';

const STATUS_KO = { 'WAIT': '대기', 'WATCH': '관찰', 'ENTRY ZONE': '매수 검토', 'BREAKOUT WATCH': '돌파 대기', 'EXTENDED': '추격 주의', 'INSUFFICIENT DATA': '데이터 부족' };
const RISK_KO = { 'LOW': '낮음', 'MEDIUM': '보통', 'HIGH': '높음', 'EXTREME': '매우 높음' };

// 화면 설정: 모의투자 사용, 거래일지 그래프 기간. 로그인하면 계정(prefs.ui)에 저장해 PC·폰이 같게
const UI_KEY = 'quantera:ui';
let UI = { paperOn: false, sparkDays: 30, ...(LS.get(UI_KEY, {}) || {}) };
const S = {
  instruments: [], byMarket: new Map(), quotes: new Map(), results: new Map(),
  watch: new Set(), trades: [], ledger: { rows: [], positions: [], rebuy: [] },
  tab: 'fav', sdTab: LS.get('quantera:sdTab', 'surge'), search: '', sel: null, tf: '1d', stream: null, scanning: null,
  firstSeen: LS.get('quantera:firstSeen', null),
  acct: UI.paperOn ? LS.get('quantera:acct', 'paper') : 'real',
  ledgerReal: { rows: [], positions: [], rebuy: [] }, ledgerPaper: { rows: [], positions: [], rebuy: [] }
};
// 최근 본 종목: 종목을 열 때마다 기록 (최신 순, 100개까지, 이 기기에 저장)
const RECENT_KEY = 'quantera:recent';
let recent = LS.get(RECENT_KEY, []) || [];
function addRecent(m){
  const q = S.quotes.get(m);
  recent = [{ m, at: Date.now(), price: q ? q.price : null }, ...recent.filter(x => x.m !== m)].slice(0, 100);
  LS.set(RECENT_KEY, recent);
}
if (!LS.get('quantera:mig1', false)){ const c = screenCfg(); if (c.surgeRepeat === 5){ c.surgeRepeat = 15; saveScreenCfg(c); } LS.set('quantera:mig1', true); }
const allCfg = () => ({ ...SURGE_DEFAULTS, ...screenCfg() });
const surge = createSurge(allCfg);
const priceOf = sym => { const q = S.quotes.get(upbit.toMarket(sym)); return q ? q.price : null; };
const paper = createPaper({ priceOf, remote: paperRemote });

// ---------------------------------------------------------------- 시작
let chart;
async function boot(){
  initLayout(localLayout(), saveLayout);
  document.body.classList.toggle('no-paper', !UI.paperOn);
  initTips();
  bindUi();
  await waitFor(() => window.LightweightCharts, 8000);
  chart = createChart($('#tv'), $('#legend'), $('#ohlc'));
  renderTf();

  initDb().catch(() => {});
  db.events.on('auth', onAuth);
  // 다른 기기에서 한 모의 거래를 앱으로 돌아올 때 맞춤
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !db.user) return;
    resetPrefsCache(); reloadTrades();
    const pr = await paperRemote.load(); if (!pr) return;
    paper.merge(pr.state, pr.trades); recompute(); renderStatus(); renderOrderForm(); if (isOrdersOpen()) renderOrders(); renderJournal();
  });
  db.events.on('tables', ok => { $('#sbDbDot').className = 'dot ' + (ok ? 'live' : 'wait'); $('#sbDb').textContent = ok ? '기록 저장소 연결' : '기록 테이블 준비 전 · 이 기기에만 저장'; });

  try{
    S.instruments = await upbit.listInstruments();
    S.byMarket = new Map(S.instruments.map(i => [i.market, i]));
    markFirstSeen();
    const qs = await upbit.getQuotes();
    for (const q of qs) S.quotes.set(q.market, q);
  }catch(e){
    $('#wlBody').innerHTML = `<div class="empty">업비트 시세를 불러오지 못했어요. (${esc(e.message)})<br>잠시 후 새로고침해 주세요.</div>`;
    setWs('off'); return;
  }
  S.watch = new Set(await loadWatchlist());
  recompute(); renderWatch();
  select(LS.get('quantera:sel', 'KRW-BTC'), { noRecent: true });
  S.stream = upbit.stream(S.instruments.map(i => i.market), {
    ticker: onTick, orderbook: renderOrderbook, trade: onTrade, status: setWs
  });
  S.stream.focus(S.sel);   // 처음 연 종목도 호가·체결 실시간 구독 (전에는 다른 종목을 눌러야 구독됐음)
  // 모의투자: 앱이 꺼져 있던 동안 지정가·예약 매도가 닿았는지 캔들로 확인
  paper.catchUp(upbit.getCandles, upbit.toMarket).then(n => { if (n) toast(`앱이 꺼져 있던 동안 모의 주문 ${n}건이 체결됐어요. 거래일지에서 확인하세요.`, 'warn'); });
  // 관심·보유 종목은 열자마자 분석(캐시라 같은 날 재요청 없음)
  analyzeList([...S.watch].map(upbit.toMarket)).then(() => { $('#scanBtn').textContent = '다시 스캔'; autoScan(true); });
  renderNews();
  setInterval(() => $('#sbReq').textContent = `요청 ${upbit.netStats().requests}회`, 2000);
}
const waitFor = (fn, ms) => new Promise(res => { const t0 = Date.now(); const k = () => fn() || Date.now() - t0 > ms ? res() : setTimeout(k, 50); k(); });

// 신규 상장 감지: 이 기기에서 처음 본 날 기록. 첫 실행은 기준선만 저장.
function markFirstSeen(){
  const today = new Date().toISOString().slice(0, 10);
  if (!S.firstSeen){ S.firstSeen = { base: today, m: {} }; for (const i of S.instruments) S.firstSeen.m[i.market] = 'base'; }
  for (const i of S.instruments) if (!S.firstSeen.m[i.market]) S.firstSeen.m[i.market] = today;
  LS.set('quantera:firstSeen', S.firstSeen);
}
const isNewListing = m => { const r = S.results.get(m); if (r && r.isNew) return true; const d = S.firstSeen && S.firstSeen.m[m]; return d && d !== 'base' && (Date.now() - Date.parse(d)) < 30 * 86400000; };

async function onAuth(user){
  $('#loginBtn').textContent = user ? '로그아웃' : '로그인';
  if (!user){ $('#sbDbDot').className = 'dot'; $('#sbDb').textContent = '로그인 전 · 이 기기에만 저장'; renderJournal(); return; }
  const lay = await remoteLayout(); if (lay) applyLayout(lay);
  S.watch = new Set(await loadWatchlist());
  S.trades = await loadTrades();
  resetPrefsCache();
  const ui = await uiRemote.load(); if (ui) setUi(ui, { noSave: true });
  const pr = await paperRemote.load(); if (pr) paper.merge(pr.state, pr.trades);
  recompute(); renderWatch(); analyzeList([...S.watch, ...S.ledger.positions.map(p => p.symbol)].map(upbit.toMarket));
  loadBal();
}

// ---------------------------------------------------------------- 실시간
let rafPending = false;
function onTick(q){
  S.quotes.set(q.market, q);
  surge.push(q); dump.push(q);
  paper.tick(upbit.toSymbol(q.market), q.price);
  if (S.sel === q.market){ chart && chart.tick(q.price, q.ts || Date.now()); renderHead(); }
  if (!rafPending){ rafPending = true; setTimeout(() => { rafPending = false; patchWatchPrices(); }, 1000); }
}
// 현재가가 움직여 판단(매수 구간 / 추격 주의 / 지지 이탈)이 바뀌면 목록·분석을 다시 그림
let lastSelStance = null, lastEntryKey = '';
setInterval(() => {
  if (!S.sel) return;
  const st = live(S.sel).stance;
  if (st !== lastSelStance){ lastSelStance = st; if (S.results.has(S.sel)){ renderInspector(); renderOrderForm(); } }
  if ((S.tab === 'pullback' || S.tab === 'bottom') && !S.search){ const key = listFor(S.tab).map(i => i.market).join(); if (key !== lastEntryKey){ lastEntryKey = key; renderWatch(); } }
}, 5000);
// ---------------------------------------------------------------- 급등 감지 + 알람
// 1초마다 검사. 새로 잡히면 소리 + 위쪽 알림. 확인(종목 클릭 또는 '모두 확인') 전까지 계속 울리고 목록에서 깜빡임.
const unseen = new Set(), unseenDump = new Set();
const dump = createSurge(allCfg, -1);
// 알림 잠시 끄기(급등·급락 같이): 감지·목록·적중률 기록은 계속, 소리·팝업·바탕화면 알림만 멈춤
const MUTE_KEY = 'quantera:surgeMute';
const muteUntil = () => { const v = LS.get(MUTE_KEY, 0) || 0; if (v > 0 && v < Date.now()){ LS.set(MUTE_KEY, 0); return 0; } return v; };   // -1 = 직접 켤 때까지
const surgeMuted = () => muteUntil() !== 0;
function setSurgeMute(min){
  LS.set(MUTE_KEY, min === 0 ? 0 : min < 0 ? -1 : Date.now() + min * 60000);
  if (min !== 0){ unseen.clear(); unseenDump.clear(); }
  renderSurgeBar(); renderMuteBtns(); renderSdDrop(true);
  toast(min === 0 ? '급등·급락 알림을 다시 켰어요.' : min < 0 ? '급등·급락 알림을 껐어요. 감지와 목록은 계속돼요.' : `급등·급락 알림을 ${min >= 60 ? min / 60 + '시간' : min + '분'} 동안 껐어요.`);
}
function muteText(){
  const v = muteUntil(); if (!v) return '';
  if (v < 0) return '꺼짐';
  const d = new Date(v); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}까지 꺼짐`;
}
function muteCtlHtml(){
  const m = surgeMuted();
  return `<div class="mute-ctl"><span class="${m ? 'muted' : 'accent'}">● 알림 ${m ? muteText() : '켜짐'}</span><span class="grow"></span>${m
    ? '<button class="pill sm" data-mute="0">다시 켜기</button>'
    : '<button class="pill sm" data-mute="30">30분 끄기</button><button class="pill sm" data-mute="60">1시간</button><button class="pill sm" data-mute="-1">끄기</button>'}</div>`;
}
function renderMuteBtns(){
  const c = $('.mute-ctl'); if (c) c.outerHTML = muteCtlHtml();
}
// 소리만 켜고 끄기 (위쪽 🔊 버튼). 감지·팝업은 그대로
const SOUND_KEY = 'quantera:soundOff';
const soundOff = () => !!LS.get(SOUND_KEY, false);
function renderSoundBtn(){
  for (const b of $$('[data-sound]')){ const off = soundOff(); b.classList.toggle('off', off); b.innerHTML = off ? SVG_SOUND_OFF : SVG_SOUND_ON; b.title = off ? '알람 소리 꺼짐 · 눌러서 켜기' : '알람 소리 켜짐 · 눌러서 끄기'; b.setAttribute('aria-label', b.title); }
}
const SVG_SOUND_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 010 6M18.5 6.5a7.5 7.5 0 010 11"/></svg>';
const SVG_SOUND_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>';
let lastSurgeKey = '', lastBeep = 0, audioCtx = null;
const getAudio = () => { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch(e){} return audioCtx; };
addEventListener('pointerdown', getAudio, { once: true });   // 브라우저는 한 번 클릭한 뒤에야 소리를 허용
// 차분한 종소리: 사인파 두 음 + 은은한 여운. 급등 = 올라가는 "딩-동", 급락 = 내려가는 "동-딩", 체결 = 한 음
function beep(kind = 'up', force = false){
  if (soundOff() && !force) return;
  const c = getAudio(); if (!c) return;
  const vol = Math.max(0, Math.min(100, +allCfg().alarmVol || 0)) / 100 * 0.18;
  if (!vol) return;
  const notes = kind === 'down' ? [[0, 784], [0.28, 523]] : kind === 'one' ? [[0, 659]] : [[0, 523], [0.28, 784]];
  const t = c.currentTime;
  for (const [d, f] of notes) for (const [mul, g0] of [[1, 1], [2, 0.18]]){   // 기본음 + 약한 배음 = 종소리 느낌
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.value = f * mul;
    g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(vol * g0, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 1.1);
    o.connect(g).connect(c.destination); o.start(t + d); o.stop(t + d + 1.15);
  }
}
function notifySurge(ms, isDump){
  if (surgeMuted() || !('Notification' in window) || Notification.permission !== 'granted') return;
  const names = ms.map(m => (S.byMarket.get(m) || {}).name || m);
  try { new Notification(isDump ? '급락 감지' : '급등 감지', { body: names.join(', ') + (isDump ? ' — 갑자기 매도가 몰리며 내리고 있어요' : ' — 갑자기 거래가 몰리고 있어요'), tag: isDump ? 'quantera-dump' : 'quantera-surge', renotify: true, icon: './icons/icon-192.png' }); } catch(e){}
}
function ackSurge(m){
  if (m){ unseen.delete(m); unseenDump.delete(m); } else { unseen.clear(); unseenDump.clear(); }
  for (const row of $$('.wl-row.blink', $('#wlBody'))) if (!unseen.has(row.dataset.m) && !unseenDump.has(row.dataset.m)) row.classList.remove('blink');
  renderSurgeBar(); renderSdDrop(true);
}
// 위쪽 검색 옆 고정 칩: [● 급등 N 이름 외] [● 급락 N] + 확인 · 30분 끄기. 누르면 아래로 목록
const sdNm = m => (S.byMarket.get(m) || {}).name || m;
const sdList = kind => { const src = kind === 'dump' ? dump : surge; return [...src.events.keys()].sort((a, b) => src.get(b).at - src.get(a).at); };
function ackKind(kind){ (kind === 'dump' ? unseenDump : unseen).clear(); for (const row of $$('.wl-row.blink', $('#wlBody'))) if (!unseen.has(row.dataset.m) && !unseenDump.has(row.dataset.m)) row.classList.remove('blink'); renderSurgeBar(); renderSdDrop(true); }
function renderSurgeBar(){
  const box = $('#sdChips'); if (!box) return;
  const muted = surgeMuted();
  const chip = (kind, label, cls, fresh) => {
    const ms = sdList(kind), n = ms.length;
    return `<button class="sd-chip ${cls}${n ? ' has' : ''}${fresh ? ' new' : ''}${S.sdTab === kind ? ' open' : ''}" data-sd="${kind}" title="${label} 목록 보기"><span class="dot-live"></span>${label} ${n}${n ? `<span class="sd-nm">${esc(sdNm(ms[0]))}${n > 1 ? ' 외' : ''}</span>` : ''}</button>`;
  };
  const up = muted ? 0 : [...unseen].filter(m => surge.events.has(m)).length;
  const dn = muted ? 0 : [...unseenDump].filter(m => dump.events.has(m)).length;
  box.innerHTML = chip('surge', '급등', 'up', up) + chip('dump', '급락', 'dn', dn)
    + `<button class="pill sm" data-surge-ack${up || dn ? '' : ' disabled'}>확인</button>`
    + (muted ? `<button class="pill sm on-warn" data-mute="0" title="${muteText()}">알림 켜기</button>` : `<button class="pill sm" data-mute="30" title="30분 동안 소리·팝업 끄기 (감지·목록은 계속)">30분 끄기</button>`);
  renderSdDrop();
}
// 종목 목록 아래 급등 · 급락 칸 (탭 2개). 위쪽 칩을 누르면 이 칸의 해당 탭으로
let sdKey = '';
function renderSdDrop(force){
  const d = $('#sdDock'); if (!d) return;
  const key = sdList('surge').join() + '|' + sdList('dump').join() + surgeMuted() + [...unseen].join() + [...unseenDump].join() + surge.log().length + '|' + surge.tracking.size;
  if (!force && key === sdKey){
    for (const el of $$('[data-ago]', d)){ const src = el.dataset.k === 'dump' ? dump : surge, e = src.get(el.dataset.ago); if (e) el.textContent = surgeText(el.dataset.ago, e); }
    for (const el of $$('[data-px]', d)){ const q = S.quotes.get(el.dataset.px) || {}; el.className = `mono sd-px ${toneOf(q.changeRate)}`; el.innerHTML = `${fmtPrice(q.price)}<br>${fmtPct(q.changeRate)}`; }
    return;
  }
  sdKey = key;
  const sec = (kind, label, cls) => {
    const src = kind === 'dump' ? dump : surge, ms = sdList(kind), un = kind === 'dump' ? unseenDump : unseen;
    const rows = ms.map(m => { const q = S.quotes.get(m) || {}, e = src.get(m);
      return `<button class="sd-row${un.has(m) ? (kind === 'dump' ? ' blink-dn' : ' blink') : ''}" data-sdm="${m}"><span class="sd-l"><span class="sd-n">${esc(sdNm(m))}</span><span class="muted" data-k="${kind}" data-ago="${m}">${surgeText(m, e)}</span></span><span class="mono sd-px ${toneOf(q.changeRate)}" data-px="${m}">${fmtPrice(q.price)}<br>${fmtPct(q.changeRate)}</span></button>`; }).join('');
    const nNew = surgeMuted() ? 0 : ms.filter(m => un.has(m)).length;
    const mute = surgeMuted() ? `<button class="pill sm on-warn" data-mute="0" title="${muteText()}">알림 켜기</button>` : `<button class="pill sm" data-mute="30" title="30분 동안 급등·급락 소리·팝업 끄기 (감지·목록은 계속)">30분 끄기</button>`;
    return `<section class="sd-sec k-${cls}" id="sdSec-${kind}"><div class="sd-dhead${nNew ? (kind === 'dump' ? ' blink-dn' : ' blink') : ''}"><span class="sd-ttl ${ms.length ? cls : 'muted'}">● ${label} ${ms.length}${nNew ? ` <span class="sd-new">새 ${nNew}</span>` : ''}</span><span class="grow"></span><button class="pill sm" data-ack-kind="${kind}"${nNew ? '' : ' disabled'}>확인</button>${mute}</div>
      <div class="sd-dbody">${rows || `<div class="empty">지금 잡힌 ${label}이 없어요.</div>`}${kind === 'surge' ? surgeStatsHtml() : ''}</div></section>`;
  };
  d.innerHTML = sec('surge', '급등', 'up') + sec('dump', '급락', 'down');
}
function toggleSd(kind){
  S.sdTab = kind; LS.set('quantera:sdTab', kind);
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  if (isPhone()){ document.body.classList.remove('m-search'); setMobile('list'); }
  if (document.body.dataset.view) setView('trade');
  const p = $('#pSurge'); if (p && !isPhone() && p.classList.contains('collapsed')) { const c = $('[data-collapse="surge"]'); if (c) c.click(); }
  renderSurgeBar(); renderSdDrop(true);
  const d = $('#sdSec-' + kind); if (d){ d.classList.remove('flash'); void d.offsetWidth; d.classList.add('flash'); }
}
setInterval(() => {
  const fresh = surge.check(S.quotes), freshDn = dump.check(S.quotes), cfg = allCfg();
  const wasMuted = surgeMuted.last; surgeMuted.last = surgeMuted();
  if (wasMuted && !surgeMuted.last) renderMuteBtns();   // 끈 시간이 끝나면 다시 켜짐 표시
  if (!surgeMuted.last){ for (const m of fresh) unseen.add(m); for (const m of freshDn) unseenDump.add(m); }
  for (const m of [...unseen]) if (!surge.events.has(m)) unseen.delete(m);
  for (const m of [...unseenDump]) if (!dump.events.has(m)) unseenDump.delete(m);
  if (fresh.length) notifySurge(fresh, false);
  if (freshDn.length) notifySurge(freshDn, true);
  if (fresh.length || freshDn.length) renderSurgeBar();
  // 새로 잡히면 바로 한 번, 확인 전까지는 반복 간격마다
  const ring = !surgeMuted.last && cfg.surgeAlarm && (unseen.size || unseenDump.size);
  if (ring && (fresh.length || freshDn.length || Date.now() - lastBeep >= cfg.surgeRepeat * 1000)){ lastBeep = Date.now(); beep(freshDn.length && !fresh.length || (!unseen.size && unseenDump.size) ? 'down' : 'up'); }
  const key = [...surge.events.keys(), '|', ...dump.events.keys()].join() + '|' + surge.log().length + '|' + surge.tracking.size;
  if (fresh.length || freshDn.length || key !== lastSurgeKey) renderSurgeBadges();
  if (key !== lastSurgeKey) renderSurgeBar();
  lastSurgeKey = key;
  renderSdDrop();
}, 1000);
function surgeText(m, e){
  const q = S.quotes.get(m) || {}, since = q.price && e.pAt ? (q.price / e.pAt - 1) * 100 : 0;
  return `${agoKo(Date.now() - e.at)} · ${allCfg().surgeSec}초 ${fmtPct(e.pct)} · 거래 ${e.ratio.toFixed(1)}배 · 이후 ${fmtPct(since)}`;
}
// 급등 탭 위 적중률 표: 잡힌 순간 샀다면 익절/손절 중 어디에 먼저 닿았는지
function surgeStatsHtml(){
  const st = surge.stats(), n = surge.log().length, live = surge.tracking.size;
  const rows = st.length ? st.map(s => `<tr><td>+${s.tp} / -${s.sl}</td><td>${s.n}</td><td class="${s.winRate >= s.need ? 'up' : ''}">${s.winRate.toFixed(0)}%</td><td class="muted">${s.need.toFixed(0)}%</td><td class="${toneOf(s.exp)}">${fmtPct(s.exp)}</td></tr>`).join('')
    : `<tr><td colspan="5" class="muted">아직 끝난 기록이 없어요. 잡힌 급등이 익절·손절에 닿거나 ${allCfg().surgeTimeoutMin}분이 지나면 쌓여요.</td></tr>`;
  return `<details class="surge-stats"${LS.get('quantera:surgeStatsOpen', true) ? ' open' : ''}><summary>적중률 기록 <span class="muted">${n}건 완료${live ? ` · ${live}건 추적 중` : ''}</span></summary>
    <table><thead><tr><th>익절/손절</th><th>건수</th><th>적중</th><th>본전</th><th>1건 평균</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="muted small">잡힌 순간 가격에 샀다고 치고 계산 · 수수료 ${allCfg().surgeFeePct}% 반영 · 손절이 먼저 닿은 걸로 보수적으로 봄 · "본전"보다 적중이 높아야 남아요 · 이 기기에 저장</div></details>`;
}
function bottomTabHtml(){
  const x = gstats().bt2;
  return bottomTradeHtml(x, '바닥 거래 검증', x.coins ? `분석한 ${x.coins}종목 · 최근 ${x.span}일` : '아래 "전체 스캔"을 하면 모든 코인의 과거 바닥 신호로 계산해요.');
}
function recentText(m){
  const x = recent.find(r => r.m === m); if (!x) return '';
  const q = S.quotes.get(m) || {}, chg = x.price && q.price ? (q.price / x.price - 1) * 100 : null;
  const when = new Date(x.at), today = new Date().toDateString() === when.toDateString();
  const t = today ? agoKo(Date.now() - x.at) : `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  return `${t} 봄${x.price ? ` · 그때 ${fmtPrice(x.price)}` : ''}${chg != null ? ` → 지금 <span class="${toneOf(chg)}">${fmtPct(chg)}</span>` : ''}`;
}
function renderSurgeBadges(){
  for (const row of $$('.wl-row', $('#wlBody'))){
    for (const [src, cls, lab] of [[surge, 'surge', '급등'], [dump, 'dump', '급락']]){
      const has = src.events.has(row.dataset.m), b = $('.badge.' + cls, row);
      if (has && !b) $('.wl-name', row).insertAdjacentHTML('beforeend', `<span class="badge ${cls}">${lab}</span>`);
      else if (!has && b) b.remove();
    }
  }
}
function setWs(s){
  const map = { live: ['live', '실시간'], connecting: ['wait', '연결 중'], reconnecting: ['wait', '재연결 중'], off: ['off', '끊김'] };
  const [c, t] = map[s] || map.off; $('#wsDot').className = 'dot ' + c; $('#wsText').textContent = t;
}

// ---------------------------------------------------------------- 현재가 기준 판단 (매수 검토 v2)
// 신호는 어제 확정 일봉으로 찾고(눌림 매수 / 바닥 반등), 현재가로 한 번 더 거릅니다.
// stance: buy_zone(매수 검토) · chase(고점·급등, 추격 주의) · broken(손절선 아래) · blocked(거래정지·유의·거래대금 부족)
//         failed(과거 검증에서 손해) · watch(신호 없음) · avoid(하락 추세) · none(분석 전)
const TYPE_KO = { pullback: '눌림 매수', bottom: '바닥 반등' };
function globalStats(){
  // 지금까지 분석한 모든 종목의 과거 신호 결과를 합침 (전체 스캔을 하면 표본이 커짐)
  const all = { pullback: [], bottom: [] };
  for (const r of S.results.values()) if (r.scr) for (const k of ['pullback', 'bottom']) all[k].push(...r.scr.bt[k]);
  const bt2 = []; let span = 0, coins = 0;
  for (const r of S.results.values()) if (r.scr && r.scr.bt2){ bt2.push(...r.scr.bt2.trades); span = Math.max(span, r.scr.bt2.days); coins++; }
  return { pullback: summarize(all.pullback), bottom: summarize(all.bottom), bt2: { ...summarizeBottom(bt2, span), coins, span } };
}
// 바닥 거래(+N% 익절, 손절 없음) 검증 표
function bottomTradeHtml(x, title, note){
  const cfg = screenCfg();
  if (!x || !x.n) return `<details class="surge-stats" open><summary>${title}</summary><div class="muted small" style="margin-top:6px">${note || '아직 과거 바닥 신호가 없어요.'}</div></details>`;
  const kv = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  return `<details class="surge-stats"${LS.get('quantera:btStatsOpen', true) ? ' open' : ''} data-bt><summary>${title} <span class="muted">${x.n}건${x.perMonth != null ? ` · 월 ${x.perMonth.toFixed(1)}회` : ''}</span></summary>
    <table class="kv2"><tbody>
      ${kv(`+${cfg.btTp}% 도달`, `<b class="${x.hit >= 80 ? 'up' : ''}">${x.done}/${x.n} (${x.hit.toFixed(0)}%)</b> · 보통 ${x.medDays ?? '-'}일${x.slow ? ` · 30일 넘게 걸린 것 ${x.slow}건` : ''}`)}
      ${kv('기다리는 동안 하락', `평균 <span class="down">${fmtPct(x.avgDd)}</span> · 최악 <span class="down">${fmtPct(x.worstDd)}</span> · -10% 넘게 빠진 것 ${x.deep}건`)}
      ${kv('아직 물려 있음', x.open ? `<b class="warn">${x.open}건</b> · 지금 평균 <span class="${toneOf(x.openAvg)}">${fmtPct(x.openAvg)}</span> · 가장 오래 ${x.openMaxDays}일` : '<span class="muted">없음</span>')}
      ${kv('끝난 거래 수익 합', `<span class="${toneOf(x.profit)}">${fmtPct(x.profit)}</span> <span class="muted">(1건당 같은 금액 기준)</span>`)}
    </tbody></table>
    <div class="muted small">바닥 신호일 종가에 사고 +${cfg.btTp}%에 팖 · 손절 없음 · 한 코인에 한 번에 하나 · 수수료 ${cfg.feePct}% 반영 · 일봉 기준${note ? ' · ' + note : ''}</div></details>`;
}
let GS = { pullback: { n: 0 }, bottom: { n: 0 } }, gsDirty = true;
const gstats = () => { if (gsDirty){ GS = globalStats(); gsDirty = false; } return GS; };
function live(market){
  const r = S.results.get(market), q = S.quotes.get(market) || {};
  if (!r || !r.scr) return { stance: 'none' };
  const cfg = screenCfg(), { block, sig } = r.scr;
  const blk = block.filter(x => x !== '거래정지');
  if (q.suspended || !S.quotes.has(market)) blk.unshift('거래정지'); // 거래정지는 실시간 상태로 판단
  if (blk.length) return { stance: 'blocked', text: `매수 검토 제외 — ${blk.join(', ')}` };
  if (sig.excluded) return { stance: 'chase', text: `고점 구간이라 제외 — ${sig.excluded.join(', ')}` };
  if (!sig.type) return { stance: r.stage === 'DOWN' ? 'avoid' : 'watch' };
  const p = q.price, dayPct = q.changeRate || 0;
  if (p && p < sig.stop) return { stance: 'broken', sig, text: `손절 기준 ${fmtPrice(sig.stop)} 아래로 내려왔어요. 신호가 깨졌으니 관망해요.` };
  if (dayPct > cfg.maxRiseToday) return { stance: 'chase', sig, text: `오늘 ${fmtPct(dayPct, 1)} 급등했어요. 추격하지 말고 다시 눌릴 때를 기다려요.` };
  if (p && p > sig.entryHi * 1.015) return { stance: 'chase', sig, text: `매수 구간 위(${fmtPct((p / sig.entryHi - 1) * 100, 1)})로 올라갔어요. 다시 눌릴 때를 기다려요.` };
  const g = gstats()[sig.type];
  if (g.n >= cfg.minSamples && g.exp <= 0) return { stance: 'failed', sig, text: `${TYPE_KO[sig.type]} 신호가 과거 ${g.n}번 평균 ${fmtPct(g.exp, 2)}로 손해라 제외했어요.` };
  return { stance: 'buy_zone', sig, type: sig.type };
}
function setResult(m, r){ S.results.set(m, r); gsDirty = true; }
// 화면에 쓰는 매매 가이드: 매수 신호가 있을 때만 (고점 구간·제외 종목엔 없음)
function effGuide(market){
  const L = live(market);
  if (!L.sig || L.stance === 'blocked') return null;
  const s = L.sig, pct = v => (v / s.ref - 1) * 100;
  return { stance: L.stance === 'buy_zone' ? 'buy_zone' : 'watch', buyLo: s.entryLo, buyHi: s.entryHi, sell1: s.t1, sell2: s.t2, stop: s.stop, ref: s.ref,
    sell1Pct: pct(s.t1), sell2Pct: pct(s.t2), stopPct: pct(s.stop), rr: (s.t1 - s.ref) / (s.ref - s.stop) };
}
const isPick = (m, type) => { const L = live(m); return L.stance === 'buy_zone' && (!type || L.type === type); };

// ---------------------------------------------------------------- 관심 목록
function listFor(tab){
  let list = S.instruments;
  const held = new Set(S.ledger.positions.map(p => upbit.toMarket(p.symbol)));
  if (tab === 'fav') list = list.filter(i => S.watch.has(i.symbol));
  else if (tab === 'hold') list = list.filter(i => held.has(i.market));
  else if (tab === 'pullback' || tab === 'bottom') list = list.filter(i => isPick(i.market, tab));
  else if (tab === 'new') list = list.filter(i => isNewListing(i.market));
  else if (tab === 'recent' && !S.search) return recent.map(x => S.byMarket.get(x.m)).filter(Boolean);
  else if (tab === 'rebuy'){ const rb = new Set(S.ledger.rebuy.map(r => upbit.toMarket(r.symbol))); list = list.filter(i => rb.has(i.market)); }
  if (S.search){ const s = S.search.toLowerCase(); list = S.instruments.filter(i => i.name.toLowerCase().includes(s) || i.market.toLowerCase().includes(s) || (i.nameEn || '').toLowerCase().includes(s)); }
  const val = i => (S.quotes.get(i.market) || {}).value24h || 0;
  return list.slice().sort((a, b) => val(b) - val(a));
}
function renderWatch(){
  const list = listFor(S.tab);
  $('#wlCount').textContent = list.length;
  const rebuy = new Set(S.ledger.rebuy.map(r => upbit.toMarket(r.symbol)));
  if (!list.length){
    const msg = { fav: '관심 종목이 없어요. 전체 탭에서 ☆를 눌러 추가하세요.', hold: '보유 종목이 없어요. 로그인하면 기존 보유 종목이 기초 이월로 보여요.', pullback: '지금 조건에 맞는 눌림 매수 종목이 없어요. 아래 "전체 스캔"을 하면 모든 종목에서 찾아요.', bottom: '지금 조건에 맞는 바닥 반등 종목이 없어요. 아래 "전체 스캔"을 하면 모든 종목에서 찾아요.', new: '최근 30일 안에 새로 상장된 종목이 없어요.', recent: '아직 본 종목이 없어요. 종목을 열면 여기에 본 순서대로 남아요.', dump: `지금 갑자기 매도가 몰리며 내린 코인이 없어요. 급등과 같은 기준(최근 ${allCfg().surgeSec}초 거래대금 ${allCfg().surgeVol}배 이상)에 가격이 ${Math.max(allCfg().surgePct, 0.5)}% 이상 내리면 잡혀요.${allCfg().dumpOn ? '' : ' (지금 설정에서 급락 감지가 꺼져 있어요)'}`, surge: `지금 갑자기 거래가 몰린 코인이 없어요. 앱이 켜져 있는 동안 1초마다 검사해요. (최근 ${allCfg().surgeSec}초 거래대금이 평소의 ${allCfg().surgeVol}배 이상)`, rebuy: '재매수 후보가 없어요. 이익을 내고 판 종목이 그때 매수가보다 싸지면 여기에 떠요.' };
    $('#wlBody').innerHTML = (S.tab === 'bottom' && !S.search ? bottomTabHtml() : '') + `<div class="empty">${S.search ? '검색 결과가 없어요.' : msg[S.tab] || ''}</div>`; return;
  }
  if (document.body.dataset.view === 'scan' && !isPhone()){ $('#wlBody').innerHTML = (S.tab === 'bottom' && !S.search ? bottomTabHtml() : '') + scanTableHtml(list); return; }
  $('#wlBody').innerHTML = (S.tab === 'bottom' && !S.search ? bottomTabHtml() : '') + list.slice(0, 300).map(i => {
    const q = S.quotes.get(i.market) || {}, r = S.results.get(i.market);
    const L = live(i.market);
    const bar = L.stance === 'buy_zone' ? 'entry' : ['chase', 'broken', 'failed'].includes(L.stance) ? 'warn' : '';
    const sv = surge.get(i.market), dv = dump.get(i.market);
    const badges = [sv ? '<span class="badge surge">급등</span>' : '', dv ? '<span class="badge dump">급락</span>' : '', L.stance === 'buy_zone' ? `<span class="badge accent">${TYPE_KO[L.type]}</span>` : '', rebuy.has(i.market) ? '<span class="badge accent">재매수</span>' : '', isNewListing(i.market) ? '<span class="badge warn">신규</span>' : '',
      q.suspended ? '<span class="badge warn">거래정지</span>' : '', i.warning ? '<span class="badge warn">유의</span>' : '', (i.caution || []).length ? '<span class="badge line">주의</span>' : ''].join('');
    return `<div class="wl-row${S.sel === i.market ? ' sel' : ''}" data-m="${i.market}">
      <span class="bar ${bar}" data-tip="${BAR_TIPS[bar]}"></span>
      <div style="min-width:0">
        <div class="wl-name"><button class="star${S.watch.has(i.symbol) ? ' on' : ''}" data-star="${i.symbol}" aria-label="관심">${S.watch.has(i.symbol) ? '★' : '☆'}</button><b>${esc(i.name)}</b>${badges}</div>
        <div class="wl-peter">${S.tab === 'recent' && !S.search ? recentText(i.market) : r && L.stance !== 'blocked' ? esc(L.text || r.peter) :`<span class="mono">${i.market}</span> · ${fmtKrwShort(q.value24h)}`}</div>
      </div>
      <div class="wl-px mono"><div class="p ${toneOf(q.changeRate)}" data-px="${i.market}">${fmtPrice(q.price)}</div><div class="c ${toneOf(q.changeRate)}" data-cr="${i.market}">${fmtPct(q.changeRate)}</div></div>
    </div>`;
  }).join('');
}
// 스캐너 화면(PC 전체 화면): 한 줄 = 한 종목, 칸별로 비교하기 쉽게 표로. 머리글을 누르면 정렬
const STANCE_KO = { buy_zone: '매수 검토', watch: '신호 없음', chase: '추격 주의', broken: '신호 깨짐', failed: '검증 탈락', blocked: '제외', avoid: '하락 추세', none: '분석 전' };
let scanSort = LS.get('quantera:scanSort', { k: 'value', d: -1 });
function scanTableHtml(list){
  const cfg = screenCfg();
  const rows = list.slice(0, 400).map(i => {
    const q = S.quotes.get(i.market) || {}, r = S.results.get(i.market), L = live(i.market), s = L.sig;
    const bt = r && r.scr ? r.scr.bt : null, g = s && bt ? summarize(bt[s.type] || []) : null;
    const b2 = r && r.scr && r.scr.bt2 && r.scr.bt2.trades.length ? summarizeBottom(r.scr.bt2.trades, r.scr.bt2.days) : null;
    const p = q.price;
    return { i, q, r, L, s, g, b2, price: q.price || 0, value: q.value24h || 0, chg: q.changeRate || 0, stance: ['buy_zone', 'watch', 'avoid', 'chase', 'broken', 'failed', 'blocked', 'none'].indexOf(L.stance),
      gap: s && p ? (p / s.entryHi - 1) * 100 : null, tp: s ? (s.t1 / s.ref - 1) * 100 : null, sl: s ? (s.stop / s.ref - 1) * 100 : null,
      win: g && g.n ? g.win : null, hit: b2 ? b2.hit : null };
  });
  const k = scanSort.k, d = scanSort.d;
  rows.sort((a, b) => { const x = a[k], y = b[k]; if (x == null && y == null) return b.value - a.value; if (x == null) return 1; if (y == null) return -1; return (x > y ? 1 : x < y ? -1 : 0) * d; });
  const th = (key, lab, cls = '') => `<th class="${cls}${k === key ? ' on' : ''}" data-ssort="${key}">${lab}${k === key ? (d > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  const watchSet = S.watch;
  return `<table class="ot scan-t"><thead><tr><th class="l">종목</th>${th('price', '현재가')}${th('chg', '등락')}${th('value', '거래대금')}${th('stance', '판단', 'l')}<th class="l">신호</th><th>매수 구간</th>${th('gap', '구간과 거리')}${th('tp', '1차 목표')}${th('sl', '손절')}${th('win', '과거 승률')}${th('hit', `바닥 +${cfg.btTp}% 도달`)}<th class="l">피터 한 줄</th></tr></thead><tbody>
    ${rows.map(x => { const { i, q, L, s, g, b2 } = x; const t = toneOf(q.changeRate);
      return `<tr class="sc-row${S.sel === i.market ? ' sel' : ''}" data-m="${i.market}">
        <td class="l"><button class="star${watchSet.has(i.symbol) ? ' on' : ''}" data-star="${i.symbol}" aria-label="관심">${watchSet.has(i.symbol) ? '★' : '☆'}</button><b>${esc(i.name)}</b> <span class="mono muted">${i.market.replace('KRW-', '')}</span>${isNewListing(i.market) ? ' <span class="badge warn">신규</span>' : ''}${i.warning ? ' <span class="badge warn">유의</span>' : ''}</td>
        <td class="mono p ${t}" data-px="${i.market}">${fmtPrice(q.price)}</td><td class="mono c ${t}">${fmtPct(q.changeRate)}</td>
        <td class="mono">${fmtKrwShort(q.value24h)}</td>
        <td class="l"><span class="st-${L.stance}">${STANCE_KO[L.stance] || ''}</span></td>
        <td class="l">${s ? TYPE_KO[s.type] : ''}</td>
        <td class="mono">${s ? `${fmtPrice(s.entryLo)} ~ ${fmtPrice(s.entryHi)}` : ''}</td>
        <td class="mono ${x.gap != null ? (x.gap > 1.5 ? 'warn' : 'muted') : ''}">${x.gap != null ? fmtPct(x.gap, 1) : ''}</td>
        <td class="mono up">${s ? fmtPrice(s.t1) + ` <span class="muted">${fmtPct(x.tp, 1)}</span>` : ''}</td>
        <td class="mono down">${s ? fmtPrice(s.stop) + ` <span class="muted">${fmtPct(x.sl, 1)}</span>` : ''}</td>
        <td class="mono">${g && g.n ? `${g.win.toFixed(0)}% <span class="muted">${g.n}번</span>` : ''}</td>
        <td class="mono">${b2 ? `${b2.hit.toFixed(0)}% <span class="muted">${b2.n}번${b2.medDays != null ? ' · ' + b2.medDays + '일' : ''}</span>` : ''}</td>
        <td class="l peter">${esc(L.text || (x.r ? x.r.peter : ''))}</td></tr>`; }).join('')}
  </tbody></table>${list.length > 400 ? `<div class="note" style="padding:8px">거래대금 순 앞의 400개만 보여요.</div>` : ''}`;
}
function patchWatchPrices(){
  for (const el of $$('[data-px]', $('#wlBody'))){
    const q = S.quotes.get(el.dataset.px); if (!q) continue;
    const t = toneOf(q.changeRate), txt = fmtPrice(q.price);
    if (el.textContent !== txt){ const m = el.tagName === 'TD' ? 'mono ' : ''; el.textContent = txt; el.className = m + 'p ' + t; const c = el.nextElementSibling; c.textContent = fmtPct(q.changeRate); c.className = m + 'c ' + t; }
  }
}

// ---------------------------------------------------------------- 종목 선택
async function select(market, { noRecent = false } = {}){
  if (unseen.has(market) || unseenDump.has(market)) ackSurge(market);
  if (!S.byMarket.has(market)) market = 'KRW-BTC';
  if (S.sel !== market) OF.price = OF.amount = OF.qty = OF.sellPct = '';
  S.sel = market; LS.set('quantera:sel', market);
  if (!noRecent){ addRecent(market); if (S.tab === 'recent' && !S.search) renderWatch(); }
  for (const el of $$('.wl-row')) el.classList.toggle('sel', el.dataset.m === market);
  S.stream && S.stream.focus(market);
  renderHead(); renderOrderbook(null); renderOrderForm(); resetTrades(market);
  loadChart(); S.dayMonth = 0; renderDailyAll(); if (document.body.dataset.mt === 'news' && isPhone()) renderMNews();
  upbit.getOrderbook(market).then(ob => S.sel === market && renderOrderbook(ob)).catch(() => {});
  $('#inspBody').innerHTML = '<div class="empty">분석 중…</div>';
  try{
    const inst = S.byMarket.get(market);
    const r = await analyzeOne(inst, S.quotes.get(market));
    setResult(market, r);
    if (S.sel === market){ renderInspector(); renderHead(); applyGuideToChart(); renderOrderForm(); }
  }catch(e){ if (S.sel === market) $('#inspBody').innerHTML = `<div class="empty">분석 실패: ${esc(e.message)}</div>`; }
}
let chartTok = 0;
async function loadChart(){
  const tok = ++chartTok, m = S.sel, tf = S.tf;
  try{
    const rows = await upbit.getCandles(m, tf, { count: tf === '1d' ? 300 : tf === '1M' ? 200 : 400 });
    if (tok !== chartTok) return;
    chart.setData(rows, tf); applyGuideToChart();
  }catch(e){ /* 차트 실패는 조용히 */ }
}
function applyGuideToChart(){
  const r = S.results.get(S.sel);
  const sym = upbit.toSymbol(S.sel), extra = [];
  const pos = S.ledger.positions.find(p => p.symbol === sym);
  if (pos) extra.push({ price: pos.avg, title: S.acct === 'paper' ? '모의 평단' : '내 평단', color: '#EDEDEF', style: 2, legend: '내 평단', width: 1 });
  if (S.acct === 'paper') for (const b of paper.activeBrackets().filter(b => b.symbol === sym)){
    if (b.tp) extra.push({ price: b.tp, title: `예약 익절 +${b.tpPct}%`, color: '#F04452', style: 1, legend: '예약 익절' });
    if (b.sl) extra.push({ price: b.sl, title: `예약 손절 -${b.slPct}%`, color: '#4C8DFF', style: 1, legend: '예약 손절' });
  }
  if (S.acct === 'paper') for (const o of paper.openOrders().filter(o => o.symbol === sym && o.type === 'limit'))
    extra.push({ price: o.price, title: `미체결 ${o.side === 'buy' ? '매수' : '매도'}`, color: '#9A9AA3', style: 2, legend: '미체결' });
  chart && chart.setGuide(effGuide(S.sel), pastBuys(S.ledger.rows, sym), extra);
}
function renderHead(){
  const i = S.byMarket.get(S.sel), q = S.quotes.get(S.sel) || {}, r = S.results.get(S.sel);
  if (!i) return;
  $('#chName').textContent = i.name; $('#chCode').textContent = i.market;
  const t = toneOf(q.changeRate);
  $('#chPrice').textContent = fmtPrice(q.price); $('#chPrice').className = 'px mono ' + t;
  $('#chChg').textContent = fmtPct(q.changeRate); $('#chChg').className = 'mono ' + t;
  const rb = S.ledger.rebuy.find(x => upbit.toMarket(x.symbol) === S.sel);
  $('#chBadges').innerHTML = [rb ? '<span class="badge accent">재매수 기회</span>' : '', r && !r.insufficient ? `<span class="badge line">${esc(STAGE_KO[r.stage] || r.stage)}</span>` : ''].join(' ');
  document.title = `${fmtPrice(q.price)} ${i.name} · QUANTERA`;
}
function renderTf(){
  $('#tfTabs').innerHTML = CONFIG.timeframes.map(t => `<button class="pill${t.id === S.tf ? ' on' : ''}" data-tf="${t.id}">${t.label}</button>`).join('');
}

// ---------------------------------------------------------------- 인스펙터
function renderInspector(){
  const r = S.results.get(S.sel), q = S.quotes.get(S.sel) || {};
  if (!r){ $('#inspBody').innerHTML = '<div class="empty">종목을 고르세요.</div>'; return; }
  $('#inspBasis').textContent = r.dailyDate ? `확정 일봉 ${r.dailyDate}` : '';
  const g = r.guide || {};
  const cur = q.price;
  const L = live(S.sel), cfg = screenCfg();
  const stanceTxt = { buy_zone: `<span class="badge accent">${TYPE_KO[L.type] || '매수 검토'}</span>`, watch: '<span class="badge line">신호 없음</span>', chase: '<span class="badge warn">추격 주의</span>', broken: '<span class="badge warn">지지 이탈</span>', failed: '<span class="badge warn">검증 탈락</span>', blocked: '<span class="badge warn">제외</span>', avoid: '<span class="badge warn">관망</span>', none: '<span class="badge line">판단 보류</span>' }[L.stance || 'none'];
  const liveNote = L.text ? `<div class="peter" style="margin-bottom:8px;color:var(--warn)">${esc(L.text)}</div>` : '';
  const row = (color, label, price, pct) => `<div class="guide-row"><span class="dot" style="background:${color}"></span><span>${label}</span><span class="mono">${price}</span><span class="pct mono ${pct == null ? 'muted' : pct >= 0 ? 'up' : 'warn'}">${pct == null ? '' : fmtPct(pct, 1)}</span></div>`;
  const G = effGuide(S.sel);
  const st = (x, label) => !x || !x.n ? `<dt>${label}</dt><dd class="muted">기록 없음</dd>`
    : `<dt>${label}</dt><dd><span class="mono">${x.n}</span>번 · 이익 <span class="mono">${x.win.toFixed(0)}%</span> · 평균 <span class="mono ${toneOf(x.exp)}">${fmtPct(x.exp, 2)}</span>${x.n < cfg.minSamples ? ' <span class="badge line">표본 부족</span>' : ''}</dd>`;
  let guide;
  if (G){
    const sig = L.sig, mine = summarize(r.scr.bt[sig.type]), all = gstats()[sig.type];
    guide = liveNote + [
      row('#C6F432', '매수 구간', `${fmtPrice(G.buyLo)} ~ ${fmtPrice(G.buyHi)}`, cur ? (cur / G.buyHi - 1) * 100 : null),
      row('#EDEDEF', '1차 매도', fmtPrice(G.sell1), G.sell1Pct),
      row('#EDEDEF', '2차 매도', fmtPrice(G.sell2), G.sell2Pct),
      row('#F5A524', '손절', fmtPrice(G.stop), G.stopPct)
    ].join('') +
    `<div class="muted" style="font-size:var(--f-s);margin-top:6px">% 는 신호일 종가 ${fmtPrice(G.ref)} 대비 · 손익비 ${G.rr.toFixed(2)}${sig.type === 'bottom' ? ' · 바닥 반등은 위험이 커서 비중을 작게' : ''}</div>
     <ul class="reasons">${sig.why.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
     <h3 style="margin:12px 0 8px">과거 같은 신호 결과 <span class="grow"></span><span class="muted" style="font-size:var(--f-s);">${cfg.holdDays}일 안 1차 매도 or 손절</span></h3>
     <dl class="kv">${st(mine, '이 종목')}${st(all, `분석한 ${S.results.size}종목`)}</dl>`;
  } else if (L.stance === 'chase' || L.stance === 'blocked') {
    guide = liveNote + `<div class="muted" style="font-size:var(--f-s)">이 종목엔 매수 가이드를 내지 않아요.</div>`;
  } else if (L.stance === 'avoid') {
    guide = `<div class="peter">하락 추세예요. 바닥 반등 조건(1년 고점 대비 -${cfg.btMinDrop}%, ${cfg.btNoNewLowDays}일 새 저점 없음, 반등 신호)이 맞으면 가이드가 떠요.</div>`;
  } else if (L.stance === 'none') {
    guide = `<div class="peter">${esc(r.peter)}</div>`;
  } else {
    guide = `<div class="peter">지금은 매수 신호가 없어요. 눌림 매수나 바닥 반등 조건이 맞으면 가이드가 떠요.</div>` +
      (g.buyLo ? row('#9A9AA3', '참고 지지', `${fmtPrice(g.buyLo)} ~ ${fmtPrice(g.buyHi)}`, null) + row('#9A9AA3', '참고 저항', fmtPrice(g.sell1), null) : '');
  }

  if (r.scr && r.scr.bt2 && r.scr.bt2.trades.length){
    const T = r.scr.bt2.trades;
    guide += bottomTradeHtml(summarizeBottom(T, r.scr.bt2.days), `바닥 거래 (+${cfg.btTp}%, 손절 없음)`, '') +
      `<div class="bt-list">${T.slice(-6).reverse().map(t => `<div><span class="mono muted">${t.t.slice(2)}</span><span>${t.done ? `<span class="up">+${cfg.btTp}%</span> ${t.days}일` : `<span class="warn">진행 중</span> ${t.days}일 · ${fmtPct(t.ret)}`}</span><span class="down">${fmtPct(t.dd)}</span></div>`).join('')}</div>`;
  }
  const P = r.profile || {};
  const pr = (k, label) => P[k] ? `<tr><td>${label}</td><td class="mono">${P[k].avg.toFixed(1)}%</td><td class="mono">${P[k].typical.toFixed(1)}%</td><td class="mono">${P[k].max.toFixed(1)}%</td><td class="mono">${P[k].min.toFixed(1)}%</td></tr>` : '';
  const stats = r.insufficient ? '' : `<dl class="kv">
      <dt>추세 단계</dt><dd>${esc(STAGE_KO[r.stage] || r.stage)}</dd>
      <dt>상태</dt><dd>${esc(STATUS_KO[r.status] || r.status)}</dd>
      <dt>추세 점수</dt><dd class="mono">${r.trendScore}</dd>
      <dt>진입 점수</dt><dd class="mono">${r.entryScore}</dd>
      <dt>위험도</dt><dd>${esc(RISK_KO[r.risk] || r.risk)}</dd>
      <dt>7일 · 30일</dt><dd class="mono"><span class="${toneOf(r.r7)}">${fmtPct(r.r7, 1)}</span> · <span class="${toneOf(r.r30)}">${fmtPct(r.r30, 1)}</span></dd>
      ${g.setups ? `<dt>같은 자리 과거</dt><dd>${g.setups}번 중 7일 안 +20% ${Math.round((g.hitRate || 0) * 100)}% · 중앙값 ${fmtPct(g.median, 1)}</dd>` : ''}
    </dl>`;
  setTimeout(() => loadNews().then(renderInspNews), 0);
  const draft = $('#wikiNote') && S.wikiFor === S.sel ? $('#wikiNote').value : ''; S.wikiFor = S.sel;
  $('#inspBody').innerHTML = `
    <div class="sec"><h3>매매 가이드 <span class="grow"></span>${stanceTxt}</h3>${guide}</div>
    <div class="sec"><div class="peter"><b>피터</b>${esc(r.peter)}</div></div>
    <div class="sec"><h3>추세 분석 (참고)</h3>${stats || '<div class="muted" style="font-size:var(--f-s)">캔들이 부족해 점수를 내지 않아요.</div>'}
      ${r.reasons && r.reasons.length ? `<details style="margin-top:8px"><summary class="muted" style="font-size:var(--f-s);cursor:pointer">근거 보기</summary><ul class="reasons">${r.reasons.slice(0, 4).map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}</div>
    <div class="sec"><h3>변동폭 프로필 <span class="grow"></span><span class="muted" style="font-size:var(--f-s);">최근 ${P.lookback || 90}일</span></h3>
      <table class="prof"><thead><tr><th></th><th>평균</th><th>보통</th><th>최대</th><th>최소</th></tr></thead><tbody>${pr('1d', '일봉') + pr('1w', '주봉')}</tbody></table>
      <div class="muted" style="font-size:var(--f-s);margin-top:6px">5분·1시간·월봉 변동폭은 수집 서버가 붙으면 채워져요.</div></div>
    <div class="sec"><h3>업비트 소식</h3><div id="inspNews"><div class="muted" style="font-size:var(--f-s)">불러오는 중…</div></div></div>
    <details class="sec wiki" id="wikiSec" ${LS.get('quantera:wikiOpen', true) ? 'open' : ''}><summary>종목 위키 <span class="muted" style="">${esc(nameOf(S.sel))}</span></summary>${wikiHtml(r)}</details>`;
  if (draft) $('#wikiNote').value = draft;
  fillNotes();
}

// ---------------------------------------------------------------- 종목 위키: 한눈에 요약 · 내 거래 · 메모(쌓기만)
const nameOf = m => (S.byMarket.get(m) || {}).name || m;
const dShort = t => new Date(t).toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' });
function wikiFacts(r){
  const sym = upbit.toSymbol(S.sel), cur = priceOf(sym), cfg = screenCfg(), out = [];
  const L = live(S.sel);
  const stance = { buy_zone: '지금 매수 검토 구간이에요', watch: '지금은 매수 신호가 없어요', chase: '많이 올라 추격 주의 구간이에요', broken: '지지선을 이탈했어요', failed: '과거 신호 검증에서 탈락했어요', blocked: '제외 조건에 걸려 있어요', avoid: '하락 추세라 관망 중이에요' }[L.stance];
  out.push([stance || '판단 보류', r && r.stage ? `추세: ${STAGE_KO[r.stage] || r.stage}` : '']);
  if (r && r.scr && r.scr.bt2 && r.scr.bt2.trades.length){
    const b = summarizeBottom(r.scr.bt2.trades, r.scr.bt2.days);
    out.push([`바닥 거래(+${cfg.btTp}%) 과거 ${b.n}번 중 ${b.hit}번 도달`, b.medDays != null ? `보통 ${b.medDays}일 · 기다리는 동안 최대 ${fmtPct(b.worstDd)}` : '']);
  } else out.push(['바닥 신호가 과거에 없었어요', '']);
  const sg = surge.log().filter(x => x.m === S.sel);
  if (sg.length) out.push([`급등 감지 ${sg.length}번 (이 기기에서 켜 둔 동안)`, `마지막 ${agoKo(Date.now() - sg[sg.length - 1].at)} 전`]);
  for (const [lab, led] of [['실제', S.ledgerReal], ['모의', S.ledgerPaper]]){
    const rows = led.rows.filter(x => x.symbol === sym); if (!rows.length) continue;
    const buys = rows.filter(x => x.side === 'buy').length, sells = rows.length - buys;
    const real = rows.reduce((a, x) => a + (x.realized || 0), 0), pos = led.positions.find(x => x.symbol === sym);
    const last = rows[rows.length - 1];
    out.push([`${lab}: 매수 ${buys} · 매도 ${sells}${sells ? ` · 실현 ${real > 0 ? '+' : ''}${won(real)}원` : ''}`,
      (pos ? `보유 중 · 평단 ${fmtPrice(pos.avg)}${cur ? ' (' + fmtPct((cur / pos.avg - 1) * 100) + ')' : ''} · ` : '') + `마지막 ${dShort(last.executed_at)} ${last.side === 'buy' ? '매수' : '매도'} ${fmtPrice(last.price)}`]);
  }
  const rb = S.ledgerReal.rebuy && S.ledgerReal.rebuy.find(x => x.symbol === sym);
  if (rb) out.push(['재매수 기회: 이익 내고 판 뒤 그때 매수가보다 낮아졌어요', '']);
  return out;
}
function wikiHtml(r){
  const sym = upbit.toSymbol(S.sel);
  const src = { carry_over: '이월', manual: '수동', paper: '모의', upbit_import: '업비트', real: '실거래' };
  const mine = [...S.ledgerReal.rows, ...S.ledgerPaper.rows].filter(x => x.symbol === sym).sort((a, b) => new Date(b.executed_at) - new Date(a.executed_at));
  return aiSumHtml() + `<div class="wiki-sum">${wikiFacts(r).map(([a, b]) => `<div><b>${esc(a)}</b>${b ? `<span class="muted">${esc(b)}</span>` : ''}</div>`).join('')}</div>
    <h4>내 거래 <span class="muted">${mine.length}건</span></h4>
    ${mine.length ? `<div class="bt-list wiki-trades">${mine.slice(0, 12).map(x => `<div><span class="mono muted">${dShort(x.executed_at)}</span><span><span class="${x.side === 'buy' ? 'up' : 'down'}">${x.side === 'buy' ? '매수' : '매도'}</span> <span class="mono">${fmtPrice(x.price)}</span> <span class="badge line">${src[x.source] || x.source}</span></span><span class="mono ${toneOf(x.realized)}">${x.realized != null ? fmtPct(x.realizedPct) : ''}</span></div>`).join('')}</div>` : '<div class="muted" style="font-size:var(--f-s)">아직 이 종목 거래가 없어요.</div>'}
    <h4>메모 <span class="muted">쌓기만 해요 (지우지 않음)</span></h4>
    <div class="wiki-add"><textarea id="wikiNote" rows="2" placeholder="왜 샀는지, 무엇을 봤는지, 다음엔 어떻게 할지"></textarea><button class="pill accent sm" id="wikiSave">남기기</button></div>
    <div id="wikiNotes" class="wiki-notes"><div class="muted" style="font-size:var(--f-s)">불러오는 중…</div></div>`;
}
const notesCache = new Map();
// 피터 써머리 (AI): 위키에 있는 숫자를 모아 Workers AI가 한 단락으로 요약. 종목별로 이 기기에 저장(다시 만들기 전까지 유지)
const AI_KEY = sym => 'quantera:ai:' + sym;
function aiFacts(r){
  const m = S.sel, sym = upbit.toSymbol(m), q = S.quotes.get(m) || {}, out = [];
  if (q.price) out.push(`현재가 ${fmtPrice(q.price)}원, 오늘 ${fmtPct(q.changeRate)}`);
  for (const [a, b] of wikiFacts(r)) out.push(b ? `${a} (${b})` : a);
  const pf = r && r.profile;
  if (pf && pf['1d']) out.push(`최근 ${pf.lookback}일 하루 변동폭: 보통 ${pf['1d'].typical.toFixed(1)}%, 평균 ${pf['1d'].avg.toFixed(1)}%, 가장 컸던 날 ${pf['1d'].max.toFixed(1)}%`);
  if (pf && pf['1w']) out.push(`주간 변동폭: 보통 ${pf['1w'].typical.toFixed(1)}%, 가장 컸던 주 ${pf['1w'].max.toFixed(1)}%`);
  const g = effGuide(m);
  if (g) out.push(`매매 가이드: 매수 구간 ${fmtPrice(g.buyLo)}~${fmtPrice(g.buyHi)}, 1차 목표 ${fmtPrice(g.sell1)}(${fmtPct(g.sell1Pct, 1)}), 2차 ${fmtPrice(g.sell2)}(${fmtPct(g.sell2Pct, 1)}), 손절 ${fmtPrice(g.stop)}(${fmtPct(g.stopPct, 1)})`);
  else out.push('지금은 매수 신호가 없어 매매 가이드 가격이 없어요');
  if (r && r.scr && r.scr.bt){ for (const t of ['pullback', 'bottom']){ const s = summarize(r.scr.bt[t] || []); if (s.n) out.push(`${TYPE_KO[t]} 신호 과거 ${s.n}번: 이긴 비율 ${s.win.toFixed(0)}%, 1건 평균 ${fmtPct(s.exp, 2)}`); } }
  const mine = [...S.ledgerReal.rows].filter(x => x.symbol === sym).slice(-12);
  for (const x of mine) out.push(`내 실제 거래 ${dShort(x.executed_at)} ${x.side === 'buy' ? '매수' : '매도'} ${fmtPrice(x.price)}원${x.realized != null ? ` (실현 ${fmtPct(x.realizedPct, 1)})` : ''}`);
  const notes = (notesCache.get(sym) || []).slice(0, 5);
  for (const n of notes) out.push(`내 메모: ${String(n.body).slice(0, 200)}`);
  return out;
}
function aiSumHtml(){
  const sym = upbit.toSymbol(S.sel), c = LS.get(AI_KEY(sym), null);
  const when = c ? new Date(c.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  return `<div class="ai-sum" id="aiSum"><div class="ai-h"><b>피터 써머리</b><span class="muted">AI 요약 · 참고용${c ? ' · ' + when : ''}</span><span class="grow"></span><button class="pill sm${c ? '' : ' accent'}" id="aiBtn">${c ? '다시 만들기' : 'AI 요약 만들기'}</button></div>
    ${c ? `<p>${esc(c.text)}</p>` : `<p class="muted">이 종목의 추세·변동폭·내 거래·메모를 모아 한 단락으로 정리해요. ${db.user ? '' : '로그인하면 쓸 수 있어요.'}</p>`}</div>`;
}
async function makeAiSum(btn){
  const m = S.sel, sym = upbit.toSymbol(m), r = S.results.get(m);
  if (!db.user){ toast('로그인하면 AI 요약을 쓸 수 있어요.'); return; }
  btn.disabled = true; btn.textContent = '만드는 중…';
  try{
    if (!notesCache.has(sym)) notesCache.set(sym, await loadNotes(sym));
    const { data } = await db.client.auth.getSession();
    const res = await fetch('/api/peter-summary', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (data && data.session ? data.session.access_token : '') },
      body: JSON.stringify({ name: nameOf(m), market: m, facts: aiFacts(r) }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.text) throw new Error(j.message || `AI 요약을 만들지 못했어요 (${res.status})`);
    LS.set(AI_KEY(sym), { text: j.text, at: j.at || Date.now() });
  }catch(err){ toast(err.message || String(err)); }
  if (S.sel === m){ const el = $('#aiSum'); if (el) el.outerHTML = aiSumHtml(); }
}
async function fillNotes(force){
  const m = S.sel, sym = upbit.toSymbol(m);
  if (force || !notesCache.has(sym)) notesCache.set(sym, await loadNotes(sym));
  const el = $('#wikiNotes'); if (!el || S.sel !== m) return;
  const list = notesCache.get(sym) || [];
  el.innerHTML = list.length ? list.map(n => `<div><span class="mono muted">${new Date(n.created_at).toLocaleString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span><p>${esc(n.body)}</p></div>`).join('') : '<div class="muted" style="font-size:var(--f-s)">아직 메모가 없어요.</div>';
}
function bindWiki(){
  $('#inspBody').addEventListener('toggle', e => { if (e.target.id === 'wikiSec') LS.set('quantera:wikiOpen', e.target.open); }, true);
  $('#inspBody').addEventListener('click', async e => {
    if (e.target.id === 'aiBtn'){ makeAiSum(e.target); return; }
    if (e.target.id !== 'wikiSave') return;
    const ta = $('#wikiNote'), body = ta.value.trim(); if (!body) return;
    e.target.disabled = true;
    await addNote(upbit.toSymbol(S.sel), body);
    ta.value = ''; e.target.disabled = false;
    await fillNotes(true);
  });
}

// ---------------------------------------------------------------- 호가·주문
function renderOrderbook(ob){
  if (!ob){ if (!$('#obBody').children.length) $('#obBody').innerHTML = '<div class="empty">호가 불러오는 중…</div>'; return; }
  if (ob.market !== S.sel) return;
  if (recOpen() && ob.market === REC.m) renderRecOb(ob);
  const units = ob.units.slice(0, 15);
  const max = Math.max(...units.map(u => Math.max(u.askSize, u.bidSize)), 1e-9);
  const q = S.quotes.get(S.sel) || {}, pc = q.prevClose || (q.price && q.changeRate != null ? q.price / (1 + q.changeRate / 100) : null);
  // 업비트처럼: 위(파는 쪽, 높은 가격) 빨강 · 아래(사는 쪽) 파랑. 가격 글자는 전일 종가 대비 색. 현재가와 같은 줄만 테두리 + 등락률
  const tone = p => pc ? toneOf(p - pc) : '';
  const row = (side, p, sz) => { const cur = q.price != null && Math.abs(p - q.price) < 1e-9;
    return `<div class="ob-row ${side}${cur ? ' cur' : ''}" data-p="${p}"><i style="width:${sz / max * 100}%"></i><span class="p mono ${tone(p)}">${fmtPrice(p)}${cur && pc ? `<em class="${tone(p)}">${fmtPct((p / pc - 1) * 100)}</em>` : ''}</span><span class="sz mono">${sz.toFixed(3)}</span></div>`; };
  const asks = units.slice().reverse().map(u => row('ask', u.ask, u.askSize)).join('');
  const bids = units.map(u => row('bid', u.bid, u.bidSize)).join('');
  $('#obBody').innerHTML = asks + bids;
  const ta = ob.totalAsk || units.reduce((s, u) => s + u.askSize, 0), tb = ob.totalBid || units.reduce((s, u) => s + u.bidSize, 0), tt = ta + tb || 1;
  $('#obTot').innerHTML = `<span class="up mono" data-tip="매도 잔량 합계 (팔려고 걸어 둔 수량)">${fmtQty(ta)}</span><div class="ob-bar"><i class="a" style="width:${ta / tt * 100}%"></i><i class="b" style="width:${tb / tt * 100}%"></i></div><span class="down mono" data-tip="매수 잔량 합계 (사려고 걸어 둔 수량)">${fmtQty(tb)}</span>`;
  if (!renderOrderbook.centered || renderOrderbook.centered !== ob.market){ renderOrderbook.centered = ob.market; const b = $('#obBody'); requestAnimationFrame(() => { b.scrollTop = (b.scrollHeight - b.clientHeight) / 2; }); }
}
const fmtQty = v => v >= 1000 ? Math.round(v).toLocaleString('ko-KR') : (+v).toLocaleString('ko-KR', { maximumFractionDigits: 3 });
// ---------------------------------------------------------------- 실시간 체결 + 체결강도
const TR = { m: null, list: [], raf: 0 };
function resetTrades(m){
  if (TR.m === m) return;
  TR.m = m; TR.list = []; renderTrades();
  upbit.getTrades(m, 50).then(rows => { if (TR.m !== m) return; const seen = new Set(TR.list.map(t => t.ts + ':' + t.price + ':' + t.size)); TR.list = [...TR.list, ...rows.filter(t => !seen.has(t.ts + ':' + t.price + ':' + t.size))].sort((a, b) => b.ts - a.ts).slice(0, 80); renderTrades(); }).catch(() => {});
}
function onTrade(t){
  if (t.market !== TR.m) return;
  TR.list.unshift(t); if (TR.list.length > 80) TR.list.length = 80;
  if (!TR.raf) TR.raf = requestAnimationFrame(() => { TR.raf = 0; renderTrades(); });
}
function renderTrades(){
  const el = $('#trList'); if (!el) return;
  if (!TR.list.length){ el.innerHTML = '<div class="empty">체결을 기다리는 중…</div>'; $('#trStr').textContent = '체결강도 -'; return; }
  const pad = v => String(v).padStart(2, '0');
  el.innerHTML = TR.list.slice(0, 60).map(t => { const d = new Date(t.ts);
    return `<div class="tr-row ${t.side === 'buy' ? 'up' : 'down'}"><span class="muted">${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}</span><span>${fmtPrice(t.price)}</span><span>${fmtQty(t.size)}</span></div>`; }).join('');
  let bv = 0, sv = 0; for (const t of TR.list) t.side === 'buy' ? bv += t.size : sv += t.size;
  const st = sv ? bv / sv * 100 : bv ? 999 : 100;
  $('#trStr').innerHTML = `체결강도 <span class="${st >= 100 ? 'up' : 'down'} mono">${st.toFixed(1)}%</span> <span class="muted">· 최근 ${TR.list.length}건</span>`;
}
// ---------------------------------------------------------------- 주문 칸 (모의투자)
// 입력값은 OF에 들고 있어서 화면을 다시 그려도 지워지지 않음
const OF = { side: 'buy', type: 'limit', strategy: LS.get('quantera:ofStrategy', 'manual'), price: '', amount: '', qty: '', sellPct: '',
  tpPct: LS.get('quantera:ofTp', 2), slPct: LS.get('quantera:ofSl', 3), slNone: LS.get('quantera:ofSlNone', false), err: '' };
const STRATS = { manual: '직접 입력', guide: '가이드 (눌림·바닥 신호)', bottom: '바닥 거래', surge: '급등 거래' };
const num = v => { const n = +String(v ?? '').replace(/[,\s원%]/g, ''); return isFinite(n) ? n : NaN; };
const r2 = v => Math.round(v * 100) / 100;
function applyStrategy(){
  const cur = priceOf(upbit.toSymbol(S.sel));
  if (OF.strategy === 'bottom'){ OF.tpPct = screenCfg().btTp; OF.slNone = true; }
  else if (OF.strategy === 'surge'){ const c = allCfg(); OF.tpPct = c.surgeTradeTp; OF.slPct = c.surgeTradeSl; OF.slNone = false; }
  else if (OF.strategy === 'guide'){
    const G = effGuide(S.sel);
    if (G && G.stance === 'buy_zone' && cur){
      const p = Math.min(cur, G.buyHi); OF.type = 'limit'; OF.price = p;
      OF.tpPct = r2((G.sell1 / p - 1) * 100); OF.slPct = r2((1 - G.stop / p) * 100); OF.slNone = false; OF.err = '';
    } else OF.err = '지금 이 종목엔 매수 가이드가 없어요. 직접 입력으로 넣어 주세요.';
  }
}
function buyPreview(){
  const cur = priceOf(upbit.toSymbol(S.sel));
  const p = OF.type === 'market' ? cur : num(OF.price), A = num(OF.amount);
  if (!(p > 0) || !(A > 0)) return '<div><span>금액과 가격을 넣으면 예상 손익이 보여요.</span></div>';
  const qty = A / p, cost = A * (1 + FEE_RATE), tp = num(OF.tpPct), sl = OF.slNone ? NaN : num(OF.slPct);
  const at = pct => { const px = p * (1 + pct / 100), net = qty * px * (1 - FEE_RATE) - cost; return [px, net]; };
  const line = (label, pct, cls) => { const [px, net] = at(pct); return `<div><span>${label} ${fmtPrice(px)}</span><b class="${cls}">${net > 0 ? '+' : ''}${won(net)}원</b></div>`; };
  return `<div><span>수량 ≈</span><b class="mono">${qty.toLocaleString('ko-KR', { maximumFractionDigits: 8 })}</b></div>` +
    (tp > 0 ? line(`익절 +${tp}%`, tp, 'up') : '') +
    (sl > 0 ? line(`손절 -${sl}%`, -sl, 'down') : `<div><span>손절</span><b class="muted">없음 · 기다림</b></div>`) +
    `<div><span>수수료(사고 팔 때)</span><b class="muted">약 ${won(A * FEE_RATE * 2)}원</b></div>`;
}
function sellPreview(pos){
  const cur = priceOf(upbit.toSymbol(S.sel));
  const p = OF.type === 'market' ? cur : num(OF.price), q = num(OF.qty);
  if (!(p > 0) || !(q > 0) || !pos) return '<div><span>가격과 수량을 넣으면 예상 손익이 보여요.</span></div>';
  const net = q * p * (1 - FEE_RATE) - pos.avg * q, pct = (p / pos.avg - 1) * 100;
  return `<div><span>받을 금액</span><b class="mono">${won(q * p * (1 - FEE_RATE))}원</b></div><div><span>예상 손익 (평단 대비 ${fmtPct(pct)})</span><b class="${toneOf(net)}">${net > 0 ? '+' : ''}${won(net)}원</b></div>`;
}
// 매도 % 단계: 2% 단위로 10%까지, 그 뒤 5% 단위 (−/+ 버튼, 키보드 ↑↓)
const PCT_STEPS = [0, 2, 4, 6, 8, 10, ...Array.from({ length: 18 }, (_, i) => 15 + i * 5)];
function stepPct(v, dir, signed){
  const x = isFinite(+v) && v !== '' ? +v : 0;
  if (signed && x < 0 || signed && x === 0 && dir < 0){ const a = -stepPct(-x, -dir, false); return a; }   // 평단 대비는 마이너스도 같은 단계
  if (dir > 0) return PCT_STEPS.find(s => s > x + 1e-9) ?? PCT_STEPS[PCT_STEPS.length - 1];
  return [...PCT_STEPS].reverse().find(s => s < x - 1e-9) ?? 0;
}
const stepper = (f, v, disabled, sign, ph = '', signed = false) =>
  `<span class="stepper"><button type="button" data-step="${f}" data-dir="-1" ${disabled ? 'disabled' : ''} aria-label="내리기">−</button><span class="sign">${sign}</span><input data-f="${f}" inputmode="decimal" value="${v}" ${disabled ? 'disabled' : ''} placeholder="${ph}"${signed ? ' data-signed' : ''}><span class="unit">%</span><button type="button" data-step="${f}" data-dir="1" ${disabled ? 'disabled' : ''} aria-label="올리기">+</button></span>`;
function patchLive(root){
  for (const el of $$('[data-lv]', root)){
    const c = priceOf(el.dataset.s); if (!c) continue;
    const k = el.dataset.lv, p = +el.dataset.p, q = +el.dataset.q;
    let txt, tone = null;
    if (k === 'vs'){ const v = (c / p - 1) * 100; txt = fmtPct(v); tone = toneOf(v); }
    else if (k === 'gap') txt = fmtPct((p / c - 1) * 100);
    else if (k === 'cur') txt = fmtPrice(c);
    else if (k === 'val') txt = won(c * q);
    else if (k === 'pnl'){ const pnl = c * q * (1 - FEE_RATE) - +el.dataset.c; txt = `${pnl > 0 ? '+' : ''}${won(pnl)} (${fmtPct((c / p - 1) * 100)})`; tone = toneOf(pnl); }
    if (el.textContent !== txt){ el.textContent = txt; if (tone != null) el.className = 'mono ' + tone; }
  }
}
function holdHtml(pos, cur){
  return `보유 <b>${pos.qty.toLocaleString('ko-KR', { maximumFractionDigits: 8 })}</b> · 평단 <b>${fmtPrice(pos.avg)}</b><br>평가손익 <b class="${toneOf(pos.pnl)}">${pos.pnl != null ? (pos.pnl > 0 ? '+' : '') + won(pos.pnl) + '원' : '-'}</b> <span class="${toneOf(pos.pnl)}">${cur ? fmtPct((cur / pos.avg - 1) * 100) : ''}</span>`;
}
// 손익 숫자 실시간 갱신 (1초): 입력 중인 칸은 건드리지 않고 숫자만 바꿈
let liveN = 0;
setInterval(() => {
  if (!S.sel || document.hidden) return;
  recompute(); renderStatus();
  const sym = upbit.toSymbol(S.sel), hb = $('#ofHold');
  if (hb){ const pos = S.ledgerPaper.positions.find(p => p.symbol === sym); if (pos) hb.innerHTML = holdHtml(pos, priceOf(sym)); }
  const mk = $('#ofMkt'), cp = priceOf(sym); if (mk && cp) mk.value = fmtPrice(cp) + ' (현재가)';
  const pi = $('#orderBox [data-f="price"]'); if (pi && cp) pi.placeholder = fmtPrice(cp);
  refreshPreview();
  patchLive($('#pJournal'));
}, 1000);
function renderOrderForm(){
  const box = $('#orderBox'); if (!box || !S.sel) return;
  const sym = upbit.toSymbol(S.sel), cur = priceOf(sym), name = (S.byMarket.get(S.sel) || {}).name || S.sel;
  const sw = `<div class="acct-sw"><span>모의 계좌 · ${esc(name)}</span><span class="grow"></span><span class="mono" data-tip="모의 계좌에서 지금 주문에 쓸 수 있는 현금">${won(paper.available())}원</span></div>`;
  const pos = S.ledgerPaper.positions.find(p => p.symbol === sym);
  const seg = `<div class="seg"><button class="buy${OF.side === 'buy' ? ' on' : ''}" data-side="buy">매수</button><button class="sell${OF.side === 'sell' ? ' on' : ''}" data-side="sell">매도</button></div>`;
  const type = `<div class="seg2"><button data-type="limit" class="${OF.type === 'limit' ? 'on' : ''}">지정가</button><button data-type="market" class="${OF.type === 'market' ? 'on' : ''}">시장가</button></div>`;
  const priceField = OF.type === 'market'
    ? `<label class="field"><span>가격</span><input id="ofMkt" value="${cur ? fmtPrice(cur) + ' (현재가)' : ''}" disabled></label>`
    : `<label class="field"><span>가격 <button type="button" class="linkbtn" data-curpx data-tip="현재가 넣기">현재가</button></span><input data-f="price" inputmode="decimal" value="${OF.price !== '' ? OF.price : ''}" placeholder="${cur ? fmtPrice(cur) : ''}"></label>`;
  let body;
  if (OF.side === 'buy'){
    body = `<label class="field"><span>방식</span><select data-f="strategy">${Object.entries(STRATS).map(([k, v]) => `<option value="${k}"${OF.strategy === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      ${type}${priceField}
      <label class="field"><span>금액</span><input data-f="amount" inputmode="numeric" value="${OF.amount}" placeholder="원"></label>
      <div class="quick">${[25, 50, 75, 100].map(x => `<button type="button" data-amt="${x}">${x === 100 ? '최대' : x + '%'}</button>`).join('')}</div>
      <label class="field"><span>익절</span>${stepper('tpPct', OF.tpPct ?? '', false, '+')}</label>
      <label class="field"><span>손절</span>${stepper('slPct', OF.slNone ? '' : (OF.slPct ?? ''), OF.slNone, '-', '없음')}</label>
      <label class="chk"><input type="checkbox" data-f="slNone" ${OF.slNone ? 'checked' : ''}> 손절 없음 (내려가도 기다림)</label>
      <div class="pv" id="ofPv">${buyPreview()}</div>
      ${OF.err ? `<div class="err">${esc(OF.err)}</div>` : ''}
      <button class="submit buy" data-submit>모의 매수 · ${esc(name)}</button>
      <div class="note">체결되면 체결가 기준으로 익절·손절 예약 매도가 자동으로 걸려요.</div>`;
  } else {
    const avail = paper.availableQty(sym);
    body = (pos ? `<div class="hold-box" id="ofHold">${holdHtml(pos, cur)}</div>` : '<div class="note">이 종목은 모의 보유가 없어요.</div>') +
      `${type}${priceField}
      ${OF.type === 'limit' ? `<label class="field"><span>평단 대비</span>${stepper('sellPct', OF.sellPct, !pos, '', pos ? '예: 2' : '', true)}</label>` : ''}
      <label class="field"><span>수량</span><input data-f="qty" inputmode="decimal" value="${OF.qty}" placeholder="${avail ? '최대 ' + avail.toLocaleString('ko-KR', { maximumFractionDigits: 8 }) : ''}"></label>
      <div class="quick">${[25, 50, 75, 100].map(x => `<button type="button" data-qp="${x}" ${avail ? '' : 'disabled'}>${x === 100 ? '전량' : x + '%'}</button>`).join('')}</div>
      <div class="pv" id="ofPv">${sellPreview(pos)}</div>
      ${OF.err ? `<div class="err">${esc(OF.err)}</div>` : ''}
      <button class="submit sell" data-submit ${avail ? '' : 'disabled'}>모의 매도 · ${esc(name)}</button>`;
  }
  // 이 종목의 미체결·예약 매도
  const mine = paper.openOrders().filter(o => o.symbol === sym), br = paper.activeBrackets().filter(b => b.symbol === sym);
  const mini = mine.length || br.length ? `<div class="pv">${mine.map(o => `<div><span>${o.side === 'buy' ? '매수' : '매도'} 대기 ${fmtPrice(o.price)}</span><button class="linkbtn" data-cancel="${o.id}">취소</button></div>`).join('')}${br.map(b => `<div><span>예약 ${b.tp ? '익절 ' + fmtPrice(b.tp) : ''}${b.tp && b.sl ? ' · ' : ''}${b.sl ? '손절 ' + fmtPrice(b.sl) : ''}</span><button class="linkbtn" data-boff="${b.id}">끄기</button></div>`).join('')}</div>` : '';
  box.innerHTML = sw + seg + body + mini + (paper.state.halted ? '<div class="err">긴급 정지 중이에요. 하단의 정지 버튼을 다시 누르면 해제돼요.</div>' : '');
}
function refreshPreview(){
  const pv = $('#ofPv'); if (!pv) return;
  const pos = S.ledgerPaper.positions.find(p => p.symbol === upbit.toSymbol(S.sel));
  pv.innerHTML = OF.side === 'buy' ? buyPreview() : sellPreview(pos);
}
function bindOrder(){
  const box = $('#orderBox');
  box.addEventListener('input', e => {
    const f = e.target.dataset.f; if (!f || f === 'strategy' || f === 'slNone') return;
    OF[f] = e.target.value; OF.err = '';
    const sym = upbit.toSymbol(S.sel), pos = S.ledgerPaper.positions.find(p => p.symbol === sym);
    if (f === 'sellPct' && pos && isFinite(num(OF.sellPct))){ OF.price = Math.round(pos.avg * (1 + num(OF.sellPct) / 100) * 1e8) / 1e8; const pi = $('[data-f="price"]', box); if (pi) pi.value = OF.price; }
    if (f === 'price' && OF.side === 'sell' && pos && num(OF.price) > 0){ OF.sellPct = r2((num(OF.price) / pos.avg - 1) * 100); const si = $('[data-f="sellPct"]', box); if (si) si.value = OF.sellPct; }
    if (f === 'tpPct') LS.set('quantera:ofTp', num(OF.tpPct)); if (f === 'slPct') LS.set('quantera:ofSl', num(OF.slPct));
    refreshPreview();
  });
  box.addEventListener('keydown', e => {
    const f = e.target.dataset && e.target.dataset.f;
    if (!['tpPct', 'slPct', 'sellPct'].includes(f) || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault(); e.target.value = OF[f] = stepPct(OF[f], e.key === 'ArrowUp' ? 1 : -1, f === 'sellPct');
    e.target.dispatchEvent(new Event('input', { bubbles: true }));
  });
  box.addEventListener('change', e => {
    const f = e.target.dataset.f;
    if (f === 'strategy'){ OF.strategy = e.target.value; LS.set('quantera:ofStrategy', OF.strategy); OF.err = ''; applyStrategy(); renderOrderForm(); }
    if (f === 'slNone'){ OF.slNone = e.target.checked; LS.set('quantera:ofSlNone', OF.slNone); renderOrderForm(); }
  });
  box.addEventListener('click', e => {
    const t = e.target.closest('button'); if (!t) return;
    const sym = upbit.toSymbol(S.sel), cur = priceOf(sym);
    if (t.dataset.step){
      const f = t.dataset.step, inp = $(`[data-f="${f}"]`, box);
      const v = stepPct(OF[f], +t.dataset.dir, f === 'sellPct');
      OF[f] = v; if (inp){ inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true })); }
      return;
    }
    if (t.dataset.acct){ setAcct(t.dataset.acct); return; }
    if (t.dataset.side){ OF.side = t.dataset.side; OF.err = ''; OF.price = ''; OF.sellPct = ''; renderOrderForm(); return; }
    if (t.dataset.type){ OF.type = t.dataset.type; OF.err = ''; renderOrderForm(); return; }
    if (t.hasAttribute('data-curpx')){ OF.price = cur || ''; renderOrderForm(); return; }
    if (t.dataset.amt){ const p = OF.type === 'market' ? cur : (num(OF.price) || cur); const cash = paper.available() / (1 + FEE_RATE); OF.amount = Math.floor(cash * +t.dataset.amt / 100); if (!OF.price && OF.type === 'limit') OF.price = p; renderOrderForm(); return; }
    if (t.dataset.qp){ OF.qty = Math.floor(paper.availableQty(sym) * +t.dataset.qp / 100 * 1e8) / 1e8; if (!OF.price && OF.type === 'limit') OF.price = cur; renderOrderForm(); return; }
    if (t.dataset.cancel){ paper.cancel(t.dataset.cancel); return; }
    if (t.dataset.boff){ paper.bracketOff(t.dataset.boff); return; }
    if (t.hasAttribute('data-submit')){
      try{
        if (!UI.paperOn) setUi({ paperOn: true });   // 처음 모의 주문을 넣으면 주문 탭·모의 거래일지가 보여요
        const base = { symbol: sym, side: OF.side, type: OF.type, price: OF.type === 'market' ? cur : (num(OF.price) || cur) };
        if (OF.side === 'buy') paper.place({ ...base, amount: num(OF.amount), tpPct: num(OF.tpPct) || null, slPct: OF.slNone ? null : (num(OF.slPct) || null),
          strategy: STRATS[OF.strategy], reason: OF.strategy === 'guide' ? (live(S.sel).text || (S.results.get(S.sel) || {}).peter || null) : null });
        else paper.place({ ...base, qty: num(OF.qty), strategy: '직접 매도' });
        OF.amount = ''; OF.qty = ''; OF.err = ''; renderOrderForm();
      }catch(err){ OF.err = err.message; renderOrderForm(); }
    }
  });
  // 호가를 누르면: 기록 · 모의 창을 그 가격으로 열기
  $('#obBody').addEventListener('click', e => {
    const row = e.target.closest('.ob-row'); if (!row) return;
    openRec(LS.get('quantera:recTab', 'rec'), { price: Math.round(+row.dataset.p * 1e8) / 1e8 });
  });
  $('#jAcct').addEventListener('click', e => { const b = e.target.closest('[data-acct]'); if (b) setAcct(b.dataset.acct); });
  for (const id of ['#estop', '#estopM']) { const b = $(id); if (b) b.addEventListener('click', () => {
    if (paper.state.halted){ paper.halt(false); toast('긴급 정지를 해제했어요. 취소된 주문은 다시 넣어야 해요.'); return; }
    if (confirm('모의 계좌의 모든 미체결 주문과 예약 매도(익절·손절)를 멈출까요?')){ paper.halt(true); toast('긴급 정지: 모의 미체결 주문과 예약 매도를 모두 멈췄어요.', 'warn'); }
  }); }
  $('#ordBody').addEventListener('click', e => {
    const t = e.target.closest('button'); if (!t) return;
    try{
      if (t.dataset.cancel) paper.cancel(t.dataset.cancel);
      else if (t.dataset.amend){ const o = paper.openOrders().find(x => x.id === t.dataset.amend); const v = prompt('새 가격', o ? o.price : ''); if (v != null) paper.amend(t.dataset.amend, num(v)); }
      else if (t.hasAttribute('data-cancel-all')){ if (confirm('모의 미체결 주문을 모두 취소할까요?')) paper.cancelAll(); }
      else if (t.dataset.boff) paper.bracketOff(t.dataset.boff);
      else if (t.dataset.bset){ const b = paper.activeBrackets().find(x => x.id === t.dataset.bset); const v = prompt('익절 %, 손절 % (손절 없으면 0)\n예: 2, 5', b ? `${b.tpPct || 0}, ${b.slPct || 0}` : '2, 0'); if (v != null){ const [tp, sl] = v.split(',').map(num); paper.bracketSet(t.dataset.bset, tp, sl); } }
      else if (t.dataset.badd){ const p = S.ledgerPaper.positions.find(x => x.symbol === t.dataset.badd); const v = prompt('평단 기준 익절 %, 손절 % (손절 없으면 0)\n예: 2, 0', '2, 0'); if (p && v != null){ const [tp, sl] = v.split(',').map(num); paper.bracketAdd(p.symbol, p.avg, paper.availableQty(p.symbol), tp, sl, '직접'); } }
      else if (t.dataset.sell){ select(upbit.toMarket(t.dataset.sell)); OF.side = 'sell'; renderOrderForm(); }
      else if (t.hasAttribute('data-deposit')){ const v = prompt('모의 계좌에 넣을 금액(원)\n예: 5000000 (500만 원)\n시작 금액에도 같이 더해서 수익률은 바뀌지 않아요.', '5000000'); if (v != null && num(v) > 0){ paper.deposit(num(v)); toast(`모의 자금 ${won(num(v))}원을 넣었어요.`, 'up'); } }
      else if (t.hasAttribute('data-reset')){ const v = prompt('모의 계좌를 새로 시작할까요? 시작 금액(원)을 넣어 주세요.\n지금까지의 체결 기록은 거래일지에 남지만, 잔고·보유·주문은 새로 시작해요.', String(paper.state.start)); if (v != null && num(v) > 0) paper.reset(num(v)); }
    }catch(err){ alert(err.message); }
  });
}
function setAcct(a){
  S.acct = a; LS.set('quantera:acct', a);
  $$('#jAcct [data-acct]').forEach(b => b.classList.toggle('on', b.dataset.acct === a));
  recompute(); renderOrderForm(); renderJournal(); renderStatus(); applyGuideToChart(); if (S.tab === 'hold') renderWatch();
  if (isOrdersOpen()) renderOrders();
  if (isHoldOpen()) renderHold();
}
const isOrdersOpen = () => !$('#ordBody').classList.contains('hidden');
// 폰에서는 표를 카드로 보여 주려고 칸마다 머리글 이름을 붙임
function labelTables(root){
  for (const t of $$('table.ot, table.jt', root)){
    const heads = $$('thead th', t).map(th => th.textContent.trim());
    if (!heads.length) continue;
    for (const tr of $$('tbody tr', t)) [...tr.children].forEach((td, i) => {
      const h = heads[i] || ''; td.dataset.label = h;
      if (h === '종목') td.classList.add('lead'); if (!h) td.classList.add('act');
    });
  }
}
// 거래일지 패널의 "주문" 탭: 미체결 · 예약 매도 · 모의 보유 · 계좌
function renderOrders(){
  const nm = s => (S.byMarket.get(upbit.toMarket(s)) || {}).name || s;
  const t = ts => new Date(ts).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const oo = paper.openOrders().slice().reverse(), br = paper.activeBrackets().slice().reverse(), pos = S.ledgerPaper.positions;
  const st = paper.state, val = pos.reduce((a, p) => a + (p.value || 0), 0), total = st.cash + val;
  const gap = (sym, px) => { const c = priceOf(sym); return c ? fmtPct((px / c - 1) * 100) : ''; };
  $('#ordBody').innerHTML = `
    <div class="ot-title">미체결 주문 <span class="muted">${oo.length}건</span><span class="grow"></span>${oo.length ? '<button class="pill" data-cancel-all>전체 취소</button>' : ''}</div>
    ${oo.length ? `<table class="ot"><thead><tr><th class="l">주문 시각</th><th class="l">종목</th><th class="l">구분</th><th>가격</th><th>현재가와 거리</th><th>수량</th><th>금액</th><th class="l">익절·손절</th><th></th></tr></thead><tbody>
      ${oo.map(o => `<tr><td class="l mono">${t(o.at)}</td><td class="l">${esc(nm(o.symbol))}</td><td class="l ${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? '매수' : '매도'} 지정가</td><td class="mono">${fmtPrice(o.price)}</td><td class="mono muted" data-lv="gap" data-s="${o.symbol}" data-p="${o.price}">${gap(o.symbol, o.price)}</td><td class="mono">${(+o.qty).toLocaleString('ko-KR', { maximumFractionDigits: 8 })}</td><td class="mono">${won(o.price * o.qty)}</td><td class="l">${o.tpPct ? '+' + o.tpPct + '%' : ''}${o.tpPct && o.slPct ? ' / ' : ''}${o.slPct ? '-' + o.slPct + '%' : (o.side === 'buy' && o.tpPct ? ' / 손절 없음' : '')}</td><td><button data-amend="${o.id}">정정</button><button data-cancel="${o.id}">취소</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty" style="padding:12px">미체결 주문이 없어요.</div>'}
    <div class="ot-title">예약 매도 (익절·손절) <span class="muted">${br.length}건</span></div>
    ${br.length ? `<table class="ot"><thead><tr><th class="l">종목</th><th>수량</th><th>매수가</th><th>익절가</th><th>손절가</th><th>지금 손익</th><th class="l">방식</th><th></th></tr></thead><tbody>
      ${br.map(b => { const c = priceOf(b.symbol), pl = c ? (c / b.entry - 1) * 100 : null; return `<tr><td class="l">${esc(nm(b.symbol))}</td><td class="mono">${(+b.qty).toLocaleString('ko-KR', { maximumFractionDigits: 8 })}</td><td class="mono">${fmtPrice(b.entry)}</td><td class="mono up">${b.tp ? fmtPrice(b.tp) + ` (+${b.tpPct}%)` : '-'}</td><td class="mono down">${b.sl ? fmtPrice(b.sl) + ` (-${b.slPct}%)` : '없음'}</td><td class="mono ${toneOf(pl)}" data-lv="vs" data-s="${b.symbol}" data-p="${b.entry}">${pl != null ? fmtPct(pl) : ''}</td><td class="l">${esc(b.strategy || '')}</td><td><button data-bset="${b.id}">수정</button><button data-boff="${b.id}">끄기</button></td></tr>`; }).join('')}</tbody></table>` : '<div class="empty" style="padding:12px">걸려 있는 예약 매도가 없어요.</div>'}
    <div class="ot-title">모의 보유 <span class="muted">${pos.length}종목</span></div>
    ${pos.length ? `<table class="ot"><thead><tr><th class="l">종목</th><th>수량</th><th>평단</th><th>현재가</th><th>평가금액</th><th>평가손익</th><th></th></tr></thead><tbody>
      ${pos.map(p => { const c = priceOf(p.symbol), has = br.some(b => b.symbol === p.symbol); return `<tr><td class="l">${esc(nm(p.symbol))}</td><td class="mono">${p.qty.toLocaleString('ko-KR', { maximumFractionDigits: 8 })}</td><td class="mono">${fmtPrice(p.avg)}</td><td class="mono" data-lv="cur" data-s="${p.symbol}">${fmtPrice(c)}</td><td class="mono" data-lv="val" data-s="${p.symbol}" data-q="${p.qty}">${p.value != null ? won(p.value) : ''}</td><td class="mono ${toneOf(p.pnl)}" data-lv="pnl" data-s="${p.symbol}" data-q="${p.qty}" data-c="${p.cost}" data-p="${p.avg}">${p.pnl != null ? (p.pnl > 0 ? '+' : '') + won(p.pnl) + ' (' + fmtPct((c / p.avg - 1) * 100) + ')' : ''}</td><td>${has ? '' : `<button data-badd="${p.symbol}">예약 걸기</button>`}<button data-sell="${p.symbol}">팔기</button></td></tr>`; }).join('')}</tbody></table>` : '<div class="empty" style="padding:12px">모의 보유 종목이 없어요.</div>'}
    <div class="ot-title">모의 계좌 <span class="grow"></span><button class="pill accent" data-deposit>자금 추가</button><button class="pill" data-reset>새로 시작</button></div>
    <table class="ot acct"><tbody><tr><td class="l">시작 금액</td><td class="mono">${won(st.start)}원</td><td class="l">현금</td><td class="mono">${won(st.cash)}원</td><td class="l">총자산</td><td class="mono">${won(total)}원</td><td class="l">수익률</td><td class="mono ${toneOf(total - st.start)}">${fmtPct((total / st.start - 1) * 100)}</td></tr></tbody></table>
    ${(st.deposits || []).length ? `<div class="note" style="padding:4px 8px">추가한 자금: ${st.deposits.map(d => `${new Date(d.at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })} +${won(d.amount)}원`).join(' · ')} · 시작 금액에 더해서 수익률은 그대로예요.</div>` : ''}
    <div class="note" style="padding:8px">앱이 켜져 있는 동안 실시간으로 체결돼요. 꺼져 있던 동안 가격이 닿았는지는 다시 열 때 분봉으로 확인해요. 수수료 0.05% 반영, 부분 체결 없음.</div>`;
  labelTables($('#ordBody'));
}
// 화면 알림
function toast(msg, tone = ''){
  const el = document.createElement('div'); el.className = 'toast ' + tone; el.textContent = msg;
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), 7000);
}
let paperRaf = false;
paper.on('change', () => {
  if (paperRaf) return; paperRaf = true;
  requestAnimationFrame(() => {
    paperRaf = false; recompute(); renderStatus(); applyGuideToChart();
    if (!$('#orderBox').contains(document.activeElement) || document.activeElement.tagName === 'BUTTON') renderOrderForm();
    if (!$('#jBody').classList.contains('hidden')) renderJournal();
    if (isOrdersOpen()) renderOrders();
    if (S.tab === 'hold') renderWatch();
  });
});
paper.on('fill', ({ order, trade }) => {
  if (order.kind === 'tp' || order.kind === 'sl') return; // 예약 매도는 아래에서 알림
  const nm = (S.byMarket.get(upbit.toMarket(trade.symbol)) || {}).name || trade.symbol;
  toast(`모의 ${trade.side === 'buy' ? '매수' : '매도'} 체결 · ${nm} ${fmtPrice(trade.price)} × ${(+trade.qty).toLocaleString('ko-KR', { maximumFractionDigits: 8 })}`, trade.side === 'buy' ? 'up' : 'down');
  if (order.type === 'limit') beep('one');
});
paper.on('bracket', ({ bracket, kind, trade }) => {
  const nm = (S.byMarket.get(upbit.toMarket(trade.symbol)) || {}).name || trade.symbol;
  const net = trade.qty * trade.price * (1 - FEE_RATE) - trade.qty * bracket.entry * (1 + FEE_RATE);
  const msg = `${kind === 'tp' ? '익절' : '손절'} 도달 · ${nm} ${fmtPrice(trade.price)}에 모의 매도 · ${net > 0 ? '+' : ''}${won(net)}원`;
  toast(msg, kind === 'tp' ? 'up' : 'down'); beep(kind === 'tp' ? 'up' : 'down');
  if ('Notification' in window && Notification.permission === 'granted') try { new Notification('모의 ' + (kind === 'tp' ? '익절' : '손절'), { body: msg, tag: 'quantera-paper-' + bracket.id, icon: './icons/icon-192.png' }); } catch(e){}
});

// ---------------------------------------------------------------- 보유 자산 (실제 | 모의)
// 거래일지 기록으로 계산한 보유 수량·평단에 실시간 시세를 곱함. 줄을 누르면 그 종목 기록만 거래일지에서 보여 줌
const isHoldOpen = () => !$('#holdBody').classList.contains('hidden');
function holdData(){
  recompute();
  const led = S.ledger, isPaper = S.acct === 'paper';
  const realizedBy = new Map(); let realized = 0;
  for (const r of led.rows) if (r.realized != null){ realized += r.realized; realizedBy.set(r.symbol, (realizedBy.get(r.symbol) || 0) + r.realized); }
  const pos = led.positions.map(p => { const cur = priceOf(p.symbol); const value = cur != null ? cur * p.qty : null;
    return { ...p, cur, value, pnl: value != null ? value * (1 - FEE_RATE) - p.cost : null, pct: value != null ? (value * (1 - FEE_RATE) / p.cost - 1) * 100 : null, realized: realizedBy.get(p.symbol) || 0, chg: (S.quotes.get(upbit.toMarket(p.symbol)) || {}).changeRate }; });
  const cost = pos.reduce((a, p) => a + p.cost, 0), value = pos.reduce((a, p) => a + (p.value || 0), 0), pnl = pos.reduce((a, p) => a + (p.pnl || 0), 0);
  for (const p of pos) p.weight = value ? (p.value || 0) / value * 100 : 0;
  pos.sort((a, b) => (b.value || 0) - (a.value || 0));
  return { isPaper, fromUpbit: !isPaper && !!(led.positions[0] && led.positions[0].fromUpbit), pos, cost, value, pnl, pct: cost ? pnl / cost * 100 : 0, realized, cash: isPaper ? paper.state.cash : null, start: isPaper ? paper.state.start : null };
}
const signWon = v => (v > 0 ? '+' : '') + won(v) + '원';
function holdSumHtml(H){
  const it = (lab, val, cls = '') => `<div class="hs-it"><span class="muted">${lab}</span><b class="mono ${cls}">${val}</b></div>`;
  return `<div class="hold-sum">
    ${it(H.isPaper ? '모의 보유' : '보유', `${H.pos.length}종목`)}
    ${it('매수금액', won(H.cost) + '원')}
    ${it('평가금액', won(H.value) + '원')}
    ${it('평가손익', signWon(H.pnl), toneOf(H.pnl))}
    ${it('수익률', fmtPct(H.pct), toneOf(H.pct))}
    ${it('누적 실현손익', signWon(H.realized), toneOf(H.realized))}
    ${H.isPaper ? it('현금', won(H.cash) + '원') + it('총자산 수익률', fmtPct(((H.cash + H.value) / H.start - 1) * 100), toneOf(H.cash + H.value - H.start)) : ''}
  </div>`;
}
function renderHold(){
  const box = $('#holdBody'); if (!box) return;
  if (S.acct !== 'paper' && !db.user){ box.innerHTML = '<div class="empty">로그인하면 보유 자산이 보여요.</div>'; return; }
  const H = holdData();
  const note = `<div class="note" style="padding:8px">${H.isPaper ? '모의 계좌 기준이에요. 모의 주문·예약 매도는 "주문" 탭에 있어요.' : (H.fromUpbit ? `업비트 잔고 기준이에요 (PC 도우미가 30초마다 올림 · ${new Date(S.bal.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })} 확인). 평단은 업비트 평단이에요.` : '거래일지 기록으로 계산했어요. PC 도우미(새 버전)가 업비트 잔고를 올리면 업비트와 똑같이 맞춰져요.')} 평가손익은 팔 때 수수료 ${FEE_RATE * 100}%를 뺀 값이에요.</div>`;
  if (!H.pos.length){ box.innerHTML = holdSumHtml(H) + `<div class="empty">${H.isPaper ? '모의 보유 종목이 없어요.' : '지금 보유 중인 종목이 없어요.'}</div>` + note; return; }
  box.innerHTML = holdSumHtml(H) + `<table class="ot hold-t"><thead><tr><th class="l">종목</th><th>보유 수량</th><th>평단</th><th>현재가</th><th>오늘</th><th>매수금액</th><th>평가금액</th><th>평가손익</th><th>수익률</th><th>비중</th><th>실현손익</th><th></th></tr></thead><tbody>
    ${H.pos.map(p => `<tr class="sc-row" data-hm="${upbit.toMarket(p.symbol)}" data-hs="${esc(p.symbol)}">
      <td class="l"><b class="hold-nm">${esc(nameOf(upbit.toMarket(p.symbol)))}</b> <span class="mono muted">${upbit.toMarket(p.symbol).replace('KRW-', '')}</span></td>
      <td class="mono">${p.qty.toLocaleString('ko-KR', { maximumFractionDigits: 8 })}</td>
      <td class="mono">${fmtPrice(p.avg)}</td>
      <td class="mono ${toneOf(p.chg)}">${fmtPrice(p.cur)}</td>
      <td class="mono ${toneOf(p.chg)}">${fmtPct(p.chg)}</td>
      <td class="mono">${won(p.cost)}</td>
      <td class="mono">${p.value != null ? won(p.value) : ''}</td>
      <td class="mono ${toneOf(p.pnl)}">${p.pnl != null ? signWon(p.pnl) : ''}</td>
      <td class="mono ${toneOf(p.pct)}">${p.pct != null ? fmtPct(p.pct) : ''}</td>
      <td class="mono"><span class="wbar"><i style="width:${p.weight.toFixed(1)}%"></i></span>${p.weight.toFixed(1)}%</td>
      <td class="mono ${toneOf(p.realized)}">${p.realized ? signWon(p.realized) : ''}</td>
      <td><button data-hjournal="${esc(p.symbol)}">기록 보기</button></td></tr>`).join('')}
  </tbody></table>` + note;
  labelTables(box);
}
// 폰: 종목마다 큰 카드
function mHoldHtml(){
  if (S.acct !== 'paper' && !db.user) return '<div class="empty">로그인하면 보유 자산이 보여요.</div>';
  const H = holdData();
  const acct = UI.paperOn ? `<div class="m-chips"><button class="pill${S.acct !== 'paper' ? ' on' : ''}" data-macct="real">실제</button><button class="pill${S.acct === 'paper' ? ' on' : ''}" data-macct="paper">모의</button></div>` : '';
  return acct + holdSumHtml(H) + (H.pos.length ? H.pos.map(p => { const m = upbit.toMarket(p.symbol); return `<button class="m-hcard" data-mm="${m}">
      <div class="h1"><span class="hn">${mLogo(m)}<b>${esc(nameOf(m))}</b></span><span class="m-pct ${toneOf(p.pct)}">${p.pct != null ? fmtPct(p.pct) : ''}</span></div>
      <div class="h2"><span class="mono ${toneOf(p.pnl)}">${p.pnl != null ? signWon(p.pnl) : ''}</span><span class="mono">${p.value != null ? won(p.value) + '원' : ''}</span></div>
      <div class="h3 muted"><span>평단 <span class="mono">${fmtPrice(p.avg)}</span> → 현재 <span class="mono ${toneOf(p.chg)}">${fmtPrice(p.cur)}</span></span><span>비중 ${p.weight.toFixed(0)}%</span></div>
    </button>`; }).join('') : `<div class="empty">${H.isPaper ? '모의 보유 종목이 없어요.' : '지금 보유 중인 종목이 없어요.'}</div>`);
}
function showJournalFor(sym){
  S.jSym = sym;
  if (PH.on){ mGo('journal'); return; }
  $('#jTabs [data-j="journal"]').click();
}
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (isHoldOpen() && $('#holdBody').offsetParent) renderHold();
  if (PH.on && PH.page === 'hold') $('#mHold').innerHTML = mHoldHtml();
}, 3000);

// ---------------------------------------------------------------- 거래일지
// 업비트 잔고(도우미가 5분마다 올림)가 있으면 실제 보유는 잔고 기준. 5,000원 미만 먼지는 뺌
let balMark = null;
function balPositions(){
  if (!S.bal || Date.now() - Date.parse(S.bal.at) > 2 * 86400000) return null;
  const out = [];
  for (const a of S.bal.accounts || []){
    if (a.currency === 'KRW' || (a.unit_currency && a.unit_currency !== 'KRW')) continue;
    const symbol = upbit.toSymbol('KRW-' + a.currency), qty = +a.balance + +(a.locked || 0), avg = +a.avg_buy_price || 0;
    const cur = priceOf(symbol), px = cur || avg;
    if (!(qty > 0) || qty * px < 5000) continue;
    const cost = qty * avg, value = cur != null ? cur * qty : null;
    out.push({ symbol, qty, avg, cost, value, pnl: value != null ? value * (1 - FEE_RATE) - cost : null, fromUpbit: true });
  }
  return out;
}
async function loadBal(){
  if (!db.user) return;
  const b = await loadBalances(); if (!b || b.at === balMark) return;
  balMark = b.at; S.bal = b;
  recompute(); await reconcileCarry();
  renderStatus(); if (S.tab === 'hold') renderWatch(); if (isHoldOpen()) renderHold(); if (PH.on && PH.page === 'hold') $('#mHold').innerHTML = mHoldHtml();
}
// 기록상 수량이 업비트 잔고보다 많고 그 종목에 "기초 이월"이 있으면 → 중복된 이월을 지운 기록으로 (원본은 남고 복구 가능)
let reconciling = false;
async function reconcileCarry(){
  if (reconciling || !S.ledgerReal.positionsRec) return;
  reconciling = true; let n = 0;
  try{
    const bal = new Map((balPositions() || []).map(p => [p.symbol, p.qty]));
    for (const p of S.ledgerReal.positionsRec){
      const px = priceOf(p.symbol) || p.avg; let excess = p.qty - (bal.get(p.symbol) || 0);
      if (excess * px < 5000) continue;
      const carries = S.ledgerReal.rows.filter(r => r.symbol === p.symbol && r.source === 'carry_over' && r.id != null).sort((a, b) => Date.parse(b.executed_at) - Date.parse(a.executed_at));
      for (const c of carries){
        if (c.qty > excess * 1.001 + 1e-9) continue;
        if (await hideTrade(c, '업비트 잔고와 맞춤: 실제 체결이 들어와 중복된 기초 이월')){ excess -= c.qty; n++; }
        if (excess * px < 5000) break;
      }
    }
    if (n){ S.trades = await loadTrades(); recompute(); renderJournal(); toast(`업비트 잔고에 맞춰 중복된 기초 이월 ${n}건을 지운 기록으로 옮겼어요. (거래일지 > 지운 기록에서 복구 가능)`); }
  }catch(e){ /* 다음에 다시 */ }
  reconciling = false;
}
function recompute(){
  S.ledgerReal = computeLedger(S.trades.filter(t => t.source !== 'paper'), priceOf);
  const bp = balPositions(); S.ledgerReal.positionsRec = S.ledgerReal.positions; if (bp) S.ledgerReal.positions = bp;
  S.ledgerPaper = computeLedger(paper.trades, priceOf);
  S.ledger = S.acct === 'paper' ? S.ledgerPaper : S.ledgerReal;
}
function renderJournal(){
  if (S.acct === 'paper') return renderJournalRows(true);
  if (!db.user){ $('#jBody').innerHTML = '<div class="empty">로그인하면 거래 기록이 보여요. 기존 보유 종목은 "기초 이월" 매수로 옮겨져 있어요.</div>'; $('#jSummary').textContent = ''; return; }
  renderJournalRows(false);
}
function renderJournalRows(isPaper){
  recompute();
  let rows = S.ledger.rows.slice().reverse();
  if (S.jSym) rows = rows.filter(r => r.symbol === S.jSym);
  renderStatus();
  const hidden = isPaper ? [] : (S.ledger.hidden || []).slice().reverse();
  if (isPaper && !rows.length){ $('#jBody').innerHTML = '<div class="empty">아직 모의 체결이 없어요. 오른쪽 주문 칸에서 모의 매수를 해 보세요.</div>'; $('#jSummary').textContent = ''; return; }
  if (!rows.length && !hidden.length && !S.jSym){ $('#jBody').innerHTML = `<div class="empty">${db.tablesOk === false ? '기록 테이블이 아직 없어요. Supabase에 PHASE 1 SQL을 실행하면 보여요.' : '아직 거래 기록이 없어요. 위 "기록 추가"로 직접 넣거나 "업비트 가져오기"를 쓰세요.'}</div>`; $('#jSummary').textContent = ''; return; }
  const realized = rows.reduce((s, r) => s + (r.realized || 0), 0);
  $('#jSummary').innerHTML = (S.jSym ? `<button class="pill sm on" data-jsym-clear title="모든 종목 보기">${esc(nameOf(upbit.toMarket(S.jSym)))}만 보는 중 ✕</button> ` : '') + `${rows.length}건 · 실현손익 <b class="mono ${toneOf(realized)}">${realized ? (realized > 0 ? '+' : '') + Math.round(realized).toLocaleString('ko-KR') : '0'}</b>${hidden.length ? ` · <button class="linkbtn" data-showhidden>지운 기록 ${hidden.length}건 ${S.showHidden ? '숨기기' : '보기'}</button>` : ''}`;
  const name = s => (S.byMarket.get(upbit.toMarket(s)) || {}).name || s;
  const src = { carry_over: '기초 이월', manual: '직접 입력', paper: '모의', upbit_import: '업비트', real: '실거래' };
  const when = t => new Date(t).toLocaleString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const head = `<thead><tr><th class="l">종목</th><th class="l">추세</th><th class="l">구분</th><th>체결가</th><th>수량</th><th>수수료</th><th>실현손익</th><th>수익률</th><th>현재가 대비</th><th class="l">출처·전략</th><th class="l">판단 이유</th><th class="l">일시</th><th class="l">ID</th><th></th></tr></thead>`;
  const tr = (r, gone) => `<tr class="${r.side === 'buy' ? 'r-buy' : 'r-sell'}${gone ? ' gone' : ''}" data-m="${upbit.toMarket(r.symbol)}">
      <td class="l sym">${esc(name(r.symbol))}</td>
      <td class="l spk">${sparkHtml(r)}</td>
      <td class="l ${r.side === 'buy' ? 'up' : 'down'} side">${r.side === 'buy' ? '매수' : '매도'}</td>
      <td class="mono">${fmtPrice(r.price)}</td>
      <td class="mono">${(+r.qty).toLocaleString('ko-KR', { maximumFractionDigits: 8 })}</td>
      <td class="mono">${Math.round(r.fee || 0).toLocaleString('ko-KR')}</td>
      <td class="mono ${toneOf(r.realized)}">${!gone && r.realized != null ? (r.realized > 0 ? '+' : '') + Math.round(r.realized).toLocaleString('ko-KR') : ''}</td>
      <td class="mono ${toneOf(r.realizedPct)}">${!gone && r.realizedPct != null ? fmtPct(r.realizedPct) : ''}</td>
      <td class="mono ${toneOf(r.vsNow)}"${!gone && r.side === 'buy' ? ` data-lv="vs" data-s="${r.symbol}" data-p="${r.price}"` : ''}>${!gone && r.side === 'buy' && r.vsNow != null ? fmtPct(r.vsNow) : ''}</td>
      <td class="l">${esc([src[r.source] || r.source, r.strategy].filter(Boolean).join(' · '))}</td>
      <td class="l reason" title="${esc(r.reason || '')}">${esc(r.reason || '')}</td>
      <td class="l mono when">${when(r.executed_at)}</td>
      <td class="l mono muted">${esc(r.trade_no)}</td>
      <td class="acts">${r.id == null ? '' : gone ? `<button data-restore="${r.hiddenBy.id}" data-tid="${r.id}">복구</button>`
        : `${r.source === 'manual' ? `<button data-edit="${r.id}">수정</button>` : ''}<button data-hide="${r.id}">지우기</button>`}</td></tr>`;
  $('#jBody').innerHTML = `<table class="jt">${head}<tbody>${rows.map(r => tr(r, false)).join('')}</tbody></table>` +
    (S.showHidden && hidden.length ? `<div class="ot-title">지운 기록 <span class="muted">${hidden.length}건 · 손익 계산에서 빠져 있어요. "복구"로 되돌릴 수 있어요.</span></div><table class="jt gone-t">${head}<tbody>${hidden.map(r => tr(r, true)).join('')}</tbody></table>` : '');
  labelTables($('#jBody'));
  loadSparks(rows.concat(S.showHidden ? hidden : []));
}

// ---------------------------------------------------------------- 거래일지 추세선 (일봉 종가 실루엣 + 거래 지점)
const sparkCache = new Map();   // market|days → { day, closes:[{t,c}] } (하루에 한 번만 받음)
const sparkKey = m => `${m}|${+UI.sparkDays || 30}`;
function sparkHtml(r){
  const d = sparkCache.get(sparkKey(upbit.toMarket(r.symbol)));
  if (!d || !d.closes || d.closes.length < 2) return '<span class="spark-ph"></span>';
  const W = 96, H = 24, C = d.closes, n = C.length;
  const day = new Date(r.executed_at).toISOString().slice(0, 10);
  const di = day < C[0].t ? null : (i => i < 0 ? null : i)(C.findIndex(p => p.t >= day));   // 기간 밖 거래는 점 없음
  const vals = C.map(x => x.c), lo = Math.min(...vals, di == null ? Infinity : r.price), hi = Math.max(...vals, di == null ? -Infinity : r.price), span = hi - lo || 1;
  const y = v => (H - 2 - (v - lo) / span * (H - 4)).toFixed(1), x = i => (i / (n - 1) * W).toFixed(1);
  const pts = C.map((p, i) => `${x(i)},${y(p.c)}`).join(' ');
  const col = r.side === 'buy' ? 'var(--up)' : 'var(--down)';
  const dot = di == null ? '' : `<circle cx="${x(di)}" cy="${y(r.price)}" r="2.6" fill="${col}" stroke="var(--panel)" stroke-width="1"/>`;
  return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,${H} ${pts} ${W},${H}" fill="${col}" opacity=".12"/><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.3" stroke-linejoin="round"/>${dot}</svg>`;
}
let sparkBusy = false;
async function loadSparks(rows){
  if (sparkBusy) return;
  const today = new Date().toISOString().slice(0, 10), days = +UI.sparkDays || 30;
  const need = [...new Set(rows.map(r => upbit.toMarket(r.symbol)))].filter(m => S.byMarket.has(m) && (sparkCache.get(sparkKey(m)) || {}).day !== today);
  if (!need.length) return;
  sparkBusy = true;
  try{
    for (const m of need.slice(0, 40)){
      try { const c = await upbit.getCandles(m, '1d', { count: days }); sparkCache.set(sparkKey(m), { day: today, closes: c.map(k => ({ t: k.t, c: k.c })) }); }
      catch(e){ sparkCache.set(sparkKey(m), { day: today, closes: [] }); }
    }
  } finally { sparkBusy = false; }
  if (!$('#jBody').classList.contains('hidden')) renderJournal();
}

// ---------------------------------------------------------------- 거래일지: 직접 기록 · 수정 · 숨김 · 복구
// ---------------------------------------------------------------- 기록 · 모의 창 (왼쪽: 작은 차트 + 호가, 오른쪽: [기록 | 모의])
const REC = { m: null, chart: null, series: null, line: null, poll: 0, tab: 'rec' };
const recOpen = () => $('#addDlg').open;
function openRec(tab = 'rec', { edit = null, price = null, side = null } = {}){
  if (edit) tab = 'rec';
  const f = $('#addForm'), r = edit || null;
  f.dataset.edit = r ? r.id : '';
  $('#addTitle').textContent = r ? '기록 수정 · 고치기 전 기록은 "지운 기록"에 남아요.' : '거래일지(실제 기록)에 적어요. 손익은 자동 계산돼요.';
  const m = r ? upbit.toMarket(r.symbol) : S.sel, inst = S.byMarket.get(m);
  f.elements.sym.value = inst ? `${inst.name} (${inst.market.slice(4)})` : '';
  f.elements.side.value = r ? r.side : (side || 'buy');
  f.elements.price.value = r ? r.price : (price || priceOf(upbit.toSymbol(m)) || '');
  f.elements.qty.value = r ? r.qty : ''; f.elements.amount.value = '';
  f.elements.fee.value = r ? r.fee : '';
  const d = r ? new Date(r.executed_at) : new Date(), pad = v => String(v).padStart(2, '0');
  f.elements.at.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  f.elements.memo.value = r ? (r.reason || '') : '';
  $('#addMsg').textContent = '';
  if (price){ OF.price = price; OF.type = 'limit'; }
  if (side) OF.side = side;
  renderAddSide();
  if (!recOpen()) $('#addDlg').showModal();
  setRecTab(tab); setRecMarket(m);
}
function openAddDlg(edit){ openRec('rec', { edit }); }
function setRecTab(t){
  REC.tab = t; LS.set('quantera:recTab', t);
  $$('#recTabs [data-rt]').forEach(b => b.classList.toggle('on', b.dataset.rt === t));
  $('#recPaneRec').classList.toggle('hidden', t !== 'rec'); $('#recPanePaper').classList.toggle('hidden', t !== 'paper');
  if (t === 'paper'){ if (REC.m && REC.m !== S.sel) select(REC.m); renderOrderForm(); }
  recPriceLine();
}
async function setRecMarket(m){
  if (!S.byMarket.has(m)) return;
  const changed = REC.m !== m; REC.m = m;
  const inst = S.byMarket.get(m), q = S.quotes.get(m) || {};
  $('#recName').textContent = inst.name; $('#recTf').textContent = `${(CONFIG.timeframes.find(t => t.id === S.tf) || {}).label || S.tf} · ${m.slice(4)}`;
  $('#recPx').innerHTML = q.price ? `<span class="${toneOf(q.changeRate)}">${fmtPrice(q.price)} ${fmtPct(q.changeRate)}</span>` : '';
  if (!REC.chart && window.LightweightCharts){
    const LC = window.LightweightCharts;
    REC.chart = LC.createChart($('#recChart'), { autoSize: true, localization: { locale: 'ko-KR', priceFormatter: p => fmtPrice(p) }, layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#9A9AA3', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' },
      grid: { vertLines: { color: '#24242A' }, horzLines: { color: '#24242A' } }, rightPriceScale: { borderColor: '#24242A' }, timeScale: { borderColor: '#24242A', timeVisible: S.tf !== '1d' },
      crosshair: { mode: 0 }, handleScroll: false, handleScale: false });
    REC.series = REC.chart.addCandlestickSeries({ upColor: '#F04452', downColor: '#4C8DFF', borderVisible: false, wickUpColor: '#F04452', wickDownColor: '#4C8DFF', priceFormat: { type: 'price', precision: 0, minMove: 1 } });
  }
  if (changed){ REC.centered = null; $('#recOb').innerHTML = '<div class="empty">호가 불러오는 중…</div>'; if (REC.series) REC.series.setData([]); }
  if (REC.series && changed){
    try{
      const c = await upbit.getCandles(m, S.tf, { count: 90 });
      if (REC.m !== m) return;
      const prec = c.length ? decimalsOf(c[c.length - 1].c) : 0;
      REC.series.applyOptions({ priceFormat: { type: 'price', precision: prec, minMove: 1 / 10 ** prec } });
      REC.series.setData(c.map(k => ({ time: k.time, open: k.o, high: k.h, low: k.l, close: k.c })));
      REC.chart.timeScale().fitContent();
    }catch(e){}
  }
  recPriceLine();
  clearInterval(REC.poll);
  const pull = () => { if (!recOpen()) return clearInterval(REC.poll); if (REC.m !== S.sel || !$('#recOb .ob-row')) upbit.getOrderbook(REC.m).then(ob => ob && ob.market === REC.m && renderRecOb(ob)).catch(() => {}); };
  pull(); REC.poll = setInterval(pull, 2000);
}
const decimalsOf = p => p >= 100 ? 0 : p >= 10 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 4 : 8;
function recPriceLine(){
  if (!REC.series) return;
  if (REC.line){ try { REC.series.removePriceLine(REC.line); } catch(e){} REC.line = null; }
  const v = REC.tab === 'rec' ? num($('#addForm').elements.price.value) : num(OF.price);
  if (v > 0) REC.line = REC.series.createPriceLine({ price: v, color: '#C6F432', lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: REC.tab === 'rec' ? '기록가' : '주문가' });
}
function renderRecOb(ob){
  const el = $('#recOb'); if (!el || !ob) return;
  const n = isPhone() ? 8 : 10, units = ob.units.slice(0, n);
  const max = Math.max(...units.map(u => Math.max(u.askSize, u.bidSize)), 1e-9);
  const q = S.quotes.get(ob.market) || {}, pc = q.prevClose || null, tone = p => pc ? toneOf(p - pc) : '';
  const row = (side, p, sz) => { const cur = q.price != null && Math.abs(p - q.price) < 1e-9;
    return `<div class="ob-row ${side}${cur ? ' cur' : ''}" data-p="${p}"><i style="width:${sz / max * 100}%"></i><span class="p mono ${tone(p)}">${fmtPrice(p)}</span><span class="sz mono">${fmtQty(sz)}</span></div>`; };
  el.innerHTML = units.slice().reverse().map(u => row('ask', u.ask, u.askSize)).join('') + units.map(u => row('bid', u.bid, u.bidSize)).join('');
  if (REC.centered !== ob.market){ REC.centered = ob.market; requestAnimationFrame(() => { el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; }); }
  if (q.price) $('#recPx').innerHTML = `<span class="${toneOf(q.changeRate)}">${fmtPrice(q.price)} ${fmtPct(q.changeRate)}</span>`;
}
function bindRec(){
  $('#recTabs').addEventListener('click', e => { const b = e.target.closest('[data-rt]'); if (b) setRecTab(b.dataset.rt); });
  $('#recClose').addEventListener('click', () => $('#addDlg').close());
  $('#addDlg').addEventListener('close', () => { clearInterval(REC.poll); REC.centered = null; });
  $('#bookRecBtn').addEventListener('click', () => openRec(LS.get('quantera:recTab', 'rec')));
  $('#recOb').addEventListener('click', e => {
    const row = e.target.closest('.ob-row'); if (!row) return;
    const p = Math.round(+row.dataset.p * 1e8) / 1e8;
    if (REC.tab === 'rec'){ $('#addForm').elements.price.value = p; addPreview(); }
    else { OF.price = p; OF.type = 'limit'; renderOrderForm(); }
    recPriceLine();
  });
  $('#addForm').elements.price.addEventListener('input', recPriceLine);
  $('#orderBox').addEventListener('input', e => { if (e.target.dataset.f === 'price') recPriceLine(); });
  $('#addForm').elements.sym.addEventListener('change', e => { const i = findInst(e.target.value); if (i && i.market !== REC.m){ setRecMarket(i.market); const p = priceOf(i.symbol); if (p && !$('#addForm').dataset.edit) $('#addForm').elements.price.value = p; } });
  $('#addDlg').addEventListener('click', e => { if (e.target === $('#addDlg')) $('#addDlg').close(); });
}
function renderAddSide(){
  const f = $('#addForm'), v = f.elements.side.value, go = $('#addGo');
  $$('#addForm [data-aside]').forEach(b => b.classList.toggle('on', b.dataset.aside === v));
  go.className = 'submit ' + v; go.textContent = `${f.dataset.edit ? '고쳐 저장' : '기록 저장'} · ${v === 'buy' ? '매수' : '매도'}`;
  addPreview();
}
// 기록 창 아래 합계: 수량이나 금액 중 하나만 넣어도 나머지를 계산해 보여 줌
function addPreview(){
  const f = $('#addForm').elements, pv = $('#addPv'); if (!pv) return;
  const p = num(f.price.value); let q = num(f.qty.value), a = num(f.amount.value);
  if (p > 0 && q > 0) a = p * q; else if (p > 0 && a > 0) q = a / p;
  if (!(p > 0 && q > 0)){ pv.innerHTML = '<div><span>가격과 수량(또는 금액)을 넣으면 합계가 보여요.</span></div>'; return; }
  const fee = num(f.fee.value) > 0 ? num(f.fee.value) : 0;
  pv.innerHTML = `<div><span>수량</span><b class="mono">${q.toLocaleString('ko-KR', { maximumFractionDigits: 8 })}</b></div><div><span>금액</span><b class="mono">${won(a)}원</b></div>${fee ? `<div><span>수수료 포함</span><b class="mono">${won(f.side.value === 'buy' ? a + fee : a - fee)}원</b></div>` : ''}`;
}
function findInst(text){
  const t = String(text || '').trim().toLowerCase(); if (!t) return null;
  const code = (t.match(/\(([a-z0-9]+)\)\s*$/) || [])[1];
  return S.instruments.find(i => code ? i.market.slice(4).toLowerCase() === code : (i.name.toLowerCase() === t || i.market.slice(4).toLowerCase() === t || i.market.toLowerCase() === t)) || null;
}
function bindJournalEdit(){
  $('#jAddBtn').addEventListener('click', () => openRec('rec'));
  bindRec();
  $('#addSyms').innerHTML = '';
  $('#addForm').addEventListener('click', e => {
    const b = e.target.closest('[data-aside]'); if (b){ e.preventDefault(); $('#addForm').elements.side.value = b.dataset.aside; renderAddSide(); }
    if (e.target.closest('[data-autofee]')){ e.preventDefault(); const f = $('#addForm').elements, p = num(f.price.value), q = num(f.qty.value) || num(f.amount.value) / p; if (p > 0 && q > 0) f.fee.value = r2(p * q * FEE_RATE); addPreview(); }
    if (e.target.closest('[data-reccur]')){ e.preventDefault(); const f = $('#addForm').elements, i = findInst(f.sym.value), p = i && priceOf(i.symbol); if (p){ f.price.value = p; recPriceLine(); addPreview(); } }
  });
  $('#addForm').addEventListener('input', addPreview);
  $('#addForm').elements.sym.addEventListener('focus', () => { if (!$('#addSyms').children.length) $('#addSyms').innerHTML = S.instruments.map(i => `<option value="${esc(i.name)} (${i.market.slice(4)})">`).join(''); });
  $('#addForm').addEventListener('submit', async e => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const f = $('#addForm').elements, msg = t => $('#addMsg').textContent = t;
    if (!db.user){ msg('기록 저장은 로그인 후에 할 수 있어요. 모의 주문은 로그인 없이도 돼요.'); $('#loginDlg').showModal(); return; }
    const inst = findInst(f.sym.value); if (!inst) return msg('종목을 목록에서 골라 주세요. (예: 비트코인 (BTC))');
    const price = num(f.price.value); if (!(price > 0)) return msg('가격을 넣어 주세요.');
    let qty = num(f.qty.value); if (!(qty > 0) && num(f.amount.value) > 0) qty = num(f.amount.value) / price;
    if (!(qty > 0)) return msg('수량이나 금액을 넣어 주세요.');
    const at = f.at.value ? new Date(f.at.value) : new Date(); if (isNaN(at)) return msg('날짜·시간을 확인해 주세요.');
    const editId = $('#addForm').dataset.edit ? +$('#addForm').dataset.edit : null;
    const row = { trade_no: 'M-' + Date.now().toString(36).toUpperCase(), source: 'manual', symbol: inst.symbol, side: f.side.value,
      price, qty, fee: num(f.fee.value) > 0 ? num(f.fee.value) : 0, executed_at: at.toISOString(), reason: f.memo.value.trim() || null,
      guide: editId ? { edit_of: editId } : null };
    $('#addGo').disabled = true;
    try{
      if (editId){ const old = S.trades.find(t => t.id === editId); if (old) await hideTrade(old, '수정 전 기록'); }
      await addTrade(row);
      S.trades = await loadTrades(); recompute(); renderJournal(); renderStatus(); applyGuideToChart();
      $('#addDlg').close(); toast(editId ? '기록을 고쳤어요. 고치기 전 기록은 "지운 기록"에 남아요.' : '기록을 추가했어요.', 'up');
    }catch(err){ msg(err.message || String(err)); }
    finally{ $('#addGo').disabled = false; }
  });
  $('#jBody').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    e.stopPropagation();
    if (b.hasAttribute('data-showhidden')) return;
    try{
      if (b.dataset.edit){ const r = S.trades.find(t => t.id === +b.dataset.edit); if (r) openAddDlg(r); return; }
      if (b.dataset.hide){
        const r = S.trades.find(t => t.id === +b.dataset.hide); if (!r) return;
        if (!confirm(`이 기록을 지울까요?\n${nameOf(upbit.toMarket(r.symbol))} ${r.side === 'buy' ? '매수' : '매도'} ${fmtPrice(r.price)} × ${(+r.qty).toLocaleString('ko-KR', { maximumFractionDigits: 8 })}\n\n손익 계산에서 빠지고 "지운 기록 보기"에서 복구할 수 있어요.`)) return;
        await hideTrade(r, '지움');
      } else if (b.dataset.restore){
        const v = S.trades.find(t => t.id === +b.dataset.restore); if (!v) return;
        await hideTrade(v, '복구');
      } else return;
      S.trades = await loadTrades(); recompute(); renderJournal(); renderStatus(); applyGuideToChart();
    }catch(err){ alert(err.message || String(err)); }
  });
  $('#holdBody').addEventListener('click', e => {
    const j = e.target.closest('[data-hjournal]'); if (j){ showJournalFor(j.dataset.hjournal); return; }
    const r = e.target.closest('[data-hm]'); if (r){ if (document.body.dataset.view) setView('trade'); select(r.dataset.hm); }
  });
  $('#jSummary').addEventListener('click', e => { if (e.target.closest('[data-jsym-clear]')){ S.jSym = null; renderJournal(); return; } if (e.target.closest('[data-showhidden]')){ S.showHidden = !S.showHidden; renderJournal(); } });
}
// 숨김 = 대상을 가리키는 무효 기록을 하나 더 쌓음 (원래 기록은 그대로). 무효 기록을 숨기면 복구
function hideTrade(t, why){
  return addTrade({ trade_no: 'V-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 4).toUpperCase(), source: 'manual',
    symbol: t.symbol, side: t.side, price: t.price, qty: t.qty, fee: 0, executed_at: new Date().toISOString(), voids_trade_id: t.id, reason: why });
}
// 하단 바: 계좌 구분 + 총자산 + 평가손익
function renderStatus(){
  const pos = S.ledger.positions, val = pos.reduce((s, p) => s + (p.value || 0), 0), pnl = pos.reduce((s, p) => s + (p.pnl || 0), 0);
  const isP = S.acct === 'paper';
  $('#sbAcct').textContent = isP ? '모의' : '실제 기록'; $('#sbAcct').className = 'sb-acct' + (isP ? '' : ' real');
  if (isP){
    const total = paper.state.cash + val, ret = (total / paper.state.start - 1) * 100;
    $('#sbAssets').innerHTML = `${won(total)} <span class="${toneOf(ret)}">(${fmtPct(ret)})</span>`;
  } else $('#sbAssets').textContent = val ? won(val) : '-';
  $('#sbPnl').textContent = pos.length ? (pnl > 0 ? '+' : '') + won(pnl) : '-';
  $('#sbPnl').className = 'mono ' + toneOf(pnl);
  const halted = paper.state.halted;
  for (const b of [$('#estop'), $('#estopM')]) if (b){ b.classList.toggle('on', halted); b.textContent = halted ? (b.id === 'estopM' ? '긴급 정지 중 · 눌러서 해제' : '정지 중 · 해제') : (b.id === 'estopM' ? '긴급 정지 · 모의 주문 전체 멈춤' : '긴급 정지'); }
}
const won = v => Math.round(v).toLocaleString('ko-KR');
// 도우미가 올린 업비트 체결을 바로 반영: 15초마다 가장 큰 id만 확인하고, 바뀌었을 때만 다시 읽음
let tradeMark = null;
async function reloadTrades(force){
  if (!db.user) return;
  const mark = await lastTradeId(); if (mark == null) return;
  const known = S.trades.reduce((m, t) => Math.max(m, +t.id || 0), 0);
  if (!force && mark === tradeMark && mark <= known) return;
  tradeMark = mark;
  if (!force && mark <= known) return;
  const t = await loadTrades(); if (!t || !t.length) return;
  const fresh = known ? t.filter(x => +x.id > known && x.source === 'upbit_import' && !x.voids_trade_id) : [];
  S.trades = t; recompute(); renderJournal(); renderStatus(); applyGuideToChart();
  if (fresh.length){
    const f = fresh[fresh.length - 1];
    toast(`업비트 체결 ${fresh.length}건이 들어왔어요 · ${nameOf(upbit.toMarket(f.symbol))} ${f.side === 'buy' ? '매수' : '매도'} ${fmtPrice(f.price)}`, 'up');
    beep('one');
  }
}
setInterval(() => { if (document.visibilityState === 'visible') reloadTrades(); }, 15000);
setInterval(() => { if (document.visibilityState === 'visible') loadBal(); }, 15000);
setInterval(() => { if ((db.user && S.trades.length) || paper.trades.length) renderJournal(); if (isOrdersOpen()) renderOrders(); }, 15000);


// ---------------------------------------------------------------- 일별 시세 (고른 종목, 한 달씩)
const dailyCache = new Map();   // market|YYYY-MM → candles
S.dayMonth = 0;                 // 0 = 이번 달, -1 = 지난달 …
function monthOf(off){ const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + off); return { y: d.getFullYear(), m: d.getMonth() }; }
async function renderDaily(target = $('#dayBody')){
  if (!target || !S.sel) return;
  const m = S.sel, { y, m: mo } = monthOf(S.dayMonth), key = `${m}|${y}-${String(mo + 1).padStart(2, '0')}`;
  const nm = nameOf(m), label = `${y}년 ${mo + 1}월`;
  const nav = `<div class="day-nav"><button class="pill sm" data-dmon="-1" aria-label="이전 달">◀</button><b>${label}</b><button class="pill sm" data-dmon="1" ${S.dayMonth >= 0 ? 'disabled' : ''} aria-label="다음 달">▶</button><span class="muted">${esc(nm)} · 일봉 (오전 9시 기준)</span>${S.dayMonth ? '<button class="linkbtn" data-dmon="0">이번 달</button>' : ''}</div>`;
  if (!dailyCache.has(key)){
    target.innerHTML = nav + '<div class="empty">불러오는 중…</div>';
    try{
      const days = new Date(y, mo + 1, 0).getDate();
      const to = new Date(Date.UTC(y, mo + 1, 1)).toISOString().replace('.000', '');
      const c = await upbit.getCandles(m, '1d', { count: days + 1, to });
      dailyCache.set(key, c);
    }catch(e){ target.innerHTML = nav + `<div class="empty">일봉을 불러오지 못했어요. (${esc(e.message)})</div>`; return; }
    if (S.sel !== m) return;
  }
  const all = dailyCache.get(key), ym = `${y}-${String(mo + 1).padStart(2, '0')}`;
  const list = all.filter(c => c.t.startsWith(ym));
  if (!list.length){ target.innerHTML = nav + '<div class="empty">이 달엔 거래 기록이 없어요 (상장 전일 수 있어요).</div>'; return; }
  const prevOf = c => { const i = all.indexOf(c); return i > 0 ? all[i - 1].c : null; };
  // 내 거래한 날 (실제 + 모의 켜짐이면 모의)
  const sym = upbit.toSymbol(m), mine = new Map();
  for (const r of [...S.ledgerReal.rows, ...(UI.paperOn ? S.ledgerPaper.rows : [])]) if (r.symbol === sym){
    const d = new Date(Date.parse(r.executed_at) - 9 * 3600e3 + 9 * 3600e3); // 업비트 일봉은 한국 시간 오전 9시 시작 = UTC 날짜
    const k = new Date(Date.parse(r.executed_at)).toISOString().slice(0, 10); const v = mine.get(k) || { b: 0, s: 0 }; r.side === 'buy' ? v.b++ : v.s++; mine.set(k, v);
  }
  const first = list[0], last = list[list.length - 1], base = prevOf(first) || first.o;
  const hi = Math.max(...list.map(c => c.h)), lo = Math.min(...list.map(c => c.l)), val = list.reduce((a, c) => a + (c.value || 0), 0);
  const ret = (last.c / base - 1) * 100;
  const sum = `<div class="day-sum"><span>월간 <b class="${toneOf(ret)}">${fmtPct(ret)}</b></span><span>고가 <b class="mono">${fmtPrice(hi)}</b></span><span>저가 <b class="mono">${fmtPrice(lo)}</b></span><span>변동폭 <b class="mono">${fmtPct((hi / lo - 1) * 100, 1).replace('+', '')}</b></span><span>거래대금 <b class="mono">${fmtKrwShort(val)}</b></span>${[...mine.keys()].some(k => k.startsWith(ym)) ? `<span>내 거래한 날 <b>${[...mine.keys()].filter(k => k.startsWith(ym)).length}일</b></span>` : ''}</div>`;
  const wd = ['일', '월', '화', '수', '목', '금', '토'];
  const rows = list.slice().reverse().map(c => {
    const p = prevOf(c), chg = p ? (c.c / p - 1) * 100 : null, rng = (c.h / c.l - 1) * 100, my = mine.get(c.t);
    const dd = new Date(c.t + 'T00:00:00Z');
    return `<tr class="${my ? 'mine' : ''}"><td class="l mono">${c.t.slice(5).replace('-', '.')} <span class="muted">${wd[dd.getUTCDay()]}</span>${my ? ` <span class="my-dot">${my.b ? `<i class="up">매수${my.b > 1 ? my.b : ''}</i>` : ''}${my.s ? `<i class="down">매도${my.s > 1 ? my.s : ''}</i>` : ''}</span>` : ''}</td>
      <td class="mono">${fmtPrice(c.o)}</td><td class="mono up">${fmtPrice(c.h)}</td><td class="mono down">${fmtPrice(c.l)}</td><td class="mono ${toneOf(chg)}"><b>${fmtPrice(c.c)}</b></td>
      <td class="mono ${toneOf(chg)}">${chg == null ? '-' : fmtPct(chg)}</td><td class="mono muted">${rng.toFixed(1)}%</td>
      <td class="mono">${(c.v || 0).toLocaleString('ko-KR', { maximumFractionDigits: c.v >= 100 ? 0 : 2 })}</td><td class="mono">${fmtKrwShort(c.value)}</td></tr>`;
  }).join('');
  target.innerHTML = nav + sum + `<table class="ot dayt"><thead><tr><th class="l">날짜</th><th>시가</th><th>고가</th><th>저가</th><th>종가</th><th>전일 대비</th><th>변동폭</th><th>거래량</th><th>거래대금</th></tr></thead><tbody>${rows}</tbody></table>`;
  labelTables(target);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-dmon]'); if (!b) return;
  const v = +b.dataset.dmon; S.dayMonth = v === 0 ? 0 : Math.min(0, S.dayMonth + v);
  renderDailyAll();
});
function renderDailyAll(){ if (!$('#dayBody').classList.contains('hidden')) renderDaily($('#dayBody')); const md = $('#mDay'); if (md && md.offsetParent) renderDaily(md); }

// ---------------------------------------------------------------- 분석 일괄
async function analyzeList(markets){
  for (const m of [...new Set(markets)]){
    const inst = S.byMarket.get(m); if (!inst || S.results.has(m)) continue;
    try { setResult(m, await analyzeOne(inst, S.quotes.get(m))); } catch(e){}
  }
  renderJournal(); renderWatch(); if (S.sel) renderHead();
}
// 자동 스캔: 앱을 열면 한 번, 그 뒤 켜져 있는 동안 30분마다 (캔들은 기기에 캐시라 다시 받는 양은 적음)
const SCAN_EVERY = 30 * 60000, SCAN_KEY = 'quantera:lastScan';
function scanLabel(){
  const t = LS.get(SCAN_KEY, 0);
  return t ? `${new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })} 스캔 · 30분마다 자동` : '열면 자동 스캔';
}
function autoScan(force){
  if (S.scanning || document.hidden) return;
  if (!force && S.results.size > 50 && Date.now() - (LS.get(SCAN_KEY, 0) || 0) < SCAN_EVERY - 5000) return;
  toggleScan(true);
}
setInterval(() => autoScan(), 60000);
async function toggleScan(auto){
  if (S.scanning){ S.scanning.abort(); return; }
  S.scanning = new AbortController(); $('#scanBtn').textContent = '중지';
  const t0 = Date.now();
  await scanAll(S.instruments, S.quotes, {
    signal: S.scanning.signal,
    onResult: r => setResult(r.market, r),
    onProgress: (d, n) => { $('#scanProg').style.width = (d / n * 100) + '%'; $('#scanText').textContent = `${d}/${n}`; if (d % 20 === 0) renderWatch(); }
  });
  const aborted = S.scanning.signal.aborted;
  S.scanning = null; $('#scanBtn').textContent = '다시 스캔';
  if (!aborted) LS.set(SCAN_KEY, Date.now());
  $('#scanText').textContent = aborted ? '중지됨' : scanLabel();
  renderWatch();
}

// ---------------------------------------------------------------- 이벤트
function bindUi(){
  bindCfg();
  bindOrder();
  bindImport();
  bindJournalEdit();
  bindMobile();
  initPhone();
  document.addEventListener('click', e => { const b = e.target.closest('[data-mute]'); if (!b) return; e.stopPropagation(); setSurgeMute(+b.dataset.mute); }, true);
  renderMuteBtns();
  document.addEventListener('click', e => { const b = e.target.closest('[data-sound]'); if (!b) return; LS.set(SOUND_KEY, !soundOff()); renderSoundBtn(); if (!soundOff()) beep('up'); toast(soundOff() ? '알람 소리를 껐어요. 감지·알림 표시는 계속돼요.' : '알람 소리를 켰어요.'); });
  renderSoundBtn();
  bindWiki();
  bindStrat();
  $('#jTabs').addEventListener('click', e => {
    const b = e.target.closest('[data-j]'); if (!b) return;
    $$('#jTabs .pill').forEach(x => x.classList.toggle('on', x === b));
    const j = b.dataset.j, news = j === 'news';
    $('#jBody').classList.toggle('hidden', j !== 'journal'); $('#newsBody').classList.toggle('hidden', !news); $('#ordBody').classList.toggle('hidden', j !== 'orders'); $('#dayBody').classList.toggle('hidden', j !== 'day'); $('#holdBody').classList.toggle('hidden', j !== 'hold'); $('#jSummary').classList.toggle('hidden', j !== 'journal');
    if (j === 'hold') renderHold();
    if (news) renderNews(); if (j === 'orders') renderOrders(); if (j === 'day'){ S.dayMonth = S.dayMonth || 0; renderDaily($('#dayBody')); }
    if (j === 'journal') renderJournal();
  });
  $('#wlTabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (!b) return; S.tab = b.dataset.tab; $$('#wlTabs .pill').forEach(x => x.classList.toggle('on', x === b)); renderWatch(); });
  $('#wlBody').addEventListener('toggle', e => { if (e.target.classList && e.target.classList.contains('surge-stats')) LS.set(e.target.hasAttribute('data-bt') ? 'quantera:btStatsOpen' : 'quantera:surgeStatsOpen', e.target.open); }, true);
  $('#sdWrap').addEventListener('click', e => {
    if (e.target.closest('[data-surge-ack]')) return ackSurge();
    const c = e.target.closest('[data-sd]'); if (c) return toggleSd(c.dataset.sd);
  });
  $('#sdDock').addEventListener('click', e => {
    const k = e.target.closest('[data-ack-kind]'); if (k){ ackKind(k.dataset.ackKind); return; }
    const r = e.target.closest('[data-sdm]');
    if (r){ const m = r.dataset.sdm; ackSurge(m); renderSdDrop(true); select(m); if (isPhone()) setMobile('trade'); }
  });
  $('#sdDock').addEventListener('toggle', e => { if (e.target.classList && e.target.classList.contains('surge-stats')) LS.set('quantera:surgeStatsOpen', e.target.open); }, true);
  $('#wlBody').addEventListener('click', async e => {
    const st = e.target.closest('[data-star]');
    if (st){ e.stopPropagation(); const sym = st.dataset.star; const on = !S.watch.has(sym); S.watch = new Set(await setWatch(sym, on)); renderWatch(); return; }
    const ss = e.target.closest('[data-ssort]'); if (ss){ const k = ss.dataset.ssort; scanSort = { k, d: scanSort.k === k ? -scanSort.d : -1 }; LS.set('quantera:scanSort', scanSort); renderWatch(); return; }
    const sr = e.target.closest('.sc-row'); if (sr){ setView('trade'); select(sr.dataset.m); return; }
    const row = e.target.closest('.wl-row'); if (row){ select(row.dataset.m); if (isPhone()){ document.body.classList.remove('m-search'); setMobile('trade'); } }
  });
  $('#jBody').addEventListener('click', e => { if (e.target.closest('button')) return; const tr = e.target.closest('tr[data-m]'); if (tr){ select(tr.dataset.m); if (isPhone()) setMobile('trade'); } });
  $('#tfTabs').addEventListener('click', e => { const b = e.target.closest('[data-tf]'); if (!b) return; S.tf = b.dataset.tf; renderTf(); loadChart(); });
  let st; $('#search').addEventListener('input', e => { clearTimeout(st); st = setTimeout(() => { S.search = e.target.value.trim(); renderWatch(); }, 150); });
  $('#scanBtn').addEventListener('click', () => toggleScan(false));
  $$('.mtabs button').forEach(b => b.addEventListener('click', () => setMobile(b.dataset.m)));
  $$('.rail [data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  addEventListener('keydown', e => { if (e.key === 'Escape' && document.body.dataset.view && !document.querySelector('dialog[open]')) setView('trade'); });
  $('#loginBtn').addEventListener('click', async () => { if (db.user){ await logout(); return; } $('#lgMsg').textContent = ''; $('#loginDlg').showModal(); });
  $('#loginForm').addEventListener('submit', async e => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    $('#lgMsg').textContent = '로그인 중…';
    try { await login($('#lgEmail').value.trim(), $('#lgPw').value); $('#loginDlg').close(); }
    catch(err){ $('#lgMsg').textContent = err.message; }
  });
}
function setUi(patch, { noSave = false } = {}){
  const before = JSON.stringify(UI);
  UI = { ...UI, ...patch }; LS.set(UI_KEY, UI);
  if (!noSave) uiRemote.save(UI);
  applyUi(JSON.stringify(UI) !== before);
}
function applyUi(changed = true){
  $$('#jAcct [data-acct]').forEach(b => b.classList.toggle('on', b.dataset.acct === S.acct));
  document.body.classList.toggle('no-paper', !UI.paperOn);
  if (!UI.paperOn && S.acct === 'paper') setAcct('real');
  else if (changed){ renderOrderForm(); renderJournal(); }
  if (!UI.paperOn && isOrdersOpen()) $('#jTabs [data-j="journal"]').click();
}
// 왼쪽 메뉴: PC에서는 고른 내용을 화면 전체로 크게 (트레이딩 = 기본 화면, Esc로 돌아옴)
function setView(v){
  if (v === 'settings'){ openCfg(); return; }
  $$('.rail [data-view]').forEach(x => x.classList.toggle('on', x.dataset.view === v));
  if (v === 'trade') delete document.body.dataset.view; else document.body.dataset.view = v;
  const pickTab = t => { S.tab = t; $$('#wlTabs .pill').forEach(x => x.classList.toggle('on', x.dataset.tab === t)); renderWatch(); };
  if (v === 'scan') pickTab(['pullback', 'bottom', 'all', 'fav', 'hold'].includes(S.tab) ? S.tab : 'pullback');
  else if (S.wasScan) renderWatch();
  S.wasScan = v === 'scan';
  if (v === 'rebuy') pickTab('rebuy');
  if (v === 'journal') $('#jTabs [data-j="journal"]').click();
  if (v === 'assets') $('#jTabs [data-j="hold"]').click();
  if (v === 'strat') renderStrat();
  if (v === 'wiki'){ const w = $('#wikiSec'); if (w){ w.open = true; LS.set('quantera:wikiOpen', true); requestAnimationFrame(() => w.scrollIntoView({ block: 'start' })); } }
  if (matchMedia('(max-width: 899px)').matches){
    if (v === 'journal' || v === 'assets') setMobile('journal');
    else if (v === 'wiki'){ setMobile('trade'); setMt('insp'); } else if (v !== 'trade') setMobile('list');
  }
  if (chart) requestAnimationFrame(() => chart.refit());
}

// ---------------------------------------------------------------- 업비트 실제 거래 가져오기
function bindImport(){
  const dlg = $('#upDlg'), msg = t => $('#upMsg').textContent = t;
  let file = null;
  $('#upImportBtn').addEventListener('click', () => {
    if (!db.user){ toast('업비트 가져오기는 로그인 후에 쓸 수 있어요.'); $('#loginDlg').showModal(); return; }
    const meta = importMeta.get();
    msg(meta.last ? `마지막 가져오기: ${new Date(meta.last).toLocaleString('ko-KR')} · ${meta.added || 0}건 추가` : '');
    dlg.showModal();
    if (!$('#upIp').textContent) fetch('https://api.ipify.org?format=json').then(r => r.json()).then(j => { $('#upIp').textContent = ` (지금 이 기기: ${j.ip})`; }).catch(() => {});
  });
  $('#upOpenCfg').addEventListener('click', () => { dlg.close(); openCfg(); requestAnimationFrame(() => { const c = $('#connSec'); if (c) c.scrollIntoView({ block: 'center' }); }); });
  $('#upFile').addEventListener('change', async e => {
    const f = e.target.files[0]; file = null; if (!f) return;
    try{
      const j = JSON.parse((await f.text()).replace(/^﻿/, ''));
      if (j.format !== 'quantera-upbit-v1' || !Array.isArray(j.orders)) throw new Error();
      file = j; $('#upFileName').textContent = `${f.name} · 주문 ${j.orders.length}건 · ${new Date(j.from).toLocaleDateString('ko-KR')} ~ ${new Date(j.to).toLocaleDateString('ko-KR')}`;
      msg('');
    }catch(err){ $('#upFileName').textContent = '파일 고르기'; msg('QUANTERA 도우미가 만든 파일이 아니에요.'); }
  });
  $('#upForm').addEventListener('submit', async e => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    if (!file){ msg('먼저 도우미가 만든 파일을 골라 주세요.'); return; }
    const btn = $('#upGo'); btn.disabled = true;
    try { msg(await applyImport(file.accounts || [], file.orders.filter(o => String(o.market).startsWith('KRW-')), file.from, file.to)); }
    catch(err){ msg(err.message || String(err)); }
    finally{ btn.disabled = false; }
  });
}
// 업비트 주문 목록 → 거래일지(실제). 같은 주문은 다시 넣지 않음. 잔고와 다르면 차이만큼 기초 이월
async function applyImport(bal, orders, from, now){
  const rows = orders.filter(o => +o.executed_volume > 0).map(o => toRow(o, upbit.toSymbol));
  const r = await importTrades(rows);
  S.trades = await loadTrades(); recompute();
  let carried = 0, over = 0;
  if ($('#upCarry').checked && bal.length){
    const have = new Map(S.ledgerReal.positions.map(p => [p.symbol, p.qty]));
    const day = new Date(from).toISOString().slice(0, 10), carry = [];
    for (const b of bal){
      if (b.currency === 'KRW' || b.unit_currency !== 'KRW') continue;
      const sym = upbit.toSymbol('KRW-' + b.currency), actual = +b.balance + +b.locked, rec = have.get(sym) || 0;
      const px = +b.avg_buy_price || priceOf(sym) || 0, diff = actual - rec;
      if (!px) continue;
      if (diff * px > 5000) carry.push({ trade_no: `C-${b.currency}-${Date.now().toString(36).slice(-5)}`, external_id: `carry:${b.currency}:${day}:${diff.toFixed(8)}`, source: 'carry_over',
        symbol: sym, side: 'buy', price: px, qty: diff, fee: 0, executed_at: new Date(from - 1000).toISOString(), reason: '업비트 잔고 맞춤 (가져오기 전 보유분, 업비트 평단)' });
      else if (-diff * px > 5000) over++;
    }
    if (carry.length){ await importTrades(carry); carried = carry.length; S.trades = await loadTrades(); }
  }
  importMeta.set({ last: now, added: r.added });
  if (S.acct !== 'real') setAcct('real'); else { renderJournal(); renderStatus(); }
  toast(`업비트 거래 ${r.added}건을 가져왔어요.`, 'up');
  return `끝났어요. 체결 주문 ${rows.length}건 중 새로 ${r.added}건 추가${r.skipped ? `, 이미 있던 ${r.skipped}건은 건너뜀` : ''}${carried ? `, 기초 이월 ${carried}종목 추가` : ''}${over ? `. 기록이 잔고보다 많은 종목 ${over}개가 있어요(출금·이전 기록 확인)` : ''}.`;
}

// ---------------------------------------------------------------- 전략 검증 (백테스트)
// 일봉으로 과거 모든 날에 같은 규칙을 적용. 캔들은 스캔과 같은 기기 캐시를 씀(같은 날 다시 돌리면 요청 거의 없음)
const STG = { type: LS.get('quantera:stratType', 'bottom'), run: null, res: {}, sort: { k: 'sum', d: -1 } };
const STG_KO = { bottom: '바닥 거래', pullback: '눌림 매수', surge: '급등 거래' };
const STG_DESC = {
  bottom: '1년 고점에서 크게 빠지고 바닥을 다진 뒤 거래량이 붙는 날(바닥 반등 신호) 종가에 샀다고 치고, +익절%에 닿으면 팔아요. 손절 0 = 손절 없이 기다림.',
  pullback: '오르던 코인이 20·60일선 근처까지 눌리고 거래량이 줄어든 날(눌림 매수 신호) 종가에 샀다고 치고, 익절·손절·최대 보유일 중 먼저 닿는 쪽으로 팔아요.',
  surge: '급등은 1초 단위라 과거 일봉으로는 검증할 수 없어요. 앱이 켜져 있는 동안 잡힌 급등을 그 순간 가격에 샀다고 치고, 조합별로 익절·손절이 먼저 닿는 쪽을 기록해요.'
};
function stratFormHtml(c){
  const o = c[STG.type];
  return `<form class="stg-form" id="stgForm" novalidate>
    <label>익절 %<input type="number" step="any" min="0.1" name="tp" value="${o.tp}"></label>
    <label>손절 % (0 = 없음)<input type="number" step="any" min="0" name="sl" value="${o.sl}"></label>
    <label>최대 보유일 (0 = 제한 없음)<input type="number" step="1" min="0" name="maxDays" value="${o.maxDays}"></label>
    <label>1회 매수 금액(원)<input type="number" step="any" min="10000" name="amount" value="${c.amount}"></label>
    <label>대상<select name="scope"><option value="all"${c.scope === 'all' ? ' selected' : ''}>거래대금 ${Math.round(c.minValue / 1e8)}억 이상 전체</option><option value="mine"${c.scope === 'mine' ? ' selected' : ''}>관심 + 보유</option></select></label>
    <button class="pill accent" type="submit" id="stgRun">${STG.run ? '중지' : '검증 실행'}</button>
    <span class="stg-prog muted" id="stgProg"></span>
  </form>`;
}
function stratSumHtml(R){
  const s = R.sum, c = R.cfg, amt = c.amount;
  if (!s.n) return `<div class="empty">조건에 맞는 과거 신호가 없었어요. (${R.coins}종목 확인)</div>`;
  const card = (lab, val, sub = '', cls = '') => `<div class="stg-card"><span class="muted">${lab}</span><b class="${cls}">${val}</b>${sub ? `<span class="muted">${sub}</span>` : ''}</div>`;
  const openWon = R.trades.filter(t => !t.done).reduce((a, t) => a + amt * t.ret / 100, 0);
  return `<div class="stg-cards">
    ${card('신호', `${s.n}번`, `${R.coins}종목 · 최근 ${R.span}일${s.perMonth != null ? ` · 한 달 ${s.perMonth.toFixed(1)}번` : ''}`)}
    ${card(`익절 +${c.opt.tp}% 도달`, `${s.hit.toFixed(0)}%`, `${s.tp}번`, s.hit >= 50 ? 'up' : '')}
    ${card('손절 · 시간 종료', `${s.sl} · ${s.time}번`, c.opt.sl ? `손절 -${c.opt.sl}%` : '손절 없음')}
    ${card('아직 못 빠져나옴', `${s.open}번`, s.open ? `평균 ${fmtPct(s.openAvg, 1)} · 가장 오래 ${s.openMaxDays}일` : '', s.open ? 'warn' : '')}
    ${card('1건 평균', fmtPct(s.avg, 2), `끝난 ${s.done}건 · 수수료 반영`, toneOf(s.avg))}
    ${card('보통 걸린 기간', s.medDays != null ? `${s.medDays}일` : '-', '끝난 거래의 중간값')}
    ${card('기다리는 동안 빠진 폭', fmtPct(s.avgDd, 1), `가장 심했던 ${fmtPct(s.worstDd, 1)}`, 'down')}
    ${card(`1회 ${won(amt)}원이면`, `${s.sum * amt / 100 >= 0 ? '+' : ''}${won(s.sum * amt / 100)}원`, `끝난 거래 합계${s.open ? ` · 미청산 평가 ${openWon >= 0 ? '+' : ''}${won(openWon)}원` : ''}`, toneOf(s.sum))}
  </div>`;
}
function stratCoinRows(R){
  const k = STG.sort.k, d = STG.sort.d;
  return R.coins_.slice().sort((a, b) => ((a[k] ?? -1e9) > (b[k] ?? -1e9) ? 1 : (a[k] ?? -1e9) < (b[k] ?? -1e9) ? -1 : 0) * d);
}
function stratTablesHtml(R){
  const amt = R.cfg.amount, rows = stratCoinRows(R);
  const th = (key, lab, cls = '') => `<th class="${cls}${STG.sort.k === key ? ' on' : ''}" data-stsort="${key}">${lab}${STG.sort.k === key ? (STG.sort.d > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  const why = t => !t.done ? '<span class="warn">진행 중</span>' : t.why === 'tp' ? '<span class="up">익절</span>' : t.why === 'sl' ? '<span class="down">손절</span>' : '<span class="muted">시간 종료</span>';
  const recent = R.trades.slice().sort((a, b) => a.t < b.t ? 1 : -1).slice(0, 40);
  if (isPhone()) return `<h4 class="stg-h">종목별 <span class="muted">합계 수익 순</span></h4>
    <div class="stg-mlist">${rows.slice(0, 60).map(x => `<div class="m-row" data-mm="${x.m}"><div><b>${esc(nameOf(x.m))}</b><span class="muted">${x.n}번 · 익절 ${x.hit.toFixed(0)}%${x.open ? ` · 진행 중 ${x.open}` : ''}</span></div><div class="mono ${toneOf(x.sum)}">${fmtPct(x.avg, 1)}<span class="muted">${x.sum * amt / 100 >= 0 ? '+' : ''}${won(x.sum * amt / 100)}원</span></div></div>`).join('')}</div>
    <h4 class="stg-h">최근 신호</h4>
    <div class="stg-mlist">${recent.map(t => `<div class="m-row" data-mm="${t.m}"><div><b>${esc(nameOf(t.m))}</b><span class="muted">${t.t.slice(2).replace(/-/g, '.')} · ${fmtPrice(t.entry)} · ${t.days}일</span></div><div class="mono ${toneOf(t.ret)}">${why(t)} ${fmtPct(t.ret, 1)}</div></div>`).join('')}</div>`;
  return `<div class="stg-cols"><div><h4 class="stg-h">종목별 <span class="muted">머리글을 누르면 정렬 · 줄을 누르면 차트로</span></h4>
    <table class="ot stg-t"><thead><tr><th class="l">종목</th>${th('n', '신호')}${th('hit', '익절 도달')}${th('sl', '손절')}${th('open', '진행 중')}${th('avg', '1건 평균')}${th('sum', '합계 수익')}${th('med', '보통 기간')}${th('worst', '가장 빠진 폭')}<th class="l">지금</th></tr></thead><tbody>
    ${rows.map(x => { const L = live(x.m); return `<tr class="sc-row" data-stm="${x.m}"><td class="l"><b>${esc(nameOf(x.m))}</b> <span class="mono muted">${x.m.replace('KRW-', '')}</span></td><td class="mono">${x.n}</td><td class="mono">${x.hit.toFixed(0)}%</td><td class="mono">${x.sl || ''}</td><td class="mono ${x.open ? 'warn' : ''}">${x.open || ''}</td><td class="mono ${toneOf(x.avg)}">${fmtPct(x.avg, 2)}</td><td class="mono ${toneOf(x.sum)}">${x.sum * amt / 100 >= 0 ? '+' : ''}${won(x.sum * amt / 100)}원</td><td class="mono">${x.med != null ? x.med + '일' : ''}</td><td class="mono down">${fmtPct(x.worst, 1)}</td><td class="l">${L.stance === 'buy_zone' && L.type === STG.type ? `<span class="badge accent">${TYPE_KO[L.type]}</span>` : ''}</td></tr>`; }).join('')}
    </tbody></table></div>
    <div><h4 class="stg-h">최근 신호 <span class="muted">${recent.length}건</span></h4>
    <table class="ot stg-t"><thead><tr><th class="l">신호일</th><th class="l">종목</th><th>매수가</th><th class="l">결과</th><th>수익</th><th>기간</th><th>빠진 폭</th></tr></thead><tbody>
    ${recent.map(t => `<tr class="sc-row" data-stm="${t.m}"><td class="l mono">${t.t}</td><td class="l">${esc(nameOf(t.m))}</td><td class="mono">${fmtPrice(t.entry)}</td><td class="l">${why(t)}</td><td class="mono ${toneOf(t.ret)}">${fmtPct(t.ret, 1)}</td><td class="mono">${t.days}일</td><td class="mono down">${fmtPct(t.dd, 1)}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}
function renderStrat(){
  const box = $('#stratBody'); if (!box) return;
  const c = stratCfg(), R = STG.res[STG.type];
  const tabs = `<div class="stg-tabs">${Object.entries(STG_KO).map(([k, v]) => `<button class="pill${STG.type === k ? ' on' : ''}" data-stg="${k}">${v}</button>`).join('')}</div>`;
  if (STG.type === 'surge'){
    box.innerHTML = tabs + `<p class="stg-desc">${STG_DESC.surge}</p>` + surgeStatsHtml().replace('<details class="surge-stats"', '<details open class="surge-stats"')
      + `<p class="note">기준·조합은 설정 > 급등·급락 감지에서 바꿔요. 지금 기본 주문: 익절 +${allCfg().surgeTradeTp}% / 손절 -${allCfg().surgeTradeSl}%.</p>`;
    return;
  }
  box.innerHTML = tabs + `<p class="stg-desc">${STG_DESC[STG.type]}</p>` + stratFormHtml(c)
    + `<div id="stgOut">${R ? stratSumHtml(R) + (R.sum.n ? stratTablesHtml(R) : '') : `<div class="empty">조건을 정하고 "검증 실행"을 누르세요. 처음엔 종목마다 일봉을 받아서 몇 분 걸릴 수 있어요(오늘 스캔을 했다면 빨라요).</div>`}</div>`;
}
function readStratForm(){
  const f = $('#stgForm'), c = stratCfg(), n = (k, d) => { const v = +f.elements[k].value; return isFinite(v) && v >= 0 ? v : d; };
  c[STG.type] = { tp: n('tp', 2) || 2, sl: n('sl', 0), maxDays: Math.round(n('maxDays', 0)) };
  c.amount = n('amount', 1e6) || 1e6; c.scope = f.elements.scope.value;
  saveStratCfg(c); return c;
}
async function runStrat(){
  if (STG.run){ STG.run.abort(); return; }
  const c = readStratForm(), type = STG.type, opt = c[type], ac = STG.run = new AbortController();
  $('#stgRun').textContent = '중지';
  const held = new Set(S.ledger.positions.map(p => upbit.toMarket(p.symbol)));
  const list = S.instruments.filter(i => c.scope === 'mine' ? (S.watch.has(i.symbol) || held.has(i.market)) : ((S.quotes.get(i.market) || {}).value24h || 0) >= c.minValue);
  const today = utcDay(), scfg = screenCfg(), trades = [], coins_ = [];
  let span = 0, done = 0;
  for (const inst of list){
    if (ac.signal.aborted) break;
    try{
      const D = (await loadDaily(inst.market, S.quotes.get(inst.market))).filter(x => x.t < today);
      if (D.length > 160){
        const T = strategyTrades(D, type, opt, scfg).map(t => ({ ...t, m: inst.market }));
        span = Math.max(span, D.length - 121);
        if (T.length){ const s = summarizeTrades(T); trades.push(...T); coins_.push({ m: inst.market, n: s.n, hit: s.hit, sl: s.sl, open: s.open, avg: s.avg, sum: s.sum, med: s.medDays, worst: s.worstDd }); }
      }
    }catch(e){ /* 한 종목 실패는 건너뜀 */ }
    done++;
    const pg = $('#stgProg'); if (pg) pg.textContent = `${done}/${list.length} 종목 확인 중…`;
  }
  const aborted = ac.signal.aborted;
  STG.run = null;
  STG.res[type] = { cfg: { ...c, opt }, trades, coins_, coins: done, span, sum: summarizeTrades(trades, span), at: Date.now() };
  if (STG.type === type){ renderStrat(); const pg = $('#stgProg'); if (pg) pg.textContent = `${aborted ? '중지됨 · ' : ''}${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })} 검증 · ${done}종목`; }
}
function bindStrat(){
  const box = $('#stratBody');
  box.addEventListener('submit', e => { e.preventDefault(); runStrat(); });
  box.addEventListener('click', e => {
    const t = e.target.closest('[data-stg]'); if (t){ if (STG.run) STG.run.abort(); STG.type = t.dataset.stg; LS.set('quantera:stratType', STG.type); renderStrat(); return; }
    const so = e.target.closest('[data-stsort]'); if (so){ const k = so.dataset.stsort; STG.sort = { k, d: STG.sort.k === k ? -STG.sort.d : -1 }; const R = STG.res[STG.type]; if (R && R.sum.n) $('#stgOut').innerHTML = stratSumHtml(R) + stratTablesHtml(R); return; }
    const r = e.target.closest('[data-stm]'); if (r){ setView('trade'); select(r.dataset.stm); return; }
  });
  box.addEventListener('change', e => { if (e.target.closest('#stgForm')) readStratForm(); });
}

// ---------------------------------------------------------------- 업비트 소식
async function renderNews(){
  const j = await loadNews();
  const srcs = j.sources || [], failed = srcs.filter(s => !s.ok).length;
  const note = (j.error || (srcs.length && failed === srcs.length)) ? '업비트 소식을 불러오지 못했어요. 잠시 후 다시 시도해요.' : '최근 소식이 없어요.';
  const html = newsHtml(j.items || [], esc, { empty: note, limit: 40 });
  $('#newsBody').innerHTML = html; $('#alertBody').innerHTML = html;
  renderInspNews(j);
}
function renderInspNews(j){
  const el = $('#inspNews'); if (!el || !j || !el.isConnected) return;
  el.innerHTML = newsHtml(newsFor(j.items || [], S.byMarket.get(S.sel)), esc, { empty: '최근 이 종목 관련 공지·공시가 없어요.', limit: 6 });
}
setInterval(() => { if (document.visibilityState === 'visible') loadNews(true).then(renderNews); }, 300000);

// ---------------------------------------------------------------- 매수 검토 기준 설정
const CFG_FIELDS = [
  ['무조건 제외', [['nearHighPct', '60일 고점에서 이 % 안쪽', 1], ['maxRise7d', '7일 상승률(%) 초과', 1], ['maxRiseToday', '오늘 상승률(%) 초과', 1], ['maxGap20', '20일선 이격(%) 초과', 1], ['minValue24h', '24시간 거래대금(억) 미만', 1e8], ['includeWarning', '투자유의 종목도 포함', 'bool']]],
  ['눌림 매수', [['pbMinDrop', '최근 30일 고점 대비 최소 하락(%)', 1], ['pbMaxDrop', '최대 하락(%)', 1], ['pbNearMa', '20·60일선과의 거리(%) 이내', 1], ['pbVolDry', '5일/20일 거래량 비율 이하', 1]]],
  ['바닥 반등', [['btMinDrop', '1년 고점 대비 최소 하락(%)', 1], ['btLowerPct', '1년 범위 하단 이 % 안', 1], ['btNoNewLowDays', '새 저점 없는 기간(일)', 1], ['btVolBurst', '반등 거래량 배수', 1], ['btTp', '바닥 거래 익절(%) — 손절 없음', 1]]],
  ['급등·급락 감지 (1초마다)', [['dumpOn', '급락도 감지 (같은 기준, 가격이 내림)', 'bool'], ['alarmVol', '알람 소리 크기 (0~100)', 1], ['surgeSec', '이 시간(초) 동안의 거래를 봄', 1], ['surgeVol', '평소 같은 시간보다 거래대금 배수', 1], ['surgePct', '그 시간 상승률(%) 이상 (0 = 가격 안 봄)', 1], ['surgeMinValue', '그 시간 최소 거래대금(백만 원)', 1e6], ['surgeKeepMin', '잡힌 뒤 목록 유지(분)', 1], ['surgeAlarm', '소리 알람', 'bool'], ['surgeRepeat', '확인 전까지 반복 간격(초)', 1], ['surgeCombos', '적중률 조합 (익절/손절, 쉼표로)', 'text'], ['surgeTimeoutMin', '적중률 시간 종료(분)', 1], ['surgeTradeTp', '급등 거래 주문 기본 익절(%)', 1], ['surgeTradeSl', '급등 거래 주문 기본 손절(%)', 1]]],
  ['검증', [['minSamples', '최소 표본 수', 1], ['holdDays', '보유 기간(일)', 1], ['feePct', '왕복 수수료(%)', 1]]]
];
function appCfgHtml(){
  return `<h4>화면 · 기록 <span class="muted" style="">계정에 저장 · PC와 폰이 같아요</span></h4>
    <label>거래일지 추세선 기간<select name="ui_sparkDays">${[30, 60, 90, 180].map(d => `<option value="${d}"${+UI.sparkDays === d ? ' selected' : ''}>${d}일</option>`).join('')}</select></label>
    <label>알람 소리 미리 듣기<span class="row-btns"><button type="button" class="pill sm" data-preview="up">급등</button><button type="button" class="pill sm" data-preview="down">급락</button></span></label>
    <label>모의 데이터<span class="row-btns"><button type="button" class="pill sm danger" data-wipe>전부 삭제</button></span></label>
    ${connCfgHtml()}`;
}
// 업비트 연결 코드: 앱에서 만들고 PC 도우미에 한 번 넣으면, 도우미가 30초마다 새 체결을 바로 올림
let connState = { list: null, fresh: '' };
function connCfgHtml(){
  const L = connState.list;
  const body = !db.user ? '<span class="muted">로그인하면 만들 수 있어요.</span>'
    : L === 'missing' ? '<span class="warn">서버 준비 전이에요 (SQL 실행 필요).</span>'
    : connState.fresh ? `<div class="conn-code">${esc(connState.fresh)}</div><span class="muted small">지금만 보여요. 도우미 첫 실행 때 붙여 넣으세요.</span>`
    : L && L.length ? `<span class="muted">연결됨 · 마지막 ${L[0].last_used_at ? new Date(L[0].last_used_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) + ` (${L[0].last_added || 0}건 추가)` : '아직 안 올라옴'}</span>`
    : '<span class="muted">아직 없어요.</span>';
  return `<div id="connSec"><h4>업비트 자동 올리기 <span class="muted" style="">PC 도우미용 연결 코드</span></h4>
    <div class="conn-row">${body}<span class="row-btns">${db.user && L !== 'missing' ? `<button type="button" class="pill sm" data-conn="new">${L && L.length ? '새 코드' : '코드 만들기'}</button>${L && L.length ? '<button type="button" class="pill sm danger" data-conn="off">연결 끊기</button>' : ''}` : ''}</span></div></div>`;
}
async function refreshConn(){
  connState.list = db.user ? await upbitLinks.list() : null;
  const box = $('#connSec'); if (box) box.outerHTML = connCfgHtml();
}
function connClick(e){
  const b = e.target.closest('[data-conn]'); if (!b) return false;
  e.preventDefault();
  (async () => {
    try{
      if (b.dataset.conn === 'off'){
        if (!confirm('PC 도우미 연결을 끊을까요? 도우미는 더 이상 올리지 못해요(새 코드를 만들면 다시 연결).')) return;
        await upbitLinks.revokeAll(); connState.fresh = ''; toast('업비트 자동 올리기 연결을 끊었어요.');
      } else {
        if (connState.list && connState.list.length && !confirm('새 코드를 만들면 지금 쓰던 코드는 끊겨요. 도우미에 새 코드를 다시 넣어야 해요. 만들까요?')) return;
        const raw = crypto.getRandomValues(new Uint8Array(20)), A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const code = 'QX-' + [...raw].map(x => A[x % 32]).join('').match(/.{1,5}/g).join('-');
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)))].map(x => x.toString(16).padStart(2, '0')).join('');
        await upbitLinks.revokeAll(); await upbitLinks.create(hash);
        connState.fresh = code;
        try { await navigator.clipboard.writeText(code); toast('연결 코드를 만들고 복사했어요. 도우미에 붙여 넣으세요.', 'up'); } catch(err){ toast('연결 코드를 만들었어요. 설정 창에서 복사하세요.', 'up'); }
      }
      await refreshConn();
    }catch(err){ alert(err.message || String(err)); }
  })();
  return true;
}
function openCfg(c = allCfg()){
  $('#cfgBody').innerHTML = appCfgHtml() + CFG_FIELDS.map(([title, fs]) => `<h4>${title}</h4>` + fs.map(([k, label, unit]) => unit === 'text'
    ? `<label>${label}<input type="text" name="${k}" value="${esc(c[k])}"></label>`
    : unit === 'bool'
    ? `<label>${label}<input type="checkbox" name="${k}" ${c[k] ? 'checked' : ''}></label>`
    : `<label>${label}<input type="number" step="any" name="${k}" value="${+(c[k] / unit).toFixed(4)}"></label>`).join('')).join('');
  $('#cfgDlg').showModal();
  connState.fresh = ''; refreshConn();
}
function bindCfg(){
  $('#cfgBody').addEventListener('click', async e => {
    const pv = e.target.closest('[data-preview]'); if (pv){ e.preventDefault(); const v = +$('#cfgBody [name="alarmVol"]').value; const c = screenCfg(), old = c.alarmVol; c.alarmVol = isFinite(v) ? v : old; saveScreenCfg(c); beep(pv.dataset.preview, true); c.alarmVol = old; saveScreenCfg(c); return; }
    if (e.target.closest('[data-wipe]')){
      e.preventDefault();
      if (!confirm('모의투자 데이터를 전부 지울까요?\n잔고·미체결 주문·예약 매도·모의 체결 기록이 이 기기와 계정에서 모두 지워져요. 실제 기록은 그대로예요.')) return;
      const st = paper.wipe(); await uiRemote.clearPaper(st); setUi({ paperOn: false });
      recompute(); renderOrderForm(); renderJournal(); renderStatus(); if (isOrdersOpen()) renderOrders();
      toast('모의 데이터를 모두 지웠어요.');
      return;
    }
    if (connClick(e)) return;
  });
  $('#cfgReset').addEventListener('click', e => { e.preventDefault(); openCfg({ ...SCREEN_DEFAULTS, ...SURGE_DEFAULTS }); });
  $('#cfgForm').addEventListener('submit', async e => {
    if (!e.submitter || e.submitter.value !== 'save') return;
    const c = {};
    for (const [, fs] of CFG_FIELDS) for (const [k, , unit] of fs){
      const el = $(`#cfgBody [name="${k}"]`);
      c[k] = unit === 'text' ? el.value : unit === 'bool' ? el.checked : (isFinite(+el.value) ? +el.value * unit : { ...SCREEN_DEFAULTS, ...SURGE_DEFAULTS }[k]);
    }
    saveScreenCfg(c);
    setUi({ sparkDays: +$('#cfgBody [name="ui_sparkDays"]').value || 30 });
    // 기준이 바뀌면 이미 받은 캔들(캐시)로 다시 계산 — 업비트 추가 요청 없음
    const ms = [...S.results.keys()]; S.results.clear(); gsDirty = true;
    await analyzeList(ms);
    if (S.sel) select(S.sel);
  });
}
// ---------------------------------------------------------------- 폰 화면: 종목 · 매매 · 거래 (+ 위쪽 🔔 알림, ⚙ 설정, 검색)
const isPhone = () => matchMedia('(max-width: 899px)').matches;
function setMobile(m){
  if (PH.on){ if (m === 'trade' || m === 'chart') mGo('coin'); else if (m === 'journal') mGo('journal'); return; }
  m = { home: 'list', watch: 'list', chart: 'trade', alerts: 'list' }[m] || m;
  if (!['list', 'trade', 'journal'].includes(m)) m = 'list';
  document.body.dataset.m = m;
  $$('.mtabs button').forEach(b => b.classList.toggle('on', b.dataset.m === m));

  if (m === 'trade'){ setMt(document.body.dataset.mt || 'book'); if (chart) requestAnimationFrame(() => chart.refit()); }
  if (m === 'journal'){ const on = $('#jTabs .pill.on'); if (on && on.dataset.j === 'day') $('#jTabs [data-j="journal"]').click(); }
  if (m !== 'list') document.body.classList.remove('m-search');
}
function setMt(t){
  document.body.dataset.mt = t;
  $$('#mtTabs button').forEach(b => b.classList.toggle('on', b.dataset.mt === t));
  if (t === 'day') renderDaily($('#mDay'));
  if (t === 'news') renderMNews();
}
async function renderMNews(){
  const el = $('#mNews'); if (!el) return;
  const j = await loadNews();
  el.innerHTML = `<div class="m-sec-t">${esc(nameOf(S.sel))} 관련 공지·공시</div>` + newsHtml(newsFor(j.items || [], S.byMarket.get(S.sel)), esc, { empty: '최근 이 종목 관련 공지·공시가 없어요.', limit: 20 });
}
function openSheet(side){ openRec('paper', { side }); }
function renderBell(){
  const n = (surgeMuted() ? 0 : unseen.size + unseenDump.size);
  const el = $('#bellN'); if (el){ el.textContent = n || ''; el.classList.toggle('on', !!n); }
  const dlg = $('#bellDlg'); if (!dlg || !dlg.open) return;
  const nm = m => (S.byMarket.get(m) || {}).name || m;
  const item = (src, m, cls) => { const e = src.get(m), q = S.quotes.get(m) || {}; return `<button class="bell-row" data-bell="${m}"><span class="badge ${cls}">${cls === 'surge' ? '급등' : '급락'}</span><b>${esc(nm(m))}</b><span class="muted">${agoKo(Date.now() - e.at)} · ${fmtPct(e.pct)}</span><span class="grow"></span><span class="mono ${toneOf(q.changeRate)}">${fmtPrice(q.price)}</span></button>`; };
  const up = [...surge.events.keys()].sort((a, b) => surge.get(b).at - surge.get(a).at), dn = [...dump.events.keys()].sort((a, b) => dump.get(b).at - dump.get(a).at);
  const sec = (ms, src, cls, lab) => `<div class="bell-sec ${cls}"><span class="${cls === 'dump' ? 'down' : 'up'}">● ${lab} ${ms.length}</span></div>` + (ms.length ? ms.map(m => item(src, m, cls)).join('') : `<div class="muted bell-none">지금 잡힌 ${lab}${lab === '급등' ? '이' : '이'} 없어요.</div>`);
  $('#bellBody').innerHTML = muteCtlHtml() + sec(up, surge, 'surge', '급등') + sec(dn, dump, 'dump', '급락');
}
setInterval(renderBell, 2000);
function bindMobile(){
  $('#mtTabs').addEventListener('click', e => { const b = e.target.closest('[data-mt]'); if (b) setMt(b.dataset.mt); });
  $('#mOrderBar').addEventListener('click', e => { const b = e.target.closest('[data-mo]'); if (b) openRec(b.dataset.mo); });
  $('#mCfgBtn').addEventListener('click', () => openCfg());
  $('#mSearchBtn').addEventListener('click', () => { setMobile('list'); document.body.classList.toggle('m-search'); if (document.body.classList.contains('m-search')) $('#search').focus(); else { $('#search').value = ''; S.search = ''; renderWatch(); } });
  $('#mBellBtn').addEventListener('click', () => { $('#bellDlg').showModal(); ackSurge(); renderBell(); renderNews(); });
  $('#bellBody').addEventListener('click', e => { const b = e.target.closest('[data-bell]'); if (!b) return; $('#bellDlg').close(); select(b.dataset.bell); setMobile('trade'); });
  // 거래 카드: 길게 누르면 수정·지우기 버튼
  let lp = null;
  $('#jBody').addEventListener('touchstart', e => { const tr = e.target.closest('tr[data-m]'); if (!tr || e.target.closest('button')) return; lp = setTimeout(() => { lp = 'done'; $$('#jBody tr.show-acts').forEach(x => x !== tr && x.classList.remove('show-acts')); tr.classList.toggle('show-acts'); if (navigator.vibrate) navigator.vibrate(15); }, 500); }, { passive: true });
  const cancel = () => { if (lp && lp !== 'done') clearTimeout(lp); };
  $('#jBody').addEventListener('touchmove', cancel, { passive: true });
  $('#jBody').addEventListener('touchend', e => { if (lp === 'done'){ e.preventDefault(); } cancel(); lp = null; });
}


// ================================================================ 폰 전용 화면
// PC는 HTS처럼 여러 칸을 한 화면에, 폰은 한 화면에 한 가지만 크게. 나머지는 ☰ 메뉴.
// PC 칸에서 쓰던 요소(차트·호가·분석·거래일지)는 폰일 때 아래 화면으로 옮겨 그대로 씀.
const PH = { page: 'home', tab: 'all', cp: LS.get('quantera:mCp', 'chart'), on: false };
const M_TITLES = { hold: '보유 자산', home: 'QUANTERA', list: '종목', search: '종목 검색', journal: '거래일지', news: '업비트 소식', strat: '전략 검증' };
const M_TABS = [['all', '전체'], ['pullback', '눌림'], ['bottom', '바닥'], ['new', '신규'], ['recent', '최근'], ['rebuy', '재매수']];
function initPhone(){
  if (!isPhone()) return;
  PH.on = true;
  document.body.classList.add('phone');
  $('#mApp').hidden = false;
  document.body.appendChild($('#toasts'));
  // 차트 · 호가 · 분석 · 일별 · 소식 · 거래일지를 폰 화면으로 옮김
  $('#mCpChart').prepend($('#tfTabs'), $('#chartWrap'));
  $('#mCpBook').append($('#obBody'), $('#obTot'), $('.tr-box'));
  mMenuIcons();
  $('#mCpInsp').append($('#inspBody'));
  $('#mCpDay').append($('#mDay'));
  $('#mCpNews').append($('#mNews'));
  $('#mJHead').append($('#jSummary'), $('#jAcct'), $('#jAddBtn'), $('#upImportBtn'));
  $('#mJBody').append($('#jBody'));
  $('#mStrat').append($('#stratBody'));
  $('#jBody').classList.remove('hidden');
  bindPhone();
  const st = history.state && history.state.mp;
  mShow(st ? st.page : 'home', st || {});
  history.replaceState({ mp: { page: PH.page, tab: PH.tab } }, '');
  setInterval(mTick, 1500);
}
// 화면 바꾸기 (뒤로 가기 버튼·안드로이드 뒤로 키가 되도록 기록에 남김)
function mGo(page, opt = {}){
  mCloseMenu();
  if (page === PH.page && page !== 'list') return mShow(page, opt);
  mShow(page, opt);
  history.pushState({ mp: { page, tab: PH.tab } }, '');
}
function mShow(page, opt = {}){
  if (opt.tab) PH.tab = opt.tab;
  PH.page = page;
  $('#mApp').dataset.page = page;
  $('#mBack').hidden = page === 'home';
  const dk = { coin: 'list', search: 'list' }[page] || page;
  $$('#mDock [data-dk]').forEach(b => b.classList.toggle('on', b.dataset.dk === dk));
  $('#mTitle').textContent = page === 'list' ? (M_TABS.find(t => t[0] === PH.tab) || [, '종목'])[1] + ' 종목' : page === 'coin' ? nameOf(S.sel) : M_TITLES[page] || 'QUANTERA';
  window.scrollTo(0, 0);
  if (page === 'search'){ setTimeout(() => $('#mSearch').focus(), 50); }
  if (page === 'coin') mSetCp(PH.cp);
  if (page === 'journal') renderJournal();
  if (page === 'strat') renderStrat();
  if (page === 'hold') $('#mHold').innerHTML = mHoldHtml();
  if (page === 'news') renderNews().then(() => { $('#mNewsAll').innerHTML = $('#newsBody').innerHTML; });
  mRender();
}
addEventListener('popstate', e => { if (!PH.on) return; const st = e.state && e.state.mp; mCloseMenu(); mShow(st ? st.page : 'home', st || {}); });
function mOpenCoin(m){ select(m); mGo('coin'); }
function mSetCp(cp){
  if (cp === 'book') cp = 'chart';   // 차트와 호가는 한 화면
  PH.cp = cp; LS.set('quantera:mCp', cp);
  $$('#mCoinTabs button').forEach(b => b.classList.toggle('on', b.dataset.cp === cp));
  $$('#mApp .m-cpane').forEach(p => p.classList.toggle('on', p.dataset.cp === cp));
  document.body.dataset.mt = cp;
  if (cp === 'chart' && chart) requestAnimationFrame(() => chart.refit());
  if (cp === 'day') renderDaily($('#mDay'));
  if (cp === 'news') renderMNews();
}
// 한 줄: 이름 · 현재가 · 등락률, 아래 줄에 가이드 한 줄 (또는 거래대금)
// 코인 로고 (업비트 공식 이미지, 못 받으면 첫 글자)
const LOGO_C = ['#C6F432', '#F04452', '#4C8DFF', '#F5A524', '#EDEDEF'];
function mLogo(m, size = ''){
  const sym = m.slice(4), c = LOGO_C[[...sym].reduce((a, ch) => a + ch.charCodeAt(0), 0) % LOGO_C.length];
  return `<i class="m-logo${size ? ' ' + size : ''}" style="--lc:${c}"><b>${esc(sym.slice(0, 1))}</b><span style="background-image:url(https://static.upbit.com/logos/${encodeURIComponent(sym)}.png)"></span></i>`;
}
// 최근 30일 종가 추세선 (거래일지와 같은 캐시 사용, 없으면 빈칸)
function mSpark(m){
  const d = sparkCache.get(sparkKey(m)); if (!d || !d.closes || d.closes.length < 2) return '<span class="m-spk"></span>';
  const W = 64, H = 26, C = d.closes.map(x => x.c), n = C.length, lo = Math.min(...C), hi = Math.max(...C), sp = hi - lo || 1;
  const pts = C.map((v, i) => `${(i / (n - 1) * W).toFixed(1)},${(H - 2 - (v - lo) / sp * (H - 4)).toFixed(1)}`).join(' ');
  const col = C[n - 1] >= C[0] ? 'var(--up)' : 'var(--down)';
  return `<svg class="m-spk" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,${H} ${pts} ${W},${H}" fill="${col}" opacity=".14"/><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}
const mPct = q => `<span class="m-pct ${toneOf(q.changeRate)}">${fmtPct(q.changeRate)}</span>`;
function mRow(i, sub, spark){
  const q = S.quotes.get(i.market) || {}, L = live(i.market);
  const badge = L.stance === 'buy_zone' ? `<span class="badge accent">${TYPE_KO[L.type]}</span>` : surge.get(i.market) ? '<span class="badge surge">급등</span>' : dump.get(i.market) ? '<span class="badge dump">급락</span>' : isNewListing(i.market) ? '<span class="badge warn">신규</span>' : '';
  const line = sub != null ? sub : (L.text && L.stance !== 'blocked' ? esc(L.text) : `${i.market.slice(4)} · 거래대금 ${fmtKrwShort(q.value24h)}`);
  return `<button class="m-row" data-mm="${i.market}">${mLogo(i.market)}<span class="m-l"><span class="m-n">${esc(i.name)}${badge}</span><span class="m-s">${line}</span></span>${spark ? mSpark(i.market) : ''}<span class="m-r mono" data-mq="${i.market}"><span>${fmtPrice(q.price)}</span>${mPct(q)}</span></button>`;
}
// 급등·급락: 옆으로 넘기는 카드
function mSdCard(m, kind){
  const i = S.byMarket.get(m); if (!i) return '';
  const q = S.quotes.get(m) || {}, src = kind === 'dump' ? dump : surge;
  return `<button class="m-sc ${kind}" data-mm="${m}"><span class="m-sc-h">${mLogo(m, 'sm')}<span class="m-sc-n">${esc(i.name)}</span></span><b class="mono ${toneOf(q.changeRate)}" data-mq2="${m}">${fmtPct(q.changeRate)}</b><span class="mono m-sc-p">${fmtPrice(q.price)}</span><span class="m-sc-t" data-k="${kind}" data-ago="${m}">${surgeText(m, src.get(m))}</span></button>`;
}
// 홈 맨 위: 내 자산 카드
const HX_C = ['#C6F432', '#EDEDEF', '#9A9AA3', '#F5A524', '#5A5A63'];
function mHeroHtml(){
  if (S.acct !== 'paper' && !db.user) return `<button class="m-hero" data-act="login"><div class="hx-t"><span>내 자산</span></div><div class="hx-e">로그인하면 보유 자산과 손익이 여기에 보여요.</div></button>`;
  const H = holdData(), segs = H.pos.slice(0, 5);
  const bar = H.value ? `<div class="hx-bar">${segs.map((p, k) => `<i style="width:${p.weight.toFixed(1)}%;background:${HX_C[k]}"></i>`).join('')}</div><div class="hx-lg">${segs.map((p, k) => `<span><i style="background:${HX_C[k]}"></i>${esc(nameOf(upbit.toMarket(p.symbol)))} ${p.weight.toFixed(0)}%</span>`).join('')}</div>` : '';
  return `<button class="m-hero" data-go="hold"><div class="hx-t"><span>${H.isPaper ? '모의 자산' : '내 자산'}</span><span class="muted">보유 ${H.pos.length}종목 ›</span></div>
    <div class="hx-v mono">${won(H.isPaper ? H.cash + H.value : H.value)}<small>원</small></div>
    <div class="hx-s"><span class="m-pct ${toneOf(H.pct)}">${fmtPct(H.pct)}</span><span class="mono ${toneOf(H.pnl)}">${signWon(H.pnl)}</span><span class="muted">평가손익</span></div>${bar}</button>`;
}
function mSurgeHtml(){
  const muted = surgeMuted();
  const sec = (kind, label, cls) => {
    const ms = sdList(kind), un = kind === 'dump' ? unseenDump : unseen;
    const nNew = muted ? 0 : ms.filter(m => un.has(m)).length;
    const cards = ms.slice(0, 12).map(m => mSdCard(m, kind)).join('');
    return `<div class="m-sd ${nNew ? (kind === 'dump' ? 'blink-dn' : 'blink') : ''}"><div class="m-sec-h"><span class="m-h ${ms.length ? cls : 'muted'}">● ${label} ${ms.length}</span>${nNew ? `<span class="sd-new">새 ${nNew}</span>` : ''}<span class="grow"></span>${nNew ? `<button class="m-btn" data-ack-kind="${kind}">확인</button>` : ''}</div>${cards ? `<div class="m-hs">${cards}</div>` : `<div class="m-none">지금 잡힌 ${label}이 없어요.</div>`}</div>`;
  };
  return sec('surge', '급등', 'up') + sec('dump', '급락', 'down')
    + `<div class="m-mute"><span class="${muted ? 'muted' : 'accent'}">● 알림 ${muted ? muteText() : '켜짐'}</span><span class="grow"></span>${muted ? '<button class="m-btn" data-mute="0">다시 켜기</button>' : '<button class="m-btn" data-mute="30">30분 끄기</button><button class="m-btn" data-mute="-1">끄기</button>'}</div>`;
}
function mMineHtml(){
  const held = new Map(S.ledger.positions.map(p => [upbit.toMarket(p.symbol), p]));
  const ms = [...new Set([...held.keys(), ...[...S.watch].map(upbit.toMarket)])].filter(m => S.byMarket.has(m));
  if (!ms.length) return `<div class="m-none">관심 종목이 없어요. 종목을 열고 ☆를 누르면 여기에 모여요.</div>`;
  loadSparks(ms.map(m => ({ symbol: upbit.toSymbol(m) })));
  return ms.map(m => { const p = held.get(m), q = S.quotes.get(m) || {};
    const sub = p && q.price ? `보유 · 평단 ${fmtPrice(p.avg)} 대비 <span class="${toneOf(q.price - p.avg)}">${fmtPct((q.price / p.avg - 1) * 100)}</span>` : null;
    return mRow(S.byMarket.get(m), sub, true); }).join('');
}
let mLastList = '';
function mRender(){
  if (!PH.on) return;
  const pg = PH.page;
  if (pg === 'home'){
    $('#mHero').innerHTML = mHeroHtml();
    const hs = $$('#mSurgeSec .m-hs').map(x => x.scrollLeft);
    $('#mSurgeSec').innerHTML = mSurgeHtml();
    $$('#mSurgeSec .m-hs').forEach((x, k) => { if (hs[k]) x.scrollLeft = hs[k]; });
    $('#mMine').innerHTML = mMineHtml();
    $('#mScanLine').textContent = $('#scanText') ? '스캔 · ' + $('#scanText').textContent : '';
  } else if (pg === 'list'){
    $('#mListTabs').innerHTML = M_TABS.map(([k, v]) => `<button class="${k === PH.tab ? 'on' : ''}" data-tab="${k}">${v}</button>`).join('');
    const save = S.search; S.search = '';
    const list = listFor(PH.tab); S.search = save;
    const key = PH.tab + list.map(i => i.market).join();
    if (key !== mLastList){
      mLastList = key;
      $('#mListNote').innerHTML = PH.tab === 'bottom' ? bottomTabHtml() : '';
      $('#mList').innerHTML = list.length ? list.slice(0, 200).map(i => mRow(i, PH.tab === 'recent' ? recentText(i.market) : undefined)).join('') : `<div class="m-none">${{ pullback: '지금 조건에 맞는 눌림 매수 종목이 없어요. ☰ → 전체 스캔을 하면 모든 종목에서 찾아요.', bottom: '지금 조건에 맞는 바닥 반등 종목이 없어요.', new: '최근 30일 안에 새로 상장된 종목이 없어요.', recent: '아직 본 종목이 없어요.', rebuy: '재매수 후보가 없어요.' }[PH.tab] || '종목이 없어요.'}</div>`;
    } else mPatch($('#mList'));
  } else if (pg === 'search'){
    const s = $('#mSearch').value.trim().toLowerCase();
    const list = s ? S.instruments.filter(i => i.name.toLowerCase().includes(s) || i.market.toLowerCase().includes(s) || (i.nameEn || '').toLowerCase().includes(s)) : recent.map(x => S.byMarket.get(x.m)).filter(Boolean).slice(0, 20);
    $('#mSearchList').innerHTML = (s ? '' : '<div class="m-sec-h"><span class="muted">최근 본 종목</span></div>') + (list.length ? list.slice(0, 80).map(i => mRow(i)).join('') : `<div class="m-none">${s ? '검색 결과가 없어요.' : '이름이나 코드를 넣어 주세요.'}</div>`);
  } else if (pg === 'coin') mCoinHead();
}
function mPatch(root){
  for (const el of $$('[data-mq]', root)){ const q = S.quotes.get(el.dataset.mq); if (!q) continue; el.innerHTML = `<span>${fmtPrice(q.price)}</span>${mPct(q)}`; }
}
function mCoinHead(){
  const i = S.byMarket.get(S.sel); if (!i) return;
  const q = S.quotes.get(S.sel) || {}, L = live(S.sel), on = S.watch.has(i.symbol);
  $('#mTitle').textContent = i.name;
  $('#mCoinHead').innerHTML = `<div class="m-coin-top">${mLogo(i.market, 'lg')}<div class="m-coin-p"><span class="m-big mono ${toneOf(q.changeRate)}">${fmtPrice(q.price)}</span><span class="m-coin-s">${mPct(q)}<span class="muted mono">${i.market.slice(4)}</span><span class="muted">거래대금 ${fmtKrwShort(q.value24h)}</span></span></div></div>
    <div class="m-coin-b"><button class="m-btn${on ? ' on' : ''}" data-mstar="${i.symbol}">${on ? '★ 관심' : '☆ 관심'}</button><button class="m-btn rec" data-mo="rec">＋ 기록</button><button class="m-btn" data-mo="paper">모의</button></div>
    ${L.text && L.stance !== 'blocked' ? `<div class="m-coin-g">${esc(L.text)}</div>` : ''}`;
}
function mTick(){
  if (!PH.on) return;
  if (PH.page === 'home'){ if (!document.activeElement || !document.activeElement.closest('#mApp')) mRender(); }
  else if (PH.page === 'list' || PH.page === 'search') mPatch($('#mApp'));
  else if (PH.page === 'coin') mCoinHead();
  if (PH.page === 'hold' || PH.page === 'home'){ /* 위에서 다시 그림 */ }
  const li = $('#mLoginItem'); if (li) li.textContent = $('#loginBtn').textContent;
  const ii = $('#mInstallItem'); if (ii) ii.hidden = $('#installBtn').classList.contains('hidden');
}
const MI = (d) => `<svg class="mi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const M_ICONS = {
  home: '<path d="M4 11l8-7 8 7v9H4z"/><path d="M10 20v-6h4v6"/>', search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
  'list:all': '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>', 'list:pullback': '<path d="M3 7l6 6 4-4 8 8"/><path d="M21 12v5h-5"/>', 'list:bottom': '<path d="M3 6c4 0 5 12 9 12s5-12 9-12"/>',
  'list:new': '<path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5z"/>', 'list:recent': '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>', 'list:rebuy': '<path d="M4 12a8 8 0 0 1 14-5l2 2M20 12a8 8 0 0 1-14 5l-2-2"/><path d="M20 4v5h-5M4 20v-5h5"/>',
  scan: '<path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4M4 12h16"/>', strat: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/>',
  hold: '<rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18M16 15h2"/>', journal: '<path d="M6 3h10l3 3v15H6z"/><path d="M9 9h7M9 13h7M9 17h4"/>',
  rec: '<path d="M12 5v14M5 12h14"/>', paper: '<path d="M4 17l5-6 4 4 7-9"/>', upbit: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  news: '<path d="M4 5h13v14H6a2 2 0 0 1-2-2z"/><path d="M17 9h3v8a2 2 0 0 1-2 2"/><path d="M8 9h5M8 13h5"/>', cfg: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  login: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>', install: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M12 18h.01"/>'
};
function mMenuIcons(){
  for (const b of $$('#mMenu button')){
    const k = b.dataset.go ? (b.dataset.go === 'list' ? 'list:' + b.dataset.tab : b.dataset.go) : b.dataset.act;
    if (M_ICONS[k] && !b.querySelector('.mi')) b.insertAdjacentHTML('afterbegin', MI(M_ICONS[k]));
  }
}
function mOpenMenu(){ $('#mApp').classList.add('menu-open'); }
function mCloseMenu(){ $('#mApp').classList.remove('menu-open'); }
function bindPhone(){
  const app = $('#mApp');
  $('#mMenuBtn').addEventListener('click', mOpenMenu);
  $('#mDim').addEventListener('click', mCloseMenu);
  $('#mBack').addEventListener('click', () => history.length > 1 ? history.back() : mShow('home'));
  $('#mFind').addEventListener('click', () => mGo('search'));
  let st; $('#mSearch').addEventListener('input', () => { clearTimeout(st); st = setTimeout(mRender, 120); });
  $('#mCoinTabs').addEventListener('click', e => { const b = e.target.closest('[data-cp]'); if (b){ mSetCp(b.dataset.cp); window.scrollTo(0, 0); } });
  app.addEventListener('click', async e => {
    const go = e.target.closest('[data-go]');
    if (go){ mGo(go.dataset.go, { tab: go.dataset.tab }); return; }
    const tb = e.target.closest('#mListTabs [data-tab]');
    if (tb){ PH.tab = tb.dataset.tab; mLastList = ''; history.replaceState({ mp: { page: 'list', tab: PH.tab } }, ''); mShow('list'); return; }
    const ack = e.target.closest('[data-ack-kind]'); if (ack){ ackKind(ack.dataset.ackKind); mRender(); return; }
    const star = e.target.closest('[data-mstar]');
    if (star){ const sym = star.dataset.mstar; S.watch = new Set(await setWatch(sym, !S.watch.has(sym))); mCoinHead(); return; }
    const ma = e.target.closest('[data-macct]'); if (ma){ setAcct(ma.dataset.macct); $('#mHold').innerHTML = mHoldHtml(); return; }
    const mo = e.target.closest('[data-mo]'); if (mo){ openRec(mo.dataset.mo); return; }
    const act = e.target.closest('[data-act]');
    if (act){ mCloseMenu(); const a = act.dataset.act;
      if (a === 'scan'){ toggleScan(false); toast('전체 스캔을 시작했어요. 끝나면 눌림·바닥 목록이 채워져요.'); }
      else if (a === 'rec' || a === 'paper') openRec(a);
      else if (a === 'upbit') $('#upImportBtn').click();
      else if (a === 'cfg') openCfg();
      else if (a === 'login') $('#loginBtn').click();
      else if (a === 'install') $('#installBtn').click();
      return; }
    const row = e.target.closest('[data-mm]'); if (row){ mOpenCoin(row.dataset.mm); return; }
  });
  app.addEventListener('toggle', e => { if (e.target.classList && e.target.classList.contains('surge-stats')) LS.set(e.target.hasAttribute('data-bt') ? 'quantera:btStatsOpen' : 'quantera:surgeStatsOpen', e.target.open); }, true);
  // 폰 ↔ PC 폭이 바뀌면 화면 구성이 달라서 새로 불러옴
  matchMedia('(max-width: 899px)').addEventListener('change', () => location.reload());
}

// ---------------------------------------------------------------- 앱 설치 (PWA)
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
let installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#installBtn').classList.remove('hidden'); });
addEventListener('appinstalled', () => $('#installBtn').classList.add('hidden'));
$('#installBtn').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('#installBtn').classList.add('hidden'); });

boot();
