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
const LOW_ACCURACY_M = 30;

const $ = (sel, root = document) => root.querySelector(sel);

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
  fitted: Boolean(loadJson('cabine.view', null)),
};

let map;
let markersLayer;
let meMarker;
let meCircle;
const markers = new Map();

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
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* spazio esaurito o archiviazione non disponibile */
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
  const opts = { method, headers: { ...headers }, credentials: 'same-origin', cache: 'no-store' };
  if (body instanceof Blob) {
    opts.body = body;
    opts.headers['Content-Type'] = body.type;
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, opts);
  if (res.status === 304) return { notModified: true };
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && state.me && path !== '/api/login') showLogin();
    throw new ApiError(res.status, data?.error || `Errore ${res.status}`, data);
  }
  return { data, etag: res.headers.get('etag') };
}

// Errore di rete (offline o server irraggiungibile) e non risposta del server.
function isNetworkError(err) {
  return !(err instanceof ApiError) && !(err instanceof ImageError);
}

// ---------------------------------------------------------------------------
// Avvio e accesso
// ---------------------------------------------------------------------------

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    state.config = (await api('/api/config')).data;
  } catch {
    state.config = { passwordRequired: true };
  }
  try {
    state.me = (await api('/api/me')).data;
    startApp();
  } catch (err) {
    // Offline ma con dati salvati: mostriamo comunque l'ultima copia.
    const cachedMe = loadJson('cabine.me', null);
    if (isNetworkError(err) && cachedMe) {
      state.me = cachedMe;
      startApp();
    } else {
      showLogin();
    }
  }
}

function showLogin() {
  state.me = null;
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-password-field').hidden = !state.config?.passwordRequired;
  const form = $('#login-form');
  form.name.value = localStorage.getItem('cabine.lastName') || '';
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
    localStorage.setItem('cabine.lastName', data.name);
    state.me = data;
    startApp();
  } catch (err) {
    $('#login-error').textContent = isNetworkError(err) ? 'Server non raggiungibile, controlla la connessione' : err.message;
  }
});

let started = false;
function startApp() {
  saveJson('cabine.me', state.me);
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#menu-name').textContent = state.me.name;
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
    await flushPending();
    const res = await api('/api/cabinets', { headers: state.etag ? { 'If-None-Match': state.etag } : {} });
    if (!res.notModified) {
      state.cabinets = res.data.cabinets;
      state.etag = res.etag;
      saveJson('cabine.cache', { cabinets: state.cabinets, etag: state.etag });
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
      if (isNetworkError(err)) throw err;
      toast(`Cabina "${cabinetTitle(item)}" non salvata: ${err.message}`, true, 6000);
      state.pending.shift();
    }
    saveJson('cabine.pending', state.pending);
  }
}

function renderSync() {
  const el = $('#sync-status');
  const parts = [];
  if (state.offline) parts.push('Offline');
  else if (state.lastSync) parts.push(`Aggiornato alle ${state.lastSync.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`);
  if (state.pending.length) parts.push(`${state.pending.length} da inviare`);
  el.textContent = parts.join(' · ');
}

function upsertCabinet(cab) {
  const i = state.cabinets.findIndex((c) => c.id === cab.id);
  if (i >= 0) state.cabinets[i] = cab;
  else state.cabinets.push(cab);
  state.etag = null;
  saveJson('cabine.cache', { cabinets: state.cabinets, etag: null });
  renderAll();
}

function getCabinet(id) {
  return state.cabinets.find((c) => c.id === id) || state.pending.find((c) => c.clientId === id);
}

// ---------------------------------------------------------------------------
// Mappa
// ---------------------------------------------------------------------------

