export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export function mean(a){ let s=0,k=0; for(const x of a){ if(x!=null && isFinite(x)){ s+=x; k++; } } return k ? s/k : null; }
export function stdev(a){ const m=mean(a); if(m==null||a.length<2) return null; let s=0; for(const x of a) s+=(x-m)*(x-m); return Math.sqrt(s/(a.length-1)); }
export const sum = a => a.reduce((s,x)=>s+x,0);
export const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const $ = (s, el=document) => el.querySelector(s);
export const $$ = (s, el=document) => [...el.querySelectorAll(s)];
export const utcDay = (d=new Date()) => d.toISOString().slice(0,10);

// 가격 표기: 업비트 호가 단위에 맞춰 자릿수 결정
export function fmtPrice(v){
  if(v==null || !isFinite(v)) return '-';
  const a=Math.abs(v);
  const d = a>=100 ? 0 : a>=1 ? 2 : a>=0.01 ? 4 : 6;
  return v.toLocaleString('ko-KR', { minimumFractionDigits:d, maximumFractionDigits:d });
}
export const fmtPct = (v, d=2) => v==null||!isFinite(v) ? '-' : (v>0?'+':'')+v.toFixed(d)+'%';
export function fmtKrwShort(v){
  if(v==null||!isFinite(v)) return '-';
  if(v>=1e12) return (v/1e12).toFixed(1)+'조';
  if(v>=1e8) return Math.round(v/1e8).toLocaleString('ko-KR')+'억';
  if(v>=1e4) return Math.round(v/1e4).toLocaleString('ko-KR')+'만';
  return Math.round(v).toLocaleString('ko-KR');
}
export const toneOf = v => v>0 ? 'up' : v<0 ? 'down' : 'flat';

export const LS = {
  get(k, d){ try{ const v=localStorage.getItem(k); return v==null?d:JSON.parse(v); }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); return true; }catch(e){ return false; } }
};

// 간단한 이벤트 버스
export function emitter(){
  const m=new Map();
  return {
    on(t, f){ (m.get(t)||m.set(t,new Set()).get(t)).add(f); return ()=>m.get(t).delete(f); },
    emit(t, p){ (m.get(t)||[]).forEach(f=>{ try{ f(p); }catch(e){ console.error(e); } }); }
  };
}
