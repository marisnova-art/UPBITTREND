// Cloudflare Pages Function — 업비트 공지·프로젝트 공시 모음 (QUANTERA 전용, 기존 사이트는 사용 안 함)
// 업비트 웹사이트가 쓰는 공개 주소를 읽어 제목·날짜·링크만 돌려줍니다(본문은 가져오지 않음).
// 공식 API가 아니라 주소가 바뀌면 빈 목록이 나올 수 있습니다 → 응답의 sources[].ok 로 확인.
// 경로: /api/upbit-news?kind=notice|disclosure|all

const SOURCES = {
  notice: {
    url: 'https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=30&category=all',
    pick: j => ((j && j.data && (j.data.notices || j.data.list)) || []).map(n => ({
      id: 'n' + n.id, kind: 'notice', category: n.category || '', title: n.title,
      at: n.listed_at || n.first_listed_at || n.created_at || null,
      url: `https://upbit.com/service_center/notice?id=${n.id}`
    }))
  },
  disclosure: {
    url: 'https://project-team.upbit.com/api/v1/disclosure?region=kr&per_page=30',
    pick: j => ((j && j.data && (j.data.posts || j.data.list || j.data)) || []).filter(Boolean).map(p => ({
      id: 'd' + p.id, kind: 'disclosure', category: '공시',
      title: p.text || p.title || '',
      symbol: (p.assets && (p.assets.symbol || (Array.isArray(p.assets) && p.assets[0] && p.assets[0].symbol))) || p.symbol || null,
      at: p.start_date || p.created_at || null,
      url: p.url || `https://upbit.com/service_center/disclosure?id=${p.id}`
    }))
  }
};

export async function onRequestGet({ request }) {
  const kind = new URL(request.url).searchParams.get('kind') || 'all';
  const keys = kind === 'all' ? Object.keys(SOURCES) : Object.keys(SOURCES).filter(k => k === kind);
  const items = [], sources = [];
  await Promise.all(keys.map(async k => {
    try {
      const res = await fetch(SOURCES[k].url, {
        headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (QUANTERA news reader)' },
        cf: { cacheTtl: 120, cacheEverything: true }
      });
      if (!res.ok) { sources.push({ kind: k, ok: false, status: res.status }); return; }
      const list = SOURCES[k].pick(await res.json()).filter(x => x.title);
      items.push(...list); sources.push({ kind: k, ok: true, count: list.length });
    } catch (e) { sources.push({ kind: k, ok: false, error: 'fetch failed' }); }
  }));
  items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return new Response(JSON.stringify({ items, sources, at: new Date().toISOString() }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' }
  });
}
