'use strict';

// Percorsi in auto e a piedi calcolati con OSRM sul server pubblico FOSSGIS
// (dati OpenStreetMap, nessuna chiave richiesta) e indicazioni in italiano.

(function (root) {
  const ROUTER = 'https://routing.openstreetmap.de';
  const PROFILES = { car: 'routed-car', foot: 'routed-foot' };

  function haversine(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  const TIMEOUT_MS = 15000;
  const OSRM_ERRORS = {
    NoRoute: 'Nessun percorso trovato verso la cabina',
    NoSegment: 'Nessuna strada vicino alla partenza o alla cabina',
  };

  async function fetchRoute(mode, from, to, signal) {
    const coords = `${from.lng.toFixed(6)},${from.lat.toFixed(6)};${to.lng.toFixed(6)},${to.lat.toFixed(6)}`;
    const url = `${ROUTER}/${PROFILES[mode]}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`;
    // Annulla se lo chiede l'app (nuovo calcolo) o se il servizio non risponde in tempo.
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, TIMEOUT_MS);
    let res;
    let data;
    try {
      res = await fetch(url, { signal: ctrl.signal });
      data = await res.json().catch(() => null);
    } catch (err) {
      if (timedOut) throw new Error('Il servizio percorsi non risponde, riprova');
      if (err.name === 'AbortError') throw err;
      throw new Error('Servizio percorsi non raggiungibile');
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    // L'interruzione può arrivare anche mentre si legge la risposta.
    if (timedOut) throw new Error('Il servizio percorsi non risponde, riprova');
    if (signal && signal.aborted) throw new DOMException('Calcolo annullato', 'AbortError');
    if (data && OSRM_ERRORS[data.code]) throw new Error(OSRM_ERRORS[data.code]);
    if (!res.ok || !data) throw new Error(`Servizio percorsi non disponibile (errore ${res.status})`);
    if (data.code !== 'Ok' || !data.routes || !data.routes.length) throw new Error('Nessun percorso trovato verso la cabina');
    return prepareRoute(data.routes[0], mode);
  }

  function prepareRoute(route, mode) {
    const coords = route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
    const steps = [];
    let along = 0;
    for (const leg of route.legs) {
      for (const s of leg.steps) {
        steps.push({
          text: instruction(s),
          icon: maneuverIcon(s.maneuver),
          type: s.maneuver.type,
          distance: s.distance,
          along,
        });
        along += s.distance;
      }
    }
    return {
      mode,
      distance: route.distance,
      duration: route.duration,
      coords,
      cum,
      geomLength: cum[cum.length - 1] || 1,
      steps,
    };
  }

  const TURNS = {
    uturn: 'fai inversione a U',
    'sharp right': 'svolta decisamente a destra',
    right: 'svolta a destra',
    'slight right': 'tieni la destra',
    straight: 'prosegui dritto',
    'slight left': 'tieni la sinistra',
    left: 'svolta a sinistra',
    'sharp left': 'svolta decisamente a sinistra',
  };

  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function instruction(step) {
    const m = step.maneuver;
    const mod = m.modifier || '';
    const road = step.name || step.ref || '';
    const on = road ? ` su ${road}` : '';
    const side = mod.includes('left') ? 'sinistra' : mod.includes('right') ? 'destra' : '';
    switch (m.type) {
      case 'depart':
        return road ? `Parti su ${road}` : 'Parti';
      case 'arrive':
        return side ? `Sei arrivato: la cabina è sulla ${side}` : 'Sei arrivato alla cabina';
      case 'roundabout':
      case 'rotary':
        return m.exit ? `Alla rotonda prendi la ${m.exit}ª uscita${on}` : `Entra nella rotonda${on}`;
      case 'roundabout turn':
        return `Alla rotonda ${TURNS[mod] || 'prosegui'}${on}`;
      case 'exit roundabout':
      case 'exit rotary':
        return `Esci dalla rotonda${on}`;
      case 'merge':
        return `Immettiti${on || ' nella strada'}`;
      case 'on ramp':
        return `Prendi la rampa${side ? ` a ${side}` : ''}${on}`;
      case 'off ramp':
        return `Prendi l'uscita${side ? ` a ${side}` : ''}${on}`;
      case 'fork':
        return side ? `Al bivio tieni la ${side}${on}` : `Al bivio prosegui dritto${on}`;
      case 'end of road':
        return `Alla fine della strada ${side ? `svolta a ${side}` : 'prosegui'}${on}`;
      case 'new name':
        return road ? `Prosegui su ${road}` : 'Prosegui dritto';
      case 'continue':
        // "continue" con una svolta: la strada gira all'incrocio e la si segue (l'altra va dritta).
        if (mod === 'uturn' || mod.startsWith('slight')) return cap(TURNS[mod]) + on;
        if (TURNS[mod] && mod !== 'straight') return cap(TURNS[mod]) + (road ? ` per restare su ${road}` : '');
        return road ? `Prosegui su ${road}` : 'Prosegui dritto';
      default:
        return cap(TURNS[mod] || 'prosegui') + on;
    }
  }

  // Nome del simbolo freccia (vedi index.html); "-r" indica la versione a destra.
  function maneuverIcon(m) {
    if (m.type === 'arrive') return 'flag';
    if (m.type === 'depart') return 'straight';
    if (m.type.includes('roundabout') || m.type.includes('rotary')) return 'roundabout';
    const mod = m.modifier || 'straight';
    const side = mod.includes('right') ? '-r' : '';
    if (mod === 'uturn') return 'uturn';
    if (mod.startsWith('sharp')) return 'sharp' + side;
    if (mod.startsWith('slight')) return 'slight' + side;
    if (mod === 'left' || mod === 'right') return 'turn' + side;
    return 'straight';
  }

  // Proietta la posizione sul percorso: quanto ci si è allontanati, quanta strada
  // resta e qual è la prossima manovra.
  function progress(route, pos) {
    const { coords, cum } = route;
    const kx = 111320 * Math.cos((pos.lat * Math.PI) / 180);
    const ky = 110540;
    let best = { dist: Infinity, along: 0 };
    for (let i = 0; i < coords.length - 1; i++) {
      const ax = (coords[i].lng - pos.lng) * kx;
      const ay = (coords[i].lat - pos.lat) * ky;
      const dx = (coords[i + 1].lng - pos.lng) * kx - ax;
      const dy = (coords[i + 1].lat - pos.lat) * ky - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best.dist) best = { dist: d, along: cum[i] + t * (cum[i + 1] - cum[i]) };
    }
    if (coords.length === 1) best = { dist: haversine(pos, coords[0]), along: 0 };
    const along = (best.along * route.distance) / route.geomLength;
    const remaining = Math.max(0, route.distance - along);
    const next = route.steps.find((s) => s.along > along + 5) || route.steps[route.steps.length - 1];
    return {
      offRoute: best.dist,
      along,
      remaining,
      remainingTime: route.distance ? (route.duration * remaining) / route.distance : 0,
      next,
      toNext: next ? Math.max(0, next.along - along) : 0,
    };
  }

  function fmtDuration(seconds) {
    const min = Math.max(1, Math.round(seconds / 60));
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }

  const api = { fetchRoute, prepareRoute, instruction, maneuverIcon, progress, fmtDuration, haversine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Routing = api;
})(typeof window !== 'undefined' ? window : globalThis);
