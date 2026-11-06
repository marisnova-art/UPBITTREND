// QUANTERA — 추세 분석 엔진 (기존 업비트트랜드 index.html ANALYSIS 블록을 모듈로 옮김, 로직 변경 없음)
import { CONFIG } from '../config.js';
import { clamp, mean, stdev, sum } from '../util.js';

export const STAGE_KO = {'DOWN':'장기 하락 구조','BOTTOMING':'바닥 형성 시도','BASE':'장기 횡보(베이스)','EARLY TREND':'상승 전환 초기','TREND':'상승 추세 지속','PULLBACK':'상승 중 단기 조정','RE-ENTRY':'조정 후 재상승 시도','EXTENDED':'단기 과열','UNKNOWN':'데이터 부족'};
export const A = {};

// Simple moving average (null until enough bars)
A.sma = (arr, n) => { const r=new Array(arr.length).fill(null); let s=0; for(let i=0;i<arr.length;i++){ s+=arr[i]; if(i>=n) s-=arr[i-n]; if(i>=n-1) r[i]=s/n; } return r; };
// Percent change of MA over lag bars
A.slope = (ma, lag, idx) => { if(!ma) return null; if(idx==null) idx=ma.length-1; if(idx-lag<0||idx>=ma.length) return null; const a=ma[idx], b=ma[idx-lag]; if(a==null||b==null||b===0) return null; return (a/b-1)*100; };
A.pct = (a, b) => (a==null||b==null||!isFinite(a)||!isFinite(b)||b===0) ? null : (a/b-1)*100;
A.maxH = (c, i0, i1) => { let v=-Infinity, i=-1; for(let k=Math.max(0,i0); k<=Math.min(c.length-1,i1); k++){ if(c[k].h>v){ v=c[k].h; i=k; } } return {v, i}; };
A.minL = (c, i0, i1) => { let v=Infinity, i=-1; for(let k=Math.max(0,i0); k<=Math.min(c.length-1,i1); k++){ if(c[k].l<v){ v=c[k].l; i=k; } } return {v, i}; };
// Swing pivots (confirmed with w bars on both sides)
A.pivots = (c, w, from) => {
  const highs=[], lows=[];
  for(let i=Math.max(w, from||0); i<c.length-w; i++){
    let isH=true, isL=true;
    for(let j=1;j<=w;j++){
      if(!(c[i].h>c[i-j].h && c[i].h>=c[i+j].h)) isH=false;
      if(!(c[i].l<c[i-j].l && c[i].l<=c[i+j].l)) isL=false;
      if(!isH && !isL) break;
    }
    if(isH) highs.push({i, v:c[i].h});
    if(isL) lows.push({i, v:c[i].l});
  }
  return {highs, lows};
};
// Average true range
A.atr = (c, n) => { const tr=[]; for(let i=Math.max(1,c.length-n); i<c.length; i++){ tr.push(Math.max(c[i].h-c[i].l, Math.abs(c[i].h-c[i-1].c), Math.abs(c[i].l-c[i-1].c))); } return mean(tr); };
const r2 = x => Math.round(x*100)/100;

// ---- Monthly: long-term cycle (25 pts)
A.monthly = function(m, frac){
  const n=m.length, C=m.map(x=>x.c), V=m.map(x=>x.v), close=C[n-1];
  const ma6=A.sma(C,6), ma12=A.sma(C,12), ma24=n>=26?A.sma(C,24):null;

  // 1) 장기 하락 둔화
  const rRecent = n>=7 ? A.pct(close, C[n-7]) : null;
  const rPrev = n>=13 ? A.pct(C[n-7], C[n-13]) : null;
  const pv = A.pivots(m, 2, Math.max(0, n-36));
  const H=pv.highs, L=pv.lows;
  const lhll = H.length>=2 && L.length>=2 && H[H.length-1].v<H[H.length-2].v && L[L.length-1].v<L[L.length-2].v;
  let s1;
  if(rRecent==null) s1=2.5;
  else if(rPrev==null) s1 = rRecent>=0 ? 3.5 : 1.5;
  else if(rRecent>=0) s1=5;
  else if(rPrev<0 && rRecent>rPrev*0.5) s1=3.5;
  else if(rRecent>rPrev) s1=2;
  else s1=0.5;
  if(lhll) s1=Math.max(0, s1-2);
  const declineSlowing = rPrev!=null && rRecent!=null && rPrev<0 && rRecent>rPrev*0.6;

  // 2) 저점 안정: 최근 12개월 최저점 이후 경과 개월
  const w12=Math.min(12,n), lo=A.minL(m, n-w12, n-1), since=n-1-lo.i;
  const s2=[0,1,2,3,3.8,4.5,5][Math.min(6,since)];
  const lowStable = since>=3;

  // 3) 월봉 이동평균 방향
  const sl6=A.slope(ma6,2), sl12=A.slope(ma12,2), sl12p=A.slope(ma12,2,n-5), sl24=ma24?A.slope(ma24,3):null;
  let p3=0, max3=4;
  p3 += sl6==null?0 : sl6>0.5?2 : sl6>-0.5?1 : 0;
  p3 += sl12==null?0 : sl12>0.3?1.5 : sl12>-0.5?0.8 : 0;
  if(sl24!=null){ max3+=1; p3 += sl24>0.2?1 : sl24>-0.5?0.5 : 0; }
  if(sl12!=null && sl12p!=null && sl12>sl12p) p3+=0.5;
  const s3 = p3/max3*5;
  const maImproving = sl12!=null && sl12p!=null && sl12>sl12p;

  // 4) 장기 거래량 변화
  const vc=V.slice(0,n-1), k=vc.length;
  const vCur = frac<0.2 ? vc[k-1] : V[n-1]/Math.max(frac,0.2);
  const base12 = mean(vc.slice(Math.max(0,k-12)));
  const vr12 = base12 ? vCur/base12 : null;
  const base12b = mean(vc.slice(Math.max(0,k-14), Math.max(1,k-2)));
  const recent3 = mean([vc[k-2], vc[k-1], vCur]);
  const vr3 = base12b ? recent3/base12b : null;
  const range3 = A.maxH(m,n-3,n-1).v / A.minL(m,n-3,n-1).v - 1;
  const vr = vr3!=null ? vr3 : (vr12!=null ? vr12 : 1);
  let s4 = vr<0.7?0.5 : vr<1?1.5 : vr<1.3?2.5 : vr<2?3.5 : vr<3.5?4.5 : (range3>1?2.5:4);
  const quietActivity = range3<0.45 && vr>=1.3;
  if(quietActivity) s4=Math.min(5, s4+1);

  // 5) 장기 가격 위치
  const hiAll=A.maxH(m,0,n-1).v, loAll=A.minL(m,0,n-1).v;
  const pos = hiAll>loAll ? (close-loAll)/(hiAll-loAll) : 0.5;
  let s5 = pos<0.05?1.5 : pos<0.35?4.5 : pos<0.55?4 : pos<0.75?2.5 : pos<0.9?1.5 : 1;
  const aboveMa12 = ma12[n-1]!=null && close>ma12[n-1];
  if(aboveMa12) s5=Math.min(5, s5+0.5);

  const parts=[s1,s2,s3,s4,s5].map(x=>r2(clamp(x,0,5)));
  return { score:sum(parts), parts, ma:{ma6,ma12,ma24}, pivots:pv, rRecent, rPrev, lhll, declineSlowing, lowStable, since,
    vr12, vr3:vr, quietActivity, pos, sl6, sl12, sl24, maImproving, aboveMa12, limited: !ma24, close };
};

