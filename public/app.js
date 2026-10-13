'use strict';

/* global L */

const TYPE_LABELS = {
  PFP: 'PFP – Armadio stradale',
  PFS: 'PFS – Punto di flessibilità secondario',
  PTE: 'PTE – Terminazione edificio',
  PCN: 'PCN / POP – Centrale',
  POZZETTO: 'Pozzetto',
  MUFFOLA: 'Muffola / giunto',
  ALTRO: 'Altro',
};
const TYPE_SHORT = { PFP: 'PFP', PFS: 'PFS', PTE: 'PTE', PCN: 'PCN', POZZETTO: 'PZ', MUFFOLA: 'MF', ALTRO: '•' };
const STATUS_LABELS = { da_fare: 'Da fare', in_corso: 'In corso', fatto: 'Fatto', problema: 'Problema' };
const DEFAULT_VIEW = { center: [42.5, 12.5], zoom: 6 };
const REFRESH_MS = 30000;
const API_TIMEOUT_MS = 20000;
const LOW_ACCURACY_M = 30;

const $ = (sel, root = document) => root.querySelector(sel);

// "Prova sul telefono" (app Android senza server): i dati restano nel telefono.
const LOCAL = Boolean(window.CABINE_CONFIG?.local);
// Funzioni dell'app Android (condividi file, schermo acceso, impostazioni), se presenti.
const NATIVE = window.CabineApp || null;
// Telefono economico (poca memoria o pochi processori): la mappa risparmia sul disegno.
const LOW_END = navigator.deviceMemory <= 3 || navigator.hardwareConcurrency <= 4;

const state = {
  me: null,
  config: null,
  cabinets: [],
  pending: loadJson('cabine.pending', []),
  etag: null,
  lastSync: null,
  offline: false,
  position: null,
  selectedId: null,
  pick: null,
  form: null,
  filterStatus: '',
  follow: false,
  userMovedMap: false,
  locateSettled: false,
  listPos: null,
  fitted: Boolean(loadJson('cabine.view', null)),
  localChanges: 0,
};

// Percorso in corso verso una cabina (anteprima o navigazione).
const nav = {
  cabId: null,
  mode: 'car',
  routes: {},
  errors: {},
  active: false,
  rerouting: false,
  lastReroute: 0,
  abort: null,
  wakeLock: null,
};

let map;
let markersLayer;
let routeLayer;
let meMarker;
let meCircle;
const markers = new Map(); // id -> { marker, key }
const dots = new Map(); // id -> { dot, key }
let dotsLayer;
let dotRenderer;
let dotMode = false;

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

function loadJson(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  store(key, JSON.stringify(value));
}

// localStorage può lanciare eccezioni (spazio esaurito, navigazione privata):
// le preferenze sono comode ma mai indispensabili.
function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* archiviazione non disponibile */
  }
}

function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtCoord(n) {
  return Number(n).toFixed(6);
}

function fmtDistance(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}

function distance(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function newClientId() {
  return crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function icon(name) {
  return `<svg class="ico"><use href="#i-${name}"/></svg>`;
}

function cabinetTitle(cab) {
  return cab.code || TYPE_LABELS[cab.type] || 'Cabina';
}

let toastTimer;
function toast(message, isError = false, ms = 3500) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error-toast', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function isDesktop() {
  return window.matchMedia('(min-width: 900px)').matches;
}

class ImageError extends Error {}

class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  let status;
  let data = null;
  let etag = null;
  if (LOCAL) {
    ({ status, data, etag } = await LocalApi.request(path, { method, body, headers }));
  } else {
    const opts = { method, headers: { ...headers }, credentials: 'same-origin', cache: 'no-store' };
    if (body instanceof Blob) {
      opts.body = body;
      opts.headers['Content-Type'] = body.type;
    } else if (body !== undefined) {
      opts.body = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
    }
    // Con segnale debolissimo una richiesta può restare appesa per minuti: le letture si
    // interrompono prima, così l'app passa a "Offline" e riprova più tardi.
    const ctrl = method === 'GET' ? new AbortController() : null;
    const timer = ctrl && setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
    try {
      const res = await fetch(path, { ...opts, signal: ctrl?.signal });
      status = res.status;
      etag = res.headers.get('etag');
      if (status !== 304 && res.headers.get('content-type')?.includes('application/json')) data = await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
  if (status === 304) return { notModified: true };
  if (status < 200 || status >= 300) {
    if (status === 401 && state.me && path !== '/api/login') showLogin();
    throw new ApiError(status, data?.error || `Errore ${status}`, data);
  }
  return { data, etag };
}

// Errore di rete (offline o server irraggiungibile) e non risposta del server.
function isNetworkError(err) {
  return !(err instanceof ApiError) && !(err instanceof ImageError);
}

// ---------------------------------------------------------------------------
// Avvio e accesso
// ---------------------------------------------------------------------------

async function init() {
  if ('serviceWorker' in navigator && !LOCAL) navigator.serviceWorker.register('sw.js').catch(() => {});
  setupModeTexts();
  const cachedMe = loadJson('cabine.me', null);
  if (cachedMe) {
    // Riapertura: la mappa compare subito con l'ultima copia, senza aspettare il server
    // (con poco segnale fa la differenza). Se l'accesso è scaduto si torna a quella pagina.
    state.me = cachedMe;
    startApp();
    loadConfig();
    api('/api/me').then(({ data }) => {
      if (!state.me) return;
      state.me = data;
      showMe();
    }).catch(() => {});
    return;
  }
  await loadConfig();
  try {
    state.me = (await api('/api/me')).data;
    startApp();
  } catch {
    showLogin();
  }
}

async function loadConfig() {
  try {
    state.config = (await api('/api/config')).data;
  } catch {
    state.config = { passwordRequired: true };
  }
  $('#login-password-field').hidden = !state.config.passwordRequired;
}

function showLogin() {
  state.me = null;
  // Una finestra rimasta aperta (es. accesso scaduto durante un'importazione) bloccherebbe
  // i tocchi sulla pagina di accesso.
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  $('#app').hidden = true;
  $('#login').hidden = false;
  // Finché non si sa se serve, il campo password resta visibile.
  $('#login-password-field').hidden = state.config ? !state.config.passwordRequired : false;
  const form = $('#login-form');
  form.name.value = load('cabine.lastName') || '';
  (form.name.value ? form.password : form.name).focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  $('#login-error').textContent = '';
  try {
    const { data } = await api('/api/login', {
      method: 'POST',
      body: { name: form.name.value, password: form.password.value },
    });
    form.password.value = '';
    store('cabine.lastName', data.name);
    state.me = data;
    startApp();
  } catch (err) {
    $('#login-error').textContent = isNetworkError(err) ? 'Server non raggiungibile, controlla la connessione' : err.message;
  }
});

let started = false;
function showMe() {
  saveJson('cabine.me', state.me);
  $('#menu-name').textContent = state.me.name;
  $('#btn-menu').textContent = state.me.name.trim().charAt(0).toUpperCase();
}

function startApp() {
  showMe();
  $('#login').hidden = true;
  $('#app').hidden = false;
  if (!started) {
    started = true;
    $('#btn-list').setAttribute('aria-expanded', String(isDesktop()));
    setupFilters();
    initMap();
    const cache = loadJson('cabine.cache', null);
    if (cache) {
      state.cabinets = cache.cabinets;
      state.etag = cache.etag;
    }
    renderAll();
    // Come su Google Maps la mappa si apre sulla tua posizione; se il GPS non risponde
    // entro qualche secondo si mostrano tutte le cabine.
    startWatch();
    setTimeout(() => {
      state.locateSettled = true;
      fitInitialView();
    }, 5000);
    setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.addEventListener('online', () => refresh());
    window.addEventListener('offline', () => { state.offline = true; renderSync(); });
  }
  refresh();
}

// ---------------------------------------------------------------------------
// Sincronizzazione
// ---------------------------------------------------------------------------

let refreshing = false;
async function refresh() {
  if (refreshing || !state.me) return;
  refreshing = true;
  try {
    // Se il server rifiuta temporaneamente una cabina in coda, la riproviamo dopo
    // ma intanto aggiorniamo comunque le altre.
    await flushPending().catch((err) => {
      if (isNetworkError(err) || err.status === 401) throw err;
    });
    const changesBefore = state.localChanges;
    const res = await api('/api/cabinets', { headers: state.etag ? { 'If-None-Match': state.etag } : {} });
    if (state.localChanges !== changesBefore) {
      // Nel frattempo abbiamo salvato qualcosa: questa copia è già vecchia, ne chiediamo una nuova.
      setTimeout(refresh, 0);
    } else if (!res.notModified) {
      state.cabinets = res.data.cabinets;
      state.etag = res.etag;
      saveCache();
      renderAll();
    }
    state.offline = false;
    state.lastSync = new Date();
  } catch (err) {
    if (isNetworkError(err)) state.offline = true;
  } finally {
    refreshing = false;
    renderSync();
  }
}

async function flushPending() {
  while (state.pending.length) {
    const item = state.pending[0];
    try {
      const { data } = await api('/api/cabinets', { method: 'POST', body: item });
      if (state.selectedId === item.clientId) state.selectedId = data.id;
      state.pending.shift();
      upsertCabinet(data);
    } catch (err) {
      // Rete assente, sessione scaduta o server in errore: si riprova più tardi.
      if (isNetworkError(err) || err.status !== 400) throw err;
      toast(`Cabina "${cabinetTitle(item)}" non salvata: ${err.message}`, true, 6000);
      state.pending.shift();
    }
    saveJson('cabine.pending', state.pending);
  }
}

function renderSync() {
  const parts = [];
  if (state.offline) parts.push('Offline');
  else if (state.lastSync) parts.push(`Aggiornato alle ${state.lastSync.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`);
  if (state.pending.length) parts.push(`${state.pending.length} da inviare`);
  $('#sync-status').textContent = parts.join(' · ');
  // Sulla mappa l'avviso compare solo quando c'è qualcosa da sapere.
  const pill = $('#sync-pill');
  pill.hidden = !state.offline && !state.pending.length;
  pill.textContent = parts.filter((t) => !t.startsWith('Aggiornato')).join(' · ');
}

function upsertCabinet(cab) {
  state.localChanges += 1;
  // Un elenco nuovo (non modificato sul posto): così i risultati dei filtri vengono ricalcolati.
  const i = state.cabinets.findIndex((c) => c.id === cab.id);
  state.cabinets = i >= 0 ? state.cabinets.map((c, j) => (j === i ? cab : c)) : [...state.cabinets, cab];
  state.etag = null;
  saveCache();
  renderAll();
}

// La copia sul telefono si scrive poco dopo, tutta in una volta: con molte cabine
// trasformarla in testo costa, e non deve rallentare il tocco che l'ha causata.
let cacheTimer = null;
function saveCache() {
  if (cacheTimer === null) cacheTimer = setTimeout(flushCache, 1000);
}
function flushCache() {
  if (cacheTimer === null) return;
  clearTimeout(cacheTimer);
  cacheTimer = null;
  if (state.me) saveJson('cabine.cache', { cabinets: state.cabinets, etag: state.etag });
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flushCache(); });
window.addEventListener('pagehide', flushCache);

function getCabinet(id) {
  return state.cabinets.find((c) => c.id === id) || state.pending.find((c) => c.clientId === id);
}

// ---------------------------------------------------------------------------
// Mappa
// ---------------------------------------------------------------------------

