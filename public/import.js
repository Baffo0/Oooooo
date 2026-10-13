'use strict';

// Lettura dei punti da importare: mappe di Google My Maps o Google Earth (KML, KMZ) e
// GeoJSON (anche quello esportato da questa app). Tutto avviene nel telefono: il file
// non viene mandato a nessun servizio esterno.

(function (root) {
  const MAX_FILE_BYTES = 30 * 1024 * 1024;
  const MAX_KML_BYTES = 60 * 1024 * 1024; // KML estratto da un KMZ
  const MAX_CODE = 80;
  const MAX_ADDRESS = 200;
  const MAX_NOTES = 4000;

  class ImportError extends Error {}

  // Tipo riconosciuto dal nome (anche dentro sigle come "NA_01_PFS_03").
  const TYPE_PATTERNS = [
    ['PFP', /(^|[^a-z])pfp([^a-z]|$)/i],
    ['PFS', /(^|[^a-z])pfs([^a-z]|$)/i],
    ['PTE', /(^|[^a-z])pte([^a-z]|$)/i],
    ['PCN', /(^|[^a-z])(pcn|pop)([^a-z]|$)/i],
    ['POZZETTO', /pozzett/i],
    ['MUFFOLA', /muffol|giunt/i],
  ];
  const TYPES = ['PFP', 'PFS', 'PTE', 'PCN', 'POZZETTO', 'MUFFOLA', 'ALTRO'];
  const STATUSES = ['da_fare', 'in_corso', 'fatto', 'problema'];

  function guessType(...texts) {
    for (const text of texts) {
      if (!text) continue;
      for (const [type, re] of TYPE_PATTERNS) if (re.test(text)) return type;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // File: KMZ (ZIP), KML (XML) o GeoJSON
  // ---------------------------------------------------------------------------

  async function readFile(file) {
    if (file.size > MAX_FILE_BYTES) throw new ImportError('File troppo grande (massimo 30 MB)');
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return parseKml(await kmlFromKmz(buf), file.name);
    const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
    const start = text.trimStart().charAt(0);
    if (start === '{') return parseGeoJson(text, file.name);
    if (start === '<') return parseKml(text, file.name);
    throw new ImportError('Formato non riconosciuto: servono file KML, KMZ o GeoJSON');
  }

  // Un KMZ è uno ZIP con dentro il KML (di solito doc.kml): si legge l'indice in fondo al file.
  async function kmlFromKmz(buf) {
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    const bad = () => new ImportError('File KMZ non valido o danneggiato');
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw bad();
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const entries = [];
    for (let n = 0; n < count; n++) {
      if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) throw bad();
      const nameLen = view.getUint16(p + 28, true);
      entries.push({
        method: view.getUint16(p + 10, true),
        compressed: view.getUint32(p + 20, true),
        size: view.getUint32(p + 24, true),
        local: view.getUint32(p + 42, true),
        name: new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen)),
      });
      p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    }
    const kmls = entries.filter((e) => /\.kml$/i.test(e.name));
    const entry = kmls.find((e) => /(^|\/)doc\.kml$/i.test(e.name)) || kmls[0];
    if (!entry) throw new ImportError('Nel file KMZ non c\'è nessuna mappa (KML)');
    if (entry.local + 30 > bytes.length || view.getUint32(entry.local, true) !== 0x04034b50) throw bad();
    const start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
    const data = bytes.subarray(start, start + entry.compressed);
    if (data.length !== entry.compressed) throw bad();
    let out;
    if (entry.method === 0) {
      out = data;
    } else if (entry.method === 8) {
      if (typeof root.DecompressionStream === 'undefined') {
        throw new ImportError('Questo telefono non riesce ad aprire i KMZ: esporta la mappa come KML');
      }
      out = await inflate(data);
    } else {
      throw new ImportError('Compressione del KMZ non supportata: esporta la mappa come KML');
    }
    return new TextDecoder('utf-8').decode(out).replace(/^﻿/, '');
  }

  // Decompressione con un tetto: un file costruito apposta non deve riempire la memoria.
  async function inflate(data) {
    const reader = new Blob([data]).stream().pipeThrough(new root.DecompressionStream('deflate-raw')).getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_KML_BYTES) {
          reader.cancel().catch(() => {});
          throw new ImportError('La mappa dentro il KMZ è troppo grande');
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof ImportError) throw err;
      throw new ImportError('File KMZ non valido o danneggiato');
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // KML (Google My Maps, Google Earth)
  // ---------------------------------------------------------------------------

  // Figli e discendenti per nome locale: funziona con e senza prefisso "kml:".
  const childrenNamed = (el, name) => Array.from(el.children).filter((c) => c.localName === name);
  const childText = (el, name) => (childrenNamed(el, name)[0]?.textContent || '').trim();
  const descendants = (el, name) => Array.from(el.getElementsByTagNameNS('*', name));

  // Le descrizioni di My Maps sono HTML (<br>, link, grassetti): si tiene solo il testo.
  function htmlToText(html) {
    if (!html) return '';
    if (!/[<&]/.test(html)) return html.trim();
    const withBreaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n');
    // Documento inerte: niente script eseguiti né immagini scaricate.
    const doc = new root.DOMParser().parseFromString(`<body>${withBreaks}</body>`, 'text/html');
    return (doc.body.textContent || '')
      .replace(/ /g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function parseKml(text, fileName) {
    const doc = new root.DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length || !doc.documentElement) {
      throw new ImportError('Il file non è un KML leggibile');
    }
    const documentEl = descendants(doc, 'Document')[0];
    const docName = (documentEl && childText(documentEl, 'name')) || baseName(fileName);
    const points = [];
    const skipped = { notPoint: 0, invalid: 0 };
    for (const pm of descendants(doc, 'Placemark')) {
      const point = descendants(pm, 'Point')[0];
      if (!point) {
        skipped.notPoint += 1;
        continue;
      }
      const coords = childText(point, 'coordinates').split(/[\s,]+/).filter(Boolean).map(Number);
      const [lng, lat] = coords;
      if (!validLatLng(lat, lng)) {
        skipped.invalid += 1;
        continue;
      }
      const folders = [];
      for (let el = pm.parentElement; el; el = el.parentElement) {
        if (el.localName === 'Folder') folders.unshift(childText(el, 'name') || 'Senza nome');
      }
      const fields = extendedData(pm);
      points.push(makePoint({
        name: childText(pm, 'name'),
        description: htmlToText(childText(pm, 'description')),
        fields,
        lat,
        lng,
        folder: folders.join(' › '),
        docName,
      }));
    }
    return finish(docName, points, skipped);
  }

  // Colonne della tabella di My Maps (<Data>) e dati dei livelli importati (<SimpleData>).
  function extendedData(pm) {
    const out = [];
    for (const d of descendants(pm, 'Data')) {
      const name = (d.getAttribute('name') || '').trim();
      const value = htmlToText(childText(d, 'value'));
      if (name && value) out.push([childText(d, 'displayName') || name, value]);
    }
    for (const d of descendants(pm, 'SimpleData')) {
      const name = (d.getAttribute('name') || '').trim();
      const value = htmlToText(d.textContent || '');
      if (name && value) out.push([name, value]);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // GeoJSON (anche l'esportazione di questa app)
  // ---------------------------------------------------------------------------

  function parseGeoJson(text, fileName) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ImportError('Il file non è un GeoJSON leggibile');
    }
    const features = json.type === 'FeatureCollection' ? json.features : json.type === 'Feature' ? [json] : null;
    if (!Array.isArray(features)) throw new ImportError('Il file non è un GeoJSON con dei punti');
    const docName = (typeof json.name === 'string' && json.name) || baseName(fileName);
    const points = [];
    const skipped = { notPoint: 0, invalid: 0 };
    for (const f of features) {
      const g = f && f.geometry;
      if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) {
        skipped.notPoint += 1;
        continue;
      }
      const [lng, lat] = g.coordinates.map(Number);
      if (!validLatLng(lat, lng)) {
        skipped.invalid += 1;
        continue;
      }
      const props = f.properties && typeof f.properties === 'object' ? f.properties : {};
      const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
      const name = str(props.code) || str(props.name) || str(props.nome) || str(props.title);
      const known = new Set(['code', 'name', 'nome', 'title', 'description', 'descrizione', 'notes', 'note', 'type', 'tipo',
        'status', 'stato', 'address', 'indirizzo', 'id', 'clientId', 'photos', 'log', 'accuracy', 'createdBy', 'createdAt',
        'updatedBy', 'updatedAt']);
      const fields = Object.entries(props)
        .filter(([k, v]) => !known.has(k) && str(v))
        .map(([k, v]) => [k, str(v)]);
      const point = makePoint({
        name,
        description: str(props.notes) || str(props.note) || htmlToText(str(props.description) || str(props.descrizione)),
        fields: [...(str(props.address) || str(props.indirizzo) ? [['indirizzo', str(props.address) || str(props.indirizzo)]] : []), ...fields],
        lat,
        lng,
        folder: str(props.folder) || str(props.layer) || str(props.livello),
        docName,
      });
      // Tipo e stato già nel formato dell'app (es. un backup esportato da qui).
      const type = str(props.type) || str(props.tipo);
      if (TYPES.includes(type.toUpperCase())) point.type = type.toUpperCase();
      const status = str(props.status) || str(props.stato);
      if (STATUSES.includes(status)) point.status = status;
      points.push(point);
    }
    return finish(docName, points, skipped);
  }

  // ---------------------------------------------------------------------------
  // Punto pronto per l'app
  // ---------------------------------------------------------------------------

  const ADDRESS_KEY = /indirizzo|address|ubicazione|via\b|localit|civico/i;

  function makePoint({ name, description, fields, lat, lng, folder, docName }) {
    const code = name.replace(/\s+/g, ' ').trim();
    let address = '';
    const extra = [];
    for (const [key, value] of fields) {
      if (/^gx_media_links$/i.test(key)) {
        extra.push(`Foto su My Maps: ${value}`);
      } else if (!address && ADDRESS_KEY.test(key)) {
        address = value.replace(/\s+/g, ' ');
      } else if (!description.includes(value)) {
        // My Maps ripete le colonne anche nella descrizione: si aggiunge solo ciò che manca.
        extra.push(`${key}: ${value}`);
      }
    }
    const notes = [code.length > MAX_CODE ? code : '', description, ...extra].filter(Boolean).join('\n');
    return {
      code: code.slice(0, MAX_CODE),
      address: address.slice(0, MAX_ADDRESS),
      notes: notes.slice(0, MAX_NOTES),
      lat: round6(lat),
      lng: round6(lng),
      folder,
      type: guessType(code, folder, description),
      docType: guessType(docName),
      status: null,
    };
  }

  // Gruppi tra cui scegliere: i livelli della mappa; se la mappa ha un solo livello,
  // le sigle all'inizio dei nomi (es. "NA_01", "NA_02").
  function finish(docName, points, skipped) {
    const folders = new Set(points.map((p) => p.folder));
    let key = (p) => p.folder || 'Senza livello';
    if (folders.size <= 1) {
      const prefix = (p) => {
        const m = p.code.match(/^\s*([a-z]{1,6})[\s_.-]?(\d{1,4})(?!\d)/i);
        return m ? `${m[1].toUpperCase()}_${m[2]}` : null;
      };
      const withPrefix = points.filter((p) => prefix(p)).length;
      const distinct = new Set(points.map(prefix).filter(Boolean)).size;
      // Sigle condivise da più punti (non un numero diverso per ogni punto).
      if (distinct >= 2 && distinct <= points.length / 3 && withPrefix >= points.length * 0.6) {
        key = (p) => prefix(p) || 'Altri';
      } else {
        key = (p) => p.folder || docName || 'Tutti i punti';
      }
    }
    const groups = new Map();
    for (const p of points) {
      p.group = key(p);
      groups.set(p.group, (groups.get(p.group) || 0) + 1);
    }
    const names = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'it', { numeric: true, sensitivity: 'base' }));
    return {
      name: docName,
      points,
      groups: names.map((name) => ({ name, count: groups.get(name) })),
      skipped,
    };
  }

  function validLatLng(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0);
  }

  const round6 = (n) => Math.round(n * 1e6) / 1e6;
  const baseName = (fileName) => String(fileName || '').replace(/\.[^.]+$/, '');

  // Identificativo fisso per ogni punto: reimportando lo stesso file il server riconosce
  // quelli già presenti (stesso meccanismo dei salvataggi offline ritentati).
  function pointId(p) {
    const s = `${p.code.toLowerCase()}|${p.lat.toFixed(6)}|${p.lng.toFixed(6)}`;
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    return `imp-${h1.toString(36)}${h2.toString(36)}`;
  }

  root.CabineImport = { readFile, parseKml, parseGeoJson, kmlFromKmz, guessType, pointId, ImportError };
})(window);
