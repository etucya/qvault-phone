// Service worker: keeps the app's own files so QVault opens offline. Banks and pictures
// live in IndexedDB, not here. Network first, so a push to main shows up on the next
// launch; the cache answers only when the network does not. Bump VERSION whenever the
// list changes. Google's sign-in and Drive requests are never touched.

const VERSION = 'qvault-v4';

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

  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      try {
        const response = await fetch(request);
        // Refresh the cached copy without holding up the page.
        if (response.status === 200 && response.type === 'basic') event.waitUntil(cache.put(request, response.clone()));
        return response;
      } catch (error) {
        const cached =
          (await cache.match(request, { ignoreSearch: true })) ||
          (request.mode === 'navigate' ? await cache.match('./index.html') : undefined);
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});