// Mappa stradale: stile "liberty" di OpenFreeMap (gratuito, senza chiave, simile a Google
// Maps), disegnato con MapLibre dentro Leaflet. Senza WebGL, o se il servizio non risponde,
// si passa da soli a OpenStreetMap.
const OFM_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const VECTOR_TIMEOUT_MS = 20000;

const vectorSupported = (() => {
  try {
    if (typeof maplibregl === 'undefined' || typeof L.maplibreGL !== 'function') return false;
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
})();
let vectorFailed = false;

function osmLayer() {
  return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 20,
    maxNativeZoom: 19,
    attribution: OSM_ATTRIBUTION,
  });
}

// labelsOnly: solo le scritte (vie, luoghi, numeri civici), da mettere sopra il satellite.
function vectorLayer(labelsOnly) {
  const layer = L.maplibreGL({
    style: labelsOnly ? { version: 8, sources: {}, layers: [] } : OFM_STYLE,
    className: labelsOnly ? 'gl-labels' : 'gl-streets',
    // Meno pixel da disegnare sugli schermi molto densi (la differenza non si vede),
    // ancora meno sui telefoni economici.
    pixelRatio: Math.min(window.devicePixelRatio || 1, LOW_END ? 1.5 : 2),
    // Scritte subito al loro posto, senza dissolvenza: meno fotogrammi da ridisegnare.
    fadeDuration: 0,
    validateStyle: false,
    refreshExpiredTiles: false,
  });
  layer.on('add', () => {
    const gl = layer.getMaplibreMap();
    if (labelsOnly) {
      gl.setStyle(OFM_STYLE, {
        transformStyle: (_previous, next) => ({ ...next, layers: next.layers.filter((l) => l.type === 'symbol') }),
      });
    }
    watchVectorLayer(layer, gl, labelsOnly);
  });
  return layer;
}

// Se lo stile non arriva (servizio irraggiungibile, rete che blocca il sito...) non lasciamo
// la mappa bianca: si passa a OpenStreetMap. Gli errori di singole tile non contano.
function watchVectorLayer(layer, gl, labelsOnly) {
  let done = false;
  const fail = (reason) => {
    if (done || !navigator.onLine) return;
    done = true;
    clearTimeout(timer);
    console.warn('Mappa vettoriale non disponibile:', reason);
    if (labelsOnly) {
      // Il satellite resta, senza le scritte.
      if (baseLayer && baseLayer.hasLayer && baseLayer.hasLayer(layer)) baseLayer.removeLayer(layer);
      return;
    }
    vectorFailed = true;
    if (currentLayer === 'strade') {
      setLayer('strade');
      toast('La mappa principale non risponde: uso OpenStreetMap', true, 5000);
    }
  };
  const timer = setTimeout(() => { if (!gl.isStyleLoaded()) fail('tempo scaduto'); }, VECTOR_TIMEOUT_MS);
  gl.on('error', (e) => { if (!gl.isStyleLoaded()) fail(e && e.error ? e.error.message : 'errore'); });
  gl.on('style.load', () => {
    if (labelsOnly && !gl.getStyle().layers.length) return;  // stile vuoto iniziale
    done = true;
    clearTimeout(timer);
  });
  layer.on('remove', () => { done = true; clearTimeout(timer); });
}

// Tornata la connessione si riprova la mappa principale.
window.addEventListener('online', () => {
  if (!vectorFailed) return;
  vectorFailed = false;
  if (currentLayer === 'strade') setLayer('strade');
});

const LAYERS = {
  strade: () => (vectorSupported && !vectorFailed ? vectorLayer(false) : osmLayer()),
  satellite: () => L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20,
      maxNativeZoom: 19,
      attribution: 'Immagini &copy; Esri, Maxar, Earthstar Geographics',
    }),
    ...(vectorSupported ? [vectorLayer(true)] : []),
  ]),
  osm: osmLayer,
};
let baseLayer;
let currentLayer = null;

function initMap() {
  const saved = loadJson('cabine.view', null);
  map = L.map('map', { zoomControl: false, maxZoom: 20 });
  // Prima la vista, poi lo sfondo: la mappa vettoriale ha bisogno di centro e zoom.
  if (saved) map.setView(saved.center, saved.zoom);
  else map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
  setLayer(LAYERS[load('cabine.layer')] ? load('cabine.layer') : 'strade');
  // Registrato dopo setView, così la vista predefinita non viene salvata come scelta dell'utente.
  map.on('moveend', () => {
    const c = map.getCenter();
    saveJson('cabine.view', { center: [c.lat, c.lng], zoom: map.getZoom() });
    queueMarkers();
  });
  map.on('zoomend', updateLabels);
  updateLabels();
  // Chi tocca o trascina la mappa decide lui dove guardare: smettiamo di seguire il GPS.
  map.getContainer().addEventListener('pointerdown', () => { state.userMovedMap = true; }, { passive: true });
  map.getContainer().addEventListener('wheel', () => { state.userMovedMap = true; }, { passive: true });
  map.on('dragstart', () => setFollow(false));
  // Pressione prolungata (o tasto destro) per aggiungere una cabina in quel punto.
  map.on('contextmenu', (e) => {
    if (state.pick || nav.cabId) return;
    openForm({ mode: 'create', lat: e.latlng.lat, lng: e.latlng.lng, accuracy: null });
  });
  map.on('click', () => {
    closeLayersMenu();
    if (!state.pick && !nav.cabId && !isDesktop()) closeDetail();
  });
  routeLayer = L.layerGroup().addTo(map);
  // Pallini delle cabine viste da lontano: tutti su un'unica tela, leggerissima da muovere.
  // La tolleranza allarga la zona che risponde al dito.
  dotRenderer = L.canvas({ padding: 0.3, tolerance: 8 });
  dotsLayer = L.layerGroup().addTo(map);
  markersLayer = L.layerGroup().addTo(map);
}

function setLayer(name) {
  if (baseLayer) map.removeLayer(baseLayer);
  currentLayer = name;
  baseLayer = LAYERS[name]().addTo(map);
  store('cabine.layer', name);
  document.querySelectorAll('#layers-menu [data-layer]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.layer === name)));
}

function closeLayersMenu() {
  $('#layers-menu').hidden = true;
  $('#btn-layers').setAttribute('aria-expanded', 'false');
}

$('#btn-layers').addEventListener('click', () => {
  const menu = $('#layers-menu');
  menu.hidden = !menu.hidden;
  $('#btn-layers').setAttribute('aria-expanded', String(!menu.hidden));
});
$('#layers-menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-layer]');
  if (!b) return;
  setLayer(b.dataset.layer);
  closeLayersMenu();
});
$('#btn-zoom-in').addEventListener('click', () => map.zoomIn());
$('#btn-zoom-out').addEventListener('click', () => map.zoomOut());

// Da vicino i segnaposto mostrano anche il nome della cabina, come i luoghi su Google Maps.
function updateLabels() {
  map.getContainer().classList.toggle('show-labels', map.getZoom() >= 17);
}

// Senza GPS (permesso negato o assente) al primo avvio inquadra tutte le cabine.
function fitInitialView() {
  if (state.fitted || state.position || !state.locateSettled || state.userMovedMap || !state.cabinets.length) return;
  state.fitted = true;
  map.fitBounds(L.latLngBounds(state.cabinets.map((c) => [c.lat, c.lng])), { padding: [60, 60], maxZoom: 16 });
}

function markerIcon(cab, pending, id) {
  const cls = pending ? 'pending' : `st-${cab.status}`;
  const selected = id === state.selectedId ? ' selected' : '';
  return L.divIcon({
    className: `cab-marker ${cls}${selected}`,
    html: `<div class="pin"><span>${esc(TYPE_SHORT[cab.type] || '•')}</span></div><div class="pin-label">${esc(cabinetTitle(cab))}</div>`,
    iconSize: [34, 42],
    iconAnchor: [17, 41],
  });
}

// Tutto ciò che si vede di un segnaposto: se non cambia, il segnaposto resta com'è.
function markerKey(cab, pending, id) {
  return `${pending ? 'p' : cab.status}|${cab.type}|${cabinetTitle(cab)}|${cab.lat}|${cab.lng}|${id === state.selectedId}`;
}

const STATUS_COLORS = { da_fare: '#2563eb', in_corso: '#d97706', fatto: '#15803d', problema: '#dc2626' };
// Oltre questo numero di cabine nello schermo i segnaposto diventano pallini.
const MAX_PINS = LOW_END ? 150 : 300;
// Segnaposto pronti anche appena fuori dallo schermo, per i piccoli spostamenti; quelli già
// disegnati si tolgono solo quando sono ben lontani, così andando avanti e indietro non si
// ricreano di continuo.
const PIN_MARGIN = 0.3;
const PIN_KEEP = 0.6;

function inBounds(b, c) {
  return c.lat >= b.getSouth() && c.lat <= b.getNorth() && c.lng >= b.getWest() && c.lng <= b.getEast();
}

function onMarkerTap(id) {
  if (nav.cabId) return;
  setFollow(false);
  openDetail(id);
}

// Si disegnano solo i segnaposto nella zona visibile e si aggiornano solo quelli cambiati:
// anche con centinaia di cabine la mappa resta fluida sui telefoni economici.
// Da lontano, con troppe cabine nello schermo, diventano pallini colorati come su Google Maps.
function renderMarkers() {
  if (!map) return;
  const list = filteredCabinets();
  const view = map.getBounds();
  let inView = 0;
  for (const c of list) if (inBounds(view, c)) inView += 1;
  // Un po' di margine evita che si passi avanti e indietro tra pallini e segnaposto.
  dotMode = inView > (dotMode ? MAX_PINS * 0.8 : MAX_PINS);
  const area = view.pad(PIN_MARGIN);
  const keep = view.pad(PIN_KEEP);

  const wanted = new Map();
  for (const c of list) {
    const show = c.id === state.selectedId ||
      (!dotMode && (inBounds(area, c) || (markers.has(c.id) && inBounds(keep, c))));
    if (show) wanted.set(c.id, [c, false]);
  }
  for (const c of state.pending) wanted.set(c.clientId, [c, true]);

  for (const [id, m] of markers) {
    if (!wanted.has(id)) {
      markersLayer.removeLayer(m.marker);
      markers.delete(id);
    }
  }
  for (const [id, [cab, pending]] of wanted) {
    const key = markerKey(cab, pending, id);
    const m = markers.get(id);
    if (m && m.key === key) continue;
    const zIndexOffset = id === state.selectedId ? 1000 : 0;
    if (m) {
      m.key = key;
      m.marker.options.title = cabinetTitle(cab);
      m.marker.setLatLng([cab.lat, cab.lng]).setIcon(markerIcon(cab, pending, id)).setZIndexOffset(zIndexOffset);
      continue;
    }
    const marker = L.marker([cab.lat, cab.lng], { icon: markerIcon(cab, pending, id), title: cabinetTitle(cab), zIndexOffset });
    marker.on('click', () => onMarkerTap(id));
    marker.addTo(markersLayer);
    markers.set(id, { marker, key });
  }
  renderDots(dotMode ? list : []);
}

