// Cloudflare Pages Function — 업비트 공개 시세 API 프록시
// 브라우저가 api.upbit.com을 직접 호출하지 못할 때(CORS 등) index.html이 자동으로 이 경로를 사용합니다.
// 경로: /api/upbit/<업비트 v1 경로>?<쿼리>
//  예) /api/upbit/candles/days?market=KRW-BTC&count=200
//      /api/upbit/candles/minutes/5?market=KRW-BTC&count=100   (보유 종목 5분봉)
//      /api/upbit/orderbook?markets=KRW-BTC                     (보유 종목 호가)

const ALLOWED = /^(market\/all|ticker|ticker\/all|orderbook|candles\/(days|weeks|months)|candles\/minutes\/(1|3|5|10|15|30|60|240))$/;

// 엣지 캐시 시간(초): 같은 요청은 캐시로 응답해 업비트 요청 제한(429)을 줄입니다.
// 호가·분봉·현재가는 실시간이라 캐시하지 않거나 아주 짧게만 둡니다.
function cacheTtl(path) {
  if (path === 'candles/months' || path === 'candles/weeks') return 3600;
  if (path === 'candles/days') return 300;
  if (path === 'market/all') return 3600;
  if (path === 'orderbook') return 0;
  if (path.startsWith('candles/minutes/')) return 5;
  return 3; // ticker
}

export async function onRequestGet({ request, params }) {
  const url = new URL(request.url);
  const path = Array.isArray(params.path) ? params.path.join('/') : (params.path || '');
  if (!ALLOWED.test(path)) {
    return new Response(JSON.stringify({ error: 'not allowed', path }), { status: 404, headers: { 'content-type': 'application/json' } });
  }
  const target = `https://api.upbit.com/v1/${path}${url.search}`;
  const ttl = cacheTtl(path);
  try {
    const upstream = await fetch(target, {
      headers: { accept: 'application/json' },
      cf: ttl > 0 ? { cacheTtl: ttl, cacheEverything: true } : { cacheTtl: 0, cacheEverything: false }
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
