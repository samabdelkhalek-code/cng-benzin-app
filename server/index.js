'use strict';

const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// Tankerkönig = official MTS-K source for German petrol prices (E5/E10/Diesel).
// Get a free key at https://creativecommons.tankerkoenig.de and set it as an
// env var on the proxy service. The public demo key returns real station
// locations but fixed demo prices, so it only proves connectivity.
const TANKERKOENIG_API_KEY =
  process.env.TANKERKOENIG_API_KEY || '00000000-0000-0000-0000-000000000002';
const TANKERKOENIG_DEMO_KEY = '00000000-0000-0000-0000-000000000002';

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parsePrice(text) {
  if (!text) return null;
  const m = String(text).replace(/,/g, '.').match(/(\d+\.\d{2,4})/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n >= 0.5 && n <= 5.0 ? n : null;
}

// ── gibgas.de (CNG-specific, ~90%+ price coverage) ───────────────────────────
// Uses their internal server.php?gimme=radius_pois API
function parseGibgasData(data) {
  if (!data?.vector || !data?.pois) return [];
  return data.vector.flatMap((id) => {
    const poi = data.pois[id];
    if (!poi?.lat || !poi?.lng || !poi?.info) return [];

    // Detect "Out of Order" status
    const isOutOfOrder = /außer betrieb|störung|defekt|geschlossen|no service/i.test(poi.info);

    const pm = poi.info.match(/<span class="preis">([\d,]+)\s*€\/kg<\/span>/);
    const price = pm ? parsePrice(pm[1]) : null;

    const dm = poi.info.match(/<span class="preisvon">([\d.]+)<\/span>/);
    return [{
      lat: parseFloat(poi.lat),
      lng: parseFloat(poi.lng),
      price,
      priceDate: dm?.[1] ?? null,
      status: isOutOfOrder ? 'out_of_order' : 'active',
      source: 'gibgas'
    }];
  });
}

// ── Bounded in-memory cache ──────────────────────────────────────────────────
// Insertion-ordered Map: the first key is the oldest, so eviction is O(1).
const MAX_CACHE_ENTRIES = 500;

function cacheSet(map, key, data) {
  map.delete(key); // re-insert so the key moves to the end
  map.set(key, { ts: Date.now(), data });
  while (map.size > MAX_CACHE_ENTRIES) map.delete(map.keys().next().value);
}

/** Returns { data, stale } or null when the key was never cached. */
function cacheGet(map, key, ttlMs) {
  const entry = map.get(key);
  if (!entry) return null;
  return { data: entry.data, stale: Date.now() - entry.ts > ttlMs };
}

// ── In-memory cache for /prices (TTL: 15 min) ────────────────────────────────
const priceCache = new Map();
const PRICE_CACHE_TTL = 15 * 60 * 1000;

function priceCacheKey(lat, lon, r, fuel) {
  return `${fuel}_${Number(lat).toFixed(2)}_${Number(lon).toFixed(2)}_${Math.round(r)}`;
}

function readPriceCache(lat, lon, r, fuel) {
  const hit = cacheGet(priceCache, priceCacheKey(lat, lon, r, fuel), PRICE_CACHE_TTL);
  return hit && !hit.stale ? hit.data : null;
}

function writePriceCache(lat, lon, r, fuel, data) {
  cacheSet(priceCache, priceCacheKey(lat, lon, r, fuel), data);
}

// ── Station discovery via Overpass (OSM) ─────────────────────────────────────
//
// Overpass is a free public service that regularly returns 504 under load. The
// app used to call it straight from the browser, so an Overpass outage meant an
// empty station list for every user. Routing it through here lets one warm
// cache serve everyone, and stale data is served indefinitely while Overpass is
// down — OSM station data changes on a scale of months, not minutes.

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

const stationCache = new Map();
const STATION_CACHE_TTL = 24 * 60 * 60 * 1000;
const OVERPASS_MIRROR_TIMEOUT_MS = 12_000;
const OVERPASS_TOTAL_BUDGET_MS = 26_000;

// Last-resort dataset: a snapshot of OSM fuel:cng stations for DE/AT/CH,
// refreshed by `npm run seed`. It guarantees the app returns stations even on
// a cold start while every Overpass mirror is down.
let osmSeed = {};
try {
  osmSeed = require('./osm-seed.json');
} catch {
  console.warn('[stations] no osm-seed.json bundled — cold starts depend on Overpass');
}

function seedStations(lat, lon, radiusKm, fuel) {
  const list = osmSeed?.[fuel];
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => haversineKm(Number(lat), Number(lon), s.lat, s.lng) <= radiusKm)
    .map((s) => ({ ...s, fuel }));
}