function renderDots(list) {
  const wanted = new Map();
  for (const c of list) if (c.id !== state.selectedId) wanted.set(c.id, c);
  for (const [id, d] of dots) {
    if (!wanted.has(id)) {
      dotsLayer.removeLayer(d.dot);
      dots.delete(id);
    }
  }
  for (const [id, cab] of wanted) {
    const key = `${cab.status}|${cab.lat}|${cab.lng}`;
    const d = dots.get(id);
    if (d && d.key === key) continue;
    if (d) {
      d.key = key;
      d.dot.setLatLng([cab.lat, cab.lng]).setStyle({ fillColor: STATUS_COLORS[cab.status] || STATUS_COLORS.da_fare });
      continue;
    }
    const dot = L.circleMarker([cab.lat, cab.lng], {
      renderer: dotRenderer,
      radius: 6,
      weight: 2,
      color: '#fff',
      fillColor: STATUS_COLORS[cab.status] || STATUS_COLORS.da_fare,
      fillOpacity: 1,
      // Il tocco su un pallino non deve arrivare alla mappa (che chiuderebbe la scheda).
      bubblingMouseEvents: false,
    });
    dot.on('click', () => onMarkerTap(id));
    dot.addTo(dotsLayer);
    dots.set(id, { dot, key });
  }
}

// Dopo uno spostamento della mappa; se la mappa si muove di continuo (navigazione, GPS)
// al massimo qualche aggiornamento al secondo.
const MARKERS_EVERY_MS = 150;
let markersTimer = null;
let markersAt = 0;
function queueMarkers() {
  if (markersTimer !== null) return;
  markersTimer = setTimeout(() => requestAnimationFrame(() => {
    markersTimer = null;
    markersAt = performance.now();
    renderMarkers();
  }), Math.max(0, markersAt + MARKERS_EVERY_MS - performance.now()));
}

// ---------------------------------------------------------------------------
// Posizione GPS (sempre attiva, come su Google Maps)
// ---------------------------------------------------------------------------

let watchId = null;
const positionWaiters = [];

function startWatch() {
  if (!navigator.geolocation || watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, { enableHighAccuracy: true, maximumAge: 3000 });
}

function onPosition(pos) {
  const first = !state.position;
  updateMyPosition(pos);
  positionWaiters.splice(0).forEach((resolve) => resolve(state.position));
  const ll = [state.position.lat, state.position.lng];
  if (first && !state.userMovedMap && !state.pick && !state.selectedId && !nav.cabId) {
    // All'apertura la mappa parte da dove sei, con le cabine intorno.
    map.setView(ll, 16);
  } else if (state.follow && !state.pick) {
    map.panTo(ll, { animate: true, duration: 0.5 });
  }
  if (nav.active) onNavPosition();
}

function onPositionError(err) {
  if (state.position) return;
  state.locateSettled = true;
  fitInitialView();
  if (err.code === 1) {
    toast(insecureContext() ? 'Il GPS funziona solo se il sito è aperto in HTTPS'
      : 'Consenti l\'accesso alla posizione per vedere dove sei sulla mappa', true, 6000);
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

function insecureContext() {
  return location.protocol === 'http:' && location.hostname !== 'localhost';
}

function updateMyPosition(pos) {
  const c = pos.coords;
  state.position = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, heading: c.heading, speed: c.speed };
  state.positionAt = Date.now();
  const ll = [c.latitude, c.longitude];
  if (!meMarker) {
    meCircle = L.circle(ll, { radius: c.accuracy, color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
    meMarker = L.marker(ll, {
      icon: L.divIcon({ className: '', html: '<div class="me"><div class="me-cone" hidden></div><div class="me-dot"></div></div>', iconSize: [64, 64] }),
      interactive: false,
      keyboard: false,
      zIndexOffset: 2000,
    }).addTo(map);
  } else {
    meMarker.setLatLng(ll);
    meCircle.setLatLng(ll).setRadius(c.accuracy);
  }
  // Direzione di marcia (disponibile quando ci si muove).
  const cone = meMarker.getElement()?.querySelector('.me-cone');
  if (cone) {
    const moving = Number.isFinite(c.heading) && c.heading >= 0 && (c.speed === null || c.speed > 0.5);
    cone.hidden = !moving;
    if (moving) cone.style.transform = `rotate(${c.heading}deg)`;
  }
  $('#btn-locate').classList.add('has-fix');
  // L'elenco è ordinato per distanza: lo aggiorniamo solo dopo spostamenti significativi.
  if (!state.listPos || distance(state.listPos, state.position) > 25) {
    state.listPos = { lat: c.latitude, lng: c.longitude };
    renderList();
  }
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Il dispositivo non supporta la geolocalizzazione'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => { updateMyPosition(pos); resolve(state.position); },
      (err) => {
        const msg = {
          1: 'Permesso di posizione negato: abilitalo nelle impostazioni del browser',
          2: 'Posizione non disponibile, riprova all\'aperto',
          3: 'Tempo scaduto per il GPS, riprova',
        }[err.code] || 'Impossibile ottenere la posizione';
        reject(new Error(insecureContext() ? 'Il GPS funziona solo se il sito è aperto in HTTPS' : msg));
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });
}

// Posizione attuale per salvare una cabina: l'ultima lettura del GPS se è di pochi
// secondi fa, altrimenti la prima nuova lettura (dal GPS già attivo o da una
// richiesta apposita). Si segnala un errore solo se falliscono entrambe.
function freshPosition() {
  if (state.position && Date.now() - state.positionAt < 10000) return Promise.resolve(state.position);
  if (watchId === null) return getPosition();
  return new Promise((resolve, reject) => {
    let done = false;
    let failures = 0;
    const ok = (p) => {
      if (done) return;
      done = true;
      resolve(p);
    };
    const fail = (err) => {
      failures += 1;
      if (done || failures < 2) return;
      done = true;
      reject(err);
    };
    nextPosition(20000).then((p) => (p ? ok(p) : fail(new Error('Tempo scaduto per il GPS, riprova'))));
    getPosition().then(ok, fail);
  });
}

// Il GPS appena acceso può sbagliare di decine di metri: per salvare una cabina
// aspettiamo fino a qualche secondo una lettura precisa, tenendo comunque la migliore.
const GOOD_ACCURACY_M = 15;

function nextPosition(ms) {
  return new Promise((resolve) => {
    const onFix = (p) => {
      clearTimeout(timer);
      resolve(p);
    };
    const timer = setTimeout(() => {
      const i = positionWaiters.indexOf(onFix);
      if (i >= 0) positionWaiters.splice(i, 1);
      resolve(null);
    }, ms);
    positionWaiters.push(onFix);
  });
}

async function accuratePosition() {
  let best = await freshPosition();
  const deadline = Date.now() + 8000;
  while (best.accuracy > GOOD_ACCURACY_M && watchId !== null && Date.now() < deadline) {
    toast(`Miglioro la precisione del GPS… ±${Math.round(best.accuracy)} m`, false, 9000);
    const next = await nextPosition(deadline - Date.now());
    if (!next) break;
    if (next.accuracy < best.accuracy) best = next;
  }
  return best;
}

function setFollow(on) {
  state.follow = on;
  $('#btn-locate').classList.toggle('following', on);
}

$('#btn-locate').addEventListener('click', async () => {
  try {
    const pos = state.position || await getPosition();
    startWatch();
    setFollow(true);
    map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), nav.active ? navZoom() : 17));
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------------------------------------------------------------------------
// Ricerca, filtri ed elenco
// ---------------------------------------------------------------------------

function setupFilters() {
  const typeSel = $('#filter-type');
  typeSel.innerHTML = '<option value="">Tutti i tipi</option>' +
    Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  typeSel.addEventListener('change', renderAll);

  $('#chips').innerHTML = [['', 'Tutte'], ...Object.entries(STATUS_LABELS)].map(([k, v]) =>
    `<button type="button" class="chip-btn ${k ? `st-${k}` : 'all'}" data-status="${k}" aria-pressed="${k === state.filterStatus}">${esc(v)}</button>`).join('');
  $('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (b) setStatusFilter(b.dataset.status);
  });
  // Promemoria sulla mappa: un tocco toglie tutti i filtri.
  $('#filter-pill').addEventListener('click', () => {
    $('#filter-type').value = '';
    setStatusFilter('');
  });

  const form = $('#cabinet-form');
  form.type.innerHTML = Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  form.status.innerHTML = Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
}

function setStatusFilter(status) {
  state.filterStatus = status;
  document.querySelectorAll('#chips [data-status]').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.status === status)));
  renderAll();
}

// I filtri stanno nell'elenco; a elenco chiuso la mappa ricorda quali sono attivi.
function renderFilterPill() {
  const type = $('#filter-type').value;
  const parts = [state.filterStatus && STATUS_LABELS[state.filterStatus], type && (type === 'ALTRO' ? 'Altro' : TYPE_LABELS[type].split(' – ')[0])].filter(Boolean);
  const listOpen = !isDesktop() && $('#list-panel').classList.contains('open');
  $('#filter-pill').hidden = !parts.length || listOpen;
  $('#filter-pill-text').textContent = `Filtro: ${parts.join(' · ')}`;
  $('#filter-pill').setAttribute('aria-label', `Togli il filtro ${parts.join(', ')}`);
}

// Testo in cui cercare, preparato una volta sola per cabina (una cabina modificata è un oggetto nuovo).
const searchTexts = new WeakMap();
function searchText(c) {
  let hay = searchTexts.get(c);
  if (hay === undefined) {
    hay = [c.code, c.address, c.notes, c.createdBy, TYPE_LABELS[c.type], ...c.log.map((l) => l.text)].join(' ').toLowerCase();
    searchTexts.set(c, hay);
  }
  return hay;
}

// Lo stesso risultato serve a mappa, elenco e suggerimenti: si ricalcola solo se cambia qualcosa.
let filterMemo = null;
function filteredCabinets() {
  const q = $('#search').value.trim().toLowerCase();
  const type = $('#filter-type').value;
  const status = state.filterStatus;
  const m = filterMemo;
  if (m && m.cabinets === state.cabinets && m.q === q && m.type === type && m.status === status) return m.list.slice();
  const words = q ? q.split(/\s+/) : [];
  const list = state.cabinets.filter((c) => {
    if (type && c.type !== type) return false;
    if (status && c.status !== status) return false;
    if (!words.length) return true;
    const hay = searchText(c);
    return words.every((word) => hay.includes(word));
  });
  filterMemo = { cabinets: state.cabinets, q, type, status, list };
  return list.slice();
}

