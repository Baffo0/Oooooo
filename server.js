'use strict';

// Server per la mappa condivisa delle cabine fibra.
// Nessuna dipendenza esterna: solo moduli integrati di Node.js (>= 18).

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const DB_FILE = path.join(DATA_DIR, 'cabinets.json');
const TEAM_PASSWORD = process.env.TEAM_PASSWORD || '';
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 90;

const TYPES = ['PFP', 'PFS', 'PTE', 'PCN', 'POZZETTO', 'MUFFOLA', 'ALTRO'];
const STATUSES = ['da_fare', 'in_corso', 'fatto', 'problema'];
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 200 * 1024;
const MAX_LOG_ENTRIES = 500;

// ---------------------------------------------------------------------------
// Archivio (file JSON con scrittura atomica)
// ---------------------------------------------------------------------------

fs.mkdirSync(PHOTOS_DIR, { recursive: true });

let db = { version: 1, cabinets: [] };
if (fs.existsSync(DB_FILE)) {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!Array.isArray(db.cabinets)) db.cabinets = [];
}
let etag = computeEtag();

function computeEtag() {
  return '"' + crypto.createHash('sha1').update(JSON.stringify(db.cabinets)).digest('base64url') + '"';
}

let writeChain = Promise.resolve();
function persist() {
  etag = computeEtag();
  const snapshot = JSON.stringify(db, null, 1);
  writeChain = writeChain.then(async () => {
    const tmp = DB_FILE + '.tmp';
    await fsp.writeFile(tmp, snapshot);
    await fsp.rename(tmp, DB_FILE);
  }).catch((err) => console.error('Errore salvataggio dati:', err));
  return writeChain;
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
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isHttps(req) {
  return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

function sessionCookie(req, value, maxAgeSeconds) {
  return `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}` + (isHttps(req) ? '; Secure' : '');
}

// Limite tentativi di accesso: 10 ogni 15 minuti per IP.
const loginAttempts = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.reset < now) {
    loginAttempts.set(ip, { count: 1, reset: now + 15 * 60e3 });
    return true;
  }
  entry.count += 1;
  return entry.count <= 10;
}

// ---------------------------------------------------------------------------
// Utilità HTTP
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Contenuto troppo grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON_BYTES);
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

function cleanText(value, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, 'Valore di testo non valido');
  return value.trim().slice(0, max);
}

function cleanNumber(value, min, max, field) {
  const n = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(400, `Valore non valido per ${field}`);
  }
  return n;
}

function cabinetFields(body) {
  const type = body.type === undefined ? 'ALTRO' : body.type;
  const status = body.status === undefined ? 'da_fare' : body.status;
  if (!TYPES.includes(type)) throw new HttpError(400, 'Tipo non valido');
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Stato non valido');
  const fields = {
    code: cleanText(body.code, 80),
    type,
    status,
    lat: cleanNumber(body.lat, -90, 90, 'latitudine'),
    lng: cleanNumber(body.lng, -180, 180, 'longitudine'),
    accuracy: null,
    address: cleanText(body.address, 200),
    notes: cleanText(body.notes, 4000),
  };
  if (body.accuracy !== undefined && body.accuracy !== null && body.accuracy !== '') {
    fields.accuracy = Math.round(cleanNumber(body.accuracy, 0, 100000, 'precisione'));
  }
  return fields;
}

