'use strict';

// Lettura dei punti da importare: mappe di Google My Maps o Google Earth (KML, KMZ) e
// GeoJSON (anche quello esportato da questa app). Tutto avviene nel telefono: il file
// non viene mandato a nessun servizio esterno.

(function (root) {
  // Una mappa di My Maps intera pesa pochi MB: oltre, il telefono rischierebbe di esaurire la memoria.
  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  const MAX_KML_BYTES = 25 * 1024 * 1024; // KML estratto da un KMZ
  const MAX_CODE = 80;
  const MAX_ADDRESS = 200;
  const MAX_NOTES = 4000;
  const MAX_LOG = 500;

  class ImportError extends Error {}

  const TYPES = ['PFP', 'PFS', 'PTE', 'PCN', 'POZZETTO', 'MUFFOLA', 'ALTRO'];
  const STATUSES = ['da_fare', 'in_corso', 'fatto', 'problema'];

  // Tipo scritto nel nome (anche dentro sigle come "NA_01_PFS_03"). Nei codici gerarchici
  // (NA_01_PFP_02_PFS_05) vale la sigla più a destra; le parole contano solo senza sigle,
  // perché "Pozzetto" può essere anche il nome di una via.
  const TYPE_TOKENS = /(?:^|[^a-z])(pfp|pfs|pte|pcn|pop)(?=[^a-z]|$)/gi;
  const TOKEN_TYPES = { PFP: 'PFP', PFS: 'PFS', PTE: 'PTE', PCN: 'PCN', POP: 'PCN' };
  const TYPE_WORDS_RE = [['POZZETTO', /pozzett/i], ['MUFFOLA', /muffol/i]];
  // Sigle che indicano il tipo, non la zona: "PFS_12" non è un gruppo.
  const TYPE_WORDS = new Set(['PFP', 'PFS', 'PTE', 'PCN', 'POP', 'PZ', 'MF']);

  function guessType(text) {
    if (!text) return null;
    const tokens = [...String(text).matchAll(TYPE_TOKENS)];
    if (tokens.length) return TOKEN_TYPES[tokens[tokens.length - 1][1].toUpperCase()];
    for (const [type, re] of TYPE_WORDS_RE) if (re.test(text)) return type;
    return null;
  }

  // Caratteri di controllo (da fogli di calcolo o GeoJSON): renderebbero non valido il KML esportato.
  const clean = (s) => String(s || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');

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
    if (file.size > MAX_FILE_BYTES) throw new ImportError('File troppo grande (massimo 20 MB)');
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
    let decoder;
    try {
      decoder = new TextDecoder(label);
    } catch {
      label = 'utf-8';
    }
    let text;
    if (/^utf-?8$/i.test(label)) {
      // Byte non validi in UTF-8: il file è quasi certamente in Windows-1252 (lettere accentate).
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        text = new TextDecoder('windows-1252').decode(bytes);
      }
    } else {
      text = decoder.decode(bytes);
    }
    return text.replace(/^\uFEFF/, '');
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
    let fixed = text.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/).map((part, i) => (i % 2 ? part : part
      .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => {
        if (XML_ENTITIES.has(name)) return m;
        return HTML_ENTITIES[name] ? `&#${HTML_ENTITIES[name]};` : `&amp;${name};`;
      })
      .replace(/&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;'))).join('');
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
      .replace(/\u00a0/g, ' ')
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
      // Di solito un punto solo; in un MultiGeometry di Google Earth anche più di uno.
      const pts = descendants(pm, 'Point');
      if (!pts.length) {
        skipped.notPoint += 1;
        continue;
      }
      // Livelli di My Maps (Folder) e mappe unite in Google Earth (Document dentro Document).
      const levels = [];
      for (let el = pm.parentElement; el; el = el.parentElement) {
        if (el.localName === 'Folder' || (el.localName === 'Document' && el !== documentEl)) levels.unshift(levelName(el));
      }
      const info = {
        name: childText(pm, 'name'),
        description: htmlToText(childText(pm, 'description')),
        fields: extendedData(pm),
        address: childText(pm, 'address'),
        folder: levels.join(' › '),
      };
      for (const point of pts) {
        const [lng, lat] = childText(point, 'coordinates').split(/[\s,]+/).filter(Boolean).map(Number);
        if (validLatLng(lat, lng)) points.push(makePoint({ ...info, lat, lng }));
        else skipped.invalid += 1;
      }
    }
    return finish(docName, points, skipped);
  }

  // Colonne della tabella di My Maps (<Data>) e dati dei livelli importati (<SimpleData>).
  // Il testo passa da htmlToText solo se contiene davvero HTML: "<scala B>" resta com'è.
  const MARKUP = /<\/?(br|p|div|a|b|i|u|em|strong|span|font|table|tr|td|th|ul|ol|li|img|h\d)\b/i;
  const cellText = (raw) => (MARKUP.test(raw) ? htmlToText(raw) : raw.trim());
  function extendedData(pm) {
    const out = [];
    for (const d of descendants(pm, 'Data')) {
      const key = (d.getAttribute('name') || '').trim();
      if (key) out.push({ key, label: childText(d, 'displayName') || key, value: cellText(child(d, 'value')?.textContent || '') });
    }
    for (const d of descendants(pm, 'SimpleData')) {
      const key = (d.getAttribute('name') || '').trim();
      if (key) out.push({ key, label: key, value: cellText(d.textContent || '') });
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
    const type = json && json.type;
    const features = type === 'FeatureCollection' ? json.features : type === 'Feature' ? [json]
      : ['Point', 'MultiPoint', 'GeometryCollection'].includes(type) ? [{ type: 'Feature', geometry: json, properties: {} }] : null;
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
      // "Name" di QGIS, "NOME" di un foglio Excel: senza badare alle maiuscole.
      const keyOf = (list) => {
        for (const n of list) {
          const k = Object.keys(props).find((x) => x.toLowerCase() === n && str(props[x]));
          if (k) return k;
        }
        return undefined;
      };
      const nameKey = keyOf(NAME_KEYS);
      const descKey = keyOf(DESCRIPTION_KEYS);
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
  const squash = (v) => String(v || '').replace(/\s+/g, ' ').trim();

  // Esportazione di questa app (KML o GeoJSON): colonne codice, tipo e stato con i valori
  // esatti dell'app. Una tabella di My Maps con colonne dai nomi simili non viene confusa.
  function ownExport(fields) {
    const get = (...keys) => fields.find((f) => keys.includes(f.key));
    const tipo = get('tipo', 'type');
    const stato = get('stato', 'status');
    return Boolean(get('codice', 'code') && tipo && stato && TYPES.includes(tipo.value) && STATUSES.includes(stato.value));
  }

  function makePoint({ name, description, fields, address, lat, lng, folder, log }) {
    name = squash(clean(name));
    description = clean(description);
    fields = fields.map((f) => ({ ...f, value: clean(f.value) }));
    const used = new Set();
    const find = (re) => fields.find((x) => !used.has(x) && keyIs(re)(x));
    const own = ownExport(fields);

    // Codice: il nome del punto. La colonna "codice" vale per l'esportazione dell'app o se il
    // nome manca; altrimenti, se diversa dal nome, resta nelle note.
    let code = name;
    const codeField = find(/^(codice|code)$/i);
    if (codeField && (own || !name || squash(codeField.value).toLowerCase() === name.toLowerCase())) {
      used.add(codeField);
      if (own || !name) code = squash(codeField.value);
    }
    // Tipo e stato dalle colonne solo se il valore si riconosce; altrimenti restano nelle note.
    const typeField = find(/^(tipo|type)$/i);
    const type = typeField ? typeValue(typeField.value) : null;
    if (type) used.add(typeField);
    const statusField = find(/^(stato|status)$/i);
    const status = statusField ? statusValue(statusField.value) : null;
    if (status) used.add(statusField);

    // Indirizzo: prima le colonne che si chiamano proprio così, poi via/strada; civico e comune
    // in colonne a parte si aggiungono.
    let addr = squash(clean(address));
    for (const re of ADDRESS_KEYS) {
      if (addr) break;
      const f = fields.find((x) => !used.has(x) && x.value && keyIs(re)(x));
      if (f) {
        used.add(f);
        addr = squash(f.value);
      }
    }
    if (!addr) {
      const via = find(/^(via|strada|piazza)$/i);
      if (via && via.value) {
        used.add(via);
        addr = squash(via.value);
      }
    }
    if (addr) {
      const civico = find(/^(civico|n\.?|numero|n\.?\s*civico|numero civico)$/i);
      if (civico && civico.value && !/\d/.test(addr)) {
        used.add(civico);
        addr += ` ${squash(civico.value)}`;
      }
      const comune = find(/^(comune|citt[aà]|localit[aà])$/i);
      if (comune && comune.value) {
        used.add(comune);
        if (!addr.toLowerCase().includes(squash(comune.value).toLowerCase())) addr += `, ${squash(comune.value)}`;
      }
    }

    // Note: la descrizione e le altre colonne, senza ripetere ciò che è già altrove.
    const noteFields = fields.filter((x) => !used.has(x) && keyIs(/^(note|notes|descrizione|description|descr|desc)$/i)(x));
    noteFields.forEach((f) => used.add(f));
    const media = fields.filter(keyIs(/^gx_media_links$/i));
    media.forEach((f) => used.add(f));
    const rest = fields.filter((x) => !used.has(x) && x.value);
    // My Maps ripete tutte le colonne nella descrizione come "colonna: valore" (anche su più
    // righe): se è così, le note si costruiscono dalle colonne, senza etichette doppie.
    const lines = description.split('\n').map((l) => l.trim()).filter(Boolean);
    const expected = new Set(fields.flatMap((f) => [`${f.label}: ${f.value}`, `${f.key}: ${f.value}`])
      .flatMap((x) => x.split('\n')).map((l) => l.trim().toLowerCase()));
    const dump = own || (lines.length > 0 && fields.length > 0 && lines.every((l) => expected.has(l.toLowerCase())));
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
    media.filter((f) => f.value).forEach((f) => parts.push(`Foto su My Maps: ${squash(f.value)}`));
    if (folder) parts.push(`Livello: ${folder}`);

    const idName = code.slice(0, MAX_CODE);
    return {
      code: idName,
      idName,
      address: addr.slice(0, MAX_ADDRESS),
      notes: parts.join('\n').slice(0, MAX_NOTES),
      lat: round6(lat),
      lng: round6(lng),
      folder: clean(folder),
      type: type || guessType(code),
      status,
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

  // Sigla di zona nel nome, ovunque si trovi: "NA_01_PFS_03", "PFS NA-01 3", "NA 01", "NA.01",
  // "NA01PFS03", "NAPOLI_01". Le cifre restano come sono: NA_001 non è la zona NA_01.
  function zoneTokens(name) {
    const out = [];
    const re = /(?:^|[^A-Za-z0-9])(?:([A-Za-z]{2,6})[_-]|([A-Z]{2,3})[ .]?|([A-Z]{4,6}))(\d{1,3})(?![0-9])/g;
    for (const m of String(name).matchAll(re)) {
      const letters = (m[1] || m[2] || m[3]).toUpperCase();
      if (!TYPE_WORDS.has(letters)) out.push({ letters, digits: m[4].padStart(2, '0') });
    }
    return out;
  }

  const sortGroups = (a, b) => {
    const last = (g) => (/^Senza /.test(g.name) ? 1 : 0);
    return last(a) - last(b) || a.name.localeCompare(b.name, 'it', { numeric: true, sensitivity: 'base' });
  };
  const leafOf = (folder) => folder.split(' › ').pop();

  function finish(docName, points, skipped) {
    // Lo stesso nome per punti diversi in più livelli (es. "PFS 1" in NA_01 e in NA_02): il
    // codice prende anche il nome del livello, altrimenti in app non si distinguerebbero.
    // Le copie identiche (stesso nome, stessa posizione) restano come sono.
    const seen = new Map();
    for (const p of points) {
      if (!p.code || !p.folder) continue;
      const key = p.code.toLowerCase();
      if (!seen.has(key)) seen.set(key, { folders: new Set(), spots: new Set() });
      seen.get(key).folders.add(p.folder);
      seen.get(key).spots.add(`${p.lat}|${p.lng}`);
    }
    for (const p of points) {
      const w = p.code && p.folder ? seen.get(p.code.toLowerCase()) : null;
      const leaf = leafOf(p.folder);
      if (w && w.folders.size > 1 && w.spots.size > 1 && !p.code.toLowerCase().includes(leaf.toLowerCase())) {
        p.code = `${leaf.slice(0, Math.max(10, MAX_CODE - p.code.length - 1))} ${p.code}`.slice(0, MAX_CODE);
      }
      p.clientId = pointId(p);
    }

    // Un livello per tipo (es. "PFS" e "PTE"): chi non ha il tipo nel nome prende quello del livello.
    const layerTypes = new Set(points.map((p) => guessType(leafOf(p.folder))).filter(Boolean));
    if (layerTypes.size >= 2) {
      for (const p of points) if (!p.type) p.type = p.folder.split(' › ').reverse().map(guessType).find(Boolean) || null;
    }

    // 1) i livelli della mappa
    const folders = new Set(points.map((p) => p.folder));
    const layers = folders.size > 1 ? countGroups(points, (p) => p.folder || 'Senza livello') : null;

    // 2) le sigle di zona nei nomi (es. NA_01, CE_03). Con i livelli, una sigla vale come zona
    // solo se raccoglie in media almeno 2 punti: i numeri progressivi delle cabine non sono zone.
    const tokens = new Map(points.map((p) => [p, zoneTokens(p.idName)]));
    const stats = new Map();
    for (const toks of tokens.values()) {
      for (const letters of new Set(toks.map((t) => t.letters))) {
        const st = stats.get(letters) || { points: 0, numbers: new Set() };
        st.points += 1;
        st.numbers.add(toks.find((t) => t.letters === letters).digits);
        stats.set(letters, st);
      }
    }
    const zones = [...stats]
      .filter(([, st]) => st.points >= Math.max(2, points.length * 0.1) && st.numbers.size >= 2
        && (!layers || st.points / st.numbers.size >= 2))
      .sort((a, b) => b[1].points / b[1].numbers.size - a[1].points / a[1].numbers.size)
      .map(([letters]) => letters);
    const zone = (p) => {
      const toks = tokens.get(p);
      for (const letters of zones) {
        const t = toks.find((x) => x.letters === letters);
        if (t) return `${t.letters}_${t.digits}`;
      }
      return 'Senza sigla';
    };
    let codes = null;
    if (zones.length && points.filter((p) => zone(p) !== 'Senza sigla').length >= points.length * 0.3) {
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