function sortByDistance(list) {
  const pos = state.position;
  const dist = new Map();
  if (pos) {
    for (const c of list) dist.set(c, distance(pos, c));
    list.sort((a, b) => dist.get(a) - dist.get(b));
  } else {
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return dist;
}

function listVisible() {
  const panel = $('#list-panel');
  return isDesktop() ? !panel.classList.contains('closed') : panel.classList.contains('open');
}

function listItemHtml(c, dist) {
  return `
    <li><button class="item" data-id="${esc(c.id)}">
      <span class="badge st-${esc(c.status)}">${esc(TYPE_SHORT[c.type])}</span>
      <span class="item-body">
        <span class="item-title">${esc(cabinetTitle(c))}</span><br>
        <span class="item-sub">${esc(c.address || `${fmtCoord(c.lat)}, ${fmtCoord(c.lng)}`)}</span><br>
        <span class="chip st-${esc(c.status)}">${esc(STATUS_LABELS[c.status])}</span>
      </span>
      ${dist ? `<span class="item-dist">${fmtDistance(dist.get(c))}</span>` : ''}
    </button></li>`;
}

// L'elenco si prepara solo quando è aperto, e a pagine: le cabine più lontane si aggiungono
// scorrendo. Con centinaia di cabine il telefono non costruisce migliaia di righe mai viste.
const LIST_PAGE = 50;
let listDirty = true;
const listRest = { items: [], dist: null, filter: null };

function renderList() {
  if (!listVisible()) {
    listDirty = true;
    return;
  }
  listDirty = false;
  const list = filteredCabinets();
  const dist = sortByDistance(list);
  const pos = state.position;
  const total = state.cabinets.length;
  $('#list-count').textContent = (list.length === total ? `${total} cabine` : `${list.length} di ${total}`) +
    (pos ? ' · le più vicine prima' : ' · le più recenti prima');

  const pendingItems = state.pending.map((c) => `
    <li><button class="item" data-id="${esc(c.clientId)}">
      <span class="badge pending">${esc(TYPE_SHORT[c.type])}</span>
      <span class="item-body">
        <span class="item-title">${esc(cabinetTitle(c))}</span><br>
        <span class="item-sub">In attesa di connessione per essere inviata</span>
      </span>
    </button></li>`).join('');

  // Quando l'elenco si aggiorna resta lungo almeno quanto lo si era già fatto scorrere;
  // con una ricerca o un filtro nuovi si riparte dall'inizio.
  const el = $('#list');
  const filter = [$('#search').value.trim().toLowerCase(), $('#filter-type').value, state.filterStatus].join('|');
  let shown = LIST_PAGE;
  if (filter === listRest.filter) shown = Math.max(LIST_PAGE, el.children.length - state.pending.length);
  else el.scrollTop = 0;
  listRest.filter = filter;
  listRest.items = list.slice(shown);
  listRest.dist = pos ? dist : null;
  el.innerHTML = pendingItems + list.slice(0, shown).map((c) => listItemHtml(c, listRest.dist)).join('');
  fillList();

  const empty = $('#list-empty');
  const q = $('#search').value.trim();
  if (list.length || state.pending.length) {
    empty.hidden = true;
  } else {
    empty.hidden = false;
    empty.innerHTML = total
      ? `Nessuna cabina corrisponde alla ricerca.${q ? `<br><button class="btn" id="btn-place-search" type="button">${icon('search')} Cerca “${esc(q)}” sulla mappa</button>` : ''}`
      : 'Ancora nessuna cabina salvata.<br>Premi <strong>+</strong> per aggiungere la prima.';
    $('#btn-place-search')?.addEventListener('click', () => searchPlace(q));
  }
}

function appendListPage() {
  const page = listRest.items.splice(0, LIST_PAGE);
  if (page.length) $('#list').insertAdjacentHTML('beforeend', page.map((c) => listItemHtml(c, listRest.dist)).join(''));
}

// Aggiunge righe finché l'elenco non arriva a poco oltre il fondo dello schermo.
function fillList() {
  const el = $('#list');
  while (listRest.items.length && el.scrollTop + el.clientHeight > el.scrollHeight - 600) appendListPage();
}
$('#list').addEventListener('scroll', fillList, { passive: true });

$('#list').addEventListener('click', (e) => {
  const btn = e.target.closest('.item');
  if (btn) focusCabinet(btn.dataset.id);
});

function focusCabinet(id) {
  const cab = getCabinet(id);
  if (!cab || nav.active || state.pick) return;
  if (nav.cabId) closeRoute();
  if (!isDesktop()) toggleList(false);
  setFollow(false);
  state.userMovedMap = true;
  map.setView([cab.lat, cab.lng], Math.max(map.getZoom(), 17));
  openDetail(id);
}

function toggleList(force) {
  const panel = $('#list-panel');
  let open;
  if (isDesktop()) {
    open = force ?? panel.classList.contains('closed');
    panel.classList.toggle('closed', !open);
    setTimeout(() => map.invalidateSize(), 50);
  } else {
    open = force ?? !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    renderFilterPill();
    // Su telefono l'elenco occupa lo schermo: la scheda aperta resterebbe sopra.
    if (open) closeDetail();
  }
  if (open && listDirty) renderList();
  $('#btn-list').setAttribute('aria-expanded', String(open));
}
$('#btn-list').addEventListener('click', () => toggleList());
// Ruotando un tablet si può passare dalla vista telefono a quella computer e viceversa.
window.matchMedia('(min-width: 900px)').addEventListener('change', () => {
  if (listDirty) renderList();
  renderFilterPill();
});

// Barra di ricerca con suggerimenti: cabine corrispondenti e ricerca di un indirizzo.
const searchInput = $('#search');
let searchTimer = null;

function clearSearch() {
  clearTimeout(searchTimer);
  searchInput.value = '';
  $('#search-clear').hidden = true;
  $('#suggestions').hidden = true;
  renderAll();
}

function renderSuggestions() {
  const box = $('#suggestions');
  const q = searchInput.value.trim();
  if (!q || document.activeElement !== searchInput) {
    box.hidden = true;
    return;
  }
  const list = filteredCabinets();
  const dist = sortByDistance(list);
  box.innerHTML = list.slice(0, 5).map((c) => `
    <button type="button" class="suggestion" role="option" data-id="${esc(c.id)}">
      <span class="badge st-${esc(c.status)}">${esc(TYPE_SHORT[c.type])}</span>
      <span class="suggestion-body"><strong>${esc(cabinetTitle(c))}</strong><span>${esc(c.address || STATUS_LABELS[c.status])}</span></span>
      ${dist.has(c) ? `<span class="dist">${fmtDistance(dist.get(c))}</span>` : ''}
    </button>`).join('') + `
    <button type="button" class="suggestion" role="option" data-place="1">
      ${icon('search')}
      <span class="suggestion-body"><strong>Cerca “${esc(q)}”</strong><span>Indirizzo o luogo sulla mappa</span></span>
    </button>`;
  box.hidden = false;
}

// Mentre si scrive si aggiornano subito solo i suggerimenti; mappa ed elenco quando ci si ferma.
searchInput.addEventListener('input', () => {
  $('#search-clear').hidden = !searchInput.value;
  renderSuggestions();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderAll, 300);
});
searchInput.addEventListener('focus', renderSuggestions);
searchInput.addEventListener('blur', () => setTimeout(() => { $('#suggestions').hidden = true; }, 150));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!$('#suggestions').hidden) $('#suggestions .suggestion')?.click();
  } else if (e.key === 'Escape') {
    searchInput.blur();
  }
});
$('#search-clear').addEventListener('click', () => {
  clearSearch();
  searchInput.focus();
});
// Evita che il campo perda il fuoco prima che il tocco sul suggerimento venga registrato.
$('#suggestions').addEventListener('mousedown', (e) => e.preventDefault());
$('#suggestions').addEventListener('click', (e) => {
  const b = e.target.closest('.suggestion');
  if (!b) return;
  const q = searchInput.value.trim();
  searchInput.blur();
  clearSearch();
  if (b.dataset.id) focusCabinet(b.dataset.id);
  else searchPlace(q);
});

