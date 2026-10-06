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
  mimitPriceDate,
  nearItaly,
  photonToPlace,
  toPlace,
  rankPlaces,
  clientKey,
  RATE_LIMIT_MAX,
  app,
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

// ── Place search ─────────────────────────────────────────────────────────────

const photonFeature = (name, type, lon, lat, extra = {}) => ({
  geometry: { coordinates: [lon, lat] },
  properties: { name, type, country: 'Italien', state: 'Trentino-Südtirol', ...extra },
});

test('photonToPlace: builds a short label and a disambiguating detail', () => {
  const p = photonToPlace(photonFeature('Bruneck', 'city', 11.9355, 46.7963));
  assert.equal(p.label, 'Bruneck');
  assert.equal(p.detail, 'Trentino-Südtirol, Italien');
  assert.equal(p.lat, 46.7963);
  assert.equal(p.lng, 11.9355);
});

test('photonToPlace: drops features without a name or usable coordinates', () => {
  assert.equal(photonToPlace({ geometry: { coordinates: [11, 46] }, properties: {} }), null);
  assert.equal(photonToPlace({ geometry: { coordinates: [] }, properties: { name: 'X' } }), null);
  assert.equal(photonToPlace({}), null);
});

test('photonToPlace: never repeats the place name inside its own detail line', () => {
  const p = photonToPlace(
    photonFeature('Bozen', 'city', 11.3548, 46.4983, { district: 'Bozen', state: 'Bozen' })
  );
  assert.equal(p.label, 'Bozen');
  assert.ok(!p.detail.split(', ').includes('Bozen'));
});

test('rankPlaces: settlements outrank streets', () => {
  const out = rankPlaces(
    [
      photonFeature('Brunecker Straße', 'street', 11.5, 48.1),
      photonFeature('Bruneck', 'city', 11.9355, 46.7963),
    ],
    5
  );
  assert.equal(out[0].label, 'Bruneck', 'the city comes first despite being listed second');
  assert.equal(out.length, 2);
});

test('rankPlaces: collapses the same town appearing under several names', () => {
  // Bilingual name, district and boundary all sit within a few hundred metres
  const out = rankPlaces(
    [
      photonFeature('Bruneck', 'city', 11.9355, 46.7963),
      photonFeature('Bruneck - Brunico', 'city', 11.9356, 46.7964),
      photonFeature('Bruneck', 'district', 11.9359, 46.7961),
      photonFeature('Brixen', 'city', 11.6578, 46.7164),
    ],
    5
  );
  assert.equal(out.length, 2, 'the three Bruneck rows collapse into one');
  assert.deepEqual(out.map((p) => p.label), ['Bruneck', 'Brixen']);
});

test('rankPlaces: honours the limit and tolerates empty input', () => {
  const many = Array.from({ length: 9 }, (_, i) =>
    photonFeature(`Ort ${i}`, 'city', 11 + i * 0.5, 46 + i * 0.5)
  );
  assert.equal(rankPlaces(many, 3).length, 3);
  assert.deepEqual(rankPlaces([], 5), []);
  assert.deepEqual(rankPlaces(undefined, 5), []);
});

test('toPlace: maps a Nominatim hit and drops unusable coordinates', () => {
  const p = toPlace({
    lat: '46.7963',
    lon: '11.9355',
    display_name: 'Bruneck, Pustertal, Bozen, Italien',
    address: { town: 'Bruneck', county: 'Bozen', state: 'Südtirol', country: 'Italien' },
  });
  assert.equal(p.label, 'Bruneck');
  assert.equal(p.detail, 'Bozen, Südtirol, Italien');
  assert.equal(toPlace({ lat: 'x', lon: 'y', display_name: 'Nirgendwo' }), null);
});

test('toPlace: falls back to the first segment of display_name', () => {
  const p = toPlace({ lat: '48.1', lon: '11.5', display_name: 'Irgendwo, Bayern', address: {} });
  assert.equal(p.label, 'Irgendwo');
});