// ---- Weekly: trend structure (35 pts)
A.weekly = function(w, frac){
  const n=w.length, C=w.map(x=>x.c), V=w.map(x=>x.v), close=C[n-1];
  const ma10=A.sma(C,10), ma20=A.sma(C,20), ma60=n>=64?A.sma(C,60):null;
  const m10=ma10[n-1], m20=ma20[n-1], m60=ma60?ma60[n-1]:null;
  const pv=A.pivots(w, 3, Math.max(0, n-60)); const H=pv.highs, L=pv.lows;

  // 1) Higher Low
  let s1=0, hl=false, hl2=false;
  const lastLow = L.length ? L[L.length-1].v : null;
  if(L.length>=2){
    hl = L[L.length-1].v > L[L.length-2].v; if(hl) s1=4.5;
    if(hl && L.length>=3 && L[L.length-2].v>L[L.length-3].v){ s1+=1.5; hl2=true; }
  } else {
    const a=A.minL(w,n-13,n-1).v, b=A.minL(w,n-26,n-14).v; hl=a>b; s1=hl?4:1;
  }
  const brokeLow = lastLow!=null && close<lastLow;
  if(hl && !brokeLow) s1+=1;
  if(brokeLow){ s1=Math.max(0,s1-4); hl=false; hl2=false; }

  // 2) Higher High
  const hh = H.length>=2 && H[H.length-1].v>H[H.length-2].v;
  const lastHigh = H.length ? H[H.length-1].v : A.maxH(w,n-27,n-2).v;
  let s2 = hh?3:0;
  if(close>lastHigh) s2+=2; else if(close>lastHigh*0.93) s2+=1;
  const lhll = H.length>=2 && L.length>=2 && H[H.length-1].v<H[H.length-2].v && L[L.length-1].v<L[L.length-2].v;

  // 3) MA10/20/60 방향·배열
  const sl10=A.slope(ma10,2), sl20=A.slope(ma20,3), sl60=ma60?A.slope(ma60,4):null;
  let minSl20=Infinity; for(let j=1;j<=12;j++){ const s=A.slope(ma20,3,n-1-j); if(s!=null) minSl20=Math.min(minSl20,s); }
  const ma20TurnUp = minSl20<-0.5 && sl20!=null && sl20>0.2;
  let p=0;
  p += sl10==null?0 : sl10>0.5?2 : sl10>-0.5?1 : 0;
  p += sl20==null?0 : sl20>0.3?2.5 : sl20>-0.5?1.3 : 0;
  p += sl60==null?0.75 : sl60>0.3?1.5 : sl60>-0.5?0.75 : 0;
  p += (m10!=null && close>m10 && m10>m20) ? 1 : (close>m20?0.5:0);
  p += m60==null?0.5 : (m20>m60?1:0);
  const s3=Math.min(8,p);

  // 4) 거래량: 감소 → 안정 → 증가 → 고점 접근
  const Vp=V.slice(); Vp[n-1] = frac<0.2 ? V[n-2] : V[n-1]/Math.max(frac,0.2);
  const baseA=mean(Vp.slice(n-21,n-9)), contrW=mean(Vp.slice(n-9,n-3)), expW=mean(Vp.slice(n-3));
  const contr = baseA ? contrW/baseA : 1, exp = contrW ? expW/contrW : 1;
  const rangeContr = A.maxH(w,n-9,n-4).v / A.minL(w,n-9,n-4).v - 1;
  const base20 = mean(V.slice(n-21,n-1));
  const vr20w = base20 ? Vp[n-1]/base20 : null;
  const hi26 = A.maxH(w,n-27,n-2).v;
  const nearHigh = close>=hi26*0.9;
  let s4=0;
  if(contr<0.9) s4+=2; if(rangeContr<0.3) s4+=1;
  if(exp>1.3) s4+=2.5; else if(exp>1.1) s4+=1.2;
  if(nearHigh && vr20w>1.1) s4+=1.5;
  s4=Math.min(7,s4);
  const prepSignal = contr<0.9 && exp>1.3 && nearHigh;

  // 5) 박스권 돌파/접근 (최근 2주 제외 12주 박스)
  const bs=n-14, be=n-3;
  const boxTop=A.maxH(w,bs,be).v, boxBot=A.minL(w,bs,be).v, boxRange=boxTop/boxBot-1;
  const hasBox = boxRange<0.45;
  let s5=0, boxBreak=false, boxNear=false;
  if(hasBox){
    s5 += boxRange<0.25?3:2;
    if(close>boxTop){ boxBreak=true; const over=close/boxTop-1; s5 += over<0.15?3.5 : over<0.3?2 : 0.5; }
    else if(close>=boxTop*0.94){ boxNear=true; s5+=2.5; }
    else if(close>=(boxTop+boxBot)/2) s5+=1;
    if(vr20w>1.2 && close>=boxTop*0.94) s5+=1.5;
  } else {
    s5 = (close>=hi26*0.95 && vr20w>1.2) ? 4 : close>=hi26*0.9 ? 2.5 : 0.5;
  }
  s5=Math.min(8,s5);
  const range16 = A.maxH(w,n-16,n-1).v / A.minL(w,n-16,n-1).v - 1;

  let crossUp=false; for(let i=Math.max(1,n-8); i<n; i++){ if(ma20[i-1]!=null && C[i-1]<ma20[i-1] && C[i]>=ma20[i]) crossUp=true; }
  const sl20prev6 = A.slope(ma20,3,n-7);
  const upStruct = close>m20 && (sl20==null?-1:sl20)>=-0.2 && hl;
  const trendCtx = close>m20 && sl20>0.3 && sl20prev6!=null && sl20prev6>0 && (m60==null || m20>m60) && (hh || close>lastHigh*0.97) && !brokeLow;
  const down = close<m20 && (sl20==null?0:sl20)<0 && (sl60==null || sl60<0);

  const parts=[r2(clamp(s1,0,7)), r2(clamp(s2,0,5)), r2(s3), r2(s4), r2(s5)];
  return { score:sum(parts), parts, ma:{ma10,ma20,ma60}, pivots:pv, close, m10, m20, m60, hl, hl2, hh, lhll, lastLow, lastHigh, brokeLow,
    sl10, sl20, sl60, ma20TurnUp, contr, exp, vr20w, nearHigh, prepSignal, boxTop, boxBot, boxRange, hasBox, boxBreak, boxNear, boxStart:bs, boxEnd:be,
    range16, crossUp, upStruct, trendCtx, down, hi26, limited: !ma60 };
};