let placeMarker;
async function searchPlace(q) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=it&accept-language=it&q=${encodeURIComponent(q)}`;
    const results = await (await fetch(url)).json();
    if (!results.length) {
      toast('Luogo non trovato');
      return;
    }
    const lat = Number(results[0].lat);
    const lng = Number(results[0].lon);
    if (!isDesktop()) toggleList(false);
    setFollow(false);
    state.userMovedMap = true;
    placeMarker?.remove();
    placeMarker = L.marker([lat, lng], {
      icon: L.divIcon({ className: '', html: '<div class="place-pin"></div>', iconSize: [26, 26], iconAnchor: [13, 31], popupAnchor: [0, -30] }),
    }).addTo(map);
    const popup = document.createElement('div');
    popup.innerHTML = `<strong>${esc(results[0].display_name.split(',').slice(0, 3).join(','))}</strong><br>
      <button class="btn btn-small btn-primary" type="button">${icon('plus')} Aggiungi cabina qui</button>`;
    popup.querySelector('button').addEventListener('click', () => {
      map.closePopup();
      openForm({ mode: 'create', lat, lng, accuracy: null });
    });
    map.setView([lat, lng], 17);
    const marker = placeMarker;
    marker.bindPopup(popup).openPopup();
    // Il segnaposto dell'indirizzo sparisce insieme al suo fumetto (tocco sulla mappa).
    marker.on('popupclose', () => marker.remove());
  } catch {
    toast('Ricerca indirizzi non disponibile', true);
  }
}

function renderAll() {
  fitInitialView();
  renderMarkers();
  renderList();
  renderSuggestions();
  renderFilterPill();
  if (state.selectedId && !state.pick && !nav.cabId) {
    if (getCabinet(state.selectedId)) renderDetail();
    else closeDetail();
  }
  if (nav.cabId && !getCabinet(nav.cabId)) closeRoute();
  renderSync();
}

// ---------------------------------------------------------------------------
// Scheda dettaglio
// ---------------------------------------------------------------------------

function openDetail(id) {
  state.selectedId = id;
  renderMarkers();
  renderDetail();
  $('#sheet').scrollTop = 0;
  revealSelected();
}

// Come su Google Maps: su telefono la cabina scelta resta visibile tra la barra di
// ricerca e la scheda, invece di finire nascosta sotto di essa.
function revealSelected() {
  const cab = getCabinet(state.selectedId);
  const sheet = $('#sheet');
  if (!cab || isDesktop() || sheet.hidden) return;
  const box = map.getContainer().getBoundingClientRect();
  const top = Math.max($('#top').getBoundingClientRect().bottom - box.top, 0) + 12;
  const bottom = sheet.getBoundingClientRect().top - box.top - 12;
  if (bottom - top < 90) return;
  const p = map.latLngToContainerPoint([cab.lat, cab.lng]);
  const pinTop = p.y - 46; // il segnaposto sta sopra il punto esatto
  if (pinTop >= top && p.y <= bottom) return;
  map.panBy([0, p.y - (top + bottom) / 2 - 20], { animate: true, duration: 0.3 });
}

function closeDetail() {
  if (!state.selectedId) return;
  state.selectedId = null;
  $('#sheet').hidden = true;
  $('#fabs').hidden = false;
  renderMarkers();
}

function renderDetail() {
  const sheet = $('#sheet');
  const cab = getCabinet(state.selectedId);
  if (!cab) return;
  const pending = !cab.id;
  // Conserva il testo che si sta scrivendo nel diario durante gli aggiornamenti automatici.
  const draft = $('#log-text', sheet)?.value || '';
  const hadFocus = document.activeElement?.id === 'log-text';
  const dest = `${cab.lat},${cab.lng}`;
  const distanceText = state.position ? ` · a ${fmtDistance(distance(state.position, cab))} da te` : '';

  sheet.innerHTML = `
    <div class="sheet-head">
      <span class="badge ${pending ? 'pending' : `st-${esc(cab.status)}`}">${esc(TYPE_SHORT[cab.type])}</span>
      <div class="sheet-title">
        <h2>${esc(cabinetTitle(cab))}</h2>
        <p class="muted small">${esc(TYPE_LABELS[cab.type])}</p>
        <p class="chip st-${esc(cab.status)}">${esc(STATUS_LABELS[cab.status])}</p>
      </div>
      <button class="icon-btn" id="sheet-close" type="button" aria-label="Chiudi">${icon('close')}</button>
    </div>
    <div class="quick-actions">
      <button class="btn btn-route" id="btn-directions" type="button">${icon('directions')} Indicazioni</button>
      <a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${dest}" target="_blank" rel="noopener">${icon('nav')} Google Maps</a>
      <a class="btn" href="https://waze.com/ul?ll=${dest}&navigate=yes" target="_blank" rel="noopener">${icon('nav')} Waze</a>
      ${pending ? '' : `
      <button class="btn" id="btn-edit" type="button">${icon('edit')} Modifica</button>
      <button class="btn" id="btn-move" type="button">${icon('move')} Sposta</button>`}
    </div>
    ${pending ? '<p class="warning small">Salvata solo su questo telefono: verrà inviata alla squadra appena torna la connessione.</p>' : ''}
    <section>
      <h3>Posizione</h3>
      ${cab.address ? `<p class="notes">${esc(cab.address)}</p>` : ''}
      <div class="coords">
        <span>${fmtCoord(cab.lat)}, ${fmtCoord(cab.lng)}</span>
        <button class="btn btn-small" id="btn-copy" type="button">${icon('copy')} Copia</button>
      </div>
      <p class="muted small">${cab.accuracy ? `Precisione GPS ±${cab.accuracy} m` : 'Posizione scelta sulla mappa'}${distanceText}</p>
    </section>
    ${cab.notes ? `<section><h3>Note</h3><p class="notes">${esc(cab.notes)}</p></section>` : ''}
    ${pending ? '' : `
    <section>
      <h3>Foto (${cab.photos.length})</h3>
      <div class="photos">
        ${cab.photos.map((p) => `<div class="photo">
            <button type="button" class="photo-open" data-view="${esc(p.id)}" aria-label="Apri foto di ${esc(p.by)} del ${esc(fmtDate(p.at))}">
              <img ${photoAttr(cab.id, p.id)} alt="Foto della cabina" loading="lazy">
            </button>
            <button type="button" class="photo-delete" data-photo="${esc(p.id)}" aria-label="Elimina foto">${icon('trash')}</button>
          </div>`).join('')}
        ${cab.photos.length < 6 ? `<button class="add-photo" id="btn-photo" type="button">${icon('camera')}<span>Aggiungi foto</span></button>` : ''}
      </div>
    </section>
    <section>
      <h3>Diario interventi</h3>
      <form class="log-form" id="log-form">
        <textarea id="log-text" rows="1" maxlength="2000" placeholder="Cosa hai fatto oggi?" aria-label="Nuova nota nel diario"></textarea>
        <button class="btn btn-primary" type="submit">Aggiungi</button>
      </form>
      <ul class="log">
        ${cab.log.map((l) => `<li>
          <div class="meta"><span><strong>${esc(l.by)}</strong> · ${esc(fmtDate(l.at))}</span>
          ${l.by === state.me.name ? `<button type="button" data-log="${esc(l.id)}">Elimina</button>` : ''}</div>
          <p>${esc(l.text)}</p>
        </li>`).join('')}
      </ul>
    </section>
    <p class="footer-meta">
      Aggiunta da <strong>${esc(cab.createdBy)}</strong> il ${esc(fmtDate(cab.createdAt))}<br>
      Ultima modifica: <strong>${esc(cab.updatedBy)}</strong> il ${esc(fmtDate(cab.updatedAt))}
    </p>
    <div class="row"><button class="btn btn-danger-text" id="btn-delete" type="button">${icon('trash')} Elimina cabina</button></div>`}
  `;
  sheet.hidden = false;
  if (!isDesktop()) $('#fabs').hidden = true;

  $('#sheet-close').addEventListener('click', closeDetail);
  $('#btn-directions').addEventListener('click', () => openRoute(state.selectedId));
  $('#btn-copy').addEventListener('click', () => copyText(`${fmtCoord(cab.lat)}, ${fmtCoord(cab.lng)}`));
  if (pending) return;

  const logText = $('#log-text');
  logText.value = draft;
  if (hadFocus) logText.focus();
  $('#btn-edit').addEventListener('click', () => openForm({ mode: 'edit', cab }));
  $('#btn-move').addEventListener('click', () => moveCabinet(cab));
  $('#btn-delete').addEventListener('click', () => deleteCabinet(cab));
  $('#btn-photo')?.addEventListener('click', () => $('#photo-input').click());
  $('#log-form').addEventListener('submit', (e) => { e.preventDefault(); addLog(cab); });
  sheet.querySelectorAll('[data-photo]').forEach((b) => b.addEventListener('click', () => deletePhoto(cab, b.dataset.photo)));
  sheet.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => openViewer(cab, b.dataset.view)));
  loadLocalPhotos(sheet);
  sheet.querySelectorAll('[data-log]').forEach((b) => b.addEventListener('click', () => deleteLog(cab, b.dataset.log)));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Coordinate copiate');
  } catch {
    window.prompt('Copia le coordinate:', text);
  }
}

async function addLog(cab) {
  const text = $('#log-text').value.trim();
  if (!text) return;
  try {
    const { data } = await api(`/api/cabinets/${cab.id}/log`, { method: 'POST', body: { text } });
    $('#log-text').value = '';
    upsertCabinet(data);
  } catch (err) {
    toast(isNetworkError(err) ? 'Sei offline: la nota non è stata salvata' : err.message, true);
  }
}

async function deleteLog(cab, logId) {
  if (!confirm('Eliminare questa nota dal diario?')) return;
  try {
    upsertCabinet((await api(`/api/cabinets/${cab.id}/log/${logId}`, { method: 'DELETE' })).data);
  } catch (err) {
    toast(isNetworkError(err) ? 'Sei offline, riprova più tardi' : err.message, true);
  }
}

async function deleteCabinet(cab) {
  if (!confirm(`Eliminare definitivamente "${cabinetTitle(cab)}" per tutta la squadra?`)) return;
  try {
    await api(`/api/cabinets/${cab.id}`, { method: 'DELETE' });
    state.localChanges += 1;
    state.cabinets = state.cabinets.filter((c) => c.id !== cab.id);
    state.etag = null;
    saveCache();
    closeDetail();
    renderAll();
    toast('Cabina eliminata');
  } catch (err) {
    toast(isNetworkError(err) ? 'Sei offline, riprova più tardi' : err.message, true);
  }
}

// ---------------------------------------------------------------------------
// Foto (ridimensionate sul telefono prima dell'invio)
// ---------------------------------------------------------------------------

$('#photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const cab = getCabinet(state.selectedId);
  if (!file || !cab?.id) return;
  toast('Caricamento foto…', false, 60000);
  try {
    const blob = await resizeImage(file, 1600, 0.82);
    upsertCabinet((await api(`/api/cabinets/${cab.id}/photos`, { method: 'POST', body: blob })).data);
    toast('Foto aggiunta');
  } catch (err) {
    toast(isNetworkError(err) ? 'Caricamento non riuscito, controlla la connessione' : err.message, true);
  }
});

function photoUrl(cabId, photoId) {
  return `/api/cabinets/${encodeURIComponent(cabId)}/photos/${encodeURIComponent(photoId)}`;
}

// Con il server la foto ha un indirizzo; in prova sul telefono la si legge dall'archivio locale.
function photoAttr(cabId, photoId) {
  return LOCAL ? `data-local-photo="${esc(cabId)}/${esc(photoId)}"` : `src="${photoUrl(cabId, photoId)}"`;
}

function loadLocalPhotos(root) {
  if (!LOCAL) return;
  root.querySelectorAll('img[data-local-photo]').forEach((img) => {
    const [cabId, photoId] = img.dataset.localPhoto.split('/');
    LocalApi.photoUrl(cabId, photoId).then((url) => { if (url) img.src = url; }).catch(() => {});
  });
}

// Visore a schermo intero, con scorrimento tra le foto della cabina.
const viewer = { cab: null, index: 0 };

async function openViewer(cab, photoId) {
  viewer.cab = cab;
  viewer.index = Math.max(0, cab.photos.findIndex((p) => p.id === photoId));
  $('#viewer').hidden = false;
  await showViewerPhoto();
}

async function showViewerPhoto() {
  const { cab, index } = viewer;
  const p = cab?.photos[index];
  if (!p) return closeViewer();
  const img = $('#viewer-img');
  img.removeAttribute('src');
  img.src = LOCAL ? (await LocalApi.photoUrl(cab.id, p.id)) || '' : photoUrl(cab.id, p.id);
  $('#viewer-caption').textContent = `Foto ${index + 1} di ${cab.photos.length} · ${p.by} · ${fmtDate(p.at)}`;
  $('#viewer-prev').hidden = cab.photos.length < 2;
  $('#viewer-next').hidden = cab.photos.length < 2;
}

function stepViewer(delta) {
  const n = viewer.cab.photos.length;
  viewer.index = (viewer.index + delta + n) % n;
  showViewerPhoto();
}

function closeViewer() {
  $('#viewer').hidden = true;
  $('#viewer-img').removeAttribute('src');
  viewer.cab = null;
}

$('#viewer-close').addEventListener('click', closeViewer);
$('#viewer-prev').addEventListener('click', () => stepViewer(-1));
$('#viewer-next').addEventListener('click', () => stepViewer(1));
$('#viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer') closeViewer(); });
// Scorrimento col dito tra una foto e l'altra.
let swipeX = null;
$('#viewer').addEventListener('touchstart', (e) => { swipeX = e.touches[0].clientX; }, { passive: true });
$('#viewer').addEventListener('touchend', (e) => {
  if (swipeX === null || !viewer.cab || viewer.cab.photos.length < 2) return;
  const dx = e.changedTouches[0].clientX - swipeX;
  swipeX = null;
  if (Math.abs(dx) > 50) stepViewer(dx < 0 ? 1 : -1);
}, { passive: true });

async function resizeImage(file, maxSide, quality) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new ImageError('Formato immagine non supportato');
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new ImageError('Conversione immagine non riuscita'))), 'image/jpeg', quality);
  });
}

async function deletePhoto(cab, photoId) {
  if (!confirm('Eliminare questa foto?')) return;
  try {
    upsertCabinet((await api(`/api/cabinets/${cab.id}/photos/${photoId}`, { method: 'DELETE' })).data);
  } catch (err) {
    toast(isNetworkError(err) ? 'Sei offline, riprova più tardi' : err.message, true);
  }
}

// ---------------------------------------------------------------------------
// Aggiunta e modifica
// ---------------------------------------------------------------------------

$('#btn-add').addEventListener('click', () => $('#add-dialog').showModal());

$('#add-dialog').addEventListener('close', async () => {
  const choice = $('#add-dialog').returnValue;
  $('#add-dialog').returnValue = '';
  if (choice === 'gps') {
    toast('Rilevamento posizione GPS…', false, 20000);
    try {
      const pos = await accuratePosition();
      $('#toast').hidden = true;
      map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 18));
      openForm({ mode: 'create', lat: pos.lat, lng: pos.lng, accuracy: Math.round(pos.accuracy) });
    } catch (err) {
      toast(err.message, true, 6000);
    }
  } else if (choice === 'map') {
    closeDetail();
    if (state.position && map.getZoom() < 16) map.setView([state.position.lat, state.position.lng], 18);
    const ll = await pickLocation('Sposta la mappa per mettere il mirino sulla cabina');
    if (ll) openForm({ mode: 'create', lat: ll.lat, lng: ll.lng, accuracy: null });
  }
});

function pickLocation(text) {
  return new Promise((resolve) => {
    setFollow(false);
    state.pick = resolve;
    $('#pick-text').textContent = text;
    $('#crosshair').hidden = false;
    $('#pick-bar').hidden = false;
    $('#fabs').hidden = true;
    $('#sheet').hidden = true;
    $('#top').hidden = true;
    closeLayersMenu();
    if (!isDesktop()) toggleList(false);
  });
}

function endPick(result) {
  const resolve = state.pick;
  state.pick = null;
  $('#crosshair').hidden = true;
  $('#pick-bar').hidden = true;
  $('#fabs').hidden = false;
  $('#top').hidden = false;
  if (state.selectedId) renderDetail();
  resolve?.(result);
}
$('#pick-cancel').addEventListener('click', () => endPick(null));
$('#pick-confirm').addEventListener('click', () => endPick(map.getCenter()));

async function moveCabinet(cab) {
  map.setView([cab.lat, cab.lng], Math.max(map.getZoom(), 18));
  const ll = await pickLocation(`Metti il mirino sulla nuova posizione di "${cabinetTitle(cab)}"`);
  if (!ll) return;
  try {
    const { data } = await api(`/api/cabinets/${cab.id}`, {
      method: 'PUT',
      body: { lat: ll.lat, lng: ll.lng, accuracy: null, baseUpdatedAt: cab.updatedAt },
    });
    upsertCabinet(data);
    toast('Posizione aggiornata');
  } catch (err) {
    handleSaveError(err);
  }
}

function openForm(opts) {
  const form = $('#cabinet-form');
  const dialog = $('#form-dialog');
  state.form = opts;
  form.reset();
  $('#form-error').textContent = '';
  const cab = opts.cab;
  const lat = cab ? cab.lat : opts.lat;
  const lng = cab ? cab.lng : opts.lng;
  const accuracy = cab ? cab.accuracy : opts.accuracy;
  $('#form-title').textContent = cab ? 'Modifica cabina' : 'Nuova cabina';
  $('#form-position').textContent = `Posizione: ${fmtCoord(lat)}, ${fmtCoord(lng)}` + (accuracy ? ` (±${accuracy} m)` : '');
  const warn = $('#form-warning');
  warn.hidden = !(opts.mode === 'create' && accuracy && accuracy > LOW_ACCURACY_M);
  warn.textContent = `Il GPS è impreciso (±${accuracy} m). Dopo aver salvato puoi correggere il punto con "Sposta".`;
  if (cab) {
    form.code.value = cab.code;
    form.type.value = cab.type;
    form.status.value = cab.status;
    form.address.value = cab.address;
    form.notes.value = cab.notes;
  } else {
    form.type.value = load('cabine.lastType') || 'PFP';
    form.status.value = 'da_fare';
  }
  dialog.showModal();
  if (!cab) reverseGeocode(lat, lng, true);
}

$('#form-cancel').addEventListener('click', () => $('#form-dialog').close());

$('#btn-geocode').addEventListener('click', () => {
  const f = state.form;
  if (f) reverseGeocode(f.cab ? f.cab.lat : f.lat, f.cab ? f.cab.lng : f.lng, false);
});

let geocodeSeq = 0;
async function reverseGeocode(lat, lng, onlyIfEmpty) {
  const input = $('#cabinet-form').address;
  const seq = ++geocodeSeq;
  const btn = $('#btn-geocode');
  btn.disabled = true;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=it&lat=${lat}&lon=${lng}`;
    const data = await (await fetch(url)).json();
    if (seq !== geocodeSeq || (onlyIfEmpty && input.value.trim())) return;
    const a = data.address || {};
    const street = a.road || a.pedestrian || a.footway || a.path || a.square || '';
    const city = a.city || a.town || a.village || a.hamlet || a.municipality || '';
    const prov = (a['ISO3166-2-lvl6'] || '').replace(/^IT-/, '');
    const text = [[street, a.house_number].filter(Boolean).join(' '), [city, prov && `(${prov})`].filter(Boolean).join(' ')]
      .filter(Boolean).join(', ');
    if (text) input.value = text;
    else if (!onlyIfEmpty) toast('Indirizzo non trovato');
  } catch {
    if (!onlyIfEmpty) toast('Ricerca indirizzo non disponibile', true);
  } finally {
    if (seq === geocodeSeq) btn.disabled = false;
  }
}

