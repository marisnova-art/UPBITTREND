// 트렌드 리포트: 실시간 뉴스(국내·해외, AI 한 줄 요약) · 일간 동향 · 주간 동향
// 서버(/api/trend)가 만들어 Supabase에 저장해 둔 것을 받아 보여 줌. 로그인 필요.
import { esc, fmtPrice, fmtPct, fmtKrwShort, toneOf, LS } from './util.js';

// 일간 동향은 이 기기에 마지막 것을 남겨 둠 → 앱을 열자마자 홈 카드가 제자리에 그려져 화면이 밀리지 않음
const cache = { news: null, daily: LS.get('quantera:trDaily', null), weekly: null }, at = { news: 0, daily: 0, weekly: 0 }, busy = {};
let tokenFn = async () => '';
export function initTrend(getToken){ tokenFn = getToken; }

export async function loadTrend(kind, force = false){
  const ttl = kind === 'news' ? 5 * 60000 : 10 * 60000;
  if (!force && cache[kind] && Date.now() - at[kind] < ttl) return cache[kind];
  if (busy[kind]) return busy[kind];
  busy[kind] = (async () => {
    try {
      const tok = await tokenFn();
      if (!tok) return { error: 'login', message: '로그인하면 트렌드 리포트를 볼 수 있어요.' };
      const res = await fetch(`/api/trend?kind=${kind}${force ? '&force=1' : ''}`, { headers: { authorization: 'Bearer ' + tok, accept: 'application/json' } });
      const j = await res.json().catch(() => ({ error: 'bad', message: '응답을 읽지 못했어요.' }));
      if (!res.ok) return cache[kind] ? { ...cache[kind], warn: j.message } : j;
      cache[kind] = j; at[kind] = Date.now();
      if (kind === 'daily') try { LS.set('quantera:trDaily', j); } catch(e){}
      return j;
    } catch (e) { return cache[kind] || { error: 'net', message: '트렌드를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.' }; }
    finally { busy[kind] = null; }
  })();
  return busy[kind];
}
export const trendCached = kind => cache[kind];

