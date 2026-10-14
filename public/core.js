'use strict';

// Regole sulle cabine condivise da server (server.js) e app senza server
// (local-api.js): validazione dei dati e modifiche all'archivio. Nessun accesso
// a disco o rete qui: chi lo usa si occupa di salvare l'archivio.

(function (root) {
  const TYPES = ['PFP', 'PFS', 'PTE', 'PCN', 'POZZETTO', 'MUFFOLA', 'ALTRO'];
  const STATUSES = ['da_fare', 'in_corso', 'fatto', 'problema'];
  const MAX_PHOTOS = 6;
  const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
  const MAX_LOG_ENTRIES = 500;
  const MAX_IMPORT = 5000;

  // Errore con codice HTTP: il server lo trasforma in risposta, l'app senza server pure.
  class CoreError extends Error {
    constructor(status, message, data) {
      super(message);
      this.status = status;
      this.data = data;
    }
  }

  function cleanText(value, max) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') throw new CoreError(400, 'Valore di testo non valido');
    return value.trim().slice(0, max);
  }

  function cleanNumber(value, min, max, field) {
    const n = Number(value);
    if (value === '' || value === null || value === undefined || !Number.isFinite(n) || n < min || n > max) {
      throw new CoreError(400, `Valore non valido per ${field}`);
    }
    return n;
  }

  function cabinetFields(body) {
    const type = body.type === undefined ? 'ALTRO' : body.type;
    const status = body.status === undefined ? 'da_fare' : body.status;
    if (!TYPES.includes(type)) throw new CoreError(400, 'Tipo non valido');
    if (!STATUSES.includes(status)) throw new CoreError(400, 'Stato non valido');
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

  // Dati scritti a mano o da versioni precedenti: garantiamo i campi che il codice si aspetta.
  function normalize(db) {
    if (!db || typeof db !== 'object') db = {};
    if (!Array.isArray(db.cabinets)) db.cabinets = [];
    for (const cab of db.cabinets) {
      if (!Array.isArray(cab.photos)) cab.photos = [];
      if (!Array.isArray(cab.log)) cab.log = [];
      // Versione dei dati della cabina, che le note del diario non cambiano: per le cabine
      // salvate prima che esistesse vale l'ultima modifica nota.
      if (!cab.editedAt) cab.editedAt = cab.updatedAt || cab.createdAt;
    }
    db.version = 1;
    return db;
  }

  function findCabinet(db, id) {
    const cab = db.cabinets.find((c) => c.id === id);
    if (!cab) throw new CoreError(404, 'Cabina non trovata');
    return cab;
  }

  // ctx = { user, now (ISO), newId() }

  // Restituisce { cabinet, created }: created è false quando un salvataggio fatto
  // offline viene ritentato con lo stesso clientId (niente doppioni).
  function createCabinet(db, body, ctx) {
    const clientId = cleanText(body.clientId, 40);
    if (clientId) {
      const existing = db.cabinets.find((c) => c.clientId === clientId);
      if (existing) return { cabinet: existing, created: false };
    }
    const cab = {
      id: ctx.newId(),
      ...cabinetFields(body),
      photos: [],
      log: [],
      createdBy: ctx.user,
      createdAt: ctx.now,
      updatedBy: ctx.user,
      updatedAt: ctx.now,
      editedAt: ctx.now,
    };
    if (clientId) cab.clientId = clientId;
    db.cabinets.push(cab);
    return { cabinet: cab, created: true };
  }

  // Importazione di tanti punti insieme (es. da Google My Maps): o entrano tutti o nessuno.
  // Ogni punto ha un clientId fisso, così importare due volte lo stesso file non crea doppioni.
  function importCabinets(db, body, ctx) {
    const list = body && body.cabinets;
    if (!Array.isArray(list) || !list.length) throw new CoreError(400, 'Nessun punto da importare');
    if (list.length > MAX_IMPORT) throw new CoreError(400, `Al massimo ${MAX_IMPORT} punti per volta`);
    list.forEach((item, i) => {
      if (!item || typeof item !== 'object') throw new CoreError(400, `Punto ${i + 1} non valido`);
      try {
        cabinetFields(item);
        cleanText(item.clientId, 40);
      } catch (err) {
        throw new CoreError(400, `Punto ${i + 1} (${String(item.code || '').slice(0, 40) || 'senza nome'}): ${err.message}`);
      }
    });
    const added = [];
    let existing = 0;
    for (const item of list) {
      const result = createCabinet(db, item, ctx);
      if (!result.created) {
        existing += 1;
        continue;
      }
      // Ripristino da un backup di questa app: il diario interventi torna con la cabina.
      if (Array.isArray(item.log)) result.cabinet.log = importLog(item.log, ctx);
      added.push(result.cabinet);
    }
    return { created: added.length, existing, added };
  }

  function importLog(log, ctx) {
    const out = [];
    for (const e of log.slice(0, MAX_LOG_ENTRIES)) {
      if (!e || typeof e !== 'object' || typeof e.text !== 'string') continue;
      const text = e.text.trim().slice(0, 2000);
      if (!text) continue;
      const at = typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at).toISOString() : ctx.now;
      const by = typeof e.by === 'string' && e.by.trim() ? e.by.trim().slice(0, 40) : ctx.user;
      out.push({ id: ctx.newId(), by, at, text });
    }
    return out;
  }

  // "Annulla" subito dopo un'importazione: si tolgono le cabine importate (per clientId) da chi
  // annulla e che nessuno ha ancora toccato, cioè senza foto e mai modificate. Le altre restano.
  function undoImport(db, body, ctx) {
    const ids = body && body.clientIds;
    if (!Array.isArray(ids) || ids.length > MAX_IMPORT) throw new CoreError(400, 'Elenco non valido');
    const wanted = new Set(ids.filter((id) => typeof id === 'string' && id.startsWith('imp-')));
    const removed = db.cabinets.filter((c) => wanted.has(c.clientId) && c.createdBy === ctx.user
      && !c.photos.length && c.updatedAt === c.createdAt);
    const gone = new Set(removed);
    db.cabinets = db.cabinets.filter((c) => !gone.has(c));
    return removed;
  }

  // Se il salvataggio su disco fallisce si tolgono le cabine appena aggiunte: riprovando
  // vengono create (e salvate) davvero, invece di risultare "già presenti" solo in memoria.
  function undoCreate(db, cabinets) {
    const gone = new Set(cabinets);
    db.cabinets = db.cabinets.filter((c) => !gone.has(c));
  }

  // Il controllo dei conflitti guarda solo i dati della scheda (editedAt): una nota nel diario o
  // una foto aggiunte da un collega nel frattempo non bloccano la modifica. Se chi salva manda
  // di nuovo gli stessi dati (risposta persa per strada) non è un conflitto.
  function updateCabinet(db, id, body, ctx) {
    const cab = findCabinet(db, id);
    const fields = cabinetFields({ ...cab, ...body });
    const base = body.baseUpdatedAt;
    if (base && base !== (cab.editedAt || cab.updatedAt) && base !== cab.updatedAt) {
      if (Object.keys(fields).every((k) => fields[k] === cab[k])) return cab;
      const who = cab.updatedBy === ctx.user ? 'un altro tuo salvataggio' : cab.updatedBy;
      throw new CoreError(409, `Nel frattempo questa cabina è stata modificata da ${who}: controlla i dati e premi di nuovo Salva.`, { cabinet: cab });
    }
    Object.assign(cab, fields, { updatedBy: ctx.user, updatedAt: ctx.now, editedAt: ctx.now });
    return cab;
  }

  function deleteCabinet(db, id) {
    const cab = findCabinet(db, id);
    db.cabinets = db.cabinets.filter((c) => c !== cab);
    return cab;
  }

  function addLog(db, id, body, ctx) {
    const cab = findCabinet(db, id);
    const text = cleanText(body.text, 2000);
    if (!text) throw new CoreError(400, 'Scrivi una nota');
    // Stessa nota rimandata (doppio tocco, risposta persa): non si scrive due volte.
    const clientId = cleanText(body.clientId, 40);
    if (clientId && cab.log.some((e) => e.clientId === clientId)) return cab;
    cab.log.unshift({ id: ctx.newId(), by: ctx.user, at: ctx.now, text, ...(clientId ? { clientId } : {}) });
    cab.log = cab.log.slice(0, MAX_LOG_ENTRIES);
    cab.updatedBy = ctx.user;
    cab.updatedAt = ctx.now;
    return cab;
  }

  function deleteLog(db, id, logId, ctx) {
    const cab = findCabinet(db, id);
    const entry = cab.log.find((e) => e.id === logId);
    if (!entry) throw new CoreError(404, 'Nota non trovata');
    if (entry.by !== ctx.user) throw new CoreError(403, 'Puoi eliminare solo le tue note');
    cab.log = cab.log.filter((e) => e !== entry);
    return cab;
  }

  // Le foto si salvano in due tempi (prima il file, poi l'archivio): il controllo
  // va ripetuto dopo, perché nel frattempo la cabina può essere sparita o piena.
  function checkPhotoSlot(db, id) {
    const cab = findCabinet(db, id);
    if (cab.photos.length >= MAX_PHOTOS) throw new CoreError(400, `Massimo ${MAX_PHOTOS} foto per cabina`);
    return cab;
  }

  function checkJpeg(bytes, contentType) {
    if (!String(contentType || '').startsWith('image/jpeg')) throw new CoreError(415, 'Sono accettate solo foto JPEG');
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new CoreError(400, 'File JPEG non valido');
    }
  }

  function addPhoto(db, id, photo) {
    const cab = checkPhotoSlot(db, id);
    cab.photos.push(photo);
    return cab;
  }

  function newPhoto(ctx) {
    return { id: ctx.newId(), by: ctx.user, at: ctx.now };
  }

  function deletePhoto(db, id, photoId) {
    const cab = findCabinet(db, id);
    cab.photos = cab.photos.filter((p) => p.id !== photoId);
    return cab;
  }

  const api = {
    TYPES,
    STATUSES,
    MAX_PHOTOS,
    MAX_PHOTO_BYTES,
    MAX_LOG_ENTRIES,
    MAX_IMPORT,
    CoreError,
    cleanText,
    cleanNumber,
    cabinetFields,
    normalize,
    findCabinet,
    createCabinet,
    importCabinets,
    undoImport,
    undoCreate,
    updateCabinet,
    deleteCabinet,
    addLog,
    deleteLog,
    checkPhotoSlot,
    checkJpeg,
    addPhoto,
    newPhoto,
    deletePhoto,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CabineCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
