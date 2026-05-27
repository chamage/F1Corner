const CACHE_NAME = 'pitcorner-shell-v20'; // v20: Implement Service Worker controllerchange auto-reload listener to ensure instant cache updates on reload without manual hard refreshes
const STATIC_ASSETS = [
  './',
  './index.html',
  './index.css',
  './manifest.json',
  './js/app.js',
  './js/api.js',
  './js/utils.js',
  './js/season-data.js',
  './js/dashboard.js',
  './js/standings.js',
  './js/calendar.js',
  './js/race-detail.js',
  './js/h2h.js',
  './js/driver-profile.js',
  './js/team-profile.js',
  './js/feedback-support.js',
  './js/charts.js',
  './logo.svg',
  './icon-192.png',
  './icon-512.png'
];

// Install: Cache all static shell files
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate: Clean up old static caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Stale-While-Revalidate Strategy (Serve from cache instantly, update in the background)
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle GET requests and local assets (avoid caching external API telemetry)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(cache => {
      return cache.match(event.request).then(cachedResponse => {
        // Fetch fresh copy from network in parallel
        const fetchPromise = fetch(event.request)
          .then(networkResponse => {
            if (networkResponse.status === 200) {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          })
          .catch(() => {
            // Silently absorb network failures when background updating
          });

        // Serve cached version immediately if present, otherwise fallback to network fetch
        return cachedResponse || fetchPromise;
      });
    })
  );
});
