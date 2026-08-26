/**
 * 서비스 워커 — 앱 껍데기와 곡 목록을 캐시해 두 가지를 해결한다.
 *   1) 홈 화면에서 띄웠을 때 즉시 뜨도록
 *   2) 파티 장소의 인터넷이 불안정해도 앱이 죽지 않도록
 *
 * 미리듣기 오디오는 재생하면서 자연히 캐시에 쌓인다(런타임 캐시).
 * 미리 전부 받아두지는 않는다 — 200곡이면 200MB 가까워서 설치가 무거워진다.
 */

const VERSION = 'v38';   // 파일 구성이 바뀌면 올린다. 옛 캐시가 남아 새 코드가 안 도는 일을 막는다.
const SHELL_CACHE = `song-game-shell-${VERSION}`;
const AUDIO_CACHE = `song-game-audio-${VERSION}`;
const AUDIO_CACHE_MAX = 80;   // 최근 재생한 곡 위주로 이 개수까지만 보관

const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/audio.js',
  './js/gyro.js',
  './js/qr.js',
  './js/spotify.js',
  './js/deck.js',
  './js/app.js',
  './data/kpop.json',
  './data/ost.json',
  './manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())   // 일부 파일이 없어도 설치는 진행
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => ![SHELL_CACHE, AUDIO_CACHE].includes(k))
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/** 오디오 캐시가 무한정 커지지 않도록 오래된 항목부터 지운다. */
async function trimAudioCache() {
  const cache = await caches.open(AUDIO_CACHE);
  const keys = await cache.keys();
  if (keys.length <= AUDIO_CACHE_MAX) return;
  await Promise.all(keys.slice(0, keys.length - AUDIO_CACHE_MAX).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 미리듣기 오디오: 캐시에 있으면 그대로, 없으면 받아서 저장
  if (url.hostname.endsWith('audio-ssl.itunes.apple.com') || url.pathname.endsWith('.m4a')) {
    event.respondWith((async () => {
      const cache = await caches.open(AUDIO_CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      try {
        const res = await fetch(request);
        if (res.ok || res.type === 'opaque') {
          cache.put(request, res.clone()).then(trimAudioCache).catch(() => {});
        }
        return res;
      } catch (err) {
        return new Response('', { status: 504, statusText: '오디오를 불러올 수 없습니다' });
      }
    })());
    return;
  }

  // 앨범아트: 캐시 우선, 실패해도 게임에 지장 없음
  if (url.hostname.includes('mzstatic.com')) {
    event.respondWith(
      caches.open(AUDIO_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const res = await fetch(request);
          if (res.ok) cache.put(request, res.clone()).catch(() => {});
          return res;
        } catch (_) {
          return new Response('', { status: 404 });
        }
      })
    );
    return;
  }

  // 같은 출처의 앱 파일: 네트워크 우선, 실패 시 캐시로 폴백
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      try {
        // no-cache 는 '받지 말라'가 아니라 '쓰기 전에 물어보라'다. 브라우저 HTTP 캐시가
        // 옛 파일을 그대로 내주는 바람에 고친 코드가 안 도는 일이 있었다.
        // 바뀐 게 없으면 304 라 비용은 거의 없다.
        const res = await fetch(request, { cache: 'no-cache' });
        if (res.ok) {
          const cache = await caches.open(SHELL_CACHE);
          cache.put(request, res.clone()).catch(() => {});
        }
        return res;
      } catch (_) {
        const hit = await caches.match(request);
        return hit || caches.match('./index.html');
      }
    })());
  }
});