function overpassFuelFilter(fuel) {
  return normalizeFuel(fuel) === 'benzin' ? '["fuel:octane_95"="yes"]' : '["fuel:cng"="yes"]';
}

function parseOverpassElements(elements, fuel) {
  if (!Array.isArray(elements)) return [];
  return elements.flatMap((el) => {
    const t = el.tags ?? {};
    const lat = el.type === 'node' ? el.lat : el.center?.lat;
    const lng = el.type === 'node' ? el.lon : el.center?.lon;
    if (lat == null || lng == null) return [];
    return [{
      id: `osm-${el.type}-${el.id}`,
      name: t.name ?? t.brand ?? t.operator ?? null,
      address: [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' '),
      city: t['addr:city'] ?? t['addr:town'] ?? t['addr:village'] ?? '',
      lat,
      lng,
      openingHours: t['opening_hours'] ?? null,
      fuel: normalizeFuel(fuel),
    }];
  });
}

async function queryOverpass(lat, lon, radiusKm, fuel) {
  const filter = overpassFuelFilter(fuel);
  const around = `(around:${Math.round(radiusKm * 1000)},${lat},${lon})`;
  const q =
    '[out:json][timeout:30];' +
    `(node["amenity"="fuel"]${filter}${around};` +
    `way["amenity"="fuel"]${filter}${around};` +
    `relation["amenity"="fuel"]${filter}${around};);` +
    'out center tags;';

  let lastErr;
  const deadline = Date.now() + OVERPASS_TOTAL_BUDGET_MS;
  // Sequential, not parallel: mirrors are a shared free resource. A per-mirror
  // timeout plus an overall budget keeps a full sweep bounded, because trying
  // five dead mirrors at 25 s each would outlast any client timeout.
  for (const mirror of OVERPASS_MIRRORS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const { data } = await axios.get(mirror, {
        params: { data: q },
        timeout: Math.min(OVERPASS_MIRROR_TIMEOUT_MS, remaining),
        headers: { 'User-Agent': 'cng-proxy/2.0 (station discovery)' },
      });
      if (!data || !Array.isArray(data.elements)) throw new Error('invalid Overpass payload');
      return parseOverpassElements(data.elements, fuel);
    } catch (err) {
      lastErr = err;
      console.error(`[stations] ${new URL(mirror).host} failed: ${err.message}`);
    }
  }
  throw lastErr ?? new Error('all Overpass mirrors failed');
}

