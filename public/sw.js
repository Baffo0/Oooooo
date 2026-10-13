'use strict';

// Rende l'app apribile anche senza connessione: i file dell'interfaccia vengono
// presi dalla rete quando possibile e dalla cache quando si è offline o il segnale è
// così debole che la rete non risponde in pochi secondi. Le librerie in vendor/ cambiano
// solo insieme alla versione della cache: si prendono subito dal telefono.
// Dati (/api), tile della mappa e percorsi non passano dalla cache.

const CACHE = 'cabine-v7';
const NETWORK_TIMEOUT_MS = 4000;
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'config.js',
  'core.js',
  'routing.js',
  'local-api.js',
  'import.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'vendor/leaflet/leaflet.js',
  'vendor/maplibre/maplibre-gl.js',
  'vendor/maplibre/maplibre-gl.css',
  'vendor/maplibre/leaflet-maplibre-gl.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(url.pathname.includes('/vendor/') ? cacheFirst(event.request) : networkFirst(event.request));
});

function fromNetwork(request) {
  return fetch(request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return res;
  });
}

function fromCache(request) {
  return caches.match(request, { ignoreSearch: true })
    .then((hit) => hit || (request.mode === 'navigate' ? caches.match('index.html') : undefined));
}

function cacheFirst(request) {
  return caches.match(request).then((hit) => hit || fromNetwork(request));
}

function networkFirst(request) {
  return new Promise((resolve) => {
    let done = false;
    const answer = (res) => {
      if (done || !res) return;
      done = true;
      clearTimeout(timer);
      resolve(res);
    };
    // Rete lenta: se c'è una copia sul telefono si usa quella (la rete intanto aggiorna la cache).
    const timer = setTimeout(() => fromCache(request).then(answer), NETWORK_TIMEOUT_MS);
    fromNetwork(request).then(answer, () => fromCache(request).then((hit) => answer(hit || Response.error())));
  });
}
