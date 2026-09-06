// Minimal service worker - just enough to make the app installable on a
// phone's home screen (Chrome/Android require one; iOS Safari doesn't, but
// it doesn't hurt there either) and to let the app shell open when offline.
//
// Deliberately NOT caching the Apps Script API calls (script.google.com).
// This app already fought a real bug where a cached API response looked
// like "nothing happened" (see SETUP.md) - a service worker that cached API
// responses would reintroduce exactly that problem, just at a different
// layer. Only the static shell (this HTML/JS file, the manifest, the
// icons) is ever cached, and even that is "network first" so an updated
// index.html is picked up immediately whenever the phone is online; the
// cache is purely a fallback for opening the app with no signal at all.

var CACHE_NAME = 'dispatch-shell-v1';
var SHELL_FILES = [
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(SHELL_FILES);
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_NAME; }).map(function (n) { return caches.delete(n); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var url = event.request.url;

  // Never intercept the API (or anything cross-origin) - always go straight
  // to the network, exactly as if there were no service worker at all.
  if (event.request.method !== 'GET' || url.indexOf(self.location.origin) !== 0) {
    return;
  }

  // App shell: network first, falling back to the cache only when offline.
  event.respondWith(
    fetch(event.request).then(function (response) {
      var copy = response.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
      return response;
    }).catch(function () {
      return caches.match(event.request).then(function (cached) {
        return cached || caches.match('./index.html');
      });
    })
  );
});
