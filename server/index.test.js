'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePrice,
  normalizeFuel,
  fuelConfig,
  parseGibgasData,
  parseTankerkoenigStations,
  parseOverpassElements,
  overpassFuelFilter,
  seedStations,
  haversineKm,
  sampleCenters,
  priceCacheKey,
  parseMimitCsv,
  buildMimitIndex,
  nearItaly,
  cacheSet,
  cacheGet,
  MAX_CACHE_ENTRIES,
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

test('parseTankerkoenigStations: demo mode keeps stations but drops placeholder prices', () => {
  const payload = {
    ok: true,
    stations: [
      { lat: 48.1, lng: 11.5, price: 1.009, isOpen: true },
      { lat: 48.2, lng: 11.6, price: 1.009, isOpen: true },
    ],
  };
  const out = parseTankerkoenigStations(payload, true);
  assert.equal(out.length, 2, 'stations still count as a confirming source');
  assert.ok(out.every((s) => s.price === null), 'demo prices are not shown as real');
  assert.ok(out.every((s) => s.source === 'tankerkoenig'));
});

// ── Station discovery ────────────────────────────────────────────────────────

test('overpassFuelFilter: cng and benzin map to their OSM tags', () => {
  assert.equal(overpassFuelFilter('cng'), '["fuel:cng"="yes"]');
  assert.equal(overpassFuelFilter('benzin'), '["fuel:octane_95"="yes"]');
  assert.equal(overpassFuelFilter(undefined), '["fuel:cng"="yes"]', 'defaults to cng');
});

test('parseOverpassElements: [] for non-array input', () => {
  assert.deepEqual(parseOverpassElements(undefined, 'cng'), []);
  assert.deepEqual(parseOverpassElements(null, 'cng'), []);
});

test('parseOverpassElements: reads nodes, ways and drops coordinate-less elements', () => {
  const out = parseOverpassElements(
    [
      {
        type: 'node',
        id: 1,
        lat: 48.1,
        lon: 11.5,
        tags: {
          name: 'Aral',
          'addr:street': 'Remsstraße',
          'addr:housenumber': '10',
          'addr:city': 'Schwäbisch Gmünd',
          opening_hours: '24/7',
        },
      },
      { type: 'way', id: 2, center: { lat: 48.2, lon: 11.6 }, tags: { brand: 'Shell' } },
      { type: 'way', id: 3, tags: { name: 'ohne Koordinaten' } },
    ],
    'cng'
  );

  assert.equal(out.length, 2, 'the element without coordinates is dropped');
  assert.deepEqual(out[0], {
    id: 'osm-node-1',
    name: 'Aral',
    address: 'Remsstraße 10',
    city: 'Schwäbisch Gmünd',
    lat: 48.1,
    lng: 11.5,
    openingHours: '24/7',
    fuel: 'cng',
  });
  assert.equal(out[1].id, 'osm-way-2');
  assert.equal(out[1].name, 'Shell', 'falls back to brand');
  assert.equal(out[1].lat, 48.2, 'way uses its center');
  assert.equal(out[1].openingHours, null);
});

test('seedStations: bundled snapshot covers Munich and respects the radius', () => {
  // Marienplatz. The seed is the Overpass-outage fallback, so it must return
  // stations without any network access.
  const near = seedStations(48.137, 11.575, 21, 'cng');
  assert.ok(near.length > 0, 'Munich has CNG stations in the snapshot');
  assert.ok(
    near.every((s) => haversineKm(48.137, 11.575, s.lat, s.lng) <= 21),
    'every station lies inside the requested radius'
  );
  assert.ok(near.every((s) => s.fuel === 'cng' && s.id.startsWith('osm-')));

  const tight = seedStations(48.137, 11.575, 2, 'cng');
  assert.ok(tight.length < near.length, 'a smaller radius returns fewer stations');
});

test('seedStations: unknown fuel yields no stations instead of throwing', () => {
  assert.deepEqual(seedStations(48.137, 11.575, 20, 'wasserstoff'), []);
});

// ── gibgas sampling ──────────────────────────────────────────────────────────
// gibgas returns only the 12 nearest POIs and ignores `r`, so wider radii need
// several sample centres to reach beyond that cap.

test('sampleCenters: a small radius needs only the centre point', () => {
  const pts = sampleCenters(48.137, 11.575, 10);
  assert.equal(pts.length, 1);
  assert.deepEqual(pts[0], { lat: 48.137, lon: 11.575 });
});

test('sampleCenters: wider radii add rings that stay inside the radius', () => {
  for (const radius of [20, 50]) {
    const pts = sampleCenters(48.137, 11.575, radius);
    assert.ok(pts.length > 1, `radius ${radius} samples more than the centre`);
    for (const p of pts) {
      const dist = haversineKm(48.137, 11.575, p.lat, p.lon);
      assert.ok(dist <= radius, `sample at ${dist.toFixed(1)}km stays within ${radius}km`);
    }
  }
  assert.ok(
    sampleCenters(48.137, 11.575, 50).length > sampleCenters(48.137, 11.575, 20).length,
    '50 km samples more widely than 20 km'
  );
});

// ── Price cache key ──────────────────────────────────────────────────────────

test('priceCacheKey: petrol grades never share an entry', () => {
  const at = (grade) => priceCacheKey(48.137, 11.575, 10, 'benzin', grade);
  assert.notEqual(at('e5'), at('e10'));
  assert.notEqual(at('e5'), at('diesel'));
  assert.notEqual(at('e10'), at('diesel'));
  assert.equal(at(undefined), at('e5'), 'an unset grade behaves like the e5 default');
});

