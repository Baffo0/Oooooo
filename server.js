'use strict';

// Server per la mappa condivisa delle cabine fibra.
// Nessuna dipendenza esterna: solo moduli integrati di Node.js (>= 18).

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const Core = require('./public/core.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const DB_FILE = path.join(DATA_DIR, 'cabinets.json');
const TEAM_PASSWORD = process.env.TEAM_PASSWORD || '';
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 90;

const MAX_JSON_BYTES = 200 * 1024;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Archivio (file JSON con scrittura atomica)
// ---------------------------------------------------------------------------

fs.mkdirSync(PHOTOS_DIR, { recursive: true });

let db = { version: 1, cabinets: [] };
if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    console.error(`Il file ${DB_FILE} è danneggiato: ripristinalo da un backup prima di avviare il server.`);
    throw err;
  }
  db = Core.normalize(db);
}
let etag = computeEtag();

function computeEtag() {
  return '"' + crypto.createHash('sha1').update(JSON.stringify(db.cabinets)).digest('base64url') + '"';
}

// Le scritture sono in coda, così un salvataggio non sovrascrive mai uno più recente.
// Se il disco fallisce (es. spazio esaurito) la richiesta risponde con un errore
// invece di far credere che i dati siano stati salvati.
let writeChain = Promise.resolve();
function persist() {
  etag = computeEtag();
  const snapshot = JSON.stringify(db, null, 1);
  const write = writeChain.then(async () => {
    const tmp = DB_FILE + '.tmp';
    await fsp.writeFile(tmp, snapshot);
    await fsp.rename(tmp, DB_FILE);
  });
  writeChain = write.catch((err) => console.error('Errore salvataggio dati:', err));
  return write.catch(() => {
    throw new HttpError(500, 'Salvataggio sul server non riuscito, riprova');
  });
}

