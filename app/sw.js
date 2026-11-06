// QUANTERA 서비스 워커 — 앱 설치(PWA)와 오프라인 첫 화면용. 범위는 /app/ 만 (기존 업비트트랜드와 별개).
// 시세(업비트)·Supabase·/api/ 는 절대 캐시하지 않습니다. 화면 파일은 네트워크 우선 → 실패 시 캐시.
const VERSION = 'q-2026-11-06-02';
const SHELL = 'quantera-shell-' + VERSION;
const FILES = ['./', './index.html', './manifest.webmanifest', './css/app.css', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('quantera-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.pathname.startsWith('/app/')) return; // 외부(업비트·Supabase·CDN)는 관여 안 함
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) { const c = await caches.open(SHELL); c.put(req, res.clone()); }
      return res;
    } catch (err) {
      const hit = await caches.match(req) || (req.mode === 'navigate' && await caches.match('./index.html'));
      if (hit) return hit;
      throw err;
    }
  })());
});