app.get('/stations', async (req, res) => {
  const { lat, lon, r = 25, fuel } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });
  const normalizedFuel = normalizeFuel(fuel);
  const radius = Math.min(Math.round(Number(r) || 25), 60);
  // Snap to a ~1 km grid so nearby users share one cache entry
  const key = `${normalizedFuel}_${Number(lat).toFixed(2)}_${Number(lon).toFixed(2)}_${radius}`;

  const hit = cacheGet(stationCache, key, STATION_CACHE_TTL);
  if (hit && !hit.stale) return res.json(hit.data);

  try {
    const stations = await queryOverpass(lat, lon, radius, normalizedFuel);
    cacheSet(stationCache, key, stations);
    res.json(stations);
  } catch (err) {
    // Overpass is unreachable: prefer a stale cache entry, then the bundled
    // snapshot. Both are real OSM data, just not fetched a moment ago.
    if (hit) {
      console.warn(`[stations] Overpass down, serving stale cache for ${key}`);
      return res.json(hit.data);
    }
    const seeded = seedStations(lat, lon, radius, normalizedFuel);
    if (seeded.length) {
      console.warn(`[stations] Overpass down, serving ${seeded.length} seeded stations for ${key}`);
      return res.json(seeded);
    }
    res.status(503).json({ error: `station discovery unavailable: ${err.message}` });
  }
});

// ── gibgas sampling ──────────────────────────────────────────────────────────
//
// gibgas.de ignores the `r` parameter: every call returns the 12 POIs nearest
// to the given point. A single query therefore cannot cover a 20 or 50 km
// radius, which is why larger radii used to surface barely more stations than
// 10 km. Querying from a ring of offset centres widens the coverage; results
// are de-duplicated downstream by the coordinate grid in `upsert`.

function sampleCenters(lat, lon, radiusKm) {
  const centers = [{ lat: Number(lat), lon: Number(lon) }];
  if (radiusKm <= 12) return centers;

  const rings = radiusKm <= 25
    ? [{ dist: radiusKm * 0.65, count: 4 }]
    : [{ dist: radiusKm * 0.45, count: 6 }, { dist: radiusKm * 0.8, count: 6 }];

  const latRad = (Number(lat) * Math.PI) / 180;
  for (const { dist, count } of rings) {
    for (let i = 0; i < count; i++) {
      const bearing = (2 * Math.PI * i) / count;
      const dLat = (dist / 111.32) * Math.cos(bearing);
      const dLon = (dist / (111.32 * Math.max(Math.cos(latRad), 0.1))) * Math.sin(bearing);
      centers.push({ lat: Number(lat) + dLat, lon: Number(lon) + dLon });
    }
  }
  return centers;
}

async function fetchGibgasAround(lat, lon, radiusKm) {
  const centers = sampleCenters(lat, lon, radiusKm);
  const results = await Promise.allSettled(
    centers.map((c) =>
      axios.get('https://www.gibgas.de/server.php', {
        params: { gimme: 'radius_pois', lat: c.lat.toFixed(5), lng: c.lon.toFixed(5), r: Math.round(radiusKm) },
        timeout: 12_000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; cng-proxy/2.0)', Accept: 'application/json' },
      })
    )
  );

  const merged = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const entry of parseGibgasData(r.value.data)) {
      // Offset centres can reach past the requested area; keep a small buffer
      if (haversineKm(Number(lat), Number(lon), entry.lat, entry.lng) <= radiusKm + 2) merged.push(entry);
    }
  }
  return merged;
}

// ── E-Control (Österreich) ────────────────────────────────────────────────────
function normalizeFuel(fuel) {
  return fuel === 'benzin' ? 'benzin' : 'cng';
}

function fuelConfig(fuel) {
  return normalizeFuel(fuel) === 'benzin'
    ? { econtrol: 'SUP', ct: 1 }
    : { econtrol: 'GAS', ct: 31 };
}

// E-Control only covers Austria — skip if clearly in Germany (lat > 47.6)
async function fetchEControl(lat, lon, fuel = 'cng') {
  if (Number(lat) > 47.6) return [];
  try {
    const cfg = fuelConfig(fuel);
    const url = `https://api.e-control.at/sprit/1.0/search/gas-stations/by-address?latitude=${lat}&longitude=${lon}&fuelType=${cfg.econtrol}&includeClosed=true`;
    const { data } = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'cng-app/1.0' } });
    return (data || []).map(s => ({
      lat: s.location.latitude,
      lng: s.location.longitude,
      price: s.prices?.[0]?.amount ?? null,
      status: s.open === false ? 'closed' : 'active',
      source: 'econtrol'
    }));
  } catch (err) {
    console.error('[prices] E-Control failed:', err.message);
    return [];
  }
}