// ---- Daily: entry timing (40 pts) + overheat + risk metrics
A.daily = function(d){
  const n=d.length, C=d.map(x=>x.c), V=d.map(x=>x.v), close=C[n-1];
  const ma20=A.sma(C,20), ma60=A.sma(C,60), ma120=n>=125?A.sma(C,120):null;
  const m20=ma20[n-1], m60=ma60[n-1], m120=ma120?ma120[n-1]:null;
  const atr=A.atr(d,14) || close*0.03;
  const r7=A.pct(close,C[n-8]), r30=A.pct(close,C[n-31]), r90=n>91?A.pct(close,C[n-91]):null;

  // 최근 상승파동 → 조정 탐지
  const hiR=A.maxH(d,n-45,n-2), loR=A.minL(d,hiR.i-40,hiR.i-1), pbR=A.minL(d,hiR.i+1,n-1);
  let pb={exists:false};
  if(hiR.i>0 && loR.i>=0 && pbR.i>hiR.i){
    const rise=hiR.v/loR.v-1, depth=1-pbR.v/hiR.v, retr=(hiR.v-pbR.v)/Math.max(1e-12,hiR.v-loR.v);
    const vRise=mean(V.slice(loR.i+1,hiR.i+1));
    const vPb=mean(V.slice(hiR.i+1, Math.min(n, Math.max(hiR.i+2, pbR.i+1))));
    pb={ exists: rise>=0.15 && depth>=0.06 && depth<=0.45, hiI:hiR.i, hiV:hiR.v, loI:loR.i, loV:loR.v, pbI:pbR.i, pbV:pbR.v,
         rise, depth, retr, volRatio: vRise? vPb/vRise : null, held: pbR.v>loR.v && retr<=0.786, recovery: close/pbR.v-1 };
  }
  const low20=A.minL(d,n-20,n-1).v, lowPrev=A.minL(d,n-40,n-21).v, lowsRising=low20>lowPrev;

  // 1) 조정 후 저점 유지
  let s1;
  if(pb.exists){ s1=pb.held?5:1.5; if(pb.held && pb.retr<=0.618) s1+=1.5; if(pb.held && pb.volRatio!=null && pb.volRatio<0.8) s1+=1.5; }
  else s1 = lowsRising?4.5:1.5;

  // 2) MA20 방향 전환
  const sl20=A.slope(ma20,5), sl20p=A.slope(ma20,5,n-11);
  const ma20TurnUp = sl20>0.3 && sl20p!=null && sl20p<=0;
  const s2 = sl20==null?0 : ma20TurnUp?6 : sl20>0.3?4 : Math.abs(sl20)<=0.3?2.5 : 0;

  // 3) MA20 / MA60 구조
  const sl60=A.slope(ma60,5), sl120=ma120?A.slope(ma120,5):null;
  const s3=(close>m20?1.5:0)+(m20>m60?2:0)+(sl60>0?1.5:0)+(m120==null?0.5:((m60>m120||sl120>0)?1:0));

  // 4) 거래량 재증가 (완성 일봉 기준)
  const vc=V.slice(0,n-1), k=vc.length;
  const vBase20=mean(vc.slice(k-21,k-1)), vr20d = vBase20 ? vc[k-1]/vBase20 : null;
  const vol3=mean(vc.slice(k-3)), volPrev10=mean(vc.slice(k-13,k-3)), reInc = volPrev10 ? vol3/volPrev10 : 1;
  const priceUp3 = close > C[n-4];
  let maxVr5=0; for(let i=k-5;i<k;i++){ const b=mean(vc.slice(Math.max(0,i-20),i)); if(b) maxVr5=Math.max(maxVr5, vc[i]/b); }
  let s4 = reInc<0.8?1 : reInc<1.1?2.5 : reInc<1.5?(priceUp3?5.5:3.5) : reInc<3?(priceUp3?8:5) : 4;
  if(pb.exists && pb.held && pb.volRatio!=null && pb.volRatio<0.85 && reInc>1.15 && priceUp3) s4=Math.max(s4,7.5);
  const pattern4 = r7!=null && r7>20 && maxVr5>3;
  if(pattern4) s4=Math.min(s4,2);

  // 5) 최근 고점 돌파 접근
  const hi60=A.maxH(d,n-61,n-2).v, dist=hi60/close-1;
  let s5; if(close>hi60){ const o=close/hi60-1; s5 = o<0.06?5 : o<0.12?3.5 : 2; } else s5 = dist<=0.03?5 : dist<=0.08?3.5 : dist<=0.15?2 : 0.5;

  // 6) 과도한 상승 아님 (과열 포인트 P)
  let P=0; const heat=[];
  if(r7>35){P+=5;heat.push('7일 급등');} else if(r7>20){P+=3;heat.push('7일 급등');} else if(r7>12){P+=1.5;heat.push('7일 상승폭 큼');} else if(r7>7) P+=0.5;
  if(r30>100){P+=5;heat.push('30일 급등');} else if(r30>50){P+=3;heat.push('30일 급등');} else if(r30>30){P+=2;heat.push('30일 상승폭 큼');} else if(r30>18) P+=0.8;
  const gap20=A.pct(close,m20), gap60=A.pct(close,m60);
  if(gap20>25){P+=4;heat.push('MA20 과이격');} else if(gap20>15){P+=2.5;heat.push('MA20 과이격');} else if(gap20>8) P+=1;
  if(gap60>45){P+=1.5;heat.push('MA60 과이격');}
  if(maxVr5>5){P+=1.5;heat.push('거래량 폭증');} else if(maxVr5>3.5) P+=0.5;
  if(pattern4) P+=1;
  let ups=0; for(let i=n-1;i>0 && C[i]>C[i-1];i--) ups++; if(ups>=5){P+=1;heat.push(`${ups}연속 상승`);}
  let longBull=0; for(let i=n-5;i<n;i++){ const x=d[i]; if((x.c-x.o)/x.o>0.08 && x.c>=hi60*0.95) longBull++; }
  if(longBull>=2){P+=1.5;heat.push('고점권 장대양봉 연속');}
  const lb=d[n-1], chaseBar=(lb.c-lb.o)/lb.o>0.1 && close>=hi60*0.95; if(chaseBar){P+=1;heat.push('장대양봉 직후');}
  const s6=Math.max(0,7-P); // 임시값 — A.applyLocation()에서 지지 근접도와 함께 재계산

  const parts=[clamp(s1,0,8),clamp(s2,0,6),clamp(s3,0,6),clamp(s4,0,8),clamp(s5,0,5),s6].map(r2);
  let score=sum(parts);

  // 리스크 지표
  const rets=[]; for(let i=1;i<n;i++) rets.push(Math.log(C[i]/C[i-1]));
  const vol30=(stdev(rets.slice(-30))||0)*100, vol90=(stdev(rets.slice(-90))||0)*100;
  const hi90=A.maxH(d,n-90,n-1).v, lo90=A.minL(d,n-90,n-1).v;
  const range20=A.maxH(d,n-20,n-1).v/low20-1;

  const p1 = range20<0.2 && reInc>1.3;
  const p2 = pb.exists && pb.volRatio!=null && pb.volRatio<0.85;
  const p3 = pb.exists && pb.held && close>pb.pbV*1.05 && reInc>1.15 && priceUp3;
  const reEntry = pb.exists && pb.held && pb.pbI>=n-25 && pb.recovery>=0.04 && close>m20 && (sl20==null?0:sl20)>-0.2 && (reInc>1.1 || priceUp3);
  const inPullback = (pb.exists && pb.pbI>=n-8 && pb.recovery<0.05) || (close<m20 && close>=m60*0.95 && sl60>0);

  return { score:r2(score), parts, ma:{ma20,ma60,ma120}, close, m20, m60, m120, atr, r7, r30, r90, pb, lowsRising, sl20, sl60, ma20TurnUp,
    vr20d, reInc, priceUp3, maxVr5, hi60, dist, P:r2(P), heat, gap20, gap60, vol30, vol90, hi90, lo90,
    ddHigh:A.pct(close,hi90), upLow:A.pct(close,lo90), patterns:{p1,p2,p3,p4:pattern4}, reEntry, inPullback, limited: !ma120 };
};

