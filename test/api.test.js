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
