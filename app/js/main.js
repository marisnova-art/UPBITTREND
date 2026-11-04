// QUANTERA — 앱 진입점. 상태 → 렌더. 거래소는 어댑터로만 접근합니다.
import { CONFIG } from './config.js';
import { $, $$, esc, fmtPrice, fmtPct, fmtKrwShort, toneOf, LS } from './util.js';
import * as upbit from './adapters/upbit.js';
import { analyzeOne, scanAll } from './analysis/scan.js';
import { STAGE_KO } from './analysis/trend.js';
import { screenCfg, saveScreenCfg, SCREEN_DEFAULTS, summarize, summarizeBottom } from './analysis/screen.js';
import { computeLedger, pastBuys } from './analysis/ledger.js';
import { createSurge, SURGE_DEFAULTS, agoKo } from './analysis/surge.js';
import { loadNews, newsFor, newsHtml } from './news.js';
import { createChart } from './ui/chart.js';
import { initTips, BAR_TIPS } from './ui/tips.js';
import { initLayout, apply as applyLayout } from './ui/layout.js';
import { db, initDb, login, logout, loadWatchlist, setWatch, loadTrades, importTrades, loadNotes, addNote, localLayout, saveLayout, remoteLayout, paperRemote, resetPrefsCache } from './db.js';
import { createPaper } from './paper.js';
import { importMeta, toRow } from './upbitPrivate.js';
import { FEE_RATE } from './analysis/ledger.js';

const STATUS_KO = { 'WAIT': '대기', 'WATCH': '관찰', 'ENTRY ZONE': '매수 검토', 'BREAKOUT WATCH': '돌파 대기', 'EXTENDED': '추격 주의', 'INSUFFICIENT DATA': '데이터 부족' };
const RISK_KO = { 'LOW': '낮음', 'MEDIUM': '보통', 'HIGH': '높음', 'EXTREME': '매우 높음' };

const S = {
  instruments: [], byMarket: new Map(), quotes: new Map(), results: new Map(),
  watch: new Set(), trades: [], ledger: { rows: [], positions: [], rebuy: [] },
  tab: 'fav', search: '', sel: null, tf: '1d', stream: null, scanning: null,
  firstSeen: LS.get('quantera:firstSeen', null),
  acct: LS.get('quantera:acct', 'paper'),
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
const allCfg = () => ({ ...SURGE_DEFAULTS, ...screenCfg() });
const surge = createSurge(allCfg);
const priceOf = sym => { const q = S.quotes.get(upbit.toMarket(sym)); return q ? q.price : null; };
const paper = createPaper({ priceOf, remote: paperRemote });

// ---------------------------------------------------------------- 시작
let chart;
async function boot(){
  initLayout(localLayout(), saveLayout);
  initTips();
  bindUi();
  await waitFor(() => window.LightweightCharts, 8000);
  chart = createChart($('#tv'), $('#legend'), $('#ohlc'));
  renderTf();

  initDb().catch(() => {});
  db.events.on('auth', onAuth);
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
    ticker: onTick, orderbook: renderOrderbook, status: setWs
  });
  S.stream.focus(S.sel);   // 처음 연 종목도 호가·체결 실시간 구독 (전에는 다른 종목을 눌러야 구독됐음)
  // 모의투자: 앱이 꺼져 있던 동안 지정가·예약 매도가 닿았는지 캔들로 확인
  paper.catchUp(upbit.getCandles, upbit.toMarket).then(n => { if (n) toast(`앱이 꺼져 있던 동안 모의 주문 ${n}건이 체결됐어요. 거래일지에서 확인하세요.`, 'warn'); });
  // 관심·보유 종목은 열자마자 분석(캐시라 같은 날 재요청 없음)
  analyzeList([...S.watch].map(upbit.toMarket));
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
  const pr = await paperRemote.load(); if (pr) paper.merge(pr.state, pr.trades);
  recompute(); renderWatch(); analyzeList([...S.watch, ...S.ledger.positions.map(p => p.symbol)].map(upbit.toMarket));
}