// ---- Cycle stage
A.stage = function(M, W, D){
  if(D.P>=CONFIG.overheat.extendedP || (D.r30>60 && D.gap20>15)) return 'EXTENDED';
  if(W.trendCtx){ if(D.reEntry) return 'RE-ENTRY'; if(D.inPullback) return 'PULLBACK'; return 'TREND'; }
  const early = (W.ma20TurnUp || W.crossUp || (W.upStruct && W.sl20!=null && W.sl20<=1.5)) && W.close>W.m20 && D.sl20>0 && D.close>D.m20;
  if(early) return D.reEntry ? 'RE-ENTRY' : 'EARLY TREND';
  if(W.down || (W.lhll && W.close<W.m20)) return (M.declineSlowing && M.lowStable) ? 'BOTTOMING' : 'DOWN';
  if(W.range16<0.45 && Math.abs(W.sl20||0)<=1.5) return 'BASE';
  if(M.lowStable || M.declineSlowing) return 'BOTTOMING';
  if(W.close<W.m20) return 'DOWN';
  return 'BASE';
};

// ---- Price levels (참고 가격대)
A.levels = function(d, D, W){
  const n=d.length, close=D.close, atr=D.atr||close*0.03;
  const pv=A.pivots(d,3,Math.max(0,n-120));
  const lowsBelow=pv.lows.filter(p=>p.v<close*0.995).sort((a,b)=>b.v-a.v);
  const highsAbove=pv.highs.filter(p=>p.v>close*1.005).sort((a,b)=>a.v-b.v);
  const support = lowsBelow.length ? lowsBelow[0].v : A.minL(d,n-20,n-1).v;
  let intLo=support, intHi=Math.min(close, support+0.8*atr); if(intHi<=intLo) intHi=intLo+0.3*atr;
  let pbLo=D.m20-0.6*atr, pbHi=D.m20+0.3*atr;
  if(D.pb && D.pb.hiV && D.pb.rise>=0.15){
    const rng=D.pb.hiV-D.pb.loV, f382=D.pb.hiV-0.382*rng, f50=D.pb.hiV-0.5*rng;
    pbLo=Math.min(pbLo, f50); pbHi=Math.max(pbHi, Math.min(f382, D.m20+atr));
  }
  if(pbHi-pbLo>3*atr) pbLo=pbHi-3*atr;
  const cands=[];
  if(W && W.boxTop>close*1.003 && W.hasBox) cands.push({v:W.boxTop, src:'주봉 박스 상단'});
  if(D.hi60>close*1.003) cands.push({v:D.hi60, src:'최근 60일 고점'});
  if(highsAbove[0]) cands.push({v:highsAbove[0].v, src:'일봉 스윙 고점'});
  cands.sort((a,b)=>a.v-b.v);
  const breakout=cands[0]||null;
  const zoneMin=Math.min(pbLo,intLo);
  const below=pv.lows.filter(p=>p.v<zoneMin*0.995).sort((a,b)=>b.v-a.v);
  let invalid=(below.length?below[0].v:A.minL(d,n-60,n-1).v)*0.99;
  if(invalid>=zoneMin) invalid=zoneMin*0.97;
  return { support, interest:[intLo,intHi], pullbackZone:[pbLo,pbHi], breakout, invalid,
    supports: lowsBelow.slice(0,3).map(p=>p.v), resistances: highsAbove.slice(0,3).map(p=>p.v) };
};