function findCabinet(id) {
  const cab = db.cabinets.find((c) => c.id === id);
  if (!cab) throw new HttpError(404, 'Cabina non trovata');
  return cab;
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
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    if (!loginAllowed(ip)) throw new HttpError(429, 'Troppi tentativi, riprova tra qualche minuto');
    const body = await readJson(req);
    const name = cleanText(body.name, 40);
    if (!name) throw new HttpError(400, 'Inserisci il tuo nome');
    if (TEAM_PASSWORD && !passwordMatches(body.password || '')) {
      throw new HttpError(401, 'Password di squadra errata');
    }
    const cookie = sessionCookie(req, createToken(name), SESSION_DAYS * 86400);
    return sendJson(res, 200, { name }, { 'Set-Cookie': cookie });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  if (pathname === '/api/config' && method === 'GET') {
    return sendJson(res, 200, { passwordRequired: Boolean(TEAM_PASSWORD), types: TYPES, statuses: STATUSES });
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

  if (pathname === '/api/cabinets' && method === 'POST') {
    const body = await readJson(req);
    const now = new Date().toISOString();
    // clientId evita duplicati quando un salvataggio fatto offline viene ritentato.
    const clientId = cleanText(body.clientId, 40);
    if (clientId) {
      const existing = db.cabinets.find((c) => c.clientId === clientId);
      if (existing) return sendJson(res, 200, existing);
    }
    const cab = {
      id: newId(),
      ...cabinetFields(body),
      photos: [],
      log: [],
      createdBy: user.name,
      createdAt: now,
      updatedBy: user.name,
      updatedAt: now,
    };
    if (clientId) cab.clientId = clientId;
    db.cabinets.push(cab);
    await persist();
    return sendJson(res, 201, cab);
  }

  let m = pathname.match(/^\/api\/cabinets\/([\w-]+)$/);
  if (m && method === 'PUT') {
    const cab = findCabinet(m[1]);
    const body = await readJson(req);
    if (body.baseUpdatedAt && body.baseUpdatedAt !== cab.updatedAt) {
      return sendJson(res, 409, {
        error: `Nel frattempo ${cab.updatedBy} ha modificato questa cabina. Ricarica e riprova.`,
        cabinet: cab,
      });
    }
    Object.assign(cab, cabinetFields({ ...cab, ...body }), {
      updatedBy: user.name,
      updatedAt: new Date().toISOString(),
    });
    await persist();
    return sendJson(res, 200, cab);
  }

  if (m && method === 'DELETE') {
    const cab = findCabinet(m[1]);
    db.cabinets = db.cabinets.filter((c) => c !== cab);
    await persist();
    await Promise.all(cab.photos.map((p) => fsp.rm(photoPath(cab.id, p.id), { force: true })));
    return sendJson(res, 200, { ok: true });
  }

  m = pathname.match(/^\/api\/cabinets\/([\w-]+)\/log$/);
  if (m && method === 'POST') {
    const cab = findCabinet(m[1]);
    const body = await readJson(req);
    const text = cleanText(body.text, 2000);
    if (!text) throw new HttpError(400, 'Scrivi una nota');
    const now = new Date().toISOString();
    cab.log.unshift({ id: newId(), by: user.name, at: now, text });
    cab.log = cab.log.slice(0, MAX_LOG_ENTRIES);
    cab.updatedBy = user.name;
    cab.updatedAt = now;
    await persist();
    return sendJson(res, 201, cab);
  }

  m = pathname.match(/^\/api\/cabinets\/([\w-]+)\/log\/([\w-]+)$/);
  if (m && method === 'DELETE') {
    const cab = findCabinet(m[1]);
    const entry = cab.log.find((e) => e.id === m[2]);
    if (!entry) throw new HttpError(404, 'Nota non trovata');
    if (entry.by !== user.name) throw new HttpError(403, 'Puoi eliminare solo le tue note');
    cab.log = cab.log.filter((e) => e !== entry);
    await persist();
    return sendJson(res, 200, cab);
  }

  m = pathname.match(/^\/api\/cabinets\/([\w-]+)\/photos$/);
  if (m && method === 'POST') {
    const cab = findCabinet(m[1]);
    if (cab.photos.length >= MAX_PHOTOS) throw new HttpError(400, `Massimo ${MAX_PHOTOS} foto per cabina`);
    if (!String(req.headers['content-type']).startsWith('image/jpeg')) {
      throw new HttpError(415, 'Sono accettate solo foto JPEG');
    }
    const buf = await readBody(req, MAX_PHOTO_BYTES);
    if (buf.length < 3 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
      throw new HttpError(400, 'File JPEG non valido');
    }
    const photo = { id: newId(), by: user.name, at: new Date().toISOString() };
    await fsp.writeFile(photoPath(cab.id, photo.id), buf);
    // Durante il caricamento la cabina potrebbe essere stata eliminata o aver ricevuto altre foto.
    if (!db.cabinets.includes(cab) || cab.photos.length >= MAX_PHOTOS) {
      await fsp.rm(photoPath(cab.id, photo.id), { force: true });
      throw new HttpError(db.cabinets.includes(cab) ? 400 : 404,
        db.cabinets.includes(cab) ? `Massimo ${MAX_PHOTOS} foto per cabina` : 'Cabina non trovata');
    }
    cab.photos.push(photo);
    await persist();
    return sendJson(res, 201, cab);
  }

  m = pathname.match(/^\/api\/cabinets\/([\w-]+)\/photos\/([\w-]+)$/);
  if (m && method === 'GET') {
    const cab = findCabinet(m[1]);
    if (!cab.photos.some((p) => p.id === m[2])) throw new HttpError(404, 'Foto non trovata');
    const data = await fsp.readFile(photoPath(cab.id, m[2]));
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' });
    return res.end(data);
  }

  if (m && method === 'DELETE') {
    const cab = findCabinet(m[1]);
    cab.photos = cab.photos.filter((p) => p.id !== m[2]);
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
  let data;
  try {
    data = await fsp.readFile(file);
  } catch {
    throw new HttpError(404, 'Non trovato');
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': rel.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // Le tile di OpenStreetMap e Nominatim richiedono il Referer (basta l'origine).
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(self), camera=(self)',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://tile.openstreetmap.org https://server.arcgisonline.com",
    "connect-src 'self' https://nominatim.openstreetmap.org",
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
  const url = new URL(req.url, 'http://localhost');
  try {
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
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Errore interno del server' : err.message });
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
