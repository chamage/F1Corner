const CACHE_NAME = 'pitcorner-shell-v21'; // v21: Implement Reload-Bypass cache-busting and Network-First navigation strategy for flawless updates on F5 reload
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

// Fetch: Advanced caching strategies based on request type
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle GET requests and local assets (avoid caching external API telemetry)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // 1. If user triggered a manual reload (F5 / Ctrl+F5), bypass cache and fetch fresh from network
  const isReload = event.request.cache === 'reload' || event.request.cache === 'no-cache';
  if (isReload) {
    event.respondWith(
      fetch(event.request).then(networkResponse => {
        return caches.open(CACHE_NAME).then(cache => {
          if (networkResponse.status === 200) {
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        });
      }).catch(() => {
        // Fallback to cache if network is offline
        return caches.match(event.request);
      })
    );
    return;
  }

  // 2. For navigation requests (like index.html), use Network-First strategy to guarantee instant updates
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(networkResponse => {
        return caches.open(CACHE_NAME).then(cache => {
          if (networkResponse.status === 200) {
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        });
      }).catch(() => {
        return caches.match(event.request) || caches.match('./index.html');
      })
    );
    return;
  }

  // 3. For sub-resources, use Stale-While-Revalidate Strategy (serve from cache, update in background)
  event.respondWith(
    caches.open(CACHE_NAME).then(cache => {
      return cache.match(event.request).then(cachedResponse => {
        const fetchPromise = fetch(event.request)
          .then(networkResponse => {
            if (networkResponse.status === 200) {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          })
          .catch(() => {
            // absorb background fetch failures gracefully
          });

        return cachedResponse || fetchPromise;
      });
    })
  );
});
