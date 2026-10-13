'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Routing = require('../public/routing.js');

// Percorso finto in stile OSRM: verso nord, poi a destra (est) fino alla cabina.
const osrmRoute = {
  distance: 300,
  duration: 60,
  geometry: { coordinates: [[9.0, 45.0], [9.0, 45.0018], [9.00127, 45.0018]] },
  legs: [{
    steps: [
      { distance: 200, duration: 40, name: 'Via Roma', maneuver: { type: 'depart', location: [9.0, 45.0] } },
      { distance: 100, duration: 20, name: 'Via Dante', maneuver: { type: 'turn', modifier: 'right', location: [9.0, 45.0018] } },
      { distance: 0, duration: 0, name: 'Via Dante', maneuver: { type: 'arrive', modifier: 'left', location: [9.00127, 45.0018] } },
    ],
  }],
};

test('indicazioni in italiano', () => {
  const say = (maneuver, name = '') => Routing.instruction({ name, maneuver });
  assert.equal(say({ type: 'turn', modifier: 'left' }, 'Via Roma'), 'Svolta a sinistra su Via Roma');
  assert.equal(say({ type: 'turn', modifier: 'slight right' }), 'Tieni la destra');
  assert.equal(say({ type: 'roundabout', exit: 2 }, 'SS36'), 'Alla rotonda prendi la 2ª uscita su SS36');
  assert.equal(say({ type: 'end of road', modifier: 'right' }), 'Alla fine della strada svolta a destra');
  assert.equal(say({ type: 'fork', modifier: 'slight left' }, 'A4'), 'Al bivio tieni la sinistra su A4');
  assert.equal(say({ type: 'new name', modifier: 'straight' }, 'Corso Buenos Aires'), 'Prosegui su Corso Buenos Aires');
  assert.equal(say({ type: 'continue', modifier: 'uturn' }), 'Fai inversione a U');
  assert.equal(say({ type: 'arrive', modifier: 'left' }), 'Sei arrivato: la cabina è sulla sinistra');
  assert.equal(say({ type: 'depart' }, 'Via Verdi'), 'Parti su Via Verdi');
});

test('icone delle manovre', () => {
  assert.equal(Routing.maneuverIcon({ type: 'turn', modifier: 'right' }), 'turn-r');
  assert.equal(Routing.maneuverIcon({ type: 'turn', modifier: 'sharp left' }), 'sharp');
  assert.equal(Routing.maneuverIcon({ type: 'roundabout', modifier: 'right' }), 'roundabout');
  assert.equal(Routing.maneuverIcon({ type: 'arrive' }), 'flag');
});

test('durate leggibili', () => {
  assert.equal(Routing.fmtDuration(20), '1 min');
  assert.equal(Routing.fmtDuration(12 * 60), '12 min');
  assert.equal(Routing.fmtDuration(65 * 60), '1 h 5 min');
  assert.equal(Routing.fmtDuration(120 * 60), '2 h');
});

test('avanzamento lungo il percorso e prossima manovra', () => {
  const route = Routing.prepareRoute(osrmRoute, 'car');
  assert.equal(route.steps.length, 3);
  assert.equal(route.steps[1].text, 'Svolta a destra su Via Dante');
  assert.equal(route.steps[1].along, 200);

  // A metà del primo tratto: mancano ~100 m alla svolta, ~200 m all'arrivo.
  const mid = Routing.progress(route, { lat: 45.0009, lng: 9.0 });
  assert.ok(mid.offRoute < 1);
  assert.equal(mid.next.type, 'turn');
  assert.ok(Math.abs(mid.toNext - 100) < 5, `toNext ${mid.toNext}`);
  assert.ok(Math.abs(mid.remaining - 200) < 5, `remaining ${mid.remaining}`);
  assert.ok(Math.abs(mid.remainingTime - 40) < 2);

  // Dopo la svolta la prossima manovra è l'arrivo.
  const after = Routing.progress(route, { lat: 45.0018, lng: 9.0006 });
  assert.equal(after.next.type, 'arrive');
});

test('riconosce quando si esce dal percorso', () => {
  const route = Routing.prepareRoute(osrmRoute, 'foot');
  const away = Routing.progress(route, { lat: 45.0009, lng: 9.002 });
  assert.ok(away.offRoute > 100, `offRoute ${away.offRoute}`);
});
