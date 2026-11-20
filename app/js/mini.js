// PC 미니 창 (Document Picture-in-Picture · 크롬·엣지): 다른 프로그램 위에 떠 있는 작은 창.
// 보유·관심·급등·급락을 한 줄씩 돌려 보여 주고, 아래에는 내 자산 손익 고정. 긴급 알림은 바로 끼어들어 누를 때까지 남음.
import { LS } from './util.js';

const KEY = 'quantera:mini';
export const MINI_DEF = { hold: true, fav: false, up: true, dn: true, al: true, iv: 5, mode: 'all', t1: '09:00', t2: '23:00', blink: true, sound: true, win: true };
export const MINI_KINDS = [['hold', '보유'], ['fav', '관심'], ['up', '급등'], ['dn', '급락'], ['al', '긴급 알림']];
export const miniCfg = () => ({ ...MINI_DEF, ...(LS.get(KEY, {}) || {}) });
export const miniSupported = () => 'documentPictureInPicture' in window;
const M = { win: null, src: null, idx: 0, timer: 0, sticky: null, last: [] };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function saveMiniCfg(c){ LS.set(KEY, c); M.idx = 0; restart(); }
// src: { items(cfg) → [{k, m, name, sym, price, pct, sub}], summary() → {text, tone} | null, open(m), ack(id), beep(), onState(open) }
export function initMini(src){ M.src = src; }
export const miniOpen = () => !!M.win;