// ---- Risk
A.risk = function(D, tradeValue){
  let p=0; const v=D.vol30;
  p += v<3?0 : v<5?1 : v<8?2 : 3;
  if(D.vol90>7) p+=1;
  const g=Math.abs(D.gap20||0); p += g>30?2 : g>15?1 : 0;
  if(D.r7>20) p+=1; if(D.r30>50) p+=1;
  if(tradeValue!=null){ if(tradeValue<5e7) p+=2; else if(tradeValue<3e8) p+=1; }
  return { points:p, label: p<=1?'LOW' : p<=3?'MEDIUM' : p<=5?'HIGH' : 'EXTREME' };
};

// ---- Price location vs. support (지지 근접도 0~100) — "이미 고점에 있는가"를 수치화
A.location = function(D, lv){
  const close=D.close, atr=D.atr||close*0.03;
  const lo=Math.min(lv.pullbackZone[0],lv.pullbackZone[1]), hi=Math.max(lv.pullbackZone[0],lv.pullbackZone[1]);
  let s;
  if(close<=lv.invalid) s=0;
  else if(close>=lo && close<=hi) s=100;
  else if(close>hi) s=100-CONFIG.location.perAtrAbove*((close-hi)/atr);
  else s=70-40*((lo-close)/Math.max(1e-12, lo-lv.invalid));
  const pos90 = D.hi90>D.lo90 ? (close-D.lo90)/(D.hi90-D.lo90) : 0.5;
  if(pos90>0.9) s-=20; else if(pos90>0.8) s-=10; else if(pos90<0.55) s+=5;
  if(D.r30>40) s-=15; else if(D.r30>25) s-=8;
  return { loc:Math.round(clamp(s,0,100)), pos90, zoneDist:A.pct(close,hi), atrAbove:(close-hi)/atr };
};
// ---- Entry score finalization: 6번째 항목을 "지지 근접 · 과열 아님"으로 계산
A.applyLocation = function(D, loc){
  D.parts[5]=r2(clamp(7*(loc/100) - Math.max(0,D.P-1)*0.8, 0, 7));
  if(loc<40) D.parts[4]=r2(Math.min(D.parts[4],2)); // 지지에서 멀면 고점 접근 가점 제한
  let score=sum(D.parts);
  score=Math.max(0, score-Math.max(0,D.P-6)*1.2);
  if(D.P>=9) score=Math.min(score,16);
  if(loc<25) score=Math.min(score,24);
  D.score=r2(score);
};
// ---- Ranking modes (렌더 시점에 계산 — 재스캔 없이 전환)
A.rankScore = function(r, mode){
  if(!r || r.error || r.insufficient || r.notScanned) return -999;
  const loc = r.loc==null ? 50 : r.loc;
  let s;
  if(mode==='breakout'){ const near = r.breakDist==null ? 0 : clamp(100-Math.abs(r.breakDist)*12,0,100); s=0.4*r.trendScore+0.35*r.entryScore+0.25*near; }
  else if(mode==='balanced'){ s=0.6*(r.trendScore+r.entryScore)/2+0.4*Math.min(r.trendScore,r.entryScore); }
  else { s=0.35*r.trendScore+0.25*r.entryScore+0.40*loc; if(r.trendScore<50) s-=12; }
  if(r.status==='EXTENDED') s-=25; if(r.stage==='DOWN') s-=15;
  if(r.risk==='EXTREME') s-=10; else if(r.risk==='HIGH') s-=4;
  if(['EARLY TREND','RE-ENTRY','PULLBACK'].includes(r.stage)) s+=4;
  if(r.status==='ENTRY ZONE') s+=3;
  return Math.round(s*100)/100;
};