$('#cabinet-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const opts = state.form;
  const fields = {
    code: form.code.value,
    type: form.type.value,
    status: form.status.value,
    address: form.address.value,
    notes: form.notes.value,
  };
  store('cabine.lastType', fields.type);
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    if (opts.mode === 'edit') {
      const { data } = await api(`/api/cabinets/${opts.cab.id}`, {
        method: 'PUT',
        body: { ...fields, baseUpdatedAt: opts.cab.updatedAt },
      });
      upsertCabinet(data);
      $('#form-dialog').close();
      toast('Modifiche salvate');
    } else {
      const item = { ...fields, lat: opts.lat, lng: opts.lng, accuracy: opts.accuracy, clientId: newClientId() };
      try {
        const { data } = await api('/api/cabinets', { method: 'POST', body: item });
        upsertCabinet(data);
        $('#form-dialog').close();
        openDetail(data.id);
        toast('Cabina salvata per tutta la squadra');
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        state.pending.push(item);
        saveJson('cabine.pending', state.pending);
        $('#form-dialog').close();
        renderAll();
        openDetail(item.clientId);
        toast('Sei offline: cabina salvata sul telefono, verrà inviata appena torna la connessione', false, 6000);
      }
    }
  } catch (err) {
    if (err.status === 409) {
      $('#form-dialog').close();
      handleSaveError(err);
    } else {
      $('#form-error').textContent = isNetworkError(err) ? 'Sei offline: le modifiche non sono state salvate' : err.message;
    }
  } finally {
    submit.disabled = false;
  }
});

function handleSaveError(err) {
  if (err.status === 409 && err.data?.cabinet) {
    upsertCabinet(err.data.cabinet);
    toast(err.message, true, 7000);
  } else {
    toast(isNetworkError(err) ? 'Sei offline: modifica non salvata' : err.message, true);
  }
}

// ---------------------------------------------------------------------------
// Percorsi in auto e a piedi, navigazione passo passo
// ---------------------------------------------------------------------------

const ARRIVE_M = 25;
const REROUTE_EVERY_MS = 10000;

function maneuverSvg(name) {
  const right = name.endsWith('-r');
  return `<svg class="ico${right ? ' flip' : ''}"><use href="#m-${name.replace(/-r$/, '')}"/></svg>`;
}

function navZoom() {
  return nav.mode === 'car' ? 17 : 18;
}

function clockIn(seconds) {
  return new Date(Date.now() + seconds * 1000).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

async function openRoute(id) {
  const cab = getCabinet(id);
  if (!cab) return;
  nav.cabId = id;
  nav.mode = load('cabine.mode') === 'foot' ? 'foot' : 'car';
  nav.routes = {};
  nav.errors = {};
  setFollow(false);
  closeLayersMenu();
  if (!isDesktop()) toggleList(false);
  document.body.classList.add('routing');
  $('#sheet').hidden = true;
  $('#fabs').hidden = false;
  $('#top').hidden = true;
  $('#btn-layers').hidden = true;
  $('#route-dest').textContent = cabinetTitle(cab);
  $('#route-top').hidden = false;
  $('#route-panel').hidden = false;
  renderRoute();

  let from = state.position;
  if (!from) {
    try {
      from = await getPosition();
      startWatch();
    } catch (err) {
      if (nav.cabId !== id) return;
      nav.errors = { car: err.message, foot: err.message };
      renderRoute();
      return;
    }
  }
  if (nav.cabId !== id) return;
  await computeRoutes(from, ['car', 'foot']);
  if (nav.cabId === id && !nav.active) fitRoute();
}

async function computeRoutes(from, modes) {
  nav.abort?.abort();
  const ctrl = new AbortController();
  nav.abort = ctrl;
  const cab = getCabinet(nav.cabId);
  await Promise.all(modes.map(async (mode) => {
    try {
      nav.routes[mode] = await Routing.fetchRoute(mode, from, cab, ctrl.signal);
      delete nav.errors[mode];
    } catch (err) {
      if (err.name === 'AbortError') return;
      const message = navigator.onLine === false ? 'Sei offline: impossibile calcolare il percorso' : err.message;
      if (nav.active && nav.routes[mode]) {
        // In navigazione meglio il percorso di prima che nessun percorso.
        toast(`Ricalcolo non riuscito: ${message}`, true);
      } else {
        nav.routes[mode] = null;
        nav.errors[mode] = message;
      }
    }
    if (ctrl.signal.aborted || !nav.cabId) return;
    if (nav.active) renderNav();
    else renderRoute();
    drawRoute();
  }));
}

function renderRoute() {
  const cab = getCabinet(nav.cabId);
  if (!cab) return;
  for (const mode of ['car', 'foot']) {
    const r = nav.routes[mode];
    $(`.mode[data-mode="${mode}"]`).setAttribute('aria-selected', String(mode === nav.mode));
    $(`[data-time="${mode}"]`).textContent = r ? Routing.fmtDuration(r.duration) : nav.errors[mode] ? '–' : '…';
  }
  const panel = $('#route-panel');
  const stepsOpen = $('details', panel)?.open || false;
  const r = nav.routes[nav.mode];
  const err = nav.errors[nav.mode];
  const dest = `${cab.lat},${cab.lng}`;
  const external = `
    <a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=${nav.mode === 'car' ? 'driving' : 'walking'}" target="_blank" rel="noopener">${icon('nav')} Google Maps</a>
    ${nav.mode === 'car' ? `<a class="btn" href="https://waze.com/ul?ll=${dest}&navigate=yes" target="_blank" rel="noopener">${icon('nav')} Waze</a>` : ''}`;
  const how = nav.mode === 'car' ? 'In auto' : 'A piedi';

  if (r) {
    panel.innerHTML = `
      <div class="route-summary">
        <span class="route-time">${Routing.fmtDuration(r.duration)}</span>
        <span class="muted">(${fmtDistance(r.distance)})</span>
      </div>
      <p class="muted small">${how} · arrivo previsto alle ${clockIn(r.duration)}</p>
      <div class="route-actions">
        <button class="btn btn-route" id="btn-start" type="button">${icon('nav')} Avvia</button>
        ${external}
      </div>
      <details${stepsOpen ? ' open' : ''}>
        <summary>Passaggi (${r.steps.length})</summary>
        <ol class="steps">
          ${r.steps.map((s) => `<li>${maneuverSvg(s.icon)}<div><div>${esc(s.text)}</div>${s.distance ? `<div class="step-dist">${fmtDistance(s.distance)}</div>` : ''}</div></li>`).join('')}
        </ol>
      </details>`;
    $('#btn-start').addEventListener('click', startNav);
  } else if (err) {
    const straight = state.position ? `<p class="muted small">In linea d'aria: ${fmtDistance(distance(state.position, cab))}</p>` : '';
    panel.innerHTML = `
      <p class="warning small">${esc(err)}</p>
      ${straight}
      <p class="muted small">Puoi comunque farti guidare dall'app di navigazione.</p>
      <div class="route-actions">${external}</div>`;
  } else {
    panel.innerHTML = `
      <p><span class="spinner"></span> Calcolo del percorso ${nav.mode === 'car' ? 'in auto' : 'a piedi'}…</p>
      <div class="route-actions">${external}</div>`;
  }
}

function drawRoute() {
  routeLayer.clearLayers();
  const r = nav.routes[nav.mode];
  const cab = getCabinet(nav.cabId);
  if (!r || !cab) return;
  const line = r.coords.map((c) => [c.lat, c.lng]);
  if (nav.mode === 'car') {
    L.polyline(line, { color: '#1557b0', weight: 10, opacity: 1, lineJoin: 'round', interactive: false }).addTo(routeLayer);
    L.polyline(line, { color: '#1a73e8', weight: 7, opacity: 1, lineJoin: 'round', interactive: false }).addTo(routeLayer);
  } else {
    L.polyline(line, { color: '#1a73e8', weight: 7, opacity: 1, dashArray: '0 12', lineCap: 'round', interactive: false }).addTo(routeLayer);
  }
  // Ultimo tratto: dalla fine della strada fino alla cabina.
  const end = r.coords[r.coords.length - 1];
  if (Routing.haversine(end, cab) > 5) {
    L.polyline([[end.lat, end.lng], [cab.lat, cab.lng]], { color: '#5f6368', weight: 3, dashArray: '2 8', interactive: false }).addTo(routeLayer);
  }
}

function fitRoute() {
  const cab = getCabinet(nav.cabId);
  if (!cab) return;
  const r = nav.routes[nav.mode];
  const points = r ? r.coords.map((c) => [c.lat, c.lng]) : [];
  points.push([cab.lat, cab.lng]);
  if (state.position) points.push([state.position.lat, state.position.lng]);
  const desktop = isDesktop();
  const top = desktop ? 20 : $('#route-top').offsetHeight + 20;
  const bottom = desktop ? 20 : $('#route-panel').offsetHeight + 20;
  map.fitBounds(L.latLngBounds(points), {
    paddingTopLeft: [desktop ? 440 : 30, top],
    paddingBottomRight: [30, bottom],
    maxZoom: 17,
  });
}

document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => {
  nav.mode = b.dataset.mode;
  store('cabine.mode', nav.mode);
  renderRoute();
  drawRoute();
  fitRoute();
}));