// ---------------------------------------------------------------- 실시간
let rafPending = false;
function onTick(q){
  S.quotes.set(q.market, q);
  surge.push(q);
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
const unseen = new Set();
let lastSurgeKey = '', lastBeep = 0, audioCtx = null;
const getAudio = () => { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch(e){} return audioCtx; };
addEventListener('pointerdown', getAudio, { once: true });   // 브라우저는 한 번 클릭한 뒤에야 소리를 허용
function beep(){
  const c = getAudio(); if (!c) return;
  const t = c.currentTime;
  [[0, 880], [0.16, 880], [0.32, 1320]].forEach(([d, f]) => {
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'square'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.2, t + d + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.13);
    o.connect(g).connect(c.destination); o.start(t + d); o.stop(t + d + 0.14);
  });
}
function notifySurge(ms){
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const names = ms.map(m => (S.byMarket.get(m) || {}).name || m);
  try { new Notification('급등 감지', { body: names.join(', ') + ' — 갑자기 거래가 몰리고 있어요', tag: 'quantera-surge', renotify: true, icon: './icons/icon-192.png' }); } catch(e){}
}
function ackSurge(m){
  if (m) unseen.delete(m); else unseen.clear();
  for (const row of $$('.wl-row.blink', $('#wlBody'))) if (!unseen.has(row.dataset.m)) row.classList.remove('blink');
  renderSurgeBar();
}
function renderSurgeBar(){
  const bar = $('#surgeBar'); if (!bar) return;
  const ms = [...unseen].filter(m => surge.events.has(m));
  if (!ms.length){ bar.classList.add('hidden'); $('#wlTabs [data-tab="surge"]').classList.remove('blink'); return; }
  const first = (S.byMarket.get(ms[0]) || {}).name || ms[0];
  bar.innerHTML = `<span class="dot-live"></span><b>급등 ${ms.length}</b><span>${esc(first)}${ms.length > 1 ? ` 외 ${ms.length - 1}` : ''}</span><button class="pill" data-surge-go>보기</button><button class="pill" data-surge-ack>모두 확인</button>`;
  bar.classList.remove('hidden');
  $('#wlTabs [data-tab="surge"]').classList.add('blink');
}
setInterval(() => {
  const fresh = surge.check(S.quotes), cfg = allCfg();
  for (const m of fresh) unseen.add(m);
  for (const m of [...unseen]) if (!surge.events.has(m)) unseen.delete(m);
  if (fresh.length){ notifySurge(fresh); renderSurgeBar(); }
  if (cfg.surgeAlarm && unseen.size && Date.now() - lastBeep >= cfg.surgeRepeat * 1000){ lastBeep = Date.now(); beep(); }
  const key = [...surge.events.keys()].join() + '|' + surge.log().length + '|' + surge.tracking.size;
  if (S.tab === 'surge' && !S.search){
    if (fresh.length || key !== lastSurgeKey) renderWatch();
    else for (const el of $$('[data-ago]', $('#wlBody'))){ const e = surge.get(el.dataset.ago); if (e) el.textContent = surgeText(el.dataset.ago, e); }
  } else if (fresh.length || key !== lastSurgeKey) renderSurgeBadges();
  if (key !== lastSurgeKey) renderSurgeBar();
  lastSurgeKey = key;
  const t = $('#wlTabs [data-tab="surge"]'); if (t) t.dataset.n = surge.events.size || '';
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
    const has = surge.events.has(row.dataset.m), b = $('.badge.surge', row);
    if (has && !b) $('.wl-name', row).insertAdjacentHTML('beforeend', '<span class="badge surge">급등</span>');
    else if (!has && b) b.remove();
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
  else if (tab === 'surge' && !S.search) return list.filter(i => surge.events.has(i.market)).sort((a, b) => surge.get(b.market).at - surge.get(a.market).at);
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
    const msg = { fav: '관심 종목이 없어요. 전체 탭에서 ☆를 눌러 추가하세요.', hold: '보유 종목이 없어요. 로그인하면 기존 보유 종목이 기초 이월로 보여요.', pullback: '지금 조건에 맞는 눌림 매수 종목이 없어요. 아래 "전체 스캔"을 하면 모든 종목에서 찾아요.', bottom: '지금 조건에 맞는 바닥 반등 종목이 없어요. 아래 "전체 스캔"을 하면 모든 종목에서 찾아요.', new: '최근 30일 안에 새로 상장된 종목이 없어요.', recent: '아직 본 종목이 없어요. 종목을 열면 여기에 본 순서대로 남아요.', surge: `지금 갑자기 거래가 몰린 코인이 없어요. 앱이 켜져 있는 동안 1초마다 검사해요. (최근 ${allCfg().surgeSec}초 거래대금이 평소의 ${allCfg().surgeVol}배 이상)`, rebuy: '재매수 후보가 없어요. 이익을 내고 판 종목이 그때 매수가보다 싸지면 여기에 떠요.' };
    $('#wlBody').innerHTML = (S.tab === 'surge' && !S.search ? surgeStatsHtml() : '') + (S.tab === 'bottom' && !S.search ? bottomTabHtml() : '') + `<div class="empty">${S.search ? '검색 결과가 없어요.' : msg[S.tab] || ''}</div>`; return;
  }
  $('#wlBody').innerHTML = (S.tab === 'surge' && !S.search ? surgeStatsHtml() : '') + (S.tab === 'bottom' && !S.search ? bottomTabHtml() : '') + list.slice(0, 300).map(i => {
    const q = S.quotes.get(i.market) || {}, r = S.results.get(i.market);
    const L = live(i.market);
    const bar = L.stance === 'buy_zone' ? 'entry' : ['chase', 'broken', 'failed'].includes(L.stance) ? 'warn' : '';
    const sv = surge.get(i.market);
    const badges = [sv ? '<span class="badge surge">급등</span>' : '', L.stance === 'buy_zone' ? `<span class="badge accent">${TYPE_KO[L.type]}</span>` : '', rebuy.has(i.market) ? '<span class="badge accent">재매수</span>' : '', isNewListing(i.market) ? '<span class="badge warn">신규</span>' : '',
      q.suspended ? '<span class="badge warn">거래정지</span>' : '', i.warning ? '<span class="badge warn">유의</span>' : '', (i.caution || []).length ? '<span class="badge line">주의</span>' : ''].join('');
    return `<div class="wl-row${S.sel === i.market ? ' sel' : ''}${S.tab === 'surge' && unseen.has(i.market) ? ' blink' : ''}" data-m="${i.market}">
      <span class="bar ${bar}" data-tip="${BAR_TIPS[bar]}"></span>
      <div style="min-width:0">
        <div class="wl-name"><button class="star${S.watch.has(i.symbol) ? ' on' : ''}" data-star="${i.symbol}" aria-label="관심">${S.watch.has(i.symbol) ? '★' : '☆'}</button><b>${esc(i.name)}</b>${badges}</div>
        <div class="wl-peter">${S.tab === 'recent' && !S.search ? recentText(i.market) : S.tab === 'surge' && sv ? `<span class="surge-txt" data-ago="${i.market}">${surgeText(i.market, sv)}</span>` : r && L.stance !== 'blocked' ? esc(L.text || r.peter) :`<span class="mono">${i.market}</span> · ${fmtKrwShort(q.value24h)}`}</div>
      </div>
      <div class="wl-px mono"><div class="p ${toneOf(q.changeRate)}" data-px="${i.market}">${fmtPrice(q.price)}</div><div class="c ${toneOf(q.changeRate)}" data-cr="${i.market}">${fmtPct(q.changeRate)}</div></div>
    </div>`;
  }).join('');
}
function patchWatchPrices(){
  for (const el of $$('[data-px]', $('#wlBody'))){
    const q = S.quotes.get(el.dataset.px); if (!q) continue;
    const t = toneOf(q.changeRate), txt = fmtPrice(q.price);
    if (el.textContent !== txt){ el.textContent = txt; el.className = 'p ' + t; const c = el.nextElementSibling; c.textContent = fmtPct(q.changeRate); c.className = 'c ' + t; }
  }
}

