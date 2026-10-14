'use strict';

// Rende l'app apribile anche senza connessione: i file dell'interfaccia vengono
// presi dalla rete quando possibile e dalla cache quando si è offline o il segnale è
// così debole che la rete non risponde in pochi secondi. Le librerie in vendor/ cambiano
// solo insieme alla versione della cache: si prendono subito dal telefono.
// Dati (/api), tile della mappa e percorsi non passano dalla cache.

const CACHE = 'cabine-v9';
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
  // cache: 'reload': i file nuovi dal server, non le copie (anche di 7 giorni) del browser.
  event.waitUntil(caches.open(CACHE)
    .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Pagine aperte dalla copia sul telefono (rete lenta): anche i loro script vengono dalla copia,
// così pagina e script sono sempre della stessa versione.
const fromCacheClients = new Set();

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname.includes('/vendor/')) {
    event.respondWith(cacheFirst(request));
  } else if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request).then(({ res, cached }) => {
      if (cached && event.resultingClientId) fromCacheClients.add(event.resultingClientId);
      return res;
    }));
  } else if (fromCacheClients.has(event.clientId)) {
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(networkFirst(request).then(({ res }) => res));
  }
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

// Risponde { res, cached }: la rete, oppure la copia sul telefono se la rete non risponde in
// tempo, non c'è, o il server è fermo (errore 5xx durante un riavvio o un aggiornamento).
function networkFirst(request) {
  return new Promise((resolve) => {
    let done = false;
    const answer = (res, cached) => {
      if (done || !res) return;
      done = true;
      clearTimeout(timer);
      resolve({ res, cached });
    };
    const cachedOr = (fallback) => fromCache(request).then((hit) => answer(hit || fallback, Boolean(hit)));
    const timer = setTimeout(() => fromCache(request).then((hit) => answer(hit, true)), NETWORK_TIMEOUT_MS);
    fromNetwork(request).then(
      (res) => (res.status >= 500 ? cachedOr(res) : answer(res, false)),
      () => cachedOr(Response.error()),
    );
  });
}