// ---- Entry status
A.status = function(stage, trendS, entryS, D, W, lv, risk, loc){
  if(stage==='EXTENDED' || D.P>=CONFIG.overheat.statusP) return 'EXTENDED';
  const res=lv.breakout ? lv.breakout.v : null;
  const nearRes = res!=null && D.close<=res && D.close>=res*0.97;
  const justBroke = D.close>D.hi60 && D.close<=D.hi60*1.03;
  const volOk = (D.vr20d||0)>=1.2 || D.reInc>=1.2;
  if(trendS>=55 && (nearRes||justBroke) && volOk) return 'BREAKOUT WATCH';
  if(trendS>=60 && entryS>=65 && loc>=CONFIG.location.minForEntryZone && ['EARLY TREND','PULLBACK','RE-ENTRY','TREND'].includes(stage) && risk!=='EXTREME' && (D.gap20==null || D.gap20<=10)) return 'ENTRY ZONE';
  if(trendS>=45 || (['EARLY TREND','PULLBACK','RE-ENTRY','BOTTOMING','BASE'].includes(stage) && entryS>=45)) return 'WATCH';
  return 'WAIT';
};

// ---- Explanation (확정 표현 금지)
A.explain = function(M, W, D, stage, status, risk, L){
  const out=[]; const f=x=>(x>0?'+':'')+x.toFixed(1)+'%';
  if(status==='EXTENDED'){
    out.push(`장기·주봉 흐름과 별개로 최근 ${D.heat.length?D.heat.join(', '):'단기 상승폭 확대'}가 확인되어(30일 ${f(D.r30||0)}, MA20 이격 ${f(D.gap20||0)}) 현재 가격은 추격 매수에 불리한 위치로 판단됩니다.`);
  } else if(L && ['TREND','EARLY TREND','RE-ENTRY','PULLBACK','BASE'].includes(stage)){
    if(L.loc<40 && L.zoneDist>0) out.push(`현재가는 조정 매수 관심대보다 ${L.zoneDist.toFixed(1)}% 위, 90일 가격 범위 상단 ${(L.pos90*100).toFixed(0)}% 지점에 있어 눌림을 기다리는 편이 상대적으로 유리한 위치입니다.`);
    else if(L.loc>=80) out.push('현재가가 조정 매수 관심대 안이나 근처에 있어 지지 반응을 확인하기 좋은 위치입니다.');
  }
  if(W.hl && W.ma20TurnUp) out.push('주봉 저점이 이전 저점보다 높아졌고 주봉 MA20이 하락에서 상승 방향으로 전환되었습니다.');
  else if(W.trendCtx) out.push('주봉 MA20이 상승 중이며 고점·저점이 높아지는 상승 구조가 유지되고 있습니다.');
  else if(W.hl) out.push('주봉에서 저점이 높아지는 구조가 관찰되지만 추세 전환 확인은 더 필요합니다.');
  else if(W.down || W.lhll) out.push('주봉에서 고점·저점이 낮아지거나 MA20 아래에 머무는 하락 구조가 이어지고 있습니다.');
  if(W.prepSignal) out.push('주봉 거래량이 줄었다가 다시 늘며 고점 부근에 접근하는 상승 준비 신호 형태입니다(상승을 보장하지 않음).');
  if(W.boxBreak) out.push(`약 12주 박스권(폭 ${(W.boxRange*100).toFixed(0)}%) 상단을 넘어선 상태입니다.`);
  else if(W.boxNear) out.push('주봉 박스권 상단에 근접해 돌파 여부를 확인할 구간입니다.');
  if(D.patterns.p2 && D.patterns.p3) out.push('일봉 조정 과정에서 거래량이 감소한 뒤 최근 거래량이 다시 증가하며 가격이 반등하고 있습니다.');
  else if(D.patterns.p2) out.push('일봉 조정 구간에서 거래량이 줄어든 상태로 저점 유지 여부를 관찰할 구간입니다.');
  else if(D.patterns.p1) out.push('일봉 가격 횡보 중 거래량이 늘어나는 거래활동 변화가 있습니다.');
  if(D.ma20TurnUp) out.push('일봉 MA20이 최근 상승 방향으로 전환되었습니다.');
  if(stage==='BOTTOMING' || stage==='BASE' || stage==='DOWN'){
    if(M.declineSlowing && M.lowStable) out.push(`월봉 하락폭이 둔화되고 최근 ${M.since}개월간 신저점이 나오지 않아 저점 안정 흐름이 보입니다.`);
    else if(M.lowStable) out.push(`최근 ${M.since}개월간 월봉 신저점이 형성되지 않았습니다.`);
    if(M.quietActivity) out.push('장기 가격 변동에 비해 월봉 거래활동이 늘어난 변화가 있습니다.');
    if(stage!=='DOWN') out.push('주봉 상승 구조는 아직 확인되지 않아 향후 상승 전환 여부를 지켜볼 단계입니다.');
  }
  if(stage==='RE-ENTRY' && status!=='EXTENDED') out.push(`최근 ${(D.pb.depth*100).toFixed(0)}% 조정 후 저점을 지키며 재상승을 시도하는 구간입니다.`);
  if(stage==='PULLBACK') out.push('상승 추세 안에서 단기 조정이 진행 중이며 지지 구간 반응 확인이 필요합니다.');
  if(risk==='EXTREME') out.push('최근 변동성이 매우 커 계산된 가격대의 신뢰도가 낮습니다.');
  else if(risk==='HIGH' && W.trendCtx) out.push('추세는 양호하지만 변동성이 높은 편입니다.');
  if(!out.length) out.push(`${STAGE_KO[stage]} 단계로 분류되며 뚜렷한 추세·거래량 신호는 제한적입니다.`);
  return out;
};

