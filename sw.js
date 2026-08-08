/* Trend Insight PWA 서비스워커 — 네트워크 우선, 실패 시 캐시 폴백 */
const CACHE = 'ti-v1';
const CORE = ['/', '/index.html', '/icon-192.png', '/icon-512.png', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;           // 외부 CDN은 브라우저 기본 처리
  if (url.pathname.startsWith('/api/')) return;         // API는 캐시하지 않음
  if (url.searchParams.has('dl')) return;               // 다운로드는 가로채지 않음 (iOS가 attachment를 무시하고 인라인 표시하는 버그 회피)
  if (url.pathname.endsWith('.pdf')) return;            // PDF도 브라우저 기본 처리 (래퍼/원본 판단은 서버가)
  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() =>
      caches.match(req).then(hit => hit || (req.mode === 'navigate' ? caches.match('/') : undefined))
    )
  );
});