async function persistOrUndo(added) {
  try {
    await persist();
  } catch (err) {
    Core.undoCreate(db, added);
    etag = computeEtag();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Sessioni (cookie firmato HMAC; cambiare TEAM_PASSWORD disconnette tutti)
// ---------------------------------------------------------------------------

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, '.session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}
const SIGNING_KEY = crypto.createHmac('sha256', loadSecret()).update('pw:' + TEAM_PASSWORD).digest();

function sign(data) {
  return crypto.createHmac('sha256', SIGNING_KEY).update(data).digest('base64url');
}

function createToken(name) {
  const payload = Buffer.from(JSON.stringify({ n: name, e: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return payload + '.' + sign(payload);
}

function readToken(token) {
  if (typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.n !== 'string' || typeof data.e !== 'number' || data.e < Date.now()) return null;
    return { name: data.n };
  } catch {
    return null;
  }
}

function passwordMatches(given) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(TEAM_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* cookie di altri siti o malformato: lo ignoriamo */
    }
  }
  return out;
}

function isHttps(req) {
  return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

function sessionCookie(req, value, maxAgeSeconds) {
  return `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}` + (isHttps(req) ? '; Secure' : '');
}

// Dopo 10 password sbagliate in 15 minuti dallo stesso IP l'accesso viene bloccato.
// Contano solo gli errori: molti colleghi possono uscire dallo stesso IP (rete mobile, ufficio).
const loginFailures = new Map();
function loginBlocked(ip) {
  const entry = loginFailures.get(ip);
  if (!entry) return false;
  if (entry.reset < Date.now()) {
    loginFailures.delete(ip);
    return false;
  }
  return entry.count >= 10;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = loginFailures.get(ip);
  if (!entry || entry.reset < now) loginFailures.set(ip, { count: 1, reset: now + 15 * 60e3 });
  else entry.count += 1;
}

// ---------------------------------------------------------------------------
// Utilità HTTP
// ---------------------------------------------------------------------------

// Stesso tipo di errore delle regole condivise: entrambi diventano una risposta HTTP.
const HttpError = Core.CoreError;

// Testi compressi con gzip: l'elenco delle cabine e i file dell'app pesano circa un quarto,
// e su una connessione lenta in strada si sente.
const GZIP_MIN_BYTES = 1024;

function acceptsGzip(req) {
  return /\bgzip\b/.test((req && req.headers['accept-encoding']) || '');
}

function sendJson(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  const head = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  };
  if (data.length < GZIP_MIN_BYTES || !acceptsGzip(res.req)) {
    res.writeHead(status, head);
    res.end(data);
    return;
  }
  zlib.gzip(data, (err, gz) => {
    if (err) {
      res.writeHead(status, head);
      res.end(data);
      return;
    }
    res.writeHead(status, { ...head, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    res.end(gz);
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      if (size > limit) return;
      size += chunk.length;
      if (size > limit) {
        // Si smette di conservare i dati ma si lascia finire l'invio: così il telefono riceve
        // davvero la risposta "troppo grande" invece di una connessione interrotta.
        chunks.length = 0;
        reject(new HttpError(413, 'Contenuto troppo grande'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = MAX_JSON_BYTES) {
  const buf = await readBody(req, limit);
  try {
    const data = JSON.parse(buf.toString('utf8') || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, 'JSON non valido');
  }
}

function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

function photoPath(cabId, photoId) {
  return path.join(PHOTOS_DIR, `${cabId}-${photoId}.jpg`);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/login' && method === 'POST') {
    // L'ultimo indirizzo è quello aggiunto dal proxy (Render, Caddy): i precedenti li sceglie il client.
    const ip = req.headers['x-forwarded-for']?.split(',').pop().trim() || req.socket.remoteAddress;
    if (loginBlocked(ip)) throw new HttpError(429, 'Troppi tentativi, riprova tra qualche minuto');
    const body = await readJson(req);
    const name = Core.cleanText(body.name, 40);
    if (!name) throw new HttpError(400, 'Inserisci il tuo nome');
    if (TEAM_PASSWORD && !passwordMatches(body.password || '')) {
      recordLoginFailure(ip);
      throw new HttpError(401, 'Password di squadra errata');
    }
    const cookie = sessionCookie(req, createToken(name), SESSION_DAYS * 86400);
    return sendJson(res, 200, { name }, { 'Set-Cookie': cookie });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  if (pathname === '/api/config' && method === 'GET') {
    // Leggibile da qualunque origine: l'app Android la usa per riconoscere il server.
    return sendJson(res, 200, { passwordRequired: Boolean(TEAM_PASSWORD), types: Core.TYPES, statuses: Core.STATUSES },
      { 'Access-Control-Allow-Origin': '*' });
  }

  const user = readToken(parseCookies(req).sid);
  if (!user) throw new HttpError(401, 'Accesso richiesto');

  if (pathname === '/api/me' && method === 'GET') {
    return sendJson(res, 200, { name: user.name });
  }

  if (pathname === '/api/cabinets' && method === 'GET') {
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    return sendJson(res, 200, { cabinets: db.cabinets }, { ETag: etag, 'Cache-Control': 'no-cache' });
  }

  const ctx = { user: user.name, now: new Date().toISOString(), newId };

  if (pathname === '/api/cabinets' && method === 'POST') {
    const result = Core.createCabinet(db, await readJson(req), ctx);
    if (result.created) await persistOrUndo([result.cabinet]);
    return sendJson(res, result.created ? 201 : 200, result.cabinet);
  }

  if (pathname === '/api/cabinets/import' && method === 'POST') {
    const { created, existing, added } = Core.importCabinets(db, await readJson(req, MAX_IMPORT_BYTES), ctx);
    if (created) await persistOrUndo(added);
    return sendJson(res, 200, { created, existing });
  }

  let m = pathname.match(/^\/api\/cabinets\/([\w-]+)$/);
  if (m && method === 'PUT') {
    const body = await readJson(req);
    const cab = Core.updateCabinet(db, m[1], body, ctx);
    await persist();
    return sendJson(res, 200, cab);
  }

  if (m && method === 'DELETE') {
    const cab = Core.deleteCabinet(db, m[1]);
    await persist();
    await Promise.all(cab.photos.map((p) => fsp.rm(photoPath(cab.id, p.id), { force: true })));
    return sendJson(res, 200, { ok: true });
  }

  m = pathname.match(/^\/api\/cabinets\/([\w-]+)\/log$/);
  if (m && method === 'POST') {
    const cab = Core.addLog(db, m[1], await readJson(req), ctx);
    await persist();
    return sendJson(res, 201, cab);
  }

  m = pathname.match(/^\/api\/cabinets\/([\w-]+)\/log\/([\w-]+)$/);
  if (m && method === 'DELETE') {
    const cab = Core.deleteLog(db, m[1], m[2], ctx);
    await persist();
    return sendJson(res, 200, cab);
  }

  m = pathname.match(/^\/api\/cabinets\/([\w-]+)\/photos$/);
  if (m && method === 'POST') {
    const cab = Core.checkPhotoSlot(db, m[1]);
    if (!String(req.headers['content-type']).startsWith('image/jpeg')) {
      throw new HttpError(415, 'Sono accettate solo foto JPEG');
    }
    const buf = await readBody(req, Core.MAX_PHOTO_BYTES);
    Core.checkJpeg(buf, req.headers['content-type']);
    const photo = Core.newPhoto(ctx);
    await fsp.writeFile(photoPath(cab.id, photo.id), buf);
    try {
      // Durante il caricamento la cabina potrebbe essere stata eliminata o aver ricevuto altre foto.
      Core.addPhoto(db, m[1], photo);
    } catch (err) {
      await fsp.rm(photoPath(cab.id, photo.id), { force: true });
      throw err;
    }
    await persist();
    return sendJson(res, 201, Core.findCabinet(db, m[1]));
  }

  m = pathname.match(/^\/api\/cabinets\/([\w-]+)\/photos\/([\w-]+)$/);
  if (m && method === 'GET') {
    const cab = Core.findCabinet(db, m[1]);
    if (!cab.photos.some((p) => p.id === m[2])) throw new HttpError(404, 'Foto non trovata');
    const data = await fsp.readFile(photoPath(cab.id, m[2]));
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' });
    return res.end(data);
  }

  if (m && method === 'DELETE') {
    const cab = Core.deletePhoto(db, m[1], m[2]);
    await persist();
    await fsp.rm(photoPath(cab.id, m[2]), { force: true });
    return sendJson(res, 200, cab);
  }

  throw new HttpError(404, 'Risorsa non trovata');
}

// ---------------------------------------------------------------------------
// File statici
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg', '.txt']);
// I file dell'app (già compressi) restano in memoria: sono pochi e piccoli.
const staticCache = new Map();
const gzip = (data, opts) => new Promise((resolve, reject) => zlib.gzip(data, opts, (err, out) => (err ? reject(err) : resolve(out))));

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Metodo non consentito');
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'Percorso non valido');
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Non trovato');
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    throw new HttpError(404, 'Non trovato');
  }
  if (!stat.isFile()) throw new HttpError(404, 'Non trovato');
  const ext = path.extname(file);
  // Il browser chiede "è cambiato?" e, se no, riceve solo una risposta vuota (304).
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'Cache-Control': rel.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache',
    ETag: etag,
    Vary: 'Accept-Encoding',
  };
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && ifNoneMatch.split(',').some((t) => t.trim() === etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  let entry = staticCache.get(file);
  if (!entry || entry.etag !== etag) {
    let data;
    try {
      data = await fsp.readFile(file);
    } catch {
      throw new HttpError(404, 'Non trovato');
    }
    const gz = COMPRESSIBLE.has(ext) && data.length >= GZIP_MIN_BYTES ? await gzip(data, { level: 9 }) : null;
    entry = { etag, data, gz };
    staticCache.set(file, entry);
  }
  const body = entry.gz && acceptsGzip(req) ? entry.gz : entry.data;
  res.writeHead(200, {
    ...headers,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    ...(body === entry.gz ? { 'Content-Encoding': 'gzip' } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // I servizi di mappe, indirizzi e percorsi richiedono il Referer (basta l'origine).
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(self), camera=(self), screen-wake-lock=(self)',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://tiles.openfreemap.org https://tile.openstreetmap.org https://server.arcgisonline.com",
    "connect-src 'self' https://tiles.openfreemap.org https://nominatim.openstreetmap.org https://routing.openstreetmap.de",
    // MapLibre elabora le tile vettoriali in un worker creato da blob:.
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
};

function sameOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  try {
    return new URL(req.headers.origin).host === host;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    // Dentro il try: un indirizzo malformato non deve far cadere il server.
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      throw new HttpError(400, 'Indirizzo non valido');
    }
    if (url.pathname.startsWith('/api/')) {
      // Protezione CSRF: le richieste che modificano dati devono arrivare dalla stessa origine.
      if (req.method !== 'GET' && req.headers.origin && !sameOrigin(req)) {
        throw new HttpError(403, 'Origine non consentita');
      }
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (err) {
    const known = err instanceof HttpError;
    const status = known ? err.status : 500;
    if (!known) console.error(err);
    // err.data porta informazioni utili all'app, es. la versione aggiornata in caso di conflitto.
    if (!res.headersSent) sendJson(res, status, known ? { error: err.message, ...(err.data || {}) } : { error: 'Errore interno del server' });
    else res.end();
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Mappa cabine in ascolto su http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`Dati salvati in ${DATA_DIR}`);
    if (!TEAM_PASSWORD) {
      console.warn('ATTENZIONE: TEAM_PASSWORD non impostata, chiunque conosca l\'indirizzo può vedere e modificare le cabine.');
    }
  });
}

module.exports = { server, flush: () => writeChain };