// ---- 상승 여력 · 과거 이력 (도달 예측이 아니라 과거 통계와 차트 위치)
A.upside = function(D, W, d, lv){
  const n=D.length, close=d.close, C=D.map(x=>x.c), ma20=d.ma.ma20;
  let wk=0, wh=0;
  for(let i=Math.max(1,W.length-53); i<W.length-1; i++){ wk++; if(W[i].h>=W[i-1].c*1.2) wh++; }
  const rng=[]; for(let i=Math.max(0,W.length-27); i<W.length-1; i++) rng.push((W[i].h/W[i].l-1)*100);
  const weekRange=mean(rng);
  // 과거 같은 코인에서 "상승 추세 속 20일선 근처" 자리 → 이후 7일 최고가 상승률
  let sn=0, sh=0; const gains=[];
  for(let i=60;i<n-7;i++){
    const m=ma20[i], mp=ma20[i-5]; if(m==null||mp==null) continue;
    if(!(C[i]>=m*0.97 && C[i]<=m*1.08 && m>mp && C[i]/C[i-30]-1<0.25)) continue;
    let mx=0; for(let j=i+1;j<=i+7;j++) if(D[j].h>mx) mx=D[j].h;
    const g=(mx/C[i]-1)*100; gains.push(g); sn++; if(g>=20) sh++;
  }
  gains.sort((a,b)=>a-b);
  const zLo=Math.min(lv.pullbackZone[0],lv.pullbackZone[1]), zHi=Math.max(lv.pullbackZone[0],lv.pullbackZone[1]);
  const entryRef = close<=zHi ? close : zHi;
  const stop=lv.invalid;
  const hi120=A.maxH(D,n-121,n-2).v, hi52=A.maxH(W,W.length-53,W.length-2).v;
  let t1 = lv.breakout ? lv.breakout.v : null;
  const highs=[hi120,hi52].filter(v=>isFinite(v) && v>entryRef*1.03).sort((a,b)=>a-b);
  if(t1==null && highs.length) t1=highs[0];
  const t2 = t1!=null ? (highs.find(v=>v>t1*1.03) || null) : null;
  const riskPct = entryRef>stop ? (entryRef-stop)/entryRef*100 : null;
  const up1 = t1 ? (t1/entryRef-1)*100 : null, up2 = t2 ? (t2/entryRef-1)*100 : null;
  return { weekHit20: wk? wh/wk : null, weeksN:wk, weekRange, setupN:sn, setupHits:sh, setupHit20: sn? sh/sn : null,
    setupMedian: gains.length ? gains[Math.floor(gains.length/2)] : null,
    entryLo:zLo, entryHi:zHi, entryRef, stop, t1, t2, up1, up2, riskPct, rr: (up1!=null && riskPct) ? up1/riskPct : null,
    inZone: close>=zLo*0.99 && close<=zHi*1.01 };
};
// ---- 추천 점수 (null = 추천 기준 미달)
A.pickScore = function(r, opt){
  opt=opt||{};
  if(!r || r.error || r.insufficient || r.notScanned || !r.up) return null;
  const u=r.up;
  if(r.status==='EXTENDED' || ['DOWN','EXTENDED','UNKNOWN'].includes(r.stage)) return null;
  if(!opt.relaxed){
    if(r.trendScore<55 || (r.loc??0)<50 || r.risk==='EXTREME') return null;
    if(r.tradeValue!=null && r.tradeValue<CONFIG.pick.minTradeValue) return null;
    if(u.rr!=null && u.rr<CONFIG.pick.minRR) return null;
    if(opt.volOnly && !((u.weekRange||0)>=CONFIG.pick.minWeekRange || (u.weekHit20||0)>=0.1)) return null;
  }
  let sc = 0.30*r.trendScore + 0.20*r.entryScore + 0.20*(r.loc??0);
  sc += clamp((u.weekRange||0)-10, 0, 30)*0.4;
  if(u.setupN>=5) sc += clamp(u.setupHit20,0,0.5)*30;
  if(u.rr!=null) sc += clamp(u.rr,0,4)*2.5;
  if((u.up1!=null && u.up1>=20) || (u.up2!=null && u.up2>=20)) sc+=4;
  if(r.status==='ENTRY ZONE') sc+=4;
  if(r.risk==='HIGH') sc-=3;
  return Math.round(sc*10)/10;
};
// ---- 한 줄 결론
A.verdict = function(r){
  const u=r.up||{};
  if(r.status==='EXTENDED') return {t:'이미 많이 오름 — 눌림을 기다리세요', c:'#ff3d1c'};
  if(r.status==='BREAKOUT WATCH') return {t:'저항선 바로 아래 — 돌파가 확인되면 검토', c:'#f2f2f2'};
  if(u.inZone && r.trendScore>=55) return {t:'지지 구간 도착 — 나눠서 매수 검토', c:'#d6ff1e'};
  if((r.loc??0)>=60) return {t:'지지 구간 근처 — 반등 확인 후 검토', c:'#d6ff1e'};
  if(r.stage==='BOTTOMING' || r.stage==='BASE') return {t:'바닥권 — 상승 전환 확인까지 관찰', c:'#a3a3a3'};
  return {t:'매수 검토가까지 내려오기를 기다리는 구간', c:'#a3a3a3'};
};

