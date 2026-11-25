// 업비트 공지·프로젝트 공시 (제목 + 원문 링크만). /api/upbit-news (Cloudflare 함수)에서 받아옵니다.
let cache = { at: 0, data: null }, inflight = null;

export async function loadNews(force = false){
  if (!force && cache.data && Date.now() - cache.at < 120000) return cache.data;
  if (inflight) return inflight;
  inflight = (async () => {
    try{
      const res = await fetch('/api/upbit-news?kind=all', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      cache = { at: Date.now(), data: j };
      return j;
    }catch(e){ return cache.data || { items: [], sources: [], error: e.message }; }
    finally { inflight = null; }
  })();
  return inflight;
}

// 이 종목 소식인지: 공시의 심볼, 또는 제목 속 "(BTC)" · "비트코인"
export function newsFor(items, inst){
  if (!inst) return [];
  const base = inst.base.toUpperCase();
  const re = new RegExp(`[(\\s,/]${base}[)\\s,/]`);
  return items.filter(n => (n.symbol && n.symbol.toUpperCase() === base) || re.test(` ${n.title} `) || (inst.name.length >= 2 && n.title.includes(inst.name)));
}

const KIND_KO = { notice: '공지', disclosure: '공시' };
export function newsHtml(items, esc, { empty = '소식이 없어요.', limit = 20 } = {}){
  if (!items.length) return `<div class="empty">${empty}</div>`;
  return `<ul class="news">${items.slice(0, limit).map(n => {
    const d = n.at ? new Date(n.at) : null;
    const when = d && !isNaN(d) ? d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    const hot = /거래지원 종료|유의 종목|거래 유의|입출금 중단|상장폐지|거래정지/.test(n.title) ? ' warn' : /신규 거래지원|디지털 자산 추가/.test(n.title) ? ' accent' : '';
    return `<li><a href="${esc(n.url)}" target="_blank" rel="noopener"><span class="badge line${hot}">${esc(n.category || KIND_KO[n.kind] || '')}</span><span class="tt">${esc(n.title)}</span><span class="muted mono">${when}</span></a></li>`;
  }).join('')}</ul>`;
}
