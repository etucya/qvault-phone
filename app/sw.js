// Service worker: keeps the app's own files so QVault opens offline. Banks and pictures
// live in IndexedDB, not here. Network first, so a push to main shows up on the next
// launch; the cache answers when the network fails or has not answered within
// NETWORK_TIMEOUT_MS (a weak signal must not leave the app on a blank screen), and a
// network answer that arrives late still refreshes the cache for next time. Bump VERSION
// whenever the list changes. Google's sign-in and Drive requests are never touched.

const VERSION = 'qvault-v5';
const NETWORK_TIMEOUT_MS = 3000;

// Every file under app/ except this one. test/shell.test.js checks the list against disk.
const SHELL = [
  './',
  './index.html',
  './app.css',
  './theme.css',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-512.png',
  './main.js',
  './config.js',
  './auth.js',
  './drive.js',
  './sync.js',
  './prefetch.js',
  './store.js',
  './storeIndexedDB.js',
  './storeMemory.js',
  './ui/components.js',
  './ui/library.js',
  './ui/setup.js',
  './ui/setupLogic.js',
  './ui/study.js',
  './ui/studyLogic.js',
  './ui/picture.js',
  './engine/dates.js',
  './engine/keywords.js',
  './engine/optionOrder.js',
  './engine/pool.js',
  './engine/quiz.js',
  './engine/sessionEngine.js',
  './engine/settings.js',
  './engine/stats.js',
  './engine/studyModel.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== VERSION).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Same origin only: googleapis.com, accounts.google.com (gsi) and the rest go straight
  // to the network, uncached.
  if (url.origin !== self.location.origin) return;

  // The network request starts now and is let run to the end whatever answers the page,
  // so a slow response still lands in the cache.
  const network = fetch(request);
  const opened = caches.open(VERSION);
  event.waitUntil(
    network
      .then(async (response) => {
        if (response.status !== 200 || response.type !== 'basic') return;
        const copy = response.clone();
        await (await opened).put(request, copy);
      })
      .catch(() => {}),
  );

  const fromCache = async () => {
    const cache = await opened;
    return (
      (await cache.match(request, { ignoreSearch: true })) ||
      (request.mode === 'navigate' ? await cache.match('./index.html') : undefined)
    );
  };

  event.respondWith(
    (async () => {
      const TIMED_OUT = Symbol('timed out');
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), NETWORK_TIMEOUT_MS);
      });
      try {
        const winner = await Promise.race([network, timeout]);
        if (winner !== TIMED_OUT) return winner;
        // Too slow: the cached copy now, and the network keeps going for the cache.
        const cached = await fromCache();
        return cached || network; // nothing cached: all there is to do is wait
      } catch (error) {
        const cached = await fromCache();
        if (cached) return cached;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })(),
  );
});