// ── Tankerkönig (German petrol prices, E5/E10/Diesel) ────────────────────────
// rad is capped at 25 km by the API. Returns one entry per station with the
// requested fuel's current price and open status.

// Pure parser, split out for testing. Tankerkönig returns `price: false` for
// stations that don't sell the requested fuel or are closed.
//
// The public demo key returns real station locations but a fixed placeholder
// price for every station. In that mode we keep the stations (they are genuine
// second-source confirmation that the station sells the fuel) and drop the
// price, so the UI shows "k.A." instead of a made-up number.
function parseTankerkoenigStations(data, demoMode = false) {
  if (!data?.ok || !Array.isArray(data.stations)) return [];
  return data.stations
    .map((s) => ({
      lat: s.lat,
      lng: s.lng,
      price: demoMode
        ? null
        : typeof s.price === 'number' && s.price > 0
          ? s.price
          : parsePrice(s.price),
      status: s.isOpen === false ? 'closed' : 'active',
      source: 'tankerkoenig',
    }))
    .filter((s) => s.lat != null && s.lng != null);
}

// Reflects what the last Tankerkönig call actually achieved, so /health can
// report whether a configured key really works instead of merely being set.
let tankerkoenigStatus =
  TANKERKOENIG_API_KEY === TANKERKOENIG_DEMO_KEY ? 'stations only (demo key)' : 'configured, not yet used';

async function fetchTankerkoenigWithKey(lat, lon, rad, type, apiKey) {
  const url = `https://creativecommons.tankerkoenig.de/json/list.php?lat=${lat}&lng=${lon}&rad=${rad}&sort=dist&type=${type}&apikey=${apiKey}`;
  const { data } = await axios.get(url, { timeout: 9000, headers: { 'User-Agent': 'cng-app/1.0' } });
  if (!data?.ok) throw new Error(data?.message || 'Tankerkönig rejected the request');
  return parseTankerkoenigStations(data, apiKey === TANKERKOENIG_DEMO_KEY);
}

/**
 * Benzin stations from Tankerkönig (MTS-K data, CC BY 4.0).
 *
 * A configured key yields real prices. If that key is rejected — wrong,
 * expired, or over quota — we fall back to the public demo key, which returns
 * genuine station locations with a placeholder price that
 * `parseTankerkoenigStations` strips. That keeps Benzin showing confirmed
 * stations instead of emptying the tab because of a bad key.
 */
async function fetchTankerkoenig(lat, lon, r = 10, benzinType = 'e5') {
  const rad = Math.min(Number(r) || 10, 25); // API hard limit
  const type = ['e5', 'e10', 'diesel'].includes(benzinType) ? benzinType : 'e5';
  const usingRealKey = TANKERKOENIG_API_KEY !== TANKERKOENIG_DEMO_KEY;

  try {
    const stations = await fetchTankerkoenigWithKey(lat, lon, rad, type, TANKERKOENIG_API_KEY);
    tankerkoenigStatus = usingRealKey ? 'live' : 'stations only (demo key)';
    return stations;
  } catch (err) {
    console.error('[prices] Tankerkönig failed:', err.message);
    if (!usingRealKey) {
      tankerkoenigStatus = `demo key failed: ${err.message}`;
      return [];
    }
    tankerkoenigStatus = `key rejected (${err.message}) — falling back to stations only`;
  }

  try {
    console.warn('[prices] falling back to the Tankerkönig demo key (stations only)');
    return await fetchTankerkoenigWithKey(lat, lon, rad, type, TANKERKOENIG_DEMO_KEY);
  } catch (err) {
    console.error('[prices] Tankerkönig demo fallback failed:', err.message);
    return [];
  }
}

