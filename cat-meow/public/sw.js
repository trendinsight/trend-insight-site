// 고양이 울음소리 아카이브 — 서비스 워커
// 앱 껍데기는 캐시에서 즉시 띄우고, 데이터(API·미디어)는 항상 네트워크 우선.

const VERSION = "v3";
const SHELL = `shell-${VERSION}`;
const SHELL_FILES = [
  "/",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                     // 업로드·삭제는 그대로 통과
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 데이터: 네트워크 우선, 실패 시 캐시 (비행기모드에서도 목록은 보이게)
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 영상 원본은 캐시하지 않음 (용량 폭증 방지)
  if (url.pathname.startsWith("/media/")) return;

  // 썸네일·스펙트로그램: 캐시 우선
  if (url.pathname.startsWith("/img/") || url.pathname.startsWith("/spec/")) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        if (res.ok) caches.open(SHELL).then((c) => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // 앱 껍데기: 네트워크 우선, 실패 시 캐시
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        if (res.ok) caches.open(SHELL).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("/")))
  );
});