function initMap() {
  const saved = loadJson('cabine.view', null);
  map = L.map('map', { zoomControl: false, attributionControl: true });
  const street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });
  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Immagini &copy; Esri, Maxar, Earthstar Geographics',
  });
  const layers = { Mappa: street, Satellite: satellite };
  (layers[localStorage.getItem('cabine.layer')] || street).addTo(map);
  L.control.layers(layers, null, { position: 'topright' }).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);
  map.on('baselayerchange', (e) => localStorage.setItem('cabine.layer', e.name));
  if (saved) map.setView(saved.center, saved.zoom);
  else map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
  // Registrato dopo setView, così la vista predefinita non viene salvata come scelta dell'utente.
  map.on('moveend', () => {
    const c = map.getCenter();
    saveJson('cabine.view', { center: [c.lat, c.lng], zoom: map.getZoom() });
  });
  // Pressione prolungata (o tasto destro) per aggiungere una cabina in quel punto.
  map.on('contextmenu', (e) => {
    if (state.pick) return;
    openForm({ mode: 'create', lat: e.latlng.lat, lng: e.latlng.lng, accuracy: null });
  });
  map.on('click', () => { if (!state.pick && !isDesktop()) closeDetail(); });
  markersLayer = L.layerGroup().addTo(map);
}

// Al primo avvio inquadra tutte le cabine; poi la mappa riparte dall'ultima vista usata.
function fitInitialView() {
  if (state.fitted || !state.cabinets.length) return;
  state.fitted = true;
  map.fitBounds(L.latLngBounds(state.cabinets.map((c) => [c.lat, c.lng])), { padding: [40, 40], maxZoom: 16 });
}

