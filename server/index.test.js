'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePrice,
  normalizeFuel,
  fuelConfig,
  parseGibgasData,
  parseTankerkoenigStations,
} = require('./index');

test('parsePrice: parses German comma decimals within plausible range', () => {
  assert.equal(parsePrice('1,239'), 1.239);
  assert.equal(parsePrice('1.50'), 1.5);
  assert.equal(parsePrice('1,099 €/kg'), 1.099);
});

test('parsePrice: rejects junk, out-of-range and too-few decimals', () => {
  assert.equal(parsePrice(null), null);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice('abc'), null);
  assert.equal(parsePrice('1,2'), null); // needs >= 2 decimals
  assert.equal(parsePrice('9.999'), null); // > 5.0
  assert.equal(parsePrice('0.40'), null); // < 0.5
});

test('normalizeFuel: only benzin is special, everything else is cng', () => {
  assert.equal(normalizeFuel('benzin'), 'benzin');
  assert.equal(normalizeFuel('cng'), 'cng');
  assert.equal(normalizeFuel(undefined), 'cng');
  assert.equal(normalizeFuel('diesel'), 'cng');
});

test('fuelConfig: maps fuels to E-Control + clever-tanken ids', () => {
  assert.deepEqual(fuelConfig('benzin'), { econtrol: 'SUP', ct: 1 });
  assert.deepEqual(fuelConfig('cng'), { econtrol: 'GAS', ct: 31 });
  assert.deepEqual(fuelConfig(undefined), { econtrol: 'GAS', ct: 31 });
});

test('parseGibgasData: returns [] for empty/invalid payloads', () => {
  assert.deepEqual(parseGibgasData(null), []);
  assert.deepEqual(parseGibgasData({}), []);
  assert.deepEqual(parseGibgasData({ vector: ['1'], pois: { 1: { lat: 48, lng: 11 } } }), []); // no info
});

test('parseGibgasData: extracts price, coords and source', () => {
  const out = parseGibgasData({
    vector: ['a'],
    pois: { a: { lat: '48.137', lng: '11.575', info: '<span class="preis">1,099 €/kg</span>' } },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].price, 1.099);
  assert.equal(out[0].lat, 48.137);
  assert.equal(out[0].lng, 11.575);
  assert.equal(out[0].status, 'active');
  assert.equal(out[0].source, 'gibgas');
});

test('parseGibgasData: flags out-of-order stations', () => {
  const out = parseGibgasData({
    vector: ['a'],
    pois: { a: { lat: '48', lng: '11', info: 'Anlage außer Betrieb' } },
  });
  assert.equal(out[0].status, 'out_of_order');
  assert.equal(out[0].price, null);
});

test('parseTankerkoenigStations: [] when API reports not ok', () => {
  assert.deepEqual(parseTankerkoenigStations({ ok: false }), []);
  assert.deepEqual(parseTankerkoenigStations({}), []);
});

test('parseTankerkoenigStations: maps price, open status and source', () => {
  const out = parseTankerkoenigStations({
    ok: true,
    stations: [
      { lat: 48.1, lng: 11.5, price: 1.759, isOpen: true },
      { lat: 48.2, lng: 11.6, price: false, isOpen: false }, // closed / no price
      { lng: 11.7, price: 1.7, isOpen: true }, // missing lat -> dropped
    ],
  });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { lat: 48.1, lng: 11.5, price: 1.759, status: 'active', source: 'tankerkoenig' });
  assert.equal(out[1].price, null);
  assert.equal(out[1].status, 'closed');
});