// ---------------------------------------------------------------- 화면
// ctx: { mine: Set(심볼 'BTC'...), names: Map('BTC' → '비트코인'), upbitNews: [...업비트 공지·공시] }
const TONE = { '+': ['호재', 'up'], '-': ['악재', 'down'], '0': ['중립', 'muted'] };
const when = t => { const d = new Date(t), m = (Date.now() - d) / 60000; return m < 60 ? `${Math.max(1, Math.round(m))}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }); };

export function trendTabsHtml(tab){
  return `<div class="tr-tabs">${[['news', '실시간 뉴스'], ['daily', '일간 동향'], ['weekly', '주간 동향']].map(([k, v]) => `<button class="pill${tab === k ? ' on' : ''}" data-trtab="${k}">${v}</button>`).join('')}<span class="grow"></span><button class="pill sm" data-trre title="지금 다시 받아오기">새로고침</button></div>`;
}

export function newsHtml(j, ctx, filter = 'all'){
  if (!j) return '<div class="empty">불러오는 중…</div>';
  if (j.error) return `<div class="empty">${esc(j.message || '불러오지 못했어요.')}</div>`;
  let items = (j.items || []).map(n => ({ ...n, mine: (n.c || []).some(c => ctx.mine.has(c)) }));
  // 업비트 공지·공시도 같이 (AI 요약 없이)
  for (const u of ctx.upbitNews || []) items.push({ id: 'u:' + u.id, at: u.at, srcName: '업비트 ' + (u.kind === 'disclosure' ? '공시' : '공지'), url: u.url, t: u.title, s: '', c: u.symbol ? [u.symbol.toUpperCase()] : [], m: /거래지원 종료|유의 종목|입출금 중단|상장폐지/.test(u.title) ? '-' : /신규 거래지원|디지털 자산 추가/.test(u.title) ? '+' : '0', upbit: true });
  items.forEach(n => { if (!n.mine) n.mine = (n.c || []).some(c => ctx.mine.has(c)); });
  items.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const cnt = { all: items.length, mine: items.filter(n => n.mine).length, '+': items.filter(n => n.m === '+').length, '-': items.filter(n => n.m === '-').length, kr: items.filter(n => n.lang === 'ko' || n.upbit).length, en: items.filter(n => n.lang === 'en').length };
  const F = { all: () => true, mine: n => n.mine, '+': n => n.m === '+', '-': n => n.m === '-', kr: n => n.lang === 'ko' || n.upbit, en: n => n.lang === 'en' };
  const list = items.filter(F[filter] || F.all).slice(0, 80);
  const chips = [['all', '전체'], ['mine', '내 코인'], ['+', '호재'], ['-', '악재'], ['kr', '국내'], ['en', '해외']].map(([k, v]) => `<button class="pill sm${filter === k ? ' on' : ''}" data-trf="${k}">${v} <span class="mono muted">${cnt[k]}</span></button>`).join('');
  const src = (j.sources || []).map(s => `<span class="${s.ok ? '' : 'warn'}" title="${s.ok ? s.n + '건' : esc(s.error || '실패')}">${esc(s.name)}${s.ok ? '' : ' ✕'}</span>`).join(' · ');
  return `<div class="tr-chips">${chips}</div>
    ${j.warn ? `<div class="note warn">${esc(j.warn)}</div>` : ''}
    <ul class="tr-news">${list.length ? list.map(n => { const [tl, tc] = TONE[n.m] || TONE['0'];
      return `<li class="${n.mine ? 'mine' : ''}"><div class="tn-h"><span class="badge ${tc === 'muted' ? 'line' : tc}">${tl}</span>${(n.c || []).map(c => `<button class="badge line${ctx.mine.has(c) ? ' accent' : ''}" data-trcoin="${esc(c)}" title="${esc(ctx.names.get(c) || c)} 열기">${esc(ctx.names.get(c) || c)}</button>`).join('')}<span class="grow"></span><span class="muted">${esc(n.srcName || '')} · ${when(n.at)}</span></div>
        <a href="${esc(n.url)}" target="_blank" rel="noopener" class="tn-t">${esc(n.t || n.title)}</a>${n.s ? `<div class="tn-s muted">${esc(n.s)}</div>` : ''}${n.lang === 'en' && n.title && n.title !== n.t ? `<div class="tn-o muted">원문: ${esc(n.title)}</div>` : ''}</li>`; }).join('') : '<li class="empty">이 조건에 맞는 뉴스가 없어요.</li>'}</ul>
    <div class="note">출처: ${src || '-'} · 업비트 공지·공시. AI(Llama 3.3 70B)가 해외 기사를 한국어로 줄이고 호재·악재를 붙였어요. 틀릴 수 있으니 중요한 건 원문을 확인하세요. ${j.checkedAt ? `마지막 수집 ${when(j.checkedAt)}` : ''}</div>`;
}

const coinList = (arr, key = 'c', sub) => `<div class="tr-cl">${(arr || []).map(x => `<button class="tr-ci" data-trm="${esc(x.m)}"><span>${esc(x.n)}</span><span class="mono ${toneOf(x[key])}">${fmtPct(x[key])}</span>${sub ? `<span class="muted mono">${sub(x)}</span>` : ''}</button>`).join('')}</div>`;
function textHtml(t){
  if (!t) return '<div class="note">AI 리포트를 아직 못 만들었어요 (오늘 AI 무료 사용량을 거의 다 썼거나 잠시 오류). 아래 숫자는 그대로 볼 수 있어요.</div>';
  const out = []; let cur = null;
  for (const line of String(t).split('\n').map(x => x.trim()).filter(Boolean)){
    const h = line.match(/^(?:■|#+|\*\*)\s*(.+?)\**$/);
    if (h){ cur = { h: h[1].replace(/\*\*/g, ''), p: [] }; out.push(cur); }
    else { if (!cur){ cur = { h: '', p: [] }; out.push(cur); } cur.p.push(line.replace(/\*\*/g, '')); }
  }
  return `<div class="tr-text">${out.map(s => `<div class="tr-sec">${s.h ? `<b>${esc(s.h)}</b>` : ''}${s.p.map(p => `<p>${esc(p)}</p>`).join('')}</div>`).join('')}</div>`;
}
export function reportHtml(kind, j, pickDay){
  if (!j) return '<div class="empty">리포트를 만드는 중이에요… (처음엔 10~20초 걸려요)</div>';
  if (j.error) return `<div class="empty">${esc(j.message || '불러오지 못했어요.')}</div>`;
  const rs = j.reports || []; if (!rs.length) return '<div class="empty">아직 리포트가 없어요.</div>';
  const r = rs.find(x => x.day === pickDay) || rs[0], S = r.stats || {};
  const days = rs.map(x => `<button class="pill sm${x.id === r.id ? ' on' : ''}" data-trday="${esc(x.day)}">${kind === 'daily' ? x.day.slice(5).replace('-', '/') : x.day.slice(5).replace('-', '/') + ' 기준'}</button>`).join('');
  const upd = r.updatedAt ? new Date(r.updatedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  const head = kind === 'daily'
    ? `<div class="tr-kpi"><div><span class="muted">오른 / 내린 코인</span><b class="mono"><span class="up">${S.up}</span> / <span class="down">${S.dn}</span></b></div><div><span class="muted">평균 등락</span><b class="mono ${toneOf(S.avg)}">${fmtPct(S.avg)}</b></div>${S.btc ? `<div><span class="muted">비트코인</span><b class="mono ${toneOf(S.btc.c)}">${fmtPct(S.btc.c)}</b></div>` : ''}${S.eth ? `<div><span class="muted">이더리움</span><b class="mono ${toneOf(S.eth.c)}">${fmtPct(S.eth.c)}</b></div>` : ''}<div><span class="muted">원화 마켓 거래대금</span><b class="mono">${fmtKrwShort(S.total)}</b></div></div>`
    : `<div class="tr-kpi"><div><span class="muted">7일 오른 / 내린 (상위 ${S.n}개)</span><b class="mono"><span class="up">${S.up}</span> / <span class="down">${S.dn}</span></b></div>${S.btc ? `<div><span class="muted">비트코인 7일</span><b class="mono ${toneOf(S.btc.c)}">${fmtPct(S.btc.c)}</b></div>` : ''}${S.eth ? `<div><span class="muted">이더리움 7일</span><b class="mono ${toneOf(S.eth.c)}">${fmtPct(S.eth.c)}</b></div>` : ''}</div>`;
  const lists = kind === 'daily'
    ? `<div class="tr-cols"><div><h4>많이 오른 코인</h4>${coinList(S.gainers)}</div><div><h4>많이 내린 코인</h4>${coinList(S.losers)}</div><div><h4>거래대금 쏠림</h4>${coinList(S.volume, 'c', x => x.share + '%')}</div></div>`
    : `<div class="tr-cols"><div><h4>7일 상승</h4>${coinList(S.gainers)}</div><div><h4>7일 하락</h4>${coinList(S.losers)}</div><div><h4>거래대금 급증 (지난주 대비)</h4>${coinList(S.hot, 'vc')}</div></div>`;
  return `<div class="tr-days">${days}<span class="grow"></span><span class="muted">${kind === 'daily' ? '오전 9시부터 · 3시간마다 새로' : '최근 7일 · 하루 한 번 새로'}${upd ? ' · ' + upd + ' 작성' : ''}</span></div>${head}${textHtml(r.text)}${lists}<div class="note">피터(AI)가 업비트 시세와 모은 뉴스만 보고 쓴 요약이에요. 투자 판단은 직접 확인한 뒤에 하세요.</div>`;
}
// 폰 홈 카드: 오늘의 동향 한 줄 + 숫자
export function homeCardHtml(j){
  const r = j && j.reports && j.reports[0];
  if (!r){
    if (j && j.error) return '';
    // 불러오는 동안 같은 크기의 빈 카드로 자리를 잡아 둠 (늦게 끼어들며 아래 카드를 밀어내던 것 방지)
    return `<button class="m-trend sk" data-go="trend"><div class="m-sec-h"><span class="m-h">오늘의 동향</span><span class="grow"></span><span class="muted">불러오는 중</span></div><div class="mt-k"><span class="muted">오름 · 내림 · BTC</span></div><div class="mt-t muted">&nbsp;</div></button>`;
  }
  const S = r.stats || {};
  const first = String(r.text || '').split('\n').map(x => x.trim()).filter(x => x && !/^(■|#|\*\*)/.test(x))[0] || '';
  return `<button class="m-trend" data-go="trend"><div class="m-sec-h"><span class="m-h">오늘의 동향</span><span class="grow"></span><span class="muted">트렌드 ›</span></div>
    <div class="mt-k"><span>오름 <b class="up mono">${S.up}</b></span><span>내림 <b class="down mono">${S.dn}</b></span>${S.btc ? `<span>BTC <b class="mono ${toneOf(S.btc.c)}">${fmtPct(S.btc.c)}</b></span>` : ''}</div>${first ? `<div class="mt-t">${esc(first)}</div>` : ''}</button>`;
}
// 새 뉴스 중 내 코인(보유·관심) 소식 → 알림용
const SEEN = 'quantera:trSeen';
export function freshMine(j, mine){
  if (!j || !j.items) return [];
  const seen = new Set(LS.get(SEEN, [])), first = !seen.size;
  const out = j.items.filter(n => !seen.has(n.id) && (n.c || []).some(c => mine.has(c)) && Date.now() - Date.parse(n.at) < 6 * 3600000);
  LS.set(SEEN, j.items.slice(0, 300).map(n => n.id));
  return first ? [] : out;
}
