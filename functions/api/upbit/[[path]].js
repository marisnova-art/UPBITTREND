// Cloudflare Pages Function — 업비트 공개 시세 API 프록시
// 브라우저가 api.upbit.com을 직접 호출하지 못할 때(CORS 등) index.html이 자동으로 이 경로를 사용합니다.
// 경로: /api/upbit/<업비트 v1 경로>?<쿼리>  예) /api/upbit/candles/days?market=KRW-BTC&count=200

const ALLOWED = /^(market\/all|ticker|ticker\/all|candles\/(days|weeks|months))$/;

// 엣지 캐시 시간(초): 같은 요청은 캐시로 응답해 업비트 요청 제한(429)을 줄입니다.
function cacheTtl(path) {
  if (path === 'candles/months' || path === 'candles/weeks') return 3600;
  if (path === 'candles/days') return 300;
  if (path === 'market/all') return 3600;
  return 5; // ticker
}

export async function onRequestGet({ request, params }) {
  const url = new URL(request.url);
  const path = Array.isArray(params.path) ? params.path.join('/') : (params.path || '');
  if (!ALLOWED.test(path)) {
    return new Response(JSON.stringify({ error: 'not allowed' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }
  const target = `https://api.upbit.com/v1/${path}${url.search}`;
  try {
    const upstream = await fetch(target, {
      headers: { accept: 'application/json' },
      cf: { cacheTtl: cacheTtl(path), cacheEverything: true }
    });
    const headers = new Headers({
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    const rem = upstream.headers.get('Remaining-Req');
    if (rem) headers.set('Remaining-Req', rem);
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'upstream fetch failed' }), { status: 502, headers: { 'content-type': 'application/json' } });
  }
}