// ---------------------------------------------------------------- 종목 선택
async function select(market, { noRecent = false } = {}){
  if (unseen.has(market)) ackSurge(market);
  if (!S.byMarket.has(market)) market = 'KRW-BTC';
  if (S.sel !== market) OF.price = OF.amount = OF.qty = OF.sellPct = '';
  S.sel = market; LS.set('quantera:sel', market);
  if (!noRecent){ addRecent(market); if (S.tab === 'recent' && !S.search) renderWatch(); }
  for (const el of $$('.wl-row')) el.classList.toggle('sel', el.dataset.m === market);
  S.stream && S.stream.focus(market);
  renderHead(); renderOrderbook(null); renderOrderForm();
  loadChart();
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
  if (pos) extra.push({ price: pos.avg, title: S.acct === 'paper' ? '모의 평단' : '내 평단', color: '#B48CFF', legend: '내 평단', width: 2 });
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
    `<div class="muted" style="font-size:12px;margin-top:6px">% 는 신호일 종가 ${fmtPrice(G.ref)} 대비 · 손익비 ${G.rr.toFixed(2)}${sig.type === 'bottom' ? ' · 바닥 반등은 위험이 커서 비중을 작게' : ''}</div>
     <ul class="reasons">${sig.why.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
     <h3 style="margin:12px 0 8px">과거 같은 신호 결과 <span class="grow"></span><span class="muted" style="font-size:12px;font-weight:400">${cfg.holdDays}일 안 1차 매도 or 손절</span></h3>
     <dl class="kv">${st(mine, '이 종목')}${st(all, `분석한 ${S.results.size}종목`)}</dl>`;
  } else if (L.stance === 'chase' || L.stance === 'blocked') {
    guide = liveNote + `<div class="muted" style="font-size:12px">이 종목엔 매수 가이드를 내지 않아요.</div>`;
  } else if (L.stance === 'avoid') {
    guide = `<div class="peter">하락 추세예요. 바닥 반등 조건(1년 고점 대비 -${cfg.btMinDrop}%, ${cfg.btNoNewLowDays}일 새 저점 없음, 반등 신호)이 맞으면 가이드가 떠요.</div>`;
  } else if (L.stance === 'none') {
    guide = `<div class="peter">${esc(r.peter)}</div>`;
  } else {
    guide = `<div class="peter">지금은 매수 신호가 없어요. 눌림 매수나 바닥 반등 조건이 맞으면 가이드가 떠요.</div>` +
      (g.buyLo ? row('#7D7D86', '참고 지지', `${fmtPrice(g.buyLo)} ~ ${fmtPrice(g.buyHi)}`, null) + row('#7D7D86', '참고 저항', fmtPrice(g.sell1), null) : '');
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
    <div class="sec"><h3>추세 분석 (참고)</h3>${stats || '<div class="muted" style="font-size:12px">캔들이 부족해 점수를 내지 않아요.</div>'}
      ${r.reasons && r.reasons.length ? `<details style="margin-top:8px"><summary class="muted" style="font-size:12px;cursor:pointer">근거 보기</summary><ul class="reasons">${r.reasons.slice(0, 4).map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}</div>
    <div class="sec"><h3>변동폭 프로필 <span class="grow"></span><span class="muted" style="font-size:12px;font-weight:400">최근 ${P.lookback || 90}일</span></h3>
      <table class="prof"><thead><tr><th></th><th>평균</th><th>보통</th><th>최대</th><th>최소</th></tr></thead><tbody>${pr('1d', '일봉') + pr('1w', '주봉')}</tbody></table>
      <div class="muted" style="font-size:12px;margin-top:6px">5분·1시간·월봉 변동폭은 수집 서버가 붙으면 채워져요.</div></div>
    <div class="sec"><h3>업비트 소식</h3><div id="inspNews"><div class="muted" style="font-size:12px">불러오는 중…</div></div></div>
    <details class="sec wiki" id="wikiSec" ${LS.get('quantera:wikiOpen', true) ? 'open' : ''}><summary>종목 위키 <span class="muted" style="font-weight:400">${esc(nameOf(S.sel))}</span></summary>${wikiHtml(r)}</details>`;
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
  return `<div class="wiki-sum">${wikiFacts(r).map(([a, b]) => `<div><b>${esc(a)}</b>${b ? `<span class="muted">${esc(b)}</span>` : ''}</div>`).join('')}</div>
    <h4>내 거래 <span class="muted">${mine.length}건</span></h4>
    ${mine.length ? `<div class="bt-list wiki-trades">${mine.slice(0, 12).map(x => `<div><span class="mono muted">${dShort(x.executed_at)}</span><span><span class="${x.side === 'buy' ? 'up' : 'down'}">${x.side === 'buy' ? '매수' : '매도'}</span> <span class="mono">${fmtPrice(x.price)}</span> <span class="badge line">${src[x.source] || x.source}</span></span><span class="mono ${toneOf(x.realized)}">${x.realized != null ? fmtPct(x.realizedPct) : ''}</span></div>`).join('')}</div>` : '<div class="muted" style="font-size:12px">아직 이 종목 거래가 없어요.</div>'}
    <h4>메모 <span class="muted">쌓기만 해요 (지우지 않음)</span></h4>
    <div class="wiki-add"><textarea id="wikiNote" rows="2" placeholder="왜 샀는지, 무엇을 봤는지, 다음엔 어떻게 할지"></textarea><button class="pill accent sm" id="wikiSave">남기기</button></div>
    <div id="wikiNotes" class="wiki-notes"><div class="muted" style="font-size:12px">불러오는 중…</div></div>`;
}
const notesCache = new Map();
async function fillNotes(force){
  const m = S.sel, sym = upbit.toSymbol(m);
  if (force || !notesCache.has(sym)) notesCache.set(sym, await loadNotes(sym));
  const el = $('#wikiNotes'); if (!el || S.sel !== m) return;
  const list = notesCache.get(sym) || [];
  el.innerHTML = list.length ? list.map(n => `<div><span class="mono muted">${new Date(n.created_at).toLocaleString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</span><p>${esc(n.body)}</p></div>`).join('') : '<div class="muted" style="font-size:12px">아직 메모가 없어요.</div>';
}
function bindWiki(){
  $('#inspBody').addEventListener('toggle', e => { if (e.target.id === 'wikiSec') LS.set('quantera:wikiOpen', e.target.open); }, true);
  $('#inspBody').addEventListener('click', async e => {
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
  const units = ob.units.slice(0, 12);
  const max = Math.max(...units.map(u => Math.max(u.askSize, u.bidSize)), 1e-9);
  const q = S.quotes.get(S.sel) || {};
  const asks = units.slice().reverse().map(u => `<div class="ob-row ask"><i style="width:${u.askSize / max * 100}%"></i><span class="p mono">${fmtPrice(u.ask)}</span><span class="sz mono">${u.askSize.toFixed(3)}</span></div>`).join('');
  const bids = units.map(u => `<div class="ob-row bid"><i style="width:${u.bidSize / max * 100}%"></i><span class="p mono">${fmtPrice(u.bid)}</span><span class="sz mono">${u.bidSize.toFixed(3)}</span></div>`).join('');
  $('#obBody').innerHTML = asks + `<div class="ob-mid mono ${toneOf(q.changeRate)}">${fmtPrice(q.price)} <span style="font-size:12px">${fmtPct(q.changeRate)}</span></div>` + bids;
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
  const sw = `<div class="acct-sw"><span>계좌</span><button data-acct="paper" class="${S.acct === 'paper' ? 'on' : ''}">모의</button><button data-acct="real" class="${S.acct === 'real' ? 'on' : ''}">실제</button><span class="grow"></span>${S.acct === 'paper' ? `<span class="mono" data-tip="모의 계좌에서 지금 주문에 쓸 수 있는 현금">${won(paper.available())}원</span>` : ''}</div>`;
  if (S.acct === 'real'){
    box.innerHTML = sw + `<div class="note">실제 계좌 주문은 업비트 API 연결(PHASE 5) 뒤에 열려요. 지금은 "모의"로 바꿔서 같은 화면으로 연습할 수 있어요. 실제 계좌 탭에서는 거래일지·보유가 실제 기록 기준으로 보여요.</div>`;
    return;
  }
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
        const base = { symbol: sym, side: OF.side, type: OF.type, price: OF.type === 'market' ? cur : (num(OF.price) || cur) };
        if (OF.side === 'buy') paper.place({ ...base, amount: num(OF.amount), tpPct: num(OF.tpPct) || null, slPct: OF.slNone ? null : (num(OF.slPct) || null),
          strategy: STRATS[OF.strategy], reason: OF.strategy === 'guide' ? (live(S.sel).text || (S.results.get(S.sel) || {}).peter || null) : null });
        else paper.place({ ...base, qty: num(OF.qty), strategy: '직접 매도' });
        OF.amount = ''; OF.qty = ''; OF.err = ''; renderOrderForm();
      }catch(err){ OF.err = err.message; renderOrderForm(); }
    }
  });
  // 호가를 누르면 그 가격이 주문 가격으로
  $('#obBody').addEventListener('click', e => {
    const row = e.target.closest('.ob-row'); if (!row) return;
    OF.price = num($('.p', row).textContent); OF.type = 'limit'; renderOrderForm();
  });
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
      else if (t.hasAttribute('data-reset')){ const v = prompt('모의 계좌를 새로 시작할까요? 시작 금액(원)을 넣어 주세요.\n지금까지의 체결 기록은 거래일지에 남지만, 잔고·보유·주문은 새로 시작해요.', String(paper.state.start)); if (v != null && num(v) > 0) paper.reset(num(v)); }
    }catch(err){ alert(err.message); }
  });
}
function setAcct(a){
  S.acct = a; LS.set('quantera:acct', a);
  recompute(); renderOrderForm(); renderJournal(); renderStatus(); applyGuideToChart(); if (S.tab === 'hold') renderWatch();
  if (isOrdersOpen()) renderOrders();
}
const isOrdersOpen = () => !$('#ordBody').classList.contains('hidden');
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
    <div class="ot-title">모의 계좌 <span class="grow"></span><button class="pill" data-reset>새로 시작</button></div>
    <table class="ot"><tbody><tr><td class="l">시작 금액</td><td class="mono">${won(st.start)}원</td><td class="l">현금</td><td class="mono">${won(st.cash)}원</td><td class="l">총자산</td><td class="mono">${won(total)}원</td><td class="l">수익률</td><td class="mono ${toneOf(total - st.start)}">${fmtPct((total / st.start - 1) * 100)}</td></tr></tbody></table>
    <div class="note" style="padding:8px">앱이 켜져 있는 동안 실시간으로 체결돼요. 꺼져 있던 동안 가격이 닿았는지는 다시 열 때 분봉으로 확인해요. 수수료 0.05% 반영, 부분 체결 없음.</div>`;
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
  if (order.type === 'limit') beep();
});
paper.on('bracket', ({ bracket, kind, trade }) => {
  const nm = (S.byMarket.get(upbit.toMarket(trade.symbol)) || {}).name || trade.symbol;
  const net = trade.qty * trade.price * (1 - FEE_RATE) - trade.qty * bracket.entry * (1 + FEE_RATE);
  const msg = `${kind === 'tp' ? '익절' : '손절'} 도달 · ${nm} ${fmtPrice(trade.price)}에 모의 매도 · ${net > 0 ? '+' : ''}${won(net)}원`;
  toast(msg, kind === 'tp' ? 'up' : 'down'); beep();
  if ('Notification' in window && Notification.permission === 'granted') try { new Notification('모의 ' + (kind === 'tp' ? '익절' : '손절'), { body: msg, tag: 'quantera-paper-' + bracket.id, icon: './icons/icon-192.png' }); } catch(e){}
});

// ---------------------------------------------------------------- 거래일지
function recompute(){
  S.ledgerReal = computeLedger(S.trades.filter(t => t.source !== 'paper'), priceOf);
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
  const rows = S.ledger.rows.slice().reverse();
  renderStatus();
  if (isPaper && !rows.length){ $('#jBody').innerHTML = '<div class="empty">아직 모의 체결이 없어요. 오른쪽 주문 칸에서 모의 매수를 해 보세요.</div>'; $('#jSummary').textContent = ''; return; }
  if (!rows.length){ $('#jBody').innerHTML = `<div class="empty">${db.tablesOk === false ? '기록 테이블이 아직 없어요. Supabase에 PHASE 1 SQL을 실행하면 보여요.' : '아직 거래 기록이 없어요.'}</div>`; return; }
  const realized = rows.reduce((s, r) => s + (r.realized || 0), 0);
  $('#jSummary').innerHTML = `${rows.length}건 · 실현손익 <b class="mono ${toneOf(realized)}">${realized ? (realized > 0 ? '+' : '') + Math.round(realized).toLocaleString('ko-KR') : '0'}</b>`;
  const name = s => (S.byMarket.get(upbit.toMarket(s)) || {}).name || s;
  const src = { carry_over: '기초 이월', manual: '수동', paper: '모의', upbit_import: '업비트', real: '실거래' };
  $('#jBody').innerHTML = `<table class="jt"><thead><tr>
      <th class="l">ID</th><th class="l">일시</th><th class="l">종목</th><th class="l">구분</th><th>체결가</th><th>수량</th><th>수수료</th><th>실현손익</th><th>수익률</th><th>현재가 대비</th><th class="l">출처·전략</th><th class="l">판단 이유</th></tr></thead><tbody>
    ${rows.map(r => `<tr data-m="${upbit.toMarket(r.symbol)}">
      <td class="l mono">${esc(r.trade_no)}</td>
      <td class="l mono">${new Date(r.executed_at).toLocaleString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</td>
      <td class="l">${esc(name(r.symbol))}</td>
      <td class="l ${r.side === 'buy' ? 'up' : 'down'}">${r.side === 'buy' ? '매수' : '매도'}</td>
      <td class="mono">${fmtPrice(r.price)}</td>
      <td class="mono">${(+r.qty).toLocaleString('ko-KR', { maximumFractionDigits: 8 })}</td>
      <td class="mono">${Math.round(r.fee).toLocaleString('ko-KR')}</td>
      <td class="mono ${toneOf(r.realized)}">${r.realized != null ? (r.realized > 0 ? '+' : '') + Math.round(r.realized).toLocaleString('ko-KR') : ''}</td>
      <td class="mono ${toneOf(r.realizedPct)}">${r.realizedPct != null ? fmtPct(r.realizedPct) : ''}</td>
      <td class="mono ${toneOf(r.vsNow)}"${r.side === 'buy' ? ` data-lv="vs" data-s="${r.symbol}" data-p="${r.price}"` : ''}>${r.side === 'buy' && r.vsNow != null ? fmtPct(r.vsNow) : ''}</td>
      <td class="l">${esc([src[r.source] || r.source, r.strategy].filter(Boolean).join(' · '))}</td>
      <td class="l reason" title="${esc(r.reason || '')}">${esc(r.reason || '')}</td></tr>`).join('')}</tbody></table>`;
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
setInterval(() => { if ((db.user && S.trades.length) || paper.trades.length) renderJournal(); if (isOrdersOpen()) renderOrders(); }, 15000);

// ---------------------------------------------------------------- 분석 일괄
async function analyzeList(markets){
  for (const m of [...new Set(markets)]){
    const inst = S.byMarket.get(m); if (!inst || S.results.has(m)) continue;
    try { setResult(m, await analyzeOne(inst, S.quotes.get(m))); } catch(e){}
  }
  renderJournal(); renderWatch(); if (S.sel) renderHead();
}
async function toggleScan(){
  if (S.scanning){ S.scanning.abort(); return; }
  S.scanning = new AbortController(); $('#scanBtn').textContent = '중지';
  const t0 = Date.now();
  await scanAll(S.instruments, S.quotes, {
    signal: S.scanning.signal,
    onResult: r => setResult(r.market, r),
    onProgress: (d, n) => { $('#scanProg').style.width = (d / n * 100) + '%'; $('#scanText').textContent = `${d}/${n}`; if (d % 20 === 0) renderWatch(); }
  });
  S.scanning = null; $('#scanBtn').textContent = '전체 스캔';
  $('#scanText').textContent = `완료 · ${Math.round((Date.now() - t0) / 1000)}초`;
  renderWatch();
}

// ---------------------------------------------------------------- 이벤트
function bindUi(){
  bindCfg();
  bindOrder();
  bindImport();
  bindWiki();
  $('#jTabs').addEventListener('click', e => {
    const b = e.target.closest('[data-j]'); if (!b) return;
    $$('#jTabs .pill').forEach(x => x.classList.toggle('on', x === b));
    const j = b.dataset.j, news = j === 'news';
    $('#jBody').classList.toggle('hidden', j !== 'journal'); $('#newsBody').classList.toggle('hidden', !news); $('#ordBody').classList.toggle('hidden', j !== 'orders'); $('#jSummary').classList.toggle('hidden', j !== 'journal');
    if (news) renderNews(); if (j === 'orders') renderOrders();
  });
  $('#wlTabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (!b) return; S.tab = b.dataset.tab; $$('#wlTabs .pill').forEach(x => x.classList.toggle('on', x === b)); renderWatch();
    if (S.tab === 'surge' && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); });
  $('#wlBody').addEventListener('toggle', e => { if (e.target.classList && e.target.classList.contains('surge-stats')) LS.set(e.target.hasAttribute('data-bt') ? 'quantera:btStatsOpen' : 'quantera:surgeStatsOpen', e.target.open); }, true);
  $('#surgeBar').addEventListener('click', e => {
    if (e.target.closest('[data-surge-ack]')) return ackSurge();
    if (e.target.closest('[data-surge-go]')){ S.search = ''; S.tab = 'surge'; $$('#wlTabs .pill').forEach(x => x.classList.toggle('on', x.dataset.tab === 'surge')); setMobile('watch'); renderWatch(); }
  });
  $('#wlBody').addEventListener('click', async e => {
    const st = e.target.closest('[data-star]');
    if (st){ e.stopPropagation(); const sym = st.dataset.star; const on = !S.watch.has(sym); S.watch = new Set(await setWatch(sym, on)); renderWatch(); return; }
    const row = e.target.closest('.wl-row'); if (row){ select(row.dataset.m); if (matchMedia('(max-width: 899px)').matches) setMobile('chart'); }
  });
  $('#jBody').addEventListener('click', e => { const tr = e.target.closest('tr[data-m]'); if (tr) select(tr.dataset.m); });
  $('#tfTabs').addEventListener('click', e => { const b = e.target.closest('[data-tf]'); if (!b) return; S.tf = b.dataset.tf; renderTf(); loadChart(); });
  let st; $('#search').addEventListener('input', e => { clearTimeout(st); st = setTimeout(() => { S.search = e.target.value.trim(); renderWatch(); }, 150); });
  $('#scanBtn').addEventListener('click', toggleScan);
  $$('.mtabs button').forEach(b => b.addEventListener('click', () => setMobile(b.dataset.m)));
  $$('.rail [data-view]').forEach(b => b.addEventListener('click', () => {
    $$('.rail button').forEach(x => x.classList.toggle('on', x === b));
    const v = b.dataset.view;
    if (v === 'settings'){ openCfg(); return; }
    if (v === 'rebuy' || v === 'scan'){ S.tab = v === 'rebuy' ? 'rebuy' : 'pullback'; $$('#wlTabs .pill').forEach(x => x.classList.toggle('on', x.dataset.tab === S.tab)); renderWatch(); }
    if (v === 'journal') $('#pJournal').scrollIntoView({ behavior: 'smooth' });
  }));
  $('#loginBtn').addEventListener('click', async () => { if (db.user){ await logout(); return; } $('#lgMsg').textContent = ''; $('#loginDlg').showModal(); });
  $('#loginForm').addEventListener('submit', async e => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    $('#lgMsg').textContent = '로그인 중…';
    try { await login($('#lgEmail').value.trim(), $('#lgPw').value); $('#loginDlg').close(); }
    catch(err){ $('#lgMsg').textContent = err.message; }
  });
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
  ['급등 감지 (1초마다)', [['surgeSec', '이 시간(초) 동안의 거래를 봄', 1], ['surgeVol', '평소 같은 시간보다 거래대금 배수', 1], ['surgePct', '그 시간 상승률(%) 이상 (0 = 가격 안 봄)', 1], ['surgeMinValue', '그 시간 최소 거래대금(백만 원)', 1e6], ['surgeKeepMin', '잡힌 뒤 목록 유지(분)', 1], ['surgeAlarm', '소리 알람', 'bool'], ['surgeRepeat', '확인 전까지 반복 간격(초)', 1], ['surgeCombos', '적중률 조합 (익절/손절, 쉼표로)', 'text'], ['surgeTimeoutMin', '적중률 시간 종료(분)', 1], ['surgeTradeTp', '급등 거래 주문 기본 익절(%)', 1], ['surgeTradeSl', '급등 거래 주문 기본 손절(%)', 1]]],
  ['검증', [['minSamples', '최소 표본 수', 1], ['holdDays', '보유 기간(일)', 1], ['feePct', '왕복 수수료(%)', 1]]]
];
function openCfg(c = allCfg()){
  $('#cfgBody').innerHTML = CFG_FIELDS.map(([title, fs]) => `<h4>${title}</h4>` + fs.map(([k, label, unit]) => unit === 'text'
    ? `<label>${label}<input type="text" name="${k}" value="${esc(c[k])}"></label>`
    : unit === 'bool'
    ? `<label>${label}<input type="checkbox" name="${k}" ${c[k] ? 'checked' : ''}></label>`
    : `<label>${label}<input type="number" step="any" name="${k}" value="${+(c[k] / unit).toFixed(4)}"></label>`).join('')).join('');
  $('#cfgDlg').showModal();
}
function bindCfg(){
  $('#cfgReset').addEventListener('click', e => { e.preventDefault(); openCfg({ ...SCREEN_DEFAULTS, ...SURGE_DEFAULTS }); });
  $('#cfgForm').addEventListener('submit', async e => {
    if (!e.submitter || e.submitter.value !== 'save') return;
    const c = {};
    for (const [, fs] of CFG_FIELDS) for (const [k, , unit] of fs){
      const el = $(`#cfgBody [name="${k}"]`);
      c[k] = unit === 'text' ? el.value : unit === 'bool' ? el.checked : (isFinite(+el.value) ? +el.value * unit : { ...SCREEN_DEFAULTS, ...SURGE_DEFAULTS }[k]);
    }
    saveScreenCfg(c);
    // 기준이 바뀌면 이미 받은 캔들(캐시)로 다시 계산 — 업비트 추가 요청 없음
    const ms = [...S.results.keys()]; S.results.clear(); gsDirty = true;
    await analyzeList(ms);
    if (S.sel) select(S.sel);
  });
}
function setMobile(m){
  document.body.dataset.m = m;
  $$('.mtabs button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  if (m === 'chart' && chart) requestAnimationFrame(() => chart.refit());
}

// ---------------------------------------------------------------- 앱 설치 (PWA)
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {});
let installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('#installBtn').classList.remove('hidden'); });
addEventListener('appinstalled', () => $('#installBtn').classList.add('hidden'));
$('#installBtn').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('#installBtn').classList.add('hidden'); });

boot();
