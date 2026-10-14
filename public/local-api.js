'use strict';

// Modalità "Prova sul telefono": risponde alle stesse richieste del server
// (/api/...) ma tiene cabine e foto nel telefono (IndexedDB), così l'app si può
// usare senza un server di squadra. Le regole sono quelle di core.js, uguali al server.

(function (root) {
  const Core = root.CabineCore;
  const DB_NAME = 'cabine-fibra-locale';
  const STORE_DATA = 'data';
  const STORE_PHOTOS = 'photos';

  let idbPromise;
  function openIdb() {
    if (!idbPromise) {
      idbPromise = new Promise((resolve, reject) => {
        if (!root.indexedDB) {
          reject(new Error('Archivio del telefono non disponibile'));
          return;
        }
        const req = root.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(STORE_DATA);
          req.result.createObjectStore(STORE_PHOTOS);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('Archivio del telefono non disponibile'));
      });
      // Chiede al browser di non cancellare i dati quando manca spazio.
      root.navigator?.storage?.persist?.().catch(() => {});
    }
    return idbPromise;
  }

  async function idb(storeName, mode, action) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = action(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error || new Error('Salvataggio sul telefono non riuscito'));
      tx.onabort = () => reject(tx.error || new Error('Salvataggio sul telefono non riuscito'));
    });
  }

  const read = (store, key) => idb(store, 'readonly', (s) => s.get(key));
  const write = (store, key, value) => idb(store, 'readwrite', (s) => s.put(value, key));
  const remove = (store, key) => idb(store, 'readwrite', (s) => s.delete(key));

  let archive = null;
  async function loadArchive() {
    if (!archive) {
      archive = Core.normalize((await read(STORE_DATA, 'archive')) || {});
      archive.rev = archive.rev || 0;
    }
    return archive;
  }

  async function saveArchive() {
    archive.rev += 1;
    await write(STORE_DATA, 'archive', archive);
  }

  // Telefono pieno: le cabine appena aggiunte non restano solo in memoria.
  async function saveOrUndo(db, added) {
    try {
      await saveArchive();
    } catch (err) {
      Core.undoCreate(db, added);
      throw new Core.CoreError(507, 'Salvataggio sul telefono non riuscito: memoria piena?');
    }
  }

  function newId() {
    const bytes = new Uint8Array(9);
    root.crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
  }

  // Come il server, le risposte sono copie: l'app non deve poter modificare l'archivio per errore.
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const ok = (status, data, etag) => ({ status, data: data === undefined ? null : copy(data), etag: etag || null });
  const photoKey = (cabId, photoId) => `${cabId}/${photoId}`;

  async function handle(path, method, body, headers) {
    const db = await loadArchive();

    if (path === '/api/config' && method === 'GET') {
      return ok(200, { passwordRequired: false, types: Core.TYPES, statuses: Core.STATUSES, local: true });
    }
    if (path === '/api/login' && method === 'POST') {
      const name = Core.cleanText(body?.name, 40);
      if (!name) throw new Core.CoreError(400, 'Inserisci il tuo nome');
      await write(STORE_DATA, 'user', name);
      return ok(200, { name });
    }
    if (path === '/api/logout' && method === 'POST') {
      await remove(STORE_DATA, 'user');
      return ok(200, { ok: true });
    }

    const user = await read(STORE_DATA, 'user');
    if (!user) throw new Core.CoreError(401, 'Accesso richiesto');
    if (path === '/api/me' && method === 'GET') return ok(200, { name: user });

    const etag = `"locale-${db.rev}"`;
    if (path === '/api/cabinets' && method === 'GET') {
      if (headers['If-None-Match'] === etag) return { status: 304, data: null, etag };
      return ok(200, { cabinets: db.cabinets }, etag);
    }

    const ctx = { user, now: new Date().toISOString(), newId };

    if (path === '/api/cabinets' && method === 'POST') {
      const result = Core.createCabinet(db, body || {}, ctx);
      if (result.created) await saveOrUndo(db, [result.cabinet]);
      return ok(result.created ? 201 : 200, result.cabinet);
    }

    if (path === '/api/cabinets/import/undo' && method === 'POST') {
      const before = db.cabinets;
      const removed = Core.undoImport(db, body || {});
      if (removed.length) {
        try {
          await saveArchive();
        } catch {
          db.cabinets = before;
          throw new Core.CoreError(507, 'Salvataggio sul telefono non riuscito: memoria piena?');
        }
      }
      return ok(200, { removed: removed.length });
    }

    if (path === '/api/cabinets/import' && method === 'POST') {
      const { created, existing, added } = Core.importCabinets(db, body || {}, ctx);
      if (created) await saveOrUndo(db, added);
      return ok(200, { created, existing });
    }

    let m = path.match(/^\/api\/cabinets\/([\w-]+)$/);
    if (m && method === 'PUT') {
      const cab = Core.updateCabinet(db, m[1], body || {}, ctx);
      await saveArchive();
      return ok(200, cab);
    }
    if (m && method === 'DELETE') {
      const cab = Core.deleteCabinet(db, m[1]);
      await saveArchive();
      await Promise.all(cab.photos.map((p) => dropPhoto(cab.id, p.id)));
      return ok(200, { ok: true });
    }

    m = path.match(/^\/api\/cabinets\/([\w-]+)\/log$/);
    if (m && method === 'POST') {
      const cab = Core.addLog(db, m[1], body || {}, ctx);
      await saveArchive();
      return ok(201, cab);
    }

    m = path.match(/^\/api\/cabinets\/([\w-]+)\/log\/([\w-]+)$/);
    if (m && method === 'DELETE') {
      const cab = Core.deleteLog(db, m[1], m[2], ctx);
      await saveArchive();
      return ok(200, cab);
    }

    m = path.match(/^\/api\/cabinets\/([\w-]+)\/photos$/);
    if (m && method === 'POST') {
      Core.checkPhotoSlot(db, m[1]);
      if (!(body instanceof Blob)) throw new Core.CoreError(400, 'Foto mancante');
      if (body.size > Core.MAX_PHOTO_BYTES) throw new Core.CoreError(413, 'Contenuto troppo grande');
      Core.checkJpeg(new Uint8Array(await body.slice(0, 3).arrayBuffer()), body.type);
      const photo = Core.newPhoto(ctx);
      await write(STORE_PHOTOS, photoKey(m[1], photo.id), body);
      const cab = Core.addPhoto(db, m[1], photo);
      await saveArchive();
      return ok(201, cab);
    }

    m = path.match(/^\/api\/cabinets\/([\w-]+)\/photos\/([\w-]+)$/);
    if (m && method === 'DELETE') {
      const cab = Core.deletePhoto(db, m[1], m[2]);
      await saveArchive();
      await dropPhoto(m[1], m[2]);
      return ok(200, cab);
    }

    throw new Core.CoreError(404, 'Risorsa non trovata');
  }

  async function dropPhoto(cabId, photoId) {
    const key = photoKey(cabId, photoId);
    if (urls.has(key)) {
      URL.revokeObjectURL(urls.get(key));
      urls.delete(key);
    }
    await remove(STORE_PHOTOS, key);
  }

  // Le richieste vanno in fila una alla volta, come le scritture del server.
  let queue = Promise.resolve();
  function request(path, { method = 'GET', body, headers = {} } = {}) {
    const run = queue.then(async () => {
      try {
        return await handle(path.split('?')[0], method, body, headers);
      } catch (err) {
        if (err instanceof Core.CoreError) return { status: err.status, data: { error: err.message, ...(err.data ? copy(err.data) : {}) }, etag: null };
        throw err;
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  // Indirizzo da usare in <img src>: le foto locali non hanno un URL sul server.
  const urls = new Map();
  async function photoUrl(cabId, photoId) {
    const key = photoKey(cabId, photoId);
    if (urls.has(key)) return urls.get(key);
    const blob = await read(STORE_PHOTOS, key);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    urls.set(key, url);
    return url;
  }

  root.LocalApi = { request, photoUrl };
})(window);