app.get('/gibgas', async (req, res) => {
  const { lat, lon, r = 25 } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });
  try {
    const { data } = await axios.get('https://www.gibgas.de/server.php', {
      params: { gimme: 'radius_pois', lat, lng: lon, r },
      timeout: 12_000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; cng-proxy/2.0)', Accept: 'application/json' },
    });
    res.json(parseGibgasData(data));
  } catch (err) {
    const status = err.response?.status ?? 502;
    res.status(status).json({ error: err.message });
  }
});

// ── clever-tanken (CNG/Erdgas and Benzin, kept as supplementary) ─────────────
app.get('/ct', async (req, res) => {
  const { lat, lon, r, fuel } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

  const url = `https://www.clever-tanken.de/tankstelle_liste_json?lat=${lat}&lon=${lon}&r=${r ?? 25}&kraftstoff=${fuelConfig(fuel).ct}`;
  try {
    const { data } = await axios.get(url, {
      timeout: 12_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; cng-proxy/2.0)',
        Accept: 'application/json, text/plain, */*',
      },
    });
    res.json(data);
  } catch (err) {
    const status = err.response?.status ?? 502;
    res.status(status).json({ error: err.message });
  }
});

// ── /prices: aggregate prices from all sources ────────────────────────────────
// Returns array of { lat, lng, price, priceDate?, status, source }
app.get('/prices', async (req, res) => {
  const { lat, lon, r = 25, fuel, benzinType = 'e5' } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });
  const normalizedFuel = normalizeFuel(fuel);
  const radius = Math.round(Number(r) || 25);

  // Serve from in-memory cache when available — avoids repeated slow upstream calls
  const cached = readPriceCache(lat, lon, radius, normalizedFuel);
  if (cached) { res.json(cached); return; }

  console.log(`[prices] ${normalizedFuel} around ${lat},${lon} r=${radius}`);

  // key = "lat3_lng3" (3dp ≈ 110m grid), value = best price entry
  const priceMap = new Map();

  const upsert = (entry) => {
    if (!entry?.lat || !entry?.lng) return;
    const key = `${Number(entry.lat).toFixed(3)}_${Number(entry.lng).toFixed(3)}`;
    const existing = priceMap.get(key);
    if (!existing) {
      priceMap.set(key, entry);
    } else {
      const sourceRank = { tankerkoenig: 4, econtrol: 3, gibgas: 2 };
      if (entry.status === 'out_of_order') {
        priceMap.set(key, { ...entry, price: existing.price || entry.price });
      } else if ((sourceRank[entry.source] || 0) > (sourceRank[existing.source] || 0)) {
        // A higher-ranked source without a price must not erase a known one
        priceMap.set(key, entry.price == null && existing.price != null ? { ...entry, price: existing.price } : entry);
      }
    }
  };

  const tasks = [
    // gibgas.de — CNG primary, ~90%+ coverage Germany/AT
    normalizedFuel === 'cng' ? fetchGibgasAround(lat, lon, radius) : Promise.resolve([]),
    // E-Control — Austria only (lat ≤ 47.6); skipped for German locations
    fetchEControl(lat, lon, normalizedFuel),
    // Tankerkönig — German petrol stations. With the demo key it still confirms
    // which stations exist and sell the fuel; only the prices are withheld.
    normalizedFuel === 'benzin'
      ? fetchTankerkoenig(lat, lon, radius, benzinType)
      : Promise.resolve([]),
  ];

  const [gibgasResult, econtrolPrices, tankerkoenigPrices] = await Promise.allSettled(tasks);

  if (gibgasResult.status === 'fulfilled') {
    for (const entry of gibgasResult.value) upsert(entry);
  }
  if (econtrolPrices.status === 'fulfilled') {
    for (const entry of econtrolPrices.value) upsert(entry);
  }
  if (tankerkoenigPrices.status === 'fulfilled') {
    for (const entry of tankerkoenigPrices.value) upsert(entry);
  }

  const result = [...priceMap.values()];
  if (result.length > 0) writePriceCache(lat, lon, radius, normalizedFuel, result);
  res.json(result);
});

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    sources: ['gibgas', 'econtrol(AT)', 'tankerkoenig'],
    tankerkoenigKey: TANKERKOENIG_API_KEY === TANKERKOENIG_DEMO_KEY ? 'demo' : 'configured',
    benzinPrices: tankerkoenigStatus,
    priceCacheEntries: priceCache.size,
    stationCacheEntries: stationCache.size,
    seedStations: Object.fromEntries(
      Object.entries(osmSeed).map(([fuel, list]) => [fuel, Array.isArray(list) ? list.length : 0])
    ),
  })
);

