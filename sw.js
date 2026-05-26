const CACHE_NAME = 'pitcorner-shell-v2'; // Incremented to v2 to force old caches to clear
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
  './logo.svg'
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

// Fetch: Network-First Strategy (Always fetch fresh online, fallback to cache offline)
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle GET requests and local assets (avoid caching external API telemetry)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    // 1. Try to fetch from the network first
    fetch(event.request)
      .then(networkResponse => {
        // If successful (status 200), clone and update our local cache
        if (networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // 2. If the network fails (offline), serve the cached version instantly!
        return caches.match(event.request);
      })
  );
});
