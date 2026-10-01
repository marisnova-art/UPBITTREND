/* =====================================================================
   매수 타이밍 스캐너 — Service Worker
   · 앱 화면(HTML·아이콘·폰트)만 캐시해 설치·오프라인 실행을 지원
   · 시세 데이터(업비트 API, /api/ 프록시)와 Supabase 동기화는 절대 캐시하지 않음
   · 배포할 때마다 VERSION 을 올리면 새 버전 알림이 뜸
   ===================================================================== */
const VERSION = 'v1.0.0';
const SHELL = `scanner-shell-${VERSION}`;
const RUNTIME = 'scanner-runtime';   // 폰트·CDN 라이브러리 (버전 무관, 오래 유지)

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-64.png'
];

// 캐시해도 되는 외부 정적 자원
const STATIC_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)));
  // skipWaiting 은 사용자가 "새로고침"을 눌렀을 때만 (스캔 중 갑자기 바뀌지 않도록)
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('scanner-shell-') && k !== SHELL).map(k => caches.delete(k)));
    if (self.registration.navigationPreload) { try { await self.registration.navigationPreload.enable(); } catch (_) {} }
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
  if (e.data === 'GET_VERSION' && e.source) e.source.postMessage({ type: 'VERSION', version: VERSION });
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 실시간 데이터는 항상 네트워크로 — SW가 관여하지 않음
  if (url.hostname.endsWith('upbit.com')) return;
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.in')) return;
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  // 페이지 이동: 네트워크 우선 → 실패 시 캐시된 앱 화면
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const pre = await e.preloadResponse;
        const res = pre || await fetch(req);
        if (res && res.ok) {
          const c = await caches.open(SHELL);
          c.put('./index.html', res.clone());
        }
        return res;
      } catch (_) {
        const c = await caches.open(SHELL);
        return (await c.match('./index.html')) || (await c.match('./')) ||
          new Response('<h1 style="font-family:sans-serif;color:#eee;background:#050505">오프라인입니다</h1>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  // 같은 출처 정적 파일: 캐시 먼저 보여주고 뒤에서 갱신
  if (url.origin === location.origin) {
    e.respondWith(staleWhileRevalidate(req, SHELL));
    return;
  }

  // 폰트·CDN: 캐시 우선
  if (STATIC_HOSTS.includes(url.hostname)) {
    e.respondWith(cacheFirst(req, RUNTIME));
  }
});

async function staleWhileRevalidate(req, name) {
  const c = await caches.open(name);
  const hit = await c.match(req, { ignoreSearch: true });
  const net = fetch(req).then(res => { if (res && res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await net) || Response.error();
}

async function cacheFirst(req, name) {
  const c = await caches.open(name);
  const hit = await c.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
    return res;
  } catch (_) { return Response.error(); }
}
