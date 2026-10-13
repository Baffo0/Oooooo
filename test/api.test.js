'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cabine-test-'));
// Una cabina salvata da una versione precedente, senza foto né diario.
fs.writeFileSync(path.join(dataDir, 'cabinets.json'), JSON.stringify({
  version: 1,
  cabinets: [{ id: 'vecchia', code: 'PFP 1', type: 'PFP', status: 'fatto', lat: 45, lng: 9, address: '', notes: '', createdBy: 'X', createdAt: '2024-01-01T00:00:00.000Z', updatedBy: 'X', updatedAt: '2024-01-01T00:00:00.000Z' }],
}));
process.env.DATA_DIR = dataDir;
process.env.TEAM_PASSWORD = 'segreta';
const { server, flush } = require('../server.js');

let base;
let cookie;

async function call(method, url, { body, headers = {}, auth = true } = {}) {
  const opts = { method, headers: { ...headers } };
  if (auth && cookie) opts.headers.cookie = cookie;
  if (Buffer.isBuffer(body)) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['content-type'] = 'application/json';
  }
  const res = await fetch(base + url, opts);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : null;
  return { status: res.status, data, headers: res.headers };
}

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await flush();
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('serve la pagina principale', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Mappa Cabine Fibra/);
  assert.ok(res.headers.get('content-security-policy'));
});

test('blocca i percorsi fuori dalla cartella pubblica', async () => {
  const res = await fetch(base + '/..%2fserver.js');
  assert.equal(res.status, 404);
});

test('le API richiedono l\'accesso', async () => {
  const res = await call('GET', '/api/cabinets', { auth: false });
  assert.equal(res.status, 401);
});

test('rifiuta una password sbagliata', async () => {
  const res = await call('POST', '/api/login', { body: { name: 'Marco', password: 'no' }, auth: false });
  assert.equal(res.status, 401);
});

test('accesso con nome e password di squadra', async () => {
  const res = await call('POST', '/api/login', { body: { name: 'Marco', password: 'segreta' }, auth: false });
  assert.equal(res.status, 200);
  cookie = res.headers.get('set-cookie').split(';')[0];
  const me = await call('GET', '/api/me');
  assert.deepEqual(me.data, { name: 'Marco' });
});

test('un cookie manomesso non è valido', async () => {
  const forged = cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA');
  const res = await fetch(base + '/api/me', { headers: { cookie: forged } });
  assert.equal(res.status, 401);
});