function markerIcon(cab, pending) {
  const cls = pending ? 'pending' : `st-${cab.status}`;
  const selected = (pending ? cab.clientId : cab.id) === state.selectedId ? ' selected' : '';
  return L.divIcon({
    className: `cab-marker${selected}`,
    html: `<span class="badge ${cls}">${esc(TYPE_SHORT[cab.type] || '•')}</span>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
}

function renderMarkers() {
  markersLayer.clearLayers();
  markers.clear();
  const add = (cab, pending) => {
    const id = pending ? cab.clientId : cab.id;
    const marker = L.marker([cab.lat, cab.lng], {
      icon: markerIcon(cab, pending),
      title: cabinetTitle(cab),
      zIndexOffset: id === state.selectedId ? 1000 : 0,
    });
    marker.on('click', () => openDetail(id));
    marker.addTo(markersLayer);
    markers.set(id, marker);
  };
  for (const cab of filteredCabinets()) add(cab, false);
  for (const cab of state.pending) add(cab, true);
}

function updateMyPosition(pos) {
  state.position = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
  const ll = [state.position.lat, state.position.lng];
  if (!meMarker) {
    meCircle = L.circle(ll, { radius: state.position.accuracy, color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
    meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [18, 18] }), interactive: false, keyboard: false }).addTo(map);
  } else {
    meMarker.setLatLng(ll);
    meCircle.setLatLng(ll).setRadius(state.position.accuracy);
  }
  $('#btn-locate').classList.add('active');
  renderList();
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
        reject(new Error(location.protocol === 'http:' && location.hostname !== 'localhost'
          ? 'Il GPS funziona solo se il sito è aperto in HTTPS' : msg));
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });
}

let watchId = null;
$('#btn-locate').addEventListener('click', async () => {
  try {
    const pos = await getPosition();
    map.flyTo([pos.lat, pos.lng], Math.max(map.getZoom(), 17));
    if (watchId === null && navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(updateMyPosition, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
    }
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------------------------------------------------------------------------
// Elenco e filtri
// ---------------------------------------------------------------------------

function setupFilters() {
  const typeSel = $('#filter-type');
  typeSel.innerHTML = '<option value="">Tutti i tipi</option>' +
    Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  const statusSel = $('#filter-status');
  statusSel.innerHTML = '<option value="">Tutti gli stati</option>' +
    Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  for (const el of [typeSel, statusSel]) el.addEventListener('change', renderAll);
  $('#search').addEventListener('input', renderAll);

  const form = $('#cabinet-form');
  form.type.innerHTML = Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  form.status.innerHTML = Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
}

function filteredCabinets() {
  const q = $('#search').value.trim().toLowerCase();
  const type = $('#filter-type').value;
  const status = $('#filter-status').value;
  return state.cabinets.filter((c) => {
    if (type && c.type !== type) return false;
    if (status && c.status !== status) return false;
    if (!q) return true;
    const hay = [c.code, c.address, c.notes, c.createdBy, TYPE_LABELS[c.type], ...c.log.map((l) => l.text)].join(' ').toLowerCase();
    return q.split(/\s+/).every((word) => hay.includes(word));
  });
}

function renderList() {
  const list = filteredCabinets();
  const pos = state.position;
  const dist = new Map();
  if (pos) {
    for (const c of list) dist.set(c, distance(pos, c));
    list.sort((a, b) => dist.get(a) - dist.get(b));
  } else {
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  const total = state.cabinets.length;
  $('#list-count').textContent = (list.length === total ? `${total} cabine` : `${list.length} di ${total} cabine`) +
    (pos ? ' · ordinate per distanza' : ' · le più recenti prima');

  const pendingItems = state.pending.map((c) => `
    <li><button class="item" data-id="${esc(c.clientId)}">
      <span class="badge pending">${esc(TYPE_SHORT[c.type])}</span>
      <span class="item-body">
        <span class="item-title">${esc(cabinetTitle(c))}</span><br>
        <span class="item-sub">In attesa di connessione per essere inviata</span>
      </span>
    </button></li>`).join('');

  $('#list').innerHTML = pendingItems + list.map((c) => `
    <li><button class="item" data-id="${esc(c.id)}">
      <span class="badge st-${esc(c.status)}">${esc(TYPE_SHORT[c.type])}</span>
      <span class="item-body">
        <span class="item-title">${esc(cabinetTitle(c))}</span><br>
        <span class="item-sub">${esc(c.address || `${fmtCoord(c.lat)}, ${fmtCoord(c.lng)}`)}</span><br>
        <span class="chip st-${esc(c.status)}">${esc(STATUS_LABELS[c.status])}</span>
      </span>
      ${pos ? `<span class="item-dist">${fmtDistance(dist.get(c))}</span>` : ''}
    </button></li>`).join('');

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

$('#list').addEventListener('click', (e) => {
  const btn = e.target.closest('.item');
  if (!btn) return;
  const cab = getCabinet(btn.dataset.id);
  if (!cab) return;
  if (!isDesktop()) toggleList(false);
  map.setView([cab.lat, cab.lng], Math.max(map.getZoom(), 17));
  openDetail(btn.dataset.id);
});

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
  }
  $('#btn-list').setAttribute('aria-expanded', String(open));
}
$('#btn-list').addEventListener('click', () => toggleList());

async function searchPlace(q) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=it&accept-language=it&q=${encodeURIComponent(q)}`;
    const results = await (await fetch(url)).json();
    if (!results.length) {
      toast('Luogo non trovato');
      return;
    }
    if (!isDesktop()) toggleList(false);
    map.flyTo([Number(results[0].lat), Number(results[0].lon)], 17);
  } catch {
    toast('Ricerca indirizzi non disponibile', true);
  }
}

function renderAll() {
  fitInitialView();
  renderMarkers();
  renderList();
  if (state.selectedId && !state.pick) {
    if (getCabinet(state.selectedId)) renderDetail();
    else closeDetail();
  }
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
    ${pending ? '<p class="warning small">Salvata solo su questo telefono: verrà inviata alla squadra appena torna la connessione.</p>' : ''}
    <section>
      <h3>Posizione</h3>
      ${cab.address ? `<p class="notes">${esc(cab.address)}</p>` : ''}
      <div class="coords">
        <span>${fmtCoord(cab.lat)}, ${fmtCoord(cab.lng)}</span>
        <button class="btn btn-small" id="btn-copy" type="button">${icon('copy')} Copia</button>
      </div>
      <p class="muted small">${cab.accuracy ? `Precisione GPS ±${cab.accuracy} m` : 'Posizione scelta sulla mappa'}${distanceText}</p>
      <div class="actions">
        <a class="btn btn-primary" href="https://www.google.com/maps/dir/?api=1&destination=${dest}" target="_blank" rel="noopener">${icon('nav')} Google Maps</a>
        <a class="btn" href="https://waze.com/ul?ll=${dest}&navigate=yes" target="_blank" rel="noopener">${icon('nav')} Waze</a>
        ${pending ? '' : `
        <button class="btn" id="btn-edit" type="button">${icon('edit')} Modifica</button>
        <button class="btn" id="btn-move" type="button">${icon('move')} Sposta</button>`}
      </div>
    </section>
    ${cab.notes ? `<section><h3>Note</h3><p class="notes">${esc(cab.notes)}</p></section>` : ''}
    ${pending ? '' : `
    <section>
      <h3>Foto (${cab.photos.length})</h3>
      <div class="photos">
        ${cab.photos.map((p) => {
          const src = `/api/cabinets/${encodeURIComponent(cab.id)}/photos/${encodeURIComponent(p.id)}`;
          return `<div class="photo">
            <a href="${src}" target="_blank" rel="noopener" title="Foto di ${esc(p.by)} del ${esc(fmtDate(p.at))}"><img src="${src}" alt="Foto della cabina" loading="lazy"></a>
            <button type="button" data-photo="${esc(p.id)}" aria-label="Elimina foto">${icon('trash')}</button>
          </div>`;
        }).join('')}
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
    state.cabinets = state.cabinets.filter((c) => c.id !== cab.id);
    state.etag = null;
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
      const pos = await getPosition();
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
    state.pick = resolve;
    $('#pick-text').textContent = text;
    $('#crosshair').hidden = false;
    $('#pick-bar').hidden = false;
    $('#fabs').hidden = true;
    $('#sheet').hidden = true;
  });
}

function endPick(result) {
  const resolve = state.pick;
  state.pick = null;
  $('#crosshair').hidden = true;
  $('#pick-bar').hidden = true;
  $('#fabs').hidden = false;
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
    form.type.value = localStorage.getItem('cabine.lastType') || 'PFP';
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
  localStorage.setItem('cabine.lastType', fields.type);
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
// Menu ed esportazioni
// ---------------------------------------------------------------------------

$('#btn-menu').addEventListener('click', () => $('#menu-dialog').showModal());

$('#menu-dialog').addEventListener('close', async () => {
  const choice = $('#menu-dialog').returnValue;
  $('#menu-dialog').returnValue = '';
  if (choice === 'logout') {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* offline */ }
    localStorage.removeItem('cabine.cache');
    localStorage.removeItem('cabine.me');
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
  const rows = state.cabinets.map((c) => [
    c.code, TYPE_LABELS[c.type], STATUS_LABELS[c.status], fmtCoord(c.lat), fmtCoord(c.lng), c.address, c.notes,
    c.createdBy, fmtDate(c.createdAt), c.updatedBy, fmtDate(c.updatedAt), `https://www.google.com/maps?q=${c.lat},${c.lng}`,
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
  const placemarks = state.cabinets.map((c) => `
  <Placemark>
    <name>${x(cabinetTitle(c))}</name>
    <description>${x([TYPE_LABELS[c.type], STATUS_LABELS[c.status], c.address, c.notes].filter(Boolean).join('\n'))}</description>
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

// Chiudi l'elenco su mobile con il tasto Esc, chiudi la scheda dettaglio.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (state.pick) endPick(null);
  else if (state.selectedId) closeDetail();
  else if (!isDesktop()) toggleList(false);
});

init();