function inRange(c){
  if (c.mode !== 'range') return true;
  const n = new Date(), m = n.getHours() * 60 + n.getMinutes();
  const p = t => { const [h, mi] = String(t || '0:0').split(':').map(Number); return h * 60 + mi; };
  const s = p(c.t1), e = p(c.t2); return s <= e ? (m >= s && m < e) : (m >= s || m < e);
}
const LBL = { hold: '보유', fav: '관심', up: '급등', dn: '급락', al: '긴급' };
function slideHtml(d){
  if (d.k === 'al') return `<div class="slide"><span class="kind k-al">긴급</span><span class="nm"><b>${esc(d.title)}</b><small>${esc(d.sub)}</small></span><span class="px"><span class="warn">누르면 확인</span></span></div>`;
  const t = d.pct > 0 ? 'up' : d.pct < 0 ? 'dn' : 'mut';
  return `<div class="slide" data-m="${esc(d.m)}"><span class="kind k-${d.k}">${LBL[d.k]}</span><span class="nm"><b>${esc(d.name)} <span class="sym">${esc(d.sym || '')}</span></b><small>${esc(d.sub || '')}</small></span><span class="px"><b>${esc(d.price)}</b><span class="${t}">${d.pct == null ? '' : (d.pct > 0 ? '+' : '') + d.pct.toFixed(2) + '%'}</span></span></div>`;
}
function paint(advance){
  const w = M.win; if (!w || !M.src) return;
  const doc = w.document, c = miniCfg(), box = doc.getElementById('slide'), dots = doc.getElementById('dots');
  const sum = M.src.summary(); const se = doc.getElementById('sum');
  se.textContent = sum ? sum.text : '로그인하면 보여요'; se.className = 'sum ' + (sum ? sum.tone : 'mut');
  if (M.sticky){ box.innerHTML = slideHtml(M.sticky); dots.innerHTML = ''; return; }
  if (!inRange(c)){ box.innerHTML = `<div class="slide"><span class="kind">쉬는 중</span><span class="nm"><b>정한 시간 밖이에요</b><small>${esc(c.t1)}~${esc(c.t2)} · 긴급 알림만 와요</small></span></div>`; dots.innerHTML = ''; return; }
  const list = M.src.items(c); M.last = list;
  if (!list.length){ box.innerHTML = `<div class="slide"><span class="nm"><b class="mut">보여 줄 종목이 없어요</b><small>설정 → 미니 창에서 보유·관심·급등·급락을 골라 주세요</small></span></div>`; dots.innerHTML = ''; return; }
  if (advance) M.idx++;
  M.idx %= list.length;
  const html = slideHtml(list[M.idx]);
  if (advance || box.dataset.i !== String(M.idx) || !box.firstElementChild){ box.innerHTML = html; box.dataset.i = M.idx; }
  else { const tmp = doc.createElement('div'); tmp.innerHTML = html; const px = tmp.querySelector('.px'), cur = box.querySelector('.px'); if (px && cur) cur.innerHTML = px.innerHTML; }   // 같은 종목이면 가격만 바꿈 (애니메이션 없이)
  dots.innerHTML = list.length <= 12 ? list.map((_, i) => `<i class="${i === M.idx ? 'on' : ''}"></i>`).join('') : `<span class="mut">${M.idx + 1}/${list.length}</span>`;
}
let live = 0;
function restart(){
  clearInterval(M.timer); clearInterval(live);
  if (!M.win) return;
  M.timer = setInterval(() => paint(true), Math.max(3, +miniCfg().iv || 5) * 1000);
  live = setInterval(() => paint(false), 1500);
  paint(false);
}
export async function openMini(){
  if (!miniSupported()) return false;
  if (M.win){ try { M.win.focus(); } catch(e){} return true; }
  const w = await documentPictureInPicture.requestWindow({ width: 360, height: 100 });
  M.win = w;
  const doc = w.document;
  for (const l of document.querySelectorAll('link[href*="fonts.googleapis"]')){ const n = doc.createElement('link'); n.rel = 'stylesheet'; n.href = l.href; doc.head.appendChild(n); }
  const st = doc.createElement('style'); st.textContent = CSS; doc.head.appendChild(st);
  doc.title = 'QUANTERA 미니';
  doc.body.innerHTML = `<div class="mini" id="mini" role="status" aria-live="polite"><div class="body"><div id="slide"></div><div class="foot"><span>내 자산</span><span class="sum" id="sum"></span><span class="dots" id="dots"></span></div></div></div>`;
  doc.body.addEventListener('click', e => {
    if (M.sticky){ const x = M.sticky; M.sticky = null; doc.getElementById('mini').classList.remove('alert', 'red'); M.src.ack(x.id); if (x.m) M.src.open(x.m); paint(false); return; }
    const s = e.target.closest('[data-m]'); if (s && s.dataset.m) M.src.open(s.dataset.m);
  });
  w.addEventListener('pagehide', () => { M.win = null; clearInterval(M.timer); clearInterval(live); if (M.src.onState) M.src.onState(false); });
  if (M.src.onState) M.src.onState(true);
  restart();
  return true;
}
export function closeMini(){ if (M.win) M.win.close(); }
// 긴급 알림: 순서를 무시하고 끼어들어 누를 때까지 남음 (시간대 밖이어도). x: 알림함 항목
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
html,body{margin:0;height:100%;background:#0B0B0D;color:var(--text);font:500 12px/1.45 var(--sans);overflow:hidden;cursor:default;user-select:none}
.mini{height:100%;border:1px solid #2a2a30;border-radius:0;display:flex;flex-direction:column}
.mini.alert{border-color:var(--warn);box-shadow:inset 0 0 0 2px rgba(245,165,36,.55);animation:blink 1s steps(2) 3}
.mini.alert.red{border-color:var(--up);box-shadow:inset 0 0 0 2px rgba(240,68,82,.55)}
@keyframes blink{50%{box-shadow:inset 0 0 0 2px transparent}}
.body{flex:1;padding:8px 12px 6px;display:flex;flex-direction:column;justify-content:space-between;gap:4px}
.slide{display:flex;align-items:center;gap:10px;min-height:42px;animation:in .35s ease;cursor:pointer}
@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.kind{flex:none;font-size:12px;padding:2px 8px;border-radius:999px;background:#1a1a1f;color:var(--muted)}
.kind.k-up{background:rgba(240,68,82,.15);color:var(--up)} .kind.k-dn{background:rgba(76,141,255,.15);color:var(--down)}
.kind.k-al{background:rgba(245,165,36,.15);color:var(--warn)} .kind.k-hold{background:rgba(198,244,50,.12);color:var(--accent)} .kind.k-fav{background:#1f1f25;color:var(--text)}
.nm{flex:1;min-width:0;display:flex;flex-direction:column}
.nm b{font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nm .sym{font:500 12px var(--mono);color:var(--muted)}
.nm small{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.px{flex:none;text-align:right;font-family:var(--mono);display:flex;flex-direction:column}
.px b{font-size:14px;font-weight:700}
.up{color:var(--up)} .dn{color:var(--down)} .warn{color:var(--warn)} .mut{color:var(--muted)}
.foot{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px;border-top:1px solid #1c1c21;padding-top:5px}
.sum{font-family:var(--mono)} .sum.up{color:var(--up)} .sum.dn{color:var(--down)}
.dots{display:flex;gap:4px;margin-left:auto;align-items:center}
.dots i{width:5px;height:5px;border-radius:50%;background:#2e2e35}
.dots i.on{background:var(--accent)}
@media (prefers-reduced-motion: reduce){.slide,.mini.alert{animation:none}}
`;