// ── MIMIT price dates ────────────────────────────────────────────────────────

test('mimitPriceDate: converts the Italian timestamp, rejecting junk', () => {
  assert.equal(mimitPriceDate('01/10/2026 20:00:06'), '01.10.2026');
  assert.equal(mimitPriceDate(''), null);
  assert.equal(mimitPriceDate(undefined), null);
  assert.equal(mimitPriceDate('2026-10-01'), null);
});

test('buildMimitIndex: carries the price date through, cheapest pump winning', () => {
  const anagrafica = [
    'Estrazione',
    'idImpianto|Gestore|Bandiera|Tipo Impianto|Nome Impianto|Indirizzo|Comune|Provincia|Latitudine|Longitudine',
    '1|G|Eni|Stradale|VANDOIES|Via X|VANDOIES|BZ|46.8141|11.7219',
  ].join('\n');
  const prezzi = [
    'Estrazione',
    'idImpianto|descCarburante|prezzo|isSelf|dtComu',
    '1|Metano|1.999|0|01/10/2026 20:00:06',
    '1|Metano|1.899|1|02/10/2026 06:30:00',
  ].join('\n');

  const [station] = buildMimitIndex(anagrafica, prezzi);
  assert.equal(station.price, 1.899, 'the cheaper pump wins');
  assert.equal(station.priceDate, '02.10.2026', 'and its date travels with it');
});

// ── Rate limiting ────────────────────────────────────────────────────────────

test('clientKey: prefers the first forwarded address over the socket', () => {
  assert.equal(
    clientKey({ headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.1' } }),
    '203.0.113.5'
  );
  assert.equal(clientKey({ headers: {}, socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
  assert.equal(clientKey({ headers: {}, socket: {} }), 'unknown');
});

// ── Routes ───────────────────────────────────────────────────────────────────
// Exercised over a real socket, but only on paths that need no upstream call,
// so the suite stays offline-safe and deterministic.

const http = require('node:http');

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function request(server, path, headers = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, headers }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on('error', reject);
  });
}

test('GET /health reports the configured sources', async () => {
  const server = await listen();
  try {
    const res = await request(server, '/health', { 'x-forwarded-for': '198.51.100.1' });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.ok(body.sources.includes('gibgas'));
    assert.ok(body.sources.includes('mimit(IT)'));
    assert.equal(typeof body.seedStations.cng, 'number');
  } finally {
    server.close();
  }
});

test('GET /geocode: a one-character query answers [] without calling upstream', async () => {
  const server = await listen();
  try {
    const res = await request(server, '/geocode?q=a', { 'x-forwarded-for': '198.51.100.2' });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), []);
  } finally {
    server.close();
  }
});

test('GET /stations and /prices reject a missing position', async () => {
  const server = await listen();
  try {
    for (const path of ['/stations?r=10&fuel=cng', '/prices?r=10&fuel=cng']) {
      const res = await request(server, path, { 'x-forwarded-for': '198.51.100.3' });
      assert.equal(res.status, 400, `${path} is rejected`);
      assert.match(JSON.parse(res.body).error, /lat and lon/);
    }
  } finally {
    server.close();
  }
});

test('the rate limit rejects a client once its window is spent', async () => {
  const server = await listen();
  const ip = '198.51.100.99';
  try {
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const res = await request(server, '/geocode?q=a', { 'x-forwarded-for': ip });
      assert.equal(res.status, 200, `request ${i + 1} is still allowed`);
    }
    const blocked = await request(server, '/geocode?q=a', { 'x-forwarded-for': ip });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers['retry-after'], 'and says when to come back');

    const other = await request(server, '/geocode?q=a', { 'x-forwarded-for': '198.51.100.100' });
    assert.equal(other.status, 200, 'a different client is unaffected');
  } finally {
    server.close();
  }
});
