/* Vision 360 — service worker.
   Everything the app needs (markup, styles, behaviour) is inlined into
   index.html, so the "app shell" is just that one file plus the icon set.
   Cache them on install, then serve same-origin GETs cache-first with a
   background refresh, and fall back to the cached shell when offline. */
'use strict';

var CACHE = 'v360-__BUILD_ID__';
var SHELL = ['./', './index.html', './manifest.webmanifest'
  __ICON_LIST__
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  var sameOrigin = url.origin === self.location.origin;

  // Navigations: try the network first (pick up a new deploy), fall back to
  // the cached shell so the app still opens with no connection.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function () {
        return caches.match('./index.html');
      })
    );
    return;
  }

  if (!sameOrigin) {
    // Google Fonts etc — cache-first with a silent background refresh.
    e.respondWith(
      caches.match(req).then(function (cached) {
        var fetchPromise = fetch(req).then(function (res) {
          if (res.ok) caches.open(CACHE).then(function (c) { c.put(req, res.clone()); });
          return res;
        }).catch(function () { return cached; });
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Same-origin assets: cache-first, fill the cache on first fetch.
  e.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        if (res.ok) caches.open(CACHE).then(function (c) { c.put(req, res.clone()); });
        return res;
      });
    })
  );
});
