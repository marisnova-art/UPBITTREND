// PC 미니 창 (Document Picture-in-Picture · 크롬·엣지): 다른 프로그램 위에 떠 있는 작은 창.
// 보유 · 급등 · 급락 · 관심을 한 줄(행)씩 따로 두고, 각 행 안에서만 종목이 돌아감 (보유는 항상 한 줄 차지).
// 아래에는 내 자산 손익과 시세 시각. 긴급 알림은 맨 위에 끼어들어 누를 때까지 남음.
// 타이머는 미니 창 쪽에서 돌림 (본 창 탭이 뒤로 가면 크롬이 본 창 타이머를 늦춰서 전에는 미니 창이 멈춘 것처럼 보였음)
import { LS } from './util.js';

const KEY = 'quantera:mini';
export const MINI_DEF = { hold: true, fav: false, up: true, dn: true, al: true, iv: 5, mode: 'all', t1: '09:00', t2: '23:00', blink: true, sound: true, win: true };
export const MINI_KINDS = [['hold', '보유'], ['up', '급등'], ['dn', '급락'], ['fav', '관심'], ['al', '긴급 알림']];
const ROWS = ['hold', 'up', 'dn', 'fav'];
export const miniCfg = () => ({ ...MINI_DEF, ...(LS.get(KEY, {}) || {}) });
export const miniSupported = () => 'documentPictureInPicture' in window;
const M = { win: null, src: null, idx: {}, cur: {}, timer: 0, live: 0, sticky: null, shown: '' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function saveMiniCfg(c){ LS.set(KEY, c); M.idx = {}; M.cur = {}; restart(); fit(); }
// src: { items(cfg) → [{k, m, name, sym, price, pct, sub}], summary() → {text, tone} | null, tickAge() → ms, refresh(), open(m), ack(id), beep(), onState(open) }
export function initMini(src){ M.src = src; }
export const miniOpen = () => !!M.win;

function inRange(c){
  if (c.mode !== 'range') return true;
  const n = new Date(), m = n.getHours() * 60 + n.getMinutes();
  const p = t => { const [h, mi] = String(t || '0:0').split(':').map(Number); return h * 60 + mi; };
  const s = p(c.t1), e = p(c.t2); return s <= e ? (m >= s && m < e) : (m >= s || m < e);
}
const LBL = { hold: '보유', fav: '관심', up: '급등', dn: '급락', al: '긴급' };
const rowsOn = c => ROWS.filter(k => c[k]);
const pctTxt = p => p == null ? '' : (p > 0 ? '+' : '') + p.toFixed(2) + '%';
const toneOf = p => p > 0 ? 'up' : p < 0 ? 'dn' : 'mut';
function itemHtml(d){
  return `<span class="nm"><b>${esc(d.name)}</b><span class="sym">${esc(d.sym || '')}</span><small>${esc(d.sub || '')}</small></span><span class="px"><b>${esc(d.price)}</b><span class="${toneOf(d.pct)}">${pctTxt(d.pct)}</span></span>`;
}
function rowHtml(k, d, n, i){
  const cnt = n > 1 ? `<span class="cnt">${i + 1}/${n}</span>` : '<span class="cnt"></span>';
  if (!d) return `<div class="row empty" data-k="${k}"><span class="kind k-${k}">${LBL[k]}</span><span class="it"><span class="nm"><small>${k === 'hold' ? '보유 종목 없음' : '지금은 없어요'}</small></span></span>${cnt}</div>`;
  return `<div class="row" data-k="${k}" data-m="${esc(d.m)}"><span class="kind k-${k}">${LBL[k]}</span><span class="it">${itemHtml(d)}</span>${cnt}</div>`;
}
function paint(advance){
  const w = M.win; if (!w || !M.src) return;
  const doc = w.document, c = miniCfg(), box = doc.getElementById('rows');
  const sum = M.src.summary(), se = doc.getElementById('sum');
  se.textContent = sum ? sum.text : '로그인하면 보여요'; se.className = 'sum ' + (sum ? sum.tone : 'mut');
  // 시세 시각: 실시간이 10초 넘게 안 오면 현재가를 따로 받아 옴 + 시각을 주황으로
  const age = M.src.tickAge ? M.src.tickAge() : 0, st = doc.getElementById('st');
  if (age > 10000 && M.src.refresh) M.src.refresh();
  st.textContent = age > 10000 ? `시세 ${Math.round(age / 1000)}초 전` : '실시간';
  st.className = 'st ' + (age > 10000 ? 'warn' : 'ok');
  const al = doc.getElementById('al');
  if (M.sticky){ al.hidden = false; al.innerHTML = `<span class="kind k-al">긴급</span><span class="nm"><b>${esc(M.sticky.title)}</b><small>${esc(M.sticky.sub)}</small></span><span class="warn">누르면 확인</span>`; }
  else al.hidden = true;
  if (!inRange(c)){ box.innerHTML = `<div class="row empty"><span class="kind">쉬는 중</span><span class="it"><span class="nm"><b>정한 시간 밖이에요</b><small>${esc(c.t1)}~${esc(c.t2)} · 긴급 알림만 와요</small></span></span></div>`; M.shown = ''; return; }
  const ks = rowsOn(c);
  if (!ks.length){ box.innerHTML = `<div class="row empty"><span class="it"><span class="nm"><small>설정 → 미니 창에서 보유·급등·급락·관심을 골라 주세요</small></span></span></div>`; M.shown = ''; return; }
  const all = M.src.items(c), by = {}; for (const k of ks) by[k] = [];
  for (const d of all) if (by[d.k]) by[d.k].push(d);
  const layout = ks.join(',');
  if (M.shown !== layout){ box.innerHTML = ks.map(k => `<div class="slot" data-k="${k}"></div>`).join(''); M.shown = layout; advance = 'all'; }
  for (const k of ks){
    const list = by[k], slot = box.querySelector(`.slot[data-k="${k}"]`); if (!slot) continue;
    // 같은 종목을 계속 따라감 (목록 순서가 바뀌어도 보던 종목 유지)
    let i = list.findIndex(d => d.m === M.cur[k]); if (i < 0) i = Math.min(M.idx[k] || 0, Math.max(0, list.length - 1));
    const step = (advance === true || advance === k) && list.length > 1;
    if (step) i = (i + 1) % list.length;
    M.idx[k] = i; const d = list[i], was = M.cur[k]; M.cur[k] = d ? d.m : null;
    if (step || advance === 'all' || !slot.firstElementChild || (d ? d.m : null) !== was || slot.firstElementChild.classList.contains('empty') !== !d){
      slot.innerHTML = rowHtml(k, d, list.length, i);
      if (step) slot.firstElementChild.classList.add('in');
    } else if (d){
      const it = slot.querySelector('.it'); if (it) it.innerHTML = itemHtml(d);   // 같은 종목이면 가격만 (애니메이션 없이)
      const cn = slot.querySelector('.cnt'); if (cn) cn.textContent = list.length > 1 ? `${i + 1}/${list.length}` : '';
    }
  }
}
function restart(){
  if (M.win){ M.win.clearInterval(M.timer); M.win.clearInterval(M.live); }
  if (!M.win) return;
  // 행마다 같은 간격으로 넘어가되, 한꺼번에 바뀌지 않게 한 행씩 번갈아 (덜 산만하게)
  const c = miniCfg(), iv = Math.max(3, +c.iv || 5) * 1000, n = Math.max(1, rowsOn(c).length); let r = 0;
  M.timer = M.win.setInterval(() => { const ks = rowsOn(miniCfg()); if (ks.length) paint(ks[r++ % ks.length]); }, Math.max(1000, iv / n));
  M.live = M.win.setInterval(() => paint(false), 1000);
  paint('all');
}
const heightFor = c => 34 + rowsOn(c).length * 38 + 30;
function fit(){ if (!M.win) return; try { M.win.resizeTo(M.win.outerWidth, heightFor(miniCfg()) + (M.win.outerHeight - M.win.innerHeight)); } catch(e){} }
export async function openMini(){
  if (!miniSupported()) return false;
  if (M.win){ try { M.win.focus(); } catch(e){} return true; }
  const w = await documentPictureInPicture.requestWindow({ width: 380, height: heightFor(miniCfg()) });
  M.win = w;
  const doc = w.document;
  for (const l of document.querySelectorAll('link[href*="fonts.googleapis"]')){ const n = doc.createElement('link'); n.rel = 'stylesheet'; n.href = l.href; doc.head.appendChild(n); }
  const st = doc.createElement('style'); st.textContent = CSS; doc.head.appendChild(st);
  doc.title = 'QUANTERA 미니';
  doc.body.innerHTML = `<div class="mini" id="mini" role="status" aria-live="polite"><div class="al" id="al" hidden></div><div class="rows" id="rows"></div><div class="foot"><span>내 자산</span><span class="sum" id="sum"></span><span class="st" id="st"></span></div></div>`;
  doc.body.addEventListener('click', e => {
    if (e.target.closest('#al') && M.sticky){ const x = M.sticky; M.sticky = null; doc.getElementById('mini').classList.remove('alert', 'red'); M.src.ack(x.id); if (x.m) M.src.open(x.m); paint(false); return; }
    const s = e.target.closest('[data-m]'); if (s && s.dataset.m) M.src.open(s.dataset.m);
  });
  w.addEventListener('pagehide', () => { try { w.clearInterval(M.timer); w.clearInterval(M.live); } catch(e){} M.win = null; M.shown = ''; if (M.src.onState) M.src.onState(false); });
  if (M.src.onState) M.src.onState(true);
  restart();
  return true;
}
export function closeMini(){ if (M.win) M.win.close(); }
// 긴급 알림: 맨 위 줄에 끼어들어 누를 때까지 남음 (시간대 밖이어도). x: 알림함 항목
export function miniUrgent(x){
  const c = miniCfg(); if (!M.win || !c.al) return;
  M.sticky = { k: 'al', id: x.id, m: x.m, title: x.title, sub: x.short || x.body || '' };
  paint(false);
  const el = M.win.document.getElementById('mini');
  el.classList.remove('alert', 'red'); void el.offsetWidth;
  if (c.blink){ el.classList.add('alert'); if (x.tone === 'down') el.classList.add('red'); }
  if (c.sound && M.src.beep) M.src.beep();
}
export function miniAck(id){ if (M.sticky && M.sticky.id === id){ M.sticky = null; if (M.win) M.win.document.getElementById('mini').classList.remove('alert', 'red'); paint(false); } }

const CSS = `
:root{color-scheme:dark;--bg:#050506;--text:#EDEDEF;--muted:#9A9AA3;--accent:#C6F432;--up:#F04452;--down:#4C8DFF;--warn:#F5A524;
  --sans:'IBM Plex Sans KR',system-ui,sans-serif;--mono:'JetBrains Mono',ui-monospace,monospace}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#0B0B0D;color:var(--text);font:500 12px/1.4 var(--sans);overflow:hidden;cursor:default;user-select:none}
.mini{height:100%;border:1px solid #2a2a30;display:flex;flex-direction:column;padding:6px 10px 4px}
.mini.alert{border-color:var(--warn);box-shadow:inset 0 0 0 2px rgba(245,165,36,.55);animation:blink 1s steps(2) 3}
.mini.alert.red{border-color:var(--up);box-shadow:inset 0 0 0 2px rgba(240,68,82,.55)}
@keyframes blink{50%{box-shadow:inset 0 0 0 2px transparent}}
.al{display:flex;align-items:center;gap:8px;padding:4px 8px;margin-bottom:4px;border-radius:10px;background:rgba(245,165,36,.1);cursor:pointer}
.al[hidden]{display:none}
.al .nm b{font-size:12px}
.rows{flex:1;display:flex;flex-direction:column;justify-content:space-evenly;min-height:0}
.slot{min-height:0}
.row{display:flex;align-items:center;gap:8px;height:36px;cursor:pointer;border-bottom:1px solid #17171b}
.slot:last-child .row{border-bottom:0}
.row.empty{cursor:default}
.row.in .it{animation:in .35s ease}
@keyframes in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
.kind{flex:none;width:40px;text-align:center;font-size:12px;padding:2px 0;border-radius:999px;background:#1a1a1f;color:var(--muted)}
.kind.k-up{background:rgba(240,68,82,.15);color:var(--up)} .kind.k-dn{background:rgba(76,141,255,.15);color:var(--down)}
.kind.k-al{background:rgba(245,165,36,.15);color:var(--warn)} .kind.k-hold{background:rgba(198,244,50,.12);color:var(--accent)} .kind.k-fav{background:#1f1f25;color:var(--text)}
.it{flex:1;min-width:0;display:flex;align-items:center;gap:8px}
.nm{flex:1;min-width:0;display:flex;align-items:baseline;gap:6px;white-space:nowrap;overflow:hidden}
.nm b{font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;flex:none;max-width:52%}
.nm .sym{font:500 12px var(--mono);color:var(--muted);flex:none}
.nm small{font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;min-width:0}
.px{flex:none;text-align:right;font-family:var(--mono);display:flex;flex-direction:column;line-height:1.2}
.px b{font-size:14px;font-weight:700}
.cnt{flex:none;width:30px;text-align:right;font:500 12px var(--mono);color:#5a5a63}
.up{color:var(--up)} .dn{color:var(--down)} .warn{color:var(--warn)} .mut{color:var(--muted)} .ok{color:#5a5a63}
.foot{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px;border-top:1px solid #1c1c21;padding-top:4px;height:26px}
.sum{font-family:var(--mono)} .sum.up{color:var(--up)} .sum.dn{color:var(--down)}
.st{margin-left:auto;font-family:var(--mono)}
@media (prefers-reduced-motion: reduce){.row.in .it,.mini.alert{animation:none}}
`;