// ---- Full per-market analysis
A.analyze = function(market, name, M, W, D, ctx){
  const bars={d:D?D.length:0, w:W?W.length:0, m:M?M.length:0};
  if(!D || !W || !M || D.length<CONFIG.minBars.daily || W.length<CONFIG.minBars.weekly || M.length<CONFIG.minBars.monthly){
    return { market, name, insufficient:true, stage:'UNKNOWN', status:'INSUFFICIENT DATA', bars, price:(D&&D.length?D[D.length-1].c:ctx.price), livePrice:ctx.price, basis:ctx.basis, warning:ctx.warning };
  }
  const m=A.monthly(M, ctx.fracM), w=A.weekly(W, ctx.fracW), d=A.daily(D);
  const lv=A.levels(D,d,w), L=A.location(d,lv);
  A.applyLocation(d, L.loc);
  const longS=r2(m.score), trendPts=r2(w.score), entryPts=r2(d.score);
  const trendScore=Math.round((longS+trendPts)/60*100), entryScore=Math.round(entryPts/40*100), total=Math.round(longS+trendPts+entryPts);
  const risk=A.risk(d, ctx.tradeValue);
  const stage=A.stage(m,w,d), status=A.status(stage,trendScore,entryScore,d,w,lv,risk.label,L.loc);
  const reasons=A.explain(m,w,d,stage,status,risk.label,L);
  const closes=D.slice(-31).map(x=>x.c), mn=Math.min(...closes), mx=Math.max(...closes);
  const res = {
    market, name, insufficient:false, price:d.close, livePrice:ctx.price, basis:ctx.basis, dailyDate:D[D.length-1].t, warning:ctx.warning,
    longS, trendPts, entryPts, total, trendScore, entryScore, stage, status, risk:risk.label, riskPts:risk.points,
    loc:L.loc, pos90:L.pos90, zoneDist:L.zoneDist, breakDist: lv.breakout ? A.pct(lv.breakout.v, d.close) : 0,
    r7:d.r7, r30:d.r30, vr20d:d.vr20d, vr20w:w.vr20w, vr12:m.vr12, gap20:d.gap20, gap60:d.gap60, vol30:d.vol30, vol90:d.vol90, ddHigh:d.ddHigh, upLow:d.upLow,
    tradeValue:ctx.tradeValue, change24:ctx.change,
    levels:{ interest:lv.interest, pullbackZone:lv.pullbackZone, breakout:lv.breakout, invalid:lv.invalid },
    parts:{ m:m.parts, w:w.parts, d:d.parts }, P:d.P,
    bottomWatch: (stage==='BOTTOMING'||stage==='BASE') && (m.declineSlowing||m.lowStable) && (d.r30==null||d.r30<30),
    highVolTrend: trendScore>=65 && d.vol30>=6,
    limited: m.limited||w.limited||d.limited,
    up: A.upside(D,W,d,lv),
    reasons, spark: closes.map(c=> mx>mn ? Math.round((c-mn)/(mx-mn)*1000)/1000 : 0.5),
    _int:{ m, w, d, lv, L }
  };
  res.rank=A.rankScore(res,'pullback');
  return res;
};