$('#route-back').addEventListener('click', () => closeRoute());

function closeRoute() {
  stopNav();
  nav.abort?.abort();
  const id = nav.cabId;
  nav.cabId = null;
  nav.routes = {};
  nav.errors = {};
  routeLayer.clearLayers();
  document.body.classList.remove('routing');
  $('#route-top').hidden = true;
  $('#route-panel').hidden = true;
  $('#top').hidden = false;
  $('#btn-layers').hidden = false;
  if (id && getCabinet(id)) openDetail(id);
}

function startNav() {
  if (!nav.routes[nav.mode]) return;
  nav.active = true;
  nav.lastReroute = Date.now();
  document.body.classList.add('navigating');
  $('#route-top').hidden = true;
  $('#route-panel').hidden = true;
  $('#nav-banner').hidden = false;
  $('#nav-bottom').hidden = false;
  setFollow(true);
  if (state.position) map.setView([state.position.lat, state.position.lng], navZoom());
  requestWakeLock();
  renderNav();
}

function stopNav() {
  if (!nav.active) return;
  nav.active = false;
  document.body.classList.remove('navigating');
  $('#nav-banner').hidden = true;
  $('#nav-bottom').hidden = true;
  releaseWakeLock();
  setFollow(false);
}

function onNavPosition() {
  const r = nav.routes[nav.mode];
  const cab = getCabinet(nav.cabId);
  if (!r || !cab) return;
  const pos = state.position;
  const p = Routing.progress(r, pos);
  const toCab = distance(pos, cab);
  // Arrivati: vicini alla cabina, oppure a fine percorso quando il GPS è poco preciso.
  if (toCab <= ARRIVE_M || (p.remaining < 20 && toCab <= Math.min(Math.max(ARRIVE_M, pos.accuracy || 0), 60))) {
    toast(`Sei arrivato: ${cabinetTitle(cab)}`, false, 5000);
    closeRoute();
    return;
  }
  // Fuori strada: ricalcola il percorso dalla posizione attuale (al massimo ogni 10 secondi).
  const limit = Math.max(nav.mode === 'car' ? 50 : 30, pos.accuracy || 0);
  if (p.offRoute > limit && !nav.rerouting && Date.now() - nav.lastReroute > REROUTE_EVERY_MS) {
    nav.lastReroute = Date.now();
    nav.rerouting = true;
    renderNav(p);
    computeRoutes(pos, [nav.mode]).finally(() => {
      nav.rerouting = false;
      if (nav.active) renderNav();
    });
    return;
  }
  renderNav(p);
}

function renderNav(p) {
  const r = nav.routes[nav.mode];
  if (!r) return;
  if (!p) p = state.position ? Routing.progress(r, state.position) : Routing.progress(r, r.coords[0]);
  const next = p.next || { icon: 'flag', text: `Prosegui verso ${cabinetTitle(getCabinet(nav.cabId) || {})}` };
  $('#nav-banner').innerHTML = nav.rerouting
    ? '<span class="spinner"></span><div class="nav-text">Ricalcolo del percorso…</div>'
    : `${maneuverSvg(next.icon)}<div><div class="nav-dist">${fmtDistance(p.toNext)}</div><div class="nav-text">${esc(next.text)}</div></div>`;
  $('#nav-bottom').innerHTML = `
    <div>
      <span class="route-time">${Routing.fmtDuration(p.remainingTime)}</span>
      <div class="muted small">${fmtDistance(p.remaining)} · arrivo alle ${clockIn(p.remainingTime)}</div>
    </div>
    <button class="btn" id="nav-exit" type="button">Esci</button>`;
  $('#nav-exit').addEventListener('click', () => {
    stopNav();
    $('#route-top').hidden = false;
    $('#route-panel').hidden = false;
    renderRoute();
    fitRoute();
  });
}

// Durante la navigazione lo schermo resta acceso.
async function requestWakeLock() {
  if (NATIVE?.keepScreenOn) {
    NATIVE.keepScreenOn(true);
    return;
  }
  try {
    nav.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    nav.wakeLock = null;
  }
}

function releaseWakeLock() {
  if (NATIVE?.keepScreenOn) NATIVE.keepScreenOn(false);
  nav.wakeLock?.release().catch(() => {});
  nav.wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && nav.active) requestWakeLock();
});

// ---------------------------------------------------------------------------
// Menu ed esportazioni
// ---------------------------------------------------------------------------

$('#btn-menu').addEventListener('click', () => $('#menu-dialog').showModal());

$('#menu-dialog').addEventListener('close', async () => {
  const choice = $('#menu-dialog').returnValue;
  $('#menu-dialog').returnValue = '';
  if (choice === 'settings') {
    NATIVE?.openSettings();
  } else if (choice === 'logout') {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* offline */ }
    clearTimeout(cacheTimer);
    cacheTimer = null;
    store('cabine.cache', null);
    store('cabine.me', null);
    state.cabinets = [];
    state.etag = null;
    closeDetail();
    renderAll();
    showLogin();
  } else if (choice === 'csv') {
    exportCsv();
  } else if (choice === 'kml') {
    exportKml();
  } else if (choice === 'geojson') {
    exportGeoJson();
  }
});

function download(name, content, type) {
  if (NATIVE?.shareFile) {
    NATIVE.shareFile(name, type.split(';')[0], content);
    return;
  }
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportName(ext) {
  return `cabine-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

function exportCsv() {
  const cols = ['codice', 'tipo', 'stato', 'latitudine', 'longitudine', 'indirizzo', 'note', 'aggiunta_da', 'aggiunta_il', 'modificata_da', 'modificata_il', 'google_maps'];
  const cell = (v) => {
    const s = String(v ?? '');
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Un testo che inizia con = + - @ verrebbe eseguito da Excel come formula.
  const text = (v) => (/^[=+\-@\t\r]/.test(v || '') ? `'${v}` : v);
  const rows = state.cabinets.map((c) => [
    text(c.code), TYPE_LABELS[c.type], STATUS_LABELS[c.status], fmtCoord(c.lat), fmtCoord(c.lng), text(c.address), text(c.notes),
    text(c.createdBy), fmtDate(c.createdAt), text(c.updatedBy), fmtDate(c.updatedAt), `https://www.google.com/maps?q=${c.lat},${c.lng}`,
  ].map(cell).join(';'));
  // BOM e punto e virgola: così Excel in italiano apre il file correttamente.
  download(exportName('csv'), '﻿' + [cols.join(';'), ...rows].join('\r\n'), 'text/csv;charset=utf-8');
}

function exportGeoJson() {
  const fc = {
    type: 'FeatureCollection',
    features: state.cabinets.map((c) => {
      const { lat, lng, ...props } = c;
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props };
    }),
  };
  download(exportName('geojson'), JSON.stringify(fc, null, 2), 'application/geo+json');
}

