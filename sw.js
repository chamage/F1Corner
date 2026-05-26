const CACHE_NAME = 'pitcorner-shell-v1';
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
  './js/charts.js'
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

// Fetch: Serve from cache if static asset, otherwise fetch from network
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle GET requests and local assets (avoid caching external OpenF1 API requests in the service worker,
  // since we already have a robust JS-based indexed localStorage system for API telemetry!)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      if (cachedResponse) {
        // Return cached shell asset immediately
        return cachedResponse;
      }
      return fetch(event.request);
    })
  );
});
