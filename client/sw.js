/**
 * Waiting for the Peak — Service Worker
 * 전략: Network-First (항상 최신 데이터 우선, API는 캐시 제외)
 */

const CACHE_NAME = "waiting-for-the-peak-v37";

// 앱 셸 캐시 목록 (정적 자산만)
const SHELL_URLS = [
    "/",
    "/index.html",
    "/static/style.css",
    "/static/app.js",
    "/static/favicon.svg",
    "/static/icons/icon-192.png",
    "/static/icons/icon-512.png",
];

// ── Install: 앱 셸 선캐시 ──
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches
            .open(CACHE_NAME)
            .then((cache) => cache.addAll(SHELL_URLS))
            .then(() => self.skipWaiting())
    );
});

// ── Activate: 오래된 캐시 정리 ──
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(
                    keys
                        .filter((k) => k !== CACHE_NAME)
                        .map((k) => caches.delete(k))
                )
            )
            .then(() => self.clients.claim())
    );
});

// ── Fetch: Network-First 전략 ──
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // API 요청 / 외부 요청은 캐시 사용하지 않음
    if (
        url.pathname.startsWith("/api/") ||
        url.hostname !== self.location.hostname
    ) {
        return; // 브라우저 기본 처리
    }

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // 성공 시 캐시 갱신
                if (response && response.status === 200 && response.type !== "opaque") {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => {
                // 오프라인: 캐시 반환
                return caches.match(event.request).then(
                    (cached) => cached || caches.match("/index.html")
                );
            })
    );
});