function exportKml() {
  const x = (s) => esc(s);
  // Le colonne in ExtendedData permettono di reimportare il file senza perdere stato e indirizzo.
  const data = (name, value) => `<Data name="${name}"><value>${x(value)}</value></Data>`;
  const placemarks = state.cabinets.map((c) => `
  <Placemark>
    <name>${x(cabinetTitle(c))}</name>
    <description>${x([TYPE_LABELS[c.type], STATUS_LABELS[c.status], c.address, c.notes].filter(Boolean).join('\n'))}</description>
    <ExtendedData>${data('codice', c.code)}${data('tipo', c.type)}${data('stato', c.status)}${data('indirizzo', c.address)}${data('note', c.notes)}</ExtendedData>
    <Point><coordinates>${c.lng},${c.lat},0</coordinates></Point>
  </Placemark>`).join('');
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Cabine fibra</name>${placemarks}
</Document>
</kml>`;
  download(exportName('kml'), kml, 'application/vnd.google-earth.kml+xml');
}

// ---------------------------------------------------------------------------
// Importazione da Google My Maps, Google Earth o GeoJSON
// ---------------------------------------------------------------------------

const importState = { name: '', points: [], groupings: {}, grouping: 'layers', unchecked: new Set(), busy: false };
const IMPORT_BATCH = 500; // punti per richiesta: con molti punti si va a blocchi

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const normName = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

// Le versioni dell'app Android precedenti alla 0.1.9 sanno scegliere solo foto.
function apkTooOld() {
  const m = navigator.userAgent.match(/CabineFibraApp\/0\.1\.(\d+)/);
  return Boolean(m) && Number(m[1]) < 9;
}

function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').hidden = true;
}

$('#menu-import').addEventListener('click', () => {
  $('#menu-dialog').close();
  if (apkTooOld()) {
    toast('Per importare i file KML o KMZ aggiorna l\'app Cabine Fibra all\'ultima versione', true, 7000);
    return;
  }
  const input = $('#import-input');
  input.value = '';
  input.click();
});

$('#import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  toast('Leggo il file…', false, 60000);
  try {
    const data = await CabineImport.readFile(file);
    if (!data.points.length) {
      toast(data.skipped.notPoint ? 'Nel file ci sono solo linee o aree: nessun punto da importare'
        : 'Nel file non ci sono punti da importare', true, 6000);
      return;
    }
    hideToast();
    openImport(data);
  } catch (err) {
    toast(err instanceof CabineImport.ImportError ? err.message : 'Il file non si riesce a leggere', true, 8000);
  } finally {
    e.target.value = '';
  }
});

// Cabine vicine a un punto: indice a celle di circa 10 m, per non confrontare tutto con tutto.
function nearIndex(list) {
  const cell = (lat, lng) => `${Math.floor(lat * 1e4)}|${Math.floor(lng * 1e4)}`;
  const grid = new Map();
  for (const c of list) {
    const k = cell(c.lat, c.lng);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(c);
  }
  return (p, meters, match = () => true) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const near = grid.get(cell(p.lat + dy * 1e-4, p.lng + dx * 1e-4)) || [];
        if (near.some((c) => distance(c, p) < meters && match(c))) return true;
      }
    }
    return false;
  };
}

// Già nell'archivio: importato prima (stesso identificativo, o un punto dello stesso tipo
// importato a meno di 2 m, cioè solo rinominato su My Maps), con lo stesso nome a meno di
// 50 m oppure, se senza nome, con un'altra cabina a meno di 3 m.
function markPresent(points) {
  const ids = new Set(state.cabinets.map((c) => c.clientId).filter(Boolean));
  const nearImported = nearIndex(state.cabinets.filter((c) => c.clientId?.startsWith('imp-')));
  const nearAny = nearIndex(state.cabinets);
  const byName = new Map();
  for (const c of state.cabinets) {
    const key = normName(c.code);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(c);
  }
  const sameName = (key, p) => Boolean(key) && (byName.get(key) || []).some((c) => distance(c, p) < 50);
  for (const p of points) {
    p.present = ids.has(p.clientId) || nearImported(p, 2, (c) => !p.type || c.type === p.type) || sameName(normName(p.code), p)
      || sameName(normName(p.idName), p) || (!p.code && nearAny(p, 3));
  }
}

function openImport(data) {
  const form = $('#import-form');
  importState.name = data.name;
  importState.points = data.points;
  importState.groupings = data.groupings;
  importState.grouping = data.defaultGrouping;
  importState.unchecked = new Set();
  importState.busy = false;
  markPresent(importState.points);

  // Tipo proposto: quello scritto nei nomi della maggior parte dei punti, altrimenti quello
  // che si capisce dai nomi dei livelli o della mappa.
  const most = (values) => [...values.reduce((m, v) => (v ? m.set(v, (m.get(v) || 0) + 1) : m), new Map())]
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  form.type.innerHTML = Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  form.type.value = most(data.points.map((p) => p.type))
    || most(data.points.map((p) => CabineImport.guessType(p.folder))) || CabineImport.guessType(data.name) || 'ALTRO';
  form.status.innerHTML = Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  form.status.value = 'da_fare';

  const notes = [`«${data.name}»`, plural(data.points.length, 'punto', 'punti')];
  if (data.skipped.notPoint) notes.push(`${plural(data.skipped.notPoint, 'linea o area', 'linee o aree')} da non importare`);
  if (data.skipped.invalid) notes.push(`${plural(data.skipped.invalid, 'punto', 'punti')} senza coordinate valide`);
  $('#import-source').textContent = notes.join(' · ');
  $('#import-error').textContent = '';
  renderImportGroups();
  setImportBusy(false);
  $('#import-dialog').showModal();
  $('#import-groups').scrollTop = 0;
}

function renderImportGroups() {
  const key = importState.grouping;
  const both = Boolean(importState.groupings.layers && importState.groupings.codes);
  $('#import-grouping').hidden = !both;
  document.querySelectorAll('#import-grouping [data-grouping]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.grouping === key)));
  const present = new Map();
  for (const p of importState.points) if (p.present) present.set(p.groups[key], (present.get(p.groups[key]) || 0) + 1);
  $('#import-groups').innerHTML = importState.groupings[key].map((g) => {
    const already = present.get(g.name) || 0;
    return `<label class="import-group">
      <input type="checkbox" data-group="${esc(g.name)}"${importState.unchecked.has(g.name) ? '' : ' checked'}>
      <span class="import-group-text">
        <span class="import-group-name">${esc(g.name)}</span>
        <span class="import-group-count">${plural(g.count, 'punto', 'punti')}${already ? ` · ${already === g.count ? 'già tutti presenti' : `${already} già ${already === 1 ? 'presente' : 'presenti'}`}` : ''}</span>
      </span>
    </label>`;
  }).join('');
  updateImportSummary();
}

// Cosa verrà importato: i punti dei gruppi scelti che non ci sono già (né due volte nel file).
function importPlan() {
  const key = importState.grouping;
  const selected = importState.points.filter((p) => !importState.unchecked.has(p.groups[key]));
  const seen = new Set();
  const fresh = [];
  for (const p of selected) {
    if (p.present || seen.has(p.clientId)) continue;
    seen.add(p.clientId);
    fresh.push(p);
  }
  return { selected, fresh, skip: selected.length - fresh.length };
}

function updateImportSummary() {
  const form = $('#import-form');
  const { selected, fresh, skip } = importPlan();
  const own = fresh.filter((p) => p.type && p.type !== form.type.value);
  $('#import-type-note').textContent = own.length
    ? `${own.length === 1 ? '1 punto ha' : `${own.length} punti hanno`} un altro tipo scritto nel nome o nella tabella `
      + `(es. ${TYPE_LABELS[own[0].type].split(' – ')[0]}) e lo tiene${own.length === 1 ? '' : 'no'}.`
    : '';
  let text;
  if (fresh.length) {
    text = fresh.length === 1 ? 'Verrà aggiunta 1 cabina' : `Verranno aggiunte ${fresh.length} cabine`;
    if (skip) text += ` · ${plural(skip, 'c\'è già e viene saltata', 'ci sono già e vengono saltate')}`;
    text += '.';
  } else {
    text = selected.length ? 'Le cabine scelte ci sono già tutte.' : 'Scegli almeno un gruppo.';
  }
  $('#import-summary').textContent = text;
  const go = $('#import-go');
  go.disabled = importState.busy || !fresh.length;
  if (!importState.busy) go.textContent = fresh.length ? `Importa ${fresh.length}` : 'Importa';
}

function setImportBusy(busy) {
  importState.busy = busy;
  document.querySelectorAll('#import-form input, #import-form select, #import-form button').forEach((el) => {
    if (el.id !== 'import-go') el.disabled = busy;
  });
  updateImportSummary();
}

$('#import-groups').addEventListener('change', (e) => {
  const box = e.target.closest('[data-group]');
  if (!box) return;
  if (box.checked) importState.unchecked.delete(box.dataset.group);
  else importState.unchecked.add(box.dataset.group);
  updateImportSummary();
});
$('#import-grouping').addEventListener('click', (e) => {
  const b = e.target.closest('[data-grouping]');
  if (!b || b.dataset.grouping === importState.grouping) return;
  importState.grouping = b.dataset.grouping;
  importState.unchecked = new Set();
  renderImportGroups();
});
$('#import-form').type.addEventListener('change', updateImportSummary);
$('#import-all').addEventListener('click', () => {
  importState.unchecked = new Set();
  renderImportGroups();
});
$('#import-none').addEventListener('click', () => {
  importState.unchecked = new Set(importState.groupings[importState.grouping].map((g) => g.name));
  renderImportGroups();
});
// Invio su una casella non deve chiudere né confermare la finestra.
$('#import-form').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') e.preventDefault();
});
// Durante l'invio la finestra resta aperta (anche con Esc o con il tasto Indietro).
$('#import-dialog').addEventListener('cancel', (e) => {
  if (importState.busy) e.preventDefault();
});

function importErrorMessage(err) {
  if (err instanceof ApiError) return err.status === 413 ? 'Troppi dati in una volta: importa meno gruppi alla volta' : err.message;
  return LOCAL ? 'Salvataggio sul telefono non riuscito' : 'Serve la connessione per importare: riprova quando c\'è campo';
}

// Dopo l'importazione si vedono le cabine nuove: via filtri e ricerca che le nasconderebbero.
function showImported(list) {
  if (searchInput.value || $('#filter-type').value || state.filterStatus) {
    clearTimeout(searchTimer);
    searchInput.value = '';
    $('#search-clear').hidden = true;
    $('#filter-type').value = '';
    setStatusFilter('');
  }
  setFollow(false);
  state.userMovedMap = true;
  map.fitBounds(L.latLngBounds(list.map((p) => [p.lat, p.lng])), { padding: [40, 40], maxZoom: 16 });
}

$('#import-form').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'import') return; // Annulla chiude la finestra
  e.preventDefault();
  if (importState.busy) return;
  const form = e.currentTarget;
  const list = importPlan().fresh.map((p) => ({
    clientId: p.clientId,
    code: p.code,
    type: p.type || form.type.value,
    status: p.status || form.status.value,
    lat: p.lat,
    lng: p.lng,
    address: p.address,
    notes: p.notes,
    ...(p.log.length ? { log: p.log } : {}),
  }));
  if (!list.length) return;
  $('#import-error').textContent = '';
  setImportBusy(true);
  let created = 0;
  let existing = 0;
  try {
    for (let i = 0; i < list.length; i += IMPORT_BATCH) {
      $('#import-go').textContent = list.length > IMPORT_BATCH
        ? `Importo… ${Math.min(i + IMPORT_BATCH, list.length)} di ${list.length}` : 'Importo…';
      const { data } = await api('/api/cabinets/import', { method: 'POST', body: { cabinets: list.slice(i, i + IMPORT_BATCH) } });
      created += data.created;
      existing += data.existing;
    }
    setImportBusy(false);
    $('#import-dialog').close();
    state.localChanges += 1;
    state.etag = null;
    showImported(list);
    toast(`${created === 1 ? 'Importata 1 cabina' : `Importate ${created} cabine`}${existing ? ` (${existing} c'${existing === 1 ? 'era' : 'erano'} già)` : ''}`, false, 5000);
    await refresh();
  } catch (err) {
    setImportBusy(false);
    $('#import-error').textContent = (created ? `${plural(created, 'cabina importata', 'cabine importate')} prima dell'errore. ` : '')
      + importErrorMessage(err);
    if (created) {
      // Riprovando, quelle già arrivate vengono riconosciute e saltate.
      state.localChanges += 1;
      state.etag = null;
      refresh().then(() => {
        markPresent(importState.points);
        if ($('#import-dialog').open) renderImportGroups();
      });
    }
  }
});

// Tasto Indietro di Android ed Esc: chiude la cosa aperta più in alto.
// Restituisce false quando non c'è niente da chiudere (l'app Android allora va in secondo piano).
function goBack() {
  const dialog = document.querySelector('dialog[open]');
  if (dialog) {
    if (!(dialog.id === 'import-dialog' && importState.busy)) dialog.close();
    return true;
  }
  if (!$('#viewer').hidden) {
    closeViewer();
    return true;
  }
  if (!$('#layers-menu').hidden) {
    closeLayersMenu();
    return true;
  }
  if (document.activeElement === searchInput) {
    searchInput.blur();
    return true;
  }
  if (state.pick) {
    endPick(null);
    return true;
  }
  if (nav.active) {
    $('#nav-exit')?.click();
    return true;
  }
  if (nav.cabId) {
    closeRoute();
    return true;
  }
  if (state.selectedId) {
    closeDetail();
    return true;
  }
  if (!isDesktop() && $('#list-panel').classList.contains('open')) {
    toggleList(false);
    return true;
  }
  return false;
}
window.cabineBack = () => (state.me ? goBack() : false);

document.addEventListener('keydown', (e) => {
  if (!$('#viewer').hidden && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    stepViewer(e.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  // I dialog si chiudono da soli con Esc.
  if (e.key !== 'Escape' || document.querySelector('dialog[open]') || nav.active) return;
  if (document.activeElement === searchInput) return;
  goBack();
});

// Testi che cambiano tra server di squadra e prova sul telefono.
function setupModeTexts() {
  if (NATIVE) {
    // Anche dalla schermata di accesso si deve poter cambiare server (password sconosciuta,
    // server sbagliato) o passare alla prova sul telefono.
    $('#login-settings').hidden = false;
    $('#login-settings').addEventListener('click', () => NATIVE.openSettings());
    $('#menu-settings').hidden = false;
    $('#export-intro').textContent = 'Condividi una copia di tutte le cabine (WhatsApp, email, Drive…), come backup o per aprirle in altri programmi.';
  }
  if (!LOCAL) return;
  $('#login-intro').textContent = 'Modalità prova: le cabine restano salvate solo su questo telefono. Scrivi il tuo nome per iniziare.';
  $('#login-submit').textContent = 'Inizia';
  $('#mode-note').hidden = false;
  $('#menu-logout').textContent = 'Cambia nome';
}

init();
