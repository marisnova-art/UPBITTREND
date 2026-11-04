// QUANTERA — 앱 진입점. 상태 → 렌더. 거래소는 어댑터로만 접근합니다.
import { CONFIG } from './config.js';
import { $, $$, esc, fmtPrice, fmtPct, fmtKrwShort, toneOf, LS } from './util.js';
import * as upbit from './adapters/upbit.js';
import { analyzeOne, scanAll } from './analysis/scan.js';
import { STAGE_KO } from './analysis/trend.js';
import { screenCfg, saveScreenCfg, SCREEN_DEFAULTS, summarize } from './analysis/screen.js';
import { computeLedger, pastBuys } from './analysis/ledger.js';
import { loadNews, newsFor, newsHtml } from './news.js';
import { createChart } from './ui/chart.js';
import { initLayout, apply as applyLayout } from './ui/layout.js';
import { db, initDb, login, logout, loadWatchlist, setWatch, loadTrades, localLayout, saveLayout, remoteLayout } from './db.js';

const STATUS_KO = { 'WAIT': '대기', 'WATCH': '관찰', 'ENTRY ZONE': '매수 검토', 'BREAKOUT WATCH': '돌파 대기', 'EXTENDED': '추격 주의', 'INSUFFICIENT DATA': '데이터 부족' };
const RISK_KO = { 'LOW': '낮음', 'MEDIUM': '보통', 'HIGH': '높음', 'EXTREME': '매우 높음' };

const S = {
  instruments: [], byMarket: new Map(), quotes: new Map(), results: new Map(),
  watch: new Set(), trades: [], ledger: { rows: [], positions: [], rebuy: [] },
  tab: 'fav', search: '', sel: null, tf: '1d', stream: null, scanning: null,
  firstSeen: LS.get('quantera:firstSeen', null)
};
const priceOf = sym => { const q = S.quotes.get(upbit.toMarket(sym)); return q ? q.price : null; };

// ---------------------------------------------------------------- 시작
let chart;
async function boot(){
  initLayout(localLayout(), saveLayout);
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
  select(LS.get('quantera:sel', 'KRW-BTC'));
  S.stream = upbit.stream(S.instruments.map(i => i.market), {
    ticker: onTick, orderbook: renderOrderbook, status: setWs
  });
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
  recompute(); renderWatch(); analyzeList([...S.watch, ...S.ledger.positions.map(p => p.symbol)].map(upbit.toMarket));
}