test('priceCacheKey: CNG ignores the grade but still separates place and radius', () => {
  assert.equal(
    priceCacheKey(48.137, 11.575, 10, 'cng', 'diesel'),
    priceCacheKey(48.137, 11.575, 10, 'cng', 'e5'),
    'grade is meaningless for CNG'
  );
  assert.notEqual(
    priceCacheKey(48.137, 11.575, 10, 'cng'),
    priceCacheKey(48.137, 11.575, 20, 'cng'),
    'radius still separates entries'
  );
  assert.notEqual(
    priceCacheKey(48.137, 11.575, 10, 'cng'),
    priceCacheKey(52.52, 13.405, 10, 'cng'),
    'location still separates entries'
  );
});

// ── Bounded cache ────────────────────────────────────────────────────────────

test('cacheGet: null when never cached, fresh vs stale otherwise', () => {
  const m = new Map();
  assert.equal(cacheGet(m, 'k', 1000), null);

  cacheSet(m, 'k', ['data']);
  const fresh = cacheGet(m, 'k', 60_000);
  assert.deepEqual(fresh.data, ['data']);
  assert.equal(fresh.stale, false);

  // A negative TTL makes any entry stale, but the data stays available
  const stale = cacheGet(m, 'k', -1);
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.data, ['data'], 'stale entries still carry data for outage fallback');
});

test('cacheSet: evicts the oldest entry once the cap is reached', () => {
  const m = new Map();
  for (let i = 0; i < MAX_CACHE_ENTRIES + 10; i++) cacheSet(m, `k${i}`, i);

  assert.equal(m.size, MAX_CACHE_ENTRIES, 'size stays bounded');
  assert.equal(cacheGet(m, 'k0', 60_000), null, 'oldest key was evicted');
  assert.ok(cacheGet(m, `k${MAX_CACHE_ENTRIES + 9}`, 60_000), 'newest key survives');
});

test('cacheSet: re-writing a key refreshes its position, not the cache size', () => {
  const m = new Map();
  cacheSet(m, 'a', 1);
  cacheSet(m, 'b', 2);
  cacheSet(m, 'a', 3);

  assert.equal(m.size, 2);
  assert.equal(cacheGet(m, 'a', 60_000).data, 3);
  assert.deepEqual([...m.keys()], ['b', 'a'], 'the rewritten key moves to the end');
});

// ── Osservaprezzi / MIMIT (Italien) ──────────────────────────────────────────

const ANAGRAFICA = [
  'Estrazione del 2026-10-03',
  'idImpianto|Gestore|Bandiera|Tipo Impianto|Nome Impianto|Indirizzo|Comune|Provincia|Latitudine|Longitudine',
  '1|G|Eni|Stradale|VANDOIES|Via X|VANDOIES|BZ|46.8141|11.7219',
  '2|G|Tamoil|Stradale|BADIA|Via Y|BADIA|BZ|46.6049|11.8959',
  '3|G|Q8|Stradale|OHNE KOORD|Via Z|ROMA|RM||',
  '4|G|Esso|Stradale|NUR BENZIN|Via W|MILANO|MI|45.4642|9.1900',
].join('\n');

const PREZZI = [
  'Estrazione del 2026-10-03',
  'idImpianto|descCarburante|prezzo|isSelf|dtComu',
  '1|Metano|1.999|0|01/10/2026 20:00:06',
  '2|Metano|1.950|0|01/10/2026 20:00:06',
  '2|Benzina|2.340|0|01/10/2026 20:00:06',
  '3|Metano|1.800|0|01/10/2026 20:00:06',
  '4|Benzina|2.100|0|01/10/2026 20:00:06',
].join('\n');

test('parseMimitCsv: skips the extraction line and splits on pipes', () => {
  const rows = parseMimitCsv(PREZZI);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].idImpianto, '1');
  assert.equal(rows[0].descCarburante, 'Metano');
  assert.equal(rows[0].prezzo, '1.999');
});

test('parseMimitCsv: tolerates empty input', () => {
  assert.deepEqual(parseMimitCsv(''), []);
  assert.deepEqual(parseMimitCsv('nur eine Zeile'), []);
});

test('buildMimitIndex: keeps only Metano stations that have coordinates', () => {
  const out = buildMimitIndex(ANAGRAFICA, PREZZI);
  const ids = out.map((s) => `${s.lat},${s.lng}`);

  assert.equal(out.length, 2, 'petrol-only and coordinate-less stations drop out');
  assert.ok(ids.includes('46.8141,11.7219'), 'Vandoies is kept');
  assert.ok(ids.includes('46.6049,11.8959'), 'Badia is kept');
  assert.ok(out.every((s) => s.source === 'mimit' && s.status === 'active'));
});

test('buildMimitIndex: a station with several pumps keeps the cheapest Metano price', () => {
  const prezzi = PREZZI + '\n1|Metano|1.899|1|01/10/2026 20:00:06';
  const vandoies = buildMimitIndex(ANAGRAFICA, prezzi).find((s) => s.lat === 46.8141);
  assert.equal(vandoies.price, 1.899);
});

test('nearItaly: gates the download to the Italian bounding box', () => {
  assert.equal(nearItaly(46.7963, 11.9355), true, 'Bruneck / South Tyrol');
  assert.equal(nearItaly(41.9028, 12.4964), true, 'Rome');
  assert.equal(nearItaly(52.52, 13.405), false, 'Berlin');
  assert.equal(nearItaly(48.137, 11.575), false, 'Munich');
});
