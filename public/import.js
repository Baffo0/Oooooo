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
  const MAX_LOG = 500;

  class ImportError extends Error {}

  const TYPES = ['PFP', 'PFS', 'PTE', 'PCN', 'POZZETTO', 'MUFFOLA', 'ALTRO'];
  const STATUSES = ['da_fare', 'in_corso', 'fatto', 'problema'];

  // Tipo scritto nel nome (anche dentro sigle come "NA_01_PFS_03").
  const TYPE_PATTERNS = [
    ['PFP', /(^|[^a-z])pfp([^a-z]|$)/i],
    ['PFS', /(^|[^a-z])pfs([^a-z]|$)/i],
    ['PTE', /(^|[^a-z])pte([^a-z]|$)/i],
    ['PCN', /(^|[^a-z])(pcn|pop)([^a-z]|$)/i],
    ['POZZETTO', /pozzett/i],
    ['MUFFOLA', /muffol/i],
  ];
  // Sigle che indicano il tipo, non la zona: "PFS_12" non è un gruppo.
  const TYPE_WORDS = new Set(['PFP', 'PFS', 'PTE', 'PCN', 'POP', 'PZ', 'MF']);

  function guessType(text) {
    if (!text) return null;
    for (const [type, re] of TYPE_PATTERNS) if (re.test(text)) return type;
    return null;
  }

  // Valori scritti in una colonna "tipo" o "stato" (anche quelli di questa app).
  function typeValue(value) {
    const v = String(value || '').trim();
    if (TYPES.includes(v.toUpperCase())) return v.toUpperCase();
    if (/^altro$/i.test(v)) return 'ALTRO';
    return guessType(v);
  }

  function statusValue(value) {
    const v = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (STATUSES.includes(v)) return v;
    if (/^(fatt[oa]|completat[oa]|chius[oa]|terminat[oa])$/.test(v)) return 'fatto';
    if (/^(in_lavorazione|aperto|in_corso)$/.test(v)) return 'in_corso';
    if (/^(guasto|ko|problem[ai])$/.test(v)) return 'problema';
    return null;
  }

  // ---------------------------------------------------------------------------
  // File: KMZ (ZIP), KML (XML) o GeoJSON
  // ---------------------------------------------------------------------------

  async function readFile(file) {
    if (file.size > MAX_FILE_BYTES) throw new ImportError('File troppo grande (massimo 30 MB)');
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return parseKml(decodeText(await kmlFromKmz(buf)), file.name);
    const text = decodeText(bytes);
    const start = text.trimStart().charAt(0);
    if (start === '{') return parseGeoJson(text, file.name);
    if (start === '<') return parseKml(text, file.name);
    throw new ImportError('Formato non riconosciuto: servono file KML, KMZ o GeoJSON');
  }

  // Quasi sempre UTF-8; i programmi più vecchi scrivono ancora in ISO-8859-1 o UTF-16.
  function decodeText(bytes) {
    let label = 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
    else {
      const head = String.fromCharCode(...bytes.subarray(0, 300));
      const m = head.match(/<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i);
      if (m) label = m[1];
    }
    let text;
    try {
      text = new TextDecoder(label).decode(bytes);
    } catch {
      label = 'utf-8';
      text = new TextDecoder('utf-8').decode(bytes);
    }
    // Lettere accentate non valide in UTF-8: il file è quasi certamente in Windows-1252.
    if (/^utf-?8$/i.test(label) && text.includes('�')) text = new TextDecoder('windows-1252').decode(bytes);
    return text.replace(/^﻿/, '');
  }

  // Un KMZ è uno ZIP con dentro il KML (di solito doc.kml): si legge l'indice in fondo al file.
  async function kmlFromKmz(buf) {
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    const bad = () => new ImportError('File KMZ non valido o danneggiato');
    let entry;
    let data;
    try {
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
        if (view.getUint32(p, true) !== 0x02014b50) throw bad();
        const nameLen = view.getUint16(p + 28, true);
        entries.push({
          method: view.getUint16(p + 10, true),
          compressed: view.getUint32(p + 20, true),
          local: view.getUint32(p + 42, true),
          name: new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen)),
        });
        p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
      }
      const kmls = entries.filter((e) => /\.kml$/i.test(e.name));
      entry = kmls.find((e) => /(^|\/)doc\.kml$/i.test(e.name)) || kmls[0];
      if (!entry) throw new ImportError('Nel file KMZ non c\'è nessuna mappa (KML)');
      if (view.getUint32(entry.local, true) !== 0x04034b50) throw bad();
      const start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
      data = bytes.subarray(start, start + entry.compressed);
      if (data.length !== entry.compressed) throw bad();
    } catch (err) {
      // Indici fuori dal file (RangeError) = ZIP rovinato.
      throw err instanceof ImportError ? err : bad();
    }
    if (entry.method === 0) return data;
    if (entry.method !== 8) throw new ImportError('Compressione del KMZ non supportata: esporta la mappa come KML');
    return inflate(data);
  }

  // Decompressione con un tetto: un file costruito apposta non deve riempire la memoria.
  async function inflate(data) {
    let stream;
    try {
      stream = new root.DecompressionStream('deflate-raw');
    } catch {
      throw new ImportError('Questo telefono non riesce ad aprire i KMZ: esporta la mappa come KML');
    }
    const reader = new Blob([data]).stream().pipeThrough(stream).getReader();
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
  function child(el, name) {
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) return c;
    return null;
  }
  const childText = (el, name) => (child(el, name)?.textContent || '').trim();
  const descendants = (el, name) => Array.from(el.getElementsByTagNameNS('*', name));

  const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);
  const HTML_ENTITIES = {
    nbsp: 160, egrave: 232, eacute: 233, agrave: 224, aacute: 225, ograve: 242, oacute: 243, ugrave: 249,
    uacute: 250, igrave: 236, iacute: 237, Egrave: 200, Eacute: 201, Agrave: 192, Ograve: 210, Ugrave: 217,
    Igrave: 204, deg: 176, euro: 8364, copy: 169, reg: 174, laquo: 171, raquo: 187, lsquo: 8216, rsquo: 8217,
    ldquo: 8220, rdquo: 8221, ndash: 8211, mdash: 8212, hellip: 8230, middot: 183, ordm: 186, ordf: 170,
  };
  const NAMESPACES = {
    gx: 'http://www.google.com/kml/ext/2.2',
    atom: 'http://www.w3.org/2005/Atom',
    xal: 'urn:oasis:names:tc:ciq:xsdschema:xAL:2.0',
    xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  };

  // Google Earth apre anche KML non del tutto regolari (&nbsp;, prefisso gx: non dichiarato):
  // al secondo tentativo si sistemano questi casi invece di rifiutare il file.
  function repairXml(text) {
    let fixed = text
      .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => {
        if (XML_ENTITIES.has(name)) return m;
        return HTML_ENTITIES[name] ? `&#${HTML_ENTITIES[name]};` : `&amp;${name};`;
      })
      .replace(/&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;');
    const missing = Object.keys(NAMESPACES).filter((p) => new RegExp(`[<\\s/]${p}:`).test(fixed) && !fixed.includes(`xmlns:${p}=`));
    if (missing.length) {
      const decl = missing.map((p) => ` xmlns:${p}="${NAMESPACES[p]}"`).join('');
      fixed = fixed.replace(/<([A-Za-z_][\w.-]*(?::[\w.-]+)?)(?=[\s>/])/, (m) => m + decl);
    }
    return fixed;
  }

  function parseXml(text) {
    const parse = (t) => {
      const doc = new root.DOMParser().parseFromString(t, 'application/xml');
      return doc.getElementsByTagName('parsererror').length || !doc.documentElement ? null : doc;
    };
    const doc = parse(text) || parse(repairXml(text));
    if (!doc) throw new ImportError('Il file non è un KML leggibile');
    return doc;
  }

  // Le descrizioni sono HTML (<br>, tabelle, link, grassetti): si tiene solo il testo.
  function htmlToText(html) {
    if (!html) return '';
    if (!/[<&]/.test(html)) return html.trim();
    const marked = html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h\d|table|ul|ol)>/gi, '\n')
      .replace(/<\/t[dh]>/gi, '\u0001');
    // Documento inerte: niente script eseguiti né immagini scaricate.
    const doc = new root.DOMParser().parseFromString(`<body>${marked}</body>`, 'text/html');
    doc.querySelectorAll('style, script, title, noscript, template').forEach((el) => el.remove());
    return (doc.body.textContent || '')
      .replace(/ /g, ' ')
      .split('\n')
      .map((line) => {
        const cells = line.split('\u0001').map((c) => c.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
        return cells.length === 2 ? `${cells[0]}: ${cells[1]}` : cells.join(' · ');
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function parseKml(text, fileName) {
    const doc = parseXml(text);
    const documentEl = descendants(doc, 'Document')[0];
    const docName = (documentEl && childText(documentEl, 'name')) || baseName(fileName);
    const placemarks = descendants(doc, 'Placemark');
    if (!placemarks.length && descendants(doc, 'NetworkLink').length) {
      throw new ImportError('Il file contiene solo il collegamento alla mappa online, non i punti. Su Google My Maps '
        + 'scaricalo di nuovo senza spuntare «Mantieni i dati aggiornati».');
    }
    const names = new Map(); // nome di ogni livello, letto una volta sola
    const levelName = (el) => {
      if (!names.has(el)) names.set(el, childText(el, 'name') || 'Senza nome');
      return names.get(el);
    };
    const points = [];
    const skipped = { notPoint: 0, invalid: 0 };
    for (const pm of placemarks) {
      const point = descendants(pm, 'Point')[0];
      if (!point) {
        skipped.notPoint += 1;
        continue;
      }
      const [lng, lat] = childText(point, 'coordinates').split(/[\s,]+/).filter(Boolean).map(Number);
      if (!validLatLng(lat, lng)) {
        skipped.invalid += 1;
        continue;
      }
      // Livelli di My Maps (Folder) e mappe unite in Google Earth (Document dentro Document).
      const levels = [];
      for (let el = pm.parentElement; el; el = el.parentElement) {
        if (el.localName === 'Folder' || (el.localName === 'Document' && el !== documentEl)) levels.unshift(levelName(el));
      }
      points.push(makePoint({
        name: childText(pm, 'name'),
        description: htmlToText(childText(pm, 'description')),
        fields: extendedData(pm),
        address: childText(pm, 'address'),
        lat,
        lng,
        folder: levels.join(' › '),
      }));
    }
    return finish(docName, points, skipped);
  }

  // Colonne della tabella di My Maps (<Data>) e dati dei livelli importati (<SimpleData>).
  function extendedData(pm) {
    const out = [];
    for (const d of descendants(pm, 'Data')) {
      const key = (d.getAttribute('name') || '').trim();
      if (key) out.push({ key, label: childText(d, 'displayName') || key, value: htmlToText(childText(d, 'value')) });
    }
    for (const d of descendants(pm, 'SimpleData')) {
      const key = (d.getAttribute('name') || '').trim();
      if (key) out.push({ key, label: key, value: htmlToText(d.textContent || '') });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // GeoJSON (anche l'esportazione di questa app)
  // ---------------------------------------------------------------------------

  const NAME_KEYS = ['name', 'nome', 'title', 'titolo', 'label', 'sigla'];
  const DESCRIPTION_KEYS = ['description', 'descrizione'];
  // Dati interni di questa app o stile della mappa: non sono informazioni sulla cabina.
  const SKIP_PROPS = /^(id|clientId|photos|accuracy|createdBy|createdAt|updatedBy|updatedAt|log|styleUrl|styleHash|styleMapHash|marker-.*|stroke.*|fill.*|icon.*|visibility|tessellate|extrude|begin|end|timestamp|altitudeMode|drawOrder)$/i;

  function parseGeoJson(text, fileName) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ImportError('Il file non è un GeoJSON leggibile');
    }
    const features = json && json.type === 'FeatureCollection' ? json.features : json && json.type === 'Feature' ? [json] : null;
    if (!Array.isArray(features)) throw new ImportError('Il file non è un GeoJSON con dei punti');
    const docName = (typeof json.name === 'string' && json.name) || baseName(fileName);
    const points = [];
    const skipped = { notPoint: 0, invalid: 0 };
    const str = (v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
    for (const f of features) {
      const coords = pointCoords(f && f.geometry);
      if (!coords.length) {
        skipped.notPoint += 1;
        continue;
      }
      const props = f.properties && typeof f.properties === 'object' ? f.properties : {};
      const nameKey = NAME_KEYS.find((k) => str(props[k]));
      const descKey = DESCRIPTION_KEYS.find((k) => str(props[k]));
      const fields = Object.keys(props)
        .filter((k) => k !== nameKey && k !== descKey && !SKIP_PROPS.test(k))
        .map((k) => ({ key: k, label: k, value: str(props[k]) }));
      for (const [lng, lat] of coords) {
        if (!validLatLng(lat, lng)) {
          skipped.invalid += 1;
          continue;
        }
        points.push(makePoint({
          name: nameKey ? str(props[nameKey]) : '',
          description: htmlToText(descKey ? str(props[descKey]) : ''),
          fields,
          address: '',
          lat,
          lng,
          folder: str(props.folder) || str(props.layer) || str(props.livello),
          log: Array.isArray(props.log) ? props.log : null,
        }));
      }
    }
    if (!points.length && skipped.invalid) {
      throw new ImportError('Le coordinate del file non sono in gradi (latitudine e longitudine): '
        + 'esportalo di nuovo in WGS 84 (EPSG:4326)');
    }
    return finish(docName, points, skipped);
  }

  // Punti singoli, gruppi di punti (MultiPoint) e collezioni miste.
  function pointCoords(g) {
    if (!g || typeof g !== 'object') return [];
    if (g.type === 'Point' && Array.isArray(g.coordinates)) return [g.coordinates.map(Number)];
    if (g.type === 'MultiPoint' && Array.isArray(g.coordinates)) return g.coordinates.filter(Array.isArray).map((c) => c.map(Number));
    if (g.type === 'GeometryCollection' && Array.isArray(g.geometries)) return g.geometries.flatMap(pointCoords);
    return [];
  }

  // ---------------------------------------------------------------------------
  // Punto pronto per l'app
  // ---------------------------------------------------------------------------

  const keyIs = (re) => (f) => re.test(f.key.trim());
  const ADDRESS_KEYS = [/^(indirizzo|address|ubicazione|posizione)$/i, /indirizzo|address/i];

  function makePoint({ name, description, fields, address, lat, lng, folder, log }) {
    const used = new Set();
    const take = (re) => {
      const f = fields.find((x) => !used.has(x) && keyIs(re)(x));
      if (f) used.add(f);
      return f;
    };
    // Esportazione di questa app (KML o GeoJSON): colonne codice, tipo, stato, indirizzo, note.
    const own = fields.some(keyIs(/^(codice|code)$/i)) && fields.some(keyIs(/^(tipo|type)$/i)) && fields.some(keyIs(/^(stato|status)$/i));
    const codeField = take(/^(codice|code)$/i);
    let code = (own && codeField ? codeField.value : name || codeField?.value || '').replace(/\s+/g, ' ').trim();
    const typeField = take(/^(tipo|type)$/i);
    const statusField = take(/^(stato|status)$/i);

    // Indirizzo: prima le colonne che si chiamano proprio così, poi via + civico + comune.
    let addr = address.replace(/\s+/g, ' ').trim();
    for (const re of ADDRESS_KEYS) {
      if (addr) break;
      const f = fields.find((x) => !used.has(x) && x.value && keyIs(re)(x));
      if (f) {
        used.add(f);
        addr = f.value.replace(/\s+/g, ' ');
      }
    }
    if (!addr) {
      const via = take(/^(via|strada|piazza)$/i);
      if (via && via.value) {
        const civico = take(/^(civico|n\.?|numero)$/i);
        const comune = take(/^(comune|citt[aà]|localit[aà])$/i);
        addr = [via.value + (civico && civico.value ? ` ${civico.value}` : ''), comune && comune.value].filter(Boolean).join(', ');
      }
    }

    // Note: la descrizione e le altre colonne, senza ripetere ciò che è già altrove.
    const noteFields = fields.filter((x) => !used.has(x) && keyIs(/^(note|notes|descrizione|description|descr|desc)$/i)(x));
    noteFields.forEach((f) => used.add(f));
    const media = fields.filter((x) => keyIs(/^gx_media_links$/i)(x));
    media.forEach((f) => used.add(f));
    const rest = fields.filter((x) => !used.has(x) && x.value);
    // My Maps ripete tutte le colonne nella descrizione come "colonna: valore": se è così,
    // le note si costruiscono dalle colonne (senza etichette doppie e senza l'indirizzo).
    const lines = description.split('\n').map((l) => l.trim()).filter(Boolean);
    const labels = new Set(fields.flatMap((f) => [f.key.toLowerCase(), f.label.toLowerCase()]));
    const dump = own || (lines.length > 0 && fields.length > 0
      && lines.every((l) => labels.has(l.split(':')[0].trim().toLowerCase())));
    const parts = [];
    if (code.length > MAX_CODE) parts.push(code);
    if (dump) {
      parts.push(...noteFields.map((f) => f.value).filter(Boolean));
      parts.push(...rest.map((f) => `${f.label}: ${f.value}`));
    } else {
      if (description) parts.push(description);
      const has = (l) => lines.some((x) => x.toLowerCase() === l.toLowerCase());
      for (const f of [...noteFields, ...rest]) {
        if (!f.value || has(f.value) || has(`${f.label}: ${f.value}`) || has(`${f.key}: ${f.value}`)) continue;
        parts.push(noteFields.includes(f) ? f.value : `${f.label}: ${f.value}`);
      }
    }
    media.filter((f) => f.value).forEach((f) => parts.push(`Foto su My Maps: ${f.value.replace(/\s+/g, ' ')}`));
    if (folder) parts.push(`Livello: ${folder}`);

    const idName = code.slice(0, MAX_CODE);
    return {
      code: idName,
      idName,
      address: addr.slice(0, MAX_ADDRESS),
      notes: parts.join('\n').slice(0, MAX_NOTES),
      lat: round6(lat),
      lng: round6(lng),
      folder,
      type: (typeField && typeValue(typeField.value)) || guessType(code),
      status: (statusField && statusValue(statusField.value)) || null,
      log: own && log ? cleanLog(log) : [],
    };
  }

  function cleanLog(log) {
    return log
      .filter((e) => e && typeof e === 'object' && typeof e.text === 'string' && e.text.trim())
      .slice(0, MAX_LOG)
      .map((e) => ({ by: typeof e.by === 'string' ? e.by : '', at: typeof e.at === 'string' ? e.at : '', text: e.text }));
  }

  // ---------------------------------------------------------------------------
  // Gruppi tra cui scegliere
  // ---------------------------------------------------------------------------

  // Sigla di zona nel nome, ovunque si trovi: "NA_01_PFS_03", "PFS NA-01 3", "NA01PFS03".
  function zoneTokens(name) {
    const out = [];
    const re = /(?:^|[^A-Za-z0-9])(?:([A-Za-z]{2,4})[_-]|([A-Z]{2,4}))(\d{1,3})(?![0-9])/g;
    for (const m of name.matchAll(re)) {
      const letters = (m[1] || m[2]).toUpperCase();
      if (!TYPE_WORDS.has(letters)) out.push({ letters, number: Number(m[3]) });
    }
    return out;
  }

  const sortGroups = (a, b) => {
    const last = (g) => (/^Senza /.test(g.name) ? 1 : 0);
    return last(a) - last(b) || a.name.localeCompare(b.name, 'it', { numeric: true, sensitivity: 'base' });
  };

  function finish(docName, points, skipped) {
    // Lo stesso nome in più livelli (es. "PFS 1" in NA_01 e in NA_02): il codice prende anche il
    // nome del livello, altrimenti in app non si distinguerebbero.
    const layersOf = new Map();
    for (const p of points) {
      if (!p.code || !p.folder) continue;
      const key = p.code.toLowerCase();
      if (!layersOf.has(key)) layersOf.set(key, new Set());
      layersOf.get(key).add(p.folder);
    }
    for (const p of points) {
      const leaf = p.folder.split(' › ').pop();
      if (p.code && p.folder && layersOf.get(p.code.toLowerCase()).size > 1 && !p.code.toLowerCase().includes(leaf.toLowerCase())) {
        p.code = `${leaf} ${p.code}`.slice(0, MAX_CODE);
      }
      p.clientId = pointId(p);
    }

    // 1) i livelli della mappa
    const folders = new Set(points.map((p) => p.folder));
    const layers = folders.size > 1 ? countGroups(points, (p) => p.folder || 'Senza livello') : null;

    // 2) le sigle di zona nei nomi (es. NA_01, CE_03): solo quelle che tornano in più punti
    let codes = null;
    const perLetters = new Map();
    for (const p of points) {
      for (const letters of new Set(zoneTokens(p.idName).map((t) => t.letters))) {
        perLetters.set(letters, (perLetters.get(letters) || 0) + 1);
      }
    }
    const zones = new Set([...perLetters].filter(([, n]) => n >= Math.max(2, points.length * 0.1)).map(([l]) => l));
    const zone = (p) => {
      const t = zoneTokens(p.idName).find((x) => zones.has(x.letters));
      return t ? `${t.letters}_${String(t.number).padStart(2, '0')}` : 'Senza sigla';
    };
    if (zones.size && points.filter((p) => zone(p) !== 'Senza sigla').length >= points.length * 0.3) {
      const groups = countGroups(points, zone);
      if (groups.list.filter((g) => g.name !== 'Senza sigla').length >= 2) codes = groups;
    }
    // Se livelli e sigle dicono la stessa cosa basta una scelta.
    if (layers && codes && sameSplit(points, layers.key, codes.key)) codes = null;

    const groupings = {};
    if (layers) groupings.layers = layers.list;
    if (codes) groupings.codes = codes.list;
    if (!layers && !codes) groupings.layers = countGroups(points, () => [...folders][0] || docName || 'Tutti i punti').list;
    for (const p of points) {
      p.groups = {};
      if (groupings.layers) p.groups.layers = (layers ? layers.key(p) : groupings.layers[0].name);
      if (codes) p.groups.codes = codes.key(p);
    }
    return {
      name: docName,
      points,
      groupings,
      // Chi divide per zone le scrive di solito nel nome (es. NA_01): si propone quella divisione.
      defaultGrouping: codes ? 'codes' : 'layers',
      skipped,
    };
  }

  function countGroups(points, key) {
    const counts = new Map();
    for (const p of points) {
      const k = key(p);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return { key, list: [...counts.entries()].map(([name, count]) => ({ name, count })).sort(sortGroups) };
  }

  // Ogni gruppo di una divisione corrisponde a un solo gruppo dell'altra.
  function sameSplit(points, keyA, keyB) {
    const ab = new Map();
    const ba = new Map();
    for (const p of points) {
      const a = keyA(p);
      const b = keyB(p);
      if ((ab.has(a) && ab.get(a) !== b) || (ba.has(b) && ba.get(b) !== a)) return false;
      ab.set(a, b);
      ba.set(b, a);
    }
    return true;
  }

  function validLatLng(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0);
  }

  const round6 = (n) => Math.round(n * 1e6) / 1e6;
  const baseName = (fileName) => String(fileName || '').replace(/\.[^.]+$/, '');

  // Identificativo fisso per ogni punto (dal nome originale e dalla posizione): reimportando
  // lo stesso file il server riconosce quelli già presenti, come i salvataggi offline ritentati.
  function pointId(p) {
    const s = `${(p.idName ?? p.code).toLowerCase()}|${p.lat.toFixed(6)}|${p.lng.toFixed(6)}`;
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    return `imp-${h1.toString(36)}${h2.toString(36)}`;
  }

  root.CabineImport = { readFile, parseKml, parseGeoJson, kmlFromKmz, decodeText, htmlToText, guessType, zoneTokens, pointId, ImportError };
})(window);