// ---------------------------------------------------------------- 실시간
let rafPending = false;
function onTick(q){
  S.quotes.set(q.market, q);
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
  return { pullback: summarize(all.pullback), bottom: summarize(all.bottom) };
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
    const msg = { fav: '관심 종목이 없어요. 전체 탭에서 ☆를 눌러 추가하세요.', hold: '보유 종목이 없어요. 로그인하면 기존 보유 종목이 기초 이월로 보여요.', pullback: '지금 조건에 맞는 눌림 매수 종목이 없어요. 아래 "전체 스캔"을 하면 모든 종목에서 찾아요.', bottom: '지금 조건에 맞는 바닥 반등 종목이 없어요. 아래 "전체 스캔"을 하면 모든 종목에서 찾아요.', new: '최근 30일 안에 새로 상장된 종목이 없어요.', rebuy: '재매수 후보가 없어요. 이익을 내고 판 종목이 그때 매수가보다 싸지면 여기에 떠요.' };
    $('#wlBody').innerHTML = `<div class="empty">${S.search ? '검색 결과가 없어요.' : msg[S.tab] || ''}</div>`; return;
  }
  $('#wlBody').innerHTML = list.slice(0, 300).map(i => {
    const q = S.quotes.get(i.market) || {}, r = S.results.get(i.market);
    const L = live(i.market);
    const bar = L.stance === 'buy_zone' ? 'entry' : ['chase', 'broken', 'failed'].includes(L.stance) ? 'warn' : '';
    const badges = [L.stance === 'buy_zone' ? `<span class="badge accent">${TYPE_KO[L.type]}</span>` : '', rebuy.has(i.market) ? '<span class="badge accent">재매수</span>' : '', isNewListing(i.market) ? '<span class="badge warn">신규</span>' : '',
      q.suspended ? '<span class="badge warn">거래정지</span>' : '', i.warning ? '<span class="badge warn">유의</span>' : '', (i.caution || []).length ? '<span class="badge line">주의</span>' : ''].join('');
    return `<div class="wl-row${S.sel === i.market ? ' sel' : ''}" data-m="${i.market}">
      <span class="bar ${bar}"></span>
      <div style="min-width:0">
        <div class="wl-name"><button class="star${S.watch.has(i.symbol) ? ' on' : ''}" data-star="${i.symbol}" aria-label="관심">${S.watch.has(i.symbol) ? '★' : '☆'}</button><b>${esc(i.name)}</b>${badges}</div>
        <div class="wl-peter">${r && L.stance !== 'blocked' ? esc(L.text || r.peter) :`<span class="mono">${i.market}</span> · ${fmtKrwShort(q.value24h)}`}</div>
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
async function select(market){
  if (!S.byMarket.has(market)) market = 'KRW-BTC';
  S.sel = market; LS.set('quantera:sel', market);
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
  chart && chart.setGuide(effGuide(S.sel), pastBuys(S.ledger.rows, upbit.toSymbol(S.sel)));
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
  $('#inspBody').innerHTML = `
    <div class="sec"><h3>매매 가이드 <span class="grow"></span>${stanceTxt}</h3>${guide}</div>
    <div class="sec"><div class="peter"><b>피터</b>${esc(r.peter)}</div></div>
    <div class="sec"><h3>추세 분석 (참고)</h3>${stats || '<div class="muted" style="font-size:12px">캔들이 부족해 점수를 내지 않아요.</div>'}
      ${r.reasons && r.reasons.length ? `<details style="margin-top:8px"><summary class="muted" style="font-size:12px;cursor:pointer">근거 보기</summary><ul class="reasons">${r.reasons.slice(0, 4).map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}</div>
    <div class="sec"><h3>변동폭 프로필 <span class="grow"></span><span class="muted" style="font-size:12px;font-weight:400">최근 ${P.lookback || 90}일</span></h3>
      <table class="prof"><thead><tr><th></th><th>평균</th><th>보통</th><th>최대</th><th>최소</th></tr></thead><tbody>${pr('1d', '일봉') + pr('1w', '주봉')}</tbody></table>
      <div class="muted" style="font-size:12px;margin-top:6px">5분·1시간·월봉 변동폭은 수집 서버가 붙으면 채워져요.</div></div>
    <details class="sec"><summary>AI 써머리</summary><div class="muted" style="font-size:12px;margin-top:8px">요약만 AI로 만들어요. 다음 단계에서 연결해요.</div></details>
    <div class="sec"><h3>업비트 소식</h3><div id="inspNews"><div class="muted" style="font-size:12px">불러오는 중…</div></div></div>
    <details class="sec"><summary>종목 위키</summary><div class="muted" style="font-size:12px;margin-top:8px">이 종목의 모든 매매 기록과 메모가 쌓여요. ${S.ledger.rows.filter(x => upbit.toMarket(x.symbol) === S.sel).length}건 기록됨.</div></details>`;
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
function renderOrderForm(){
  const g = effGuide(S.sel);
  const price = g && g.stance === 'buy_zone' ? g.buyHi : (S.quotes.get(S.sel) || {}).price;
  $('#orderBox').innerHTML = `
    <div class="seg"><button class="buy on" disabled>매수</button><button class="sell" disabled>매도</button></div>
    <label class="field"><span>가격</span><input value="${price ? fmtPrice(price) : ''}" disabled></label>
    <label class="field"><span>손절</span><input value="${g && g.stop ? fmtPrice(g.stop) : ''}" disabled></label>
    <div class="note">가이드 값이 자동으로 들어가요. 모의투자 주문은 PHASE 2, 실주문은 PHASE 5에서 열려요.</div>`;
}

// ---------------------------------------------------------------- 거래일지
function recompute(){ S.ledger = computeLedger(S.trades, priceOf); }
function renderJournal(){
  if (!db.user){ $('#jBody').innerHTML = '<div class="empty">로그인하면 거래 기록이 보여요. 기존 보유 종목은 "기초 이월" 매수로 옮겨져 있어요.</div>'; $('#jSummary').textContent = ''; return; }
  recompute();
  const rows = S.ledger.rows.slice().reverse();
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
      <td class="mono ${toneOf(r.vsNow)}">${r.side === 'buy' && r.vsNow != null ? fmtPct(r.vsNow) : ''}</td>
      <td class="l">${esc([src[r.source] || r.source, r.strategy].filter(Boolean).join(' · '))}</td>
      <td class="l reason" title="${esc(r.reason || '')}">${esc(r.reason || '')}</td></tr>`).join('')}</tbody></table>`;
  // 하단 바 자산
  const pos = S.ledger.positions, val = pos.reduce((s, p) => s + (p.value || 0), 0), pnl = pos.reduce((s, p) => s + (p.pnl || 0), 0);
  $('#sbAssets').textContent = val ? Math.round(val).toLocaleString('ko-KR') : '-';
  $('#sbPnl').textContent = pos.length ? (pnl > 0 ? '+' : '') + Math.round(pnl).toLocaleString('ko-KR') : '-';
  $('#sbPnl').className = 'mono ' + toneOf(pnl);
}
setInterval(() => { if (db.user && S.trades.length) renderJournal(); }, 15000);

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
  $('#jTabs').addEventListener('click', e => {
    const b = e.target.closest('[data-j]'); if (!b) return;
    $$('#jTabs .pill').forEach(x => x.classList.toggle('on', x === b));
    const news = b.dataset.j === 'news';
    $('#jBody').classList.toggle('hidden', news); $('#newsBody').classList.toggle('hidden', !news); $('#jSummary').classList.toggle('hidden', news);
    if (news) renderNews();
  });
  $('#wlTabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (!b) return; S.tab = b.dataset.tab; $$('#wlTabs .pill').forEach(x => x.classList.toggle('on', x === b)); renderWatch(); });
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
  ['바닥 반등', [['btMinDrop', '1년 고점 대비 최소 하락(%)', 1], ['btLowerPct', '1년 범위 하단 이 % 안', 1], ['btNoNewLowDays', '새 저점 없는 기간(일)', 1], ['btVolBurst', '반등 거래량 배수', 1]]],
  ['검증', [['minSamples', '최소 표본 수', 1], ['holdDays', '보유 기간(일)', 1], ['feePct', '왕복 수수료(%)', 1]]]
];
function openCfg(c = screenCfg()){
  $('#cfgBody').innerHTML = CFG_FIELDS.map(([title, fs]) => `<h4>${title}</h4>` + fs.map(([k, label, unit]) => unit === 'bool'
    ? `<label>${label}<input type="checkbox" name="${k}" ${c[k] ? 'checked' : ''}></label>`
    : `<label>${label}<input type="number" step="any" name="${k}" value="${+(c[k] / unit).toFixed(4)}"></label>`).join('')).join('');
  $('#cfgDlg').showModal();
}
function bindCfg(){
  $('#cfgReset').addEventListener('click', e => { e.preventDefault(); openCfg({ ...SCREEN_DEFAULTS }); });
  $('#cfgForm').addEventListener('submit', async e => {
    if (!e.submitter || e.submitter.value !== 'save') return;
    const c = {};
    for (const [, fs] of CFG_FIELDS) for (const [k, , unit] of fs){
      const el = $(`#cfgBody [name="${k}"]`);
      c[k] = unit === 'bool' ? el.checked : (isFinite(+el.value) ? +el.value * unit : SCREEN_DEFAULTS[k]);
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
