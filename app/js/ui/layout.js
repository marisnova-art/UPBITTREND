// PC 패널 크기 조절·접기. 값은 CSS 변수로 두고, 바뀌면 저장(이 기기 + 로그인 시 Supabase).
import { $, $$ } from '../util.js';

const DEF = { ver: 3, watch: 280, surge: 280, book: 280, insp: 280, journal: 300, collapsed: [] };
const LIM = { watch: [220, 560], surge: [200, 520], book: [200, 460], insp: [240, 620], journal: [140, 640] };
let state = { ...DEF }, onSave = () => {};

export function initLayout(saved, save){
  onSave = save || onSave;
  apply(saved);
  for (const sp of $$('[data-split]')){
    const k = sp.dataset.split;
    sp.addEventListener('pointerdown', e => {
      if (state.collapsed.includes(k)) return;
      e.preventDefault(); sp.setPointerCapture(e.pointerId); sp.classList.add('drag');
      const start = { x: e.clientX, y: e.clientY, v: state[k] };
      const move = ev => {
        let v;
        if (k === 'watch' || k === 'surge') v = start.v + (ev.clientX - start.x);
        else if (k === 'journal') v = start.v - (ev.clientY - start.y);
        else v = start.v - (ev.clientX - start.x); // 오른쪽 패널은 왼쪽으로 끌면 넓어짐
        state[k] = Math.round(Math.max(LIM[k][0], Math.min(LIM[k][1], v)));
        paint();
      };
      const up = () => { sp.classList.remove('drag'); sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); onSave({ ...state }); };
      sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up);
    });
    sp.addEventListener('dblclick', () => { state[k] = DEF[k]; paint(); onSave({ ...state }); });
  }
  for (const b of $$('[data-collapse]')){
    b.addEventListener('click', () => {
      const k = b.dataset.collapse;
      state.collapsed = state.collapsed.includes(k) ? state.collapsed.filter(x => x !== k) : [...state.collapsed, k];
      paint(); onSave({ ...state });
    });
  }
}
export function apply(saved){
  // 칸 폭 기본값을 줄인 뒤(ver 3, 세로 칸 4개 같은 폭) 예전에 저장된 폭은 버리고 접힘만 유지
  state = saved && saved.ver === DEF.ver ? { ...DEF, ...saved } : { ...DEF, journal: (saved && saved.journal) || DEF.journal, collapsed: (saved && saved.collapsed) || [] };
  if (!Array.isArray(state.collapsed)) state.collapsed = [];
  paint();
}
function paint(){
  const desk = $('#desk'), root = document.documentElement.style;
  for (const k of ['watch', 'surge', 'book', 'insp', 'journal']) root.setProperty(k === 'journal' ? '--h-journal' : '--w-' + k, state[k] + 'px');
  for (const k of ['watch', 'surge', 'book', 'insp']) desk.classList.toggle('c-' + k, state.collapsed.includes(k));
  $('#colCenter').classList.toggle('c-journal', state.collapsed.includes('journal'));
  for (const p of $$('[data-panel]')) p.classList.toggle('collapsed', state.collapsed.includes(p.dataset.panel));
  const arrows = { watch: ['‹', '›'], surge: ['‹', '›'], book: ['›', '‹'], insp: ['›', '‹'], journal: ['⌄', '⌃'] };
  for (const b of $$('[data-collapse]')){ const k = b.dataset.collapse; b.textContent = arrows[k][state.collapsed.includes(k) ? 1 : 0]; }
}