test('crea, legge, modifica ed elimina una cabina', async () => {
  const created = await call('POST', '/api/cabinets', {
    body: { code: 'PFP 012', type: 'PFP', status: 'da_fare', lat: 45.4642, lng: 9.19, accuracy: 6.4, address: 'Via Roma 1, Milano', notes: 'Chiave in sede' },
  });
  assert.equal(created.status, 201);
  const cab = created.data;
  assert.equal(cab.createdBy, 'Marco');
  assert.equal(cab.accuracy, 6);

  const list = await call('GET', '/api/cabinets');
  assert.ok(list.data.cabinets.some((c) => c.id === cab.id));
  const etag = list.headers.get('etag');
  const cached = await call('GET', '/api/cabinets', { headers: { 'if-none-match': etag } });
  assert.equal(cached.status, 304);

  const updated = await call('PUT', `/api/cabinets/${cab.id}`, { body: { status: 'fatto', baseUpdatedAt: cab.updatedAt } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.status, 'fatto');
  assert.equal(updated.data.code, 'PFP 012');

  const stale = await call('PUT', `/api/cabinets/${cab.id}`, { body: { status: 'problema', baseUpdatedAt: '2000-01-01T00:00:00.000Z' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.cabinet.status, 'fatto');

  const removed = await call('DELETE', `/api/cabinets/${cab.id}`);
  assert.equal(removed.status, 200);
  assert.ok(!(await call('GET', '/api/cabinets')).data.cabinets.some((c) => c.id === cab.id));
});

test('valida i dati in ingresso', async () => {
  const badLat = await call('POST', '/api/cabinets', { body: { lat: 200, lng: 9 } });
  assert.equal(badLat.status, 400);
  const badType = await call('POST', '/api/cabinets', { body: { lat: 45, lng: 9, type: 'XYZ' } });
  assert.equal(badType.status, 400);
  const noLat = await call('POST', '/api/cabinets', { body: { lng: 9 } });
  assert.equal(noLat.status, 400);
});

test('un salvataggio offline ritentato non crea doppioni', async () => {
  const body = { lat: 41.9, lng: 12.5, clientId: 'abc-123' };
  const first = await call('POST', '/api/cabinets', { body });
  const second = await call('POST', '/api/cabinets', { body });
  assert.equal(first.data.id, second.data.id);
  await call('DELETE', `/api/cabinets/${first.data.id}`);
});

test('diario interventi e foto', async () => {
  const cab = (await call('POST', '/api/cabinets', { body: { lat: 40.85, lng: 14.27 } })).data;

  const logged = await call('POST', `/api/cabinets/${cab.id}/log`, { body: { text: 'Sostituito splitter' } });
  assert.equal(logged.status, 201);
  assert.equal(logged.data.log[0].text, 'Sostituito splitter');
  assert.equal(logged.data.log[0].by, 'Marco');

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const notJpeg = await call('POST', `/api/cabinets/${cab.id}/photos`, { body: Buffer.from('ciao'), headers: { 'content-type': 'image/jpeg' } });
  assert.equal(notJpeg.status, 400);
  const uploaded = await call('POST', `/api/cabinets/${cab.id}/photos`, { body: jpeg, headers: { 'content-type': 'image/jpeg' } });
  assert.equal(uploaded.status, 201);
  const photo = uploaded.data.photos[0];

  const img = await fetch(`${base}/api/cabinets/${cab.id}/photos/${photo.id}`, { headers: { cookie } });
  assert.equal(img.status, 200);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), jpeg);
  const anon = await fetch(`${base}/api/cabinets/${cab.id}/photos/${photo.id}`);
  assert.equal(anon.status, 401);

  // Un collega non può cancellare le note del diario altrui.
  const other = await call('POST', '/api/login', { body: { name: 'Luca', password: 'segreta' }, auth: false });
  const otherCookie = other.headers.get('set-cookie').split(';')[0];
  const denied = await fetch(`${base}/api/cabinets/${cab.id}/log/${logged.data.log[0].id}`, { method: 'DELETE', headers: { cookie: otherCookie } });
  assert.equal(denied.status, 403);

  await call('DELETE', `/api/cabinets/${cab.id}`);
  assert.equal(fs.readdirSync(path.join(dataDir, 'photos')).length, 0);
});

test('rifiuta richieste di modifica da altri siti', async () => {
  const res = await call('POST', '/api/cabinets', { body: { lat: 45, lng: 9 }, headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

test('i dati restano salvati su disco', async () => {
  const cab = (await call('POST', '/api/cabinets', { body: { code: 'PTE 7', lat: 45.07, lng: 7.68 } })).data;
  await flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'cabinets.json'), 'utf8'));
  assert.ok(saved.cabinets.some((c) => c.id === cab.id && c.code === 'PTE 7'));
});

test('blocca dopo troppe password sbagliate, non dopo accessi riusciti', async () => {
  for (let i = 0; i < 12; i++) {
    const ok = await call('POST', '/api/login', { body: { name: `Collega ${i}`, password: 'segreta' }, auth: false });
    assert.equal(ok.status, 200);
  }
  // Una password sbagliata è già stata provata in un test precedente.
  for (let i = 0; i < 9; i++) await call('POST', '/api/login', { body: { name: 'X', password: 'no' }, auth: false });
  const blocked = await call('POST', '/api/login', { body: { name: 'Marco', password: 'segreta' }, auth: false });
  assert.equal(blocked.status, 429);
});

test('le cabine salvate da versioni precedenti funzionano', async () => {
  const logged = await call('POST', '/api/cabinets/vecchia/log', { body: { text: 'Controllata' } });
  assert.equal(logged.status, 201);
  assert.deepEqual(logged.data.photos, []);
});

test('un indirizzo malformato non fa cadere il server', async () => {
  const { port } = server.address();
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.end('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    let data = '';
    socket.on('data', (d) => { data += d; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1\.1 400/);
  const res = await fetch(base + '/api/config');
  assert.equal(res.status, 200);
});

test('un cookie malformato viene ignorato', async () => {
  const res = await fetch(base + '/api/me', { headers: { cookie: `altro=%E0%A4%A; ${cookie}` } });
  assert.equal(res.status, 200);
});

// Richiesta senza decompressione automatica, per vedere i byte che viaggiano davvero.
function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(base + url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('i file dell\'app viaggiano compressi e non si riscaricano se non sono cambiati', async () => {
  const plain = await rawGet('/app.js');
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.ok(plain.headers.etag);

  const gz = await rawGet('/app.js', { 'accept-encoding': 'gzip, deflate, br' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(gz.headers.vary, 'Accept-Encoding');
  assert.ok(gz.body.length < plain.body.length / 2);
  assert.deepEqual(zlib.gunzipSync(gz.body), plain.body);

  const same = await rawGet('/app.js', { 'if-none-match': plain.headers.etag });
  assert.equal(same.status, 304);
  assert.equal(same.body.length, 0);
  const changed = await rawGet('/app.js', { 'if-none-match': 'W/"vecchio"' });
  assert.equal(changed.status, 200);

  // Le immagini sono già compresse.
  const png = await rawGet('/icons/icon-192.png', { 'accept-encoding': 'gzip' });
  assert.equal(png.status, 200);
  assert.equal(png.headers['content-encoding'], undefined);
});

test('l\'elenco delle cabine viaggia compresso', async () => {
  for (let i = 0; i < 4; i++) {
    const res = await call('POST', '/api/cabinets', { body: { code: `PTE compresso ${i}`, type: 'PTE', status: 'da_fare', lat: 45.1, lng: 9.1, notes: 'Nota lunga '.repeat(30) } });
    assert.equal(res.status, 201);
  }
  const res = await rawGet('/api/cabinets', { cookie, 'accept-encoding': 'gzip' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'gzip');
  const data = JSON.parse(zlib.gunzipSync(res.body));
  assert.ok(data.cabinets.some((c) => c.code === 'PTE compresso 3'));
  const notModified = await rawGet('/api/cabinets', { cookie, 'accept-encoding': 'gzip', 'if-none-match': res.headers.etag });
  assert.equal(notModified.status, 304);
});

test('importa tanti punti insieme, senza doppioni se si ripete', async () => {
  const cabinets = Array.from({ length: 120 }, (_, i) => ({
    clientId: `imp-prova-${i}`,
    code: `NA_0${1 + (i % 6)} PFS ${i}`,
    type: 'PFS',
    status: 'da_fare',
    lat: 40.85 + i * 0.001,
    lng: 14.25,
    notes: 'Da Google My Maps',
  }));
  const first = await call('POST', '/api/cabinets/import', { body: { cabinets } });
  assert.equal(first.status, 200);
  assert.deepEqual(first.data, { created: 120, existing: 0 });
  const again = await call('POST', '/api/cabinets/import', { body: { cabinets } });
  assert.deepEqual(again.data, { created: 0, existing: 120 });
  const list = await call('GET', '/api/cabinets');
  assert.equal(list.data.cabinets.filter((c) => c.clientId?.startsWith('imp-prova-')).length, 120);
  const one = list.data.cabinets.find((c) => c.clientId === 'imp-prova-7');
  assert.equal(one.code, 'NA_02 PFS 7');
  assert.equal(one.createdBy, 'Marco');
});

test('importazione: o tutti o nessuno, con limiti e accesso', async () => {
  const before = (await call('GET', '/api/cabinets')).data.cabinets.length;
  const bad = await call('POST', '/api/cabinets/import', { body: { cabinets: [
    { clientId: 'imp-ok', code: 'Buono', type: 'PFS', lat: 41, lng: 14 },
    { clientId: 'imp-ko', code: 'Sbagliato', type: 'PFS', lat: 141, lng: 14 },
  ] } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Punto 2 \(Sbagliato\)/);
  assert.equal((await call('GET', '/api/cabinets')).data.cabinets.length, before);

  assert.equal((await call('POST', '/api/cabinets/import', { body: { cabinets: [] } })).status, 400);
  assert.equal((await call('POST', '/api/cabinets/import', { body: { cabinets: 'x' } })).status, 400);
  const tooMany = Array.from({ length: 5001 }, (_, i) => ({ lat: 41, lng: 14, clientId: `t${i}` }));
  assert.equal((await call('POST', '/api/cabinets/import', { body: { cabinets: tooMany } })).status, 400);
  assert.equal((await call('POST', '/api/cabinets/import', { body: { cabinets: [{ lat: 41, lng: 14 }] }, auth: false })).status, 401);
  const foreign = await call('POST', '/api/cabinets/import', { body: { cabinets: [{ lat: 41, lng: 14 }] }, headers: { origin: 'https://altro.example' } });
  assert.equal(foreign.status, 403);
});

test('importazione da backup: il diario torna con la cabina', async () => {
  const res = await call('POST', '/api/cabinets/import', { body: { cabinets: [{
    clientId: 'imp-diario', code: 'PTE con diario', type: 'PTE', status: 'fatto', lat: 41.2, lng: 14.2,
    log: [{ by: 'Sara', at: '2026-03-01T10:00:00.000Z', text: 'Sostituito lucchetto' }, { text: '' }, { by: 'x'.repeat(80), at: 'ieri', text: 'Pulito' }],
  }] } });
  assert.equal(res.status, 200);
  const cab = (await call('GET', '/api/cabinets')).data.cabinets.find((c) => c.clientId === 'imp-diario');
  assert.equal(cab.log.length, 2);
  assert.deepEqual([cab.log[0].by, cab.log[0].at, cab.log[0].text], ['Sara', '2026-03-01T10:00:00.000Z', 'Sostituito lucchetto']);
  assert.equal(cab.log[1].by.length, 40);
  assert.ok(cab.log.every((e) => e.id));
});

test('importazione oltre 5 MB: risposta 413, non connessione interrotta', async () => {
  const res = await call('POST', '/api/cabinets/import', { body: { cabinets: [{ lat: 41, lng: 14, notes: 'x'.repeat(6 * 1024 * 1024) }] } });
  assert.equal(res.status, 413);
  assert.match(res.data.error, /troppo grande/i);
});

test('se il salvataggio fallisce le cabine appena aggiunte si tolgono', () => {
  const Core = require('../public/core.js');
  let n = 0;
  const ctx = { user: 'Test', now: '2026-01-01T00:00:00.000Z', newId: () => `id${n++}` };
  const db = Core.normalize({ cabinets: [] });
  const body = { cabinets: [{ clientId: 'imp-a', lat: 41, lng: 14 }, { clientId: 'imp-b', lat: 41.1, lng: 14 }] };
  const first = Core.importCabinets(db, body, ctx);
  assert.equal(first.created, 2);
  Core.undoCreate(db, first.added);
  assert.equal(db.cabinets.length, 0);
  assert.equal(Core.importCabinets(db, body, ctx).created, 2);
});