// ── AXON Agent Endpoints ──────────────────────────────────────────────────────

app.get('/v1/agent-info', (_req, res) =>
  res.json({
    name: 'cng-station-agent',
    version: '1.0.0',
    description: 'Finds cheapest CNG and petrol stations near a location in Germany and Austria. Returns prices, coordinates and status.',
    actions: ['find_cheapest_cng', 'find_cheapest_benzin', 'get_stations'],
    price_per_cu: 100,
    currency: 'picoSUI',
    coverage: ['DE', 'AT'],
  })
);

app.use(express.json());

app.post('/v1/agent-task', async (req, res) => {
  const { session_id, action, params = {} } = req.body || {};

  if (!action) return res.status(400).json({ error: 'action required' });

  const lat  = params.lat  || params.latitude;
  const lon  = params.lon  || params.longitude || params.lng;
  const r    = params.radius || params.r || 25;

  if (!lat || !lon) {
    return res.status(422).json({ error: 'lat and lon (or latitude/longitude) required in params' });
  }

  const fuelMap = {
    find_cheapest_cng:    'cng',
    find_cheapest_benzin: 'benzin',
    get_stations:         params.fuel || 'cng',
  };

  const fuel = fuelMap[action];
  if (!fuel) {
    return res.status(400).json({
      error: `Unknown action '${action}'. Available: ${Object.keys(fuelMap).join(', ')}`,
    });
  }

  const t0 = Date.now();
  try {
    // Reuse the /prices logic by making an internal request
    const mockReq = { query: { lat, lon, r, fuel } };
    const stations = await new Promise((resolve, reject) => {
      const mockRes = {
        json: resolve,
        status(code) { return { json: reject }; },
      };
      // Call the prices handler directly
      require('http').get(
        `http://localhost:${PORT}/prices?lat=${lat}&lon=${lon}&r=${r}&fuel=${fuel}`,
        (response) => {
          let data = '';
          response.on('data', chunk => data += chunk);
          response.on('end', () => resolve(JSON.parse(data)));
        }
      ).on('error', reject);
    });

    const active = stations.filter(s => s.status !== 'out_of_order' && s.price != null);
    active.sort((a, b) => a.price - b.price);

    const elapsed = Date.now() - t0;
    const computeUnits = 1;

    return res.json({
      session_id,
      result: {
        fuel,
        radius_km: Number(r),
        total_stations: stations.length,
        active_with_price: active.length,
        cheapest: active.slice(0, 5).map(s => ({
          lat: s.lat,
          lng: s.lng,
          price_eur_per_kg: s.price,
          status: s.status,
          source: s.source,
        })),
        coverage_note: 'Sources: gibgas.de, clever-tanken, E-Control, Tankerkönig',
      },
      compute_units: computeUnits,
      elapsed_ms: elapsed,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Only start the server when run directly (not when required by tests).
if (require.main === module) {
  app.listen(PORT, () => console.log(`CNG proxy listening on :${PORT}`));
}

module.exports = {
  app,
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
  cacheSet,
  cacheGet,
  MAX_CACHE_ENTRIES,
};
