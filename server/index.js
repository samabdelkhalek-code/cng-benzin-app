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

// benzinType belongs in the key: E5, E10 and diesel are different products at
// different prices, so leaving it out made the grades collide — whichever was
// requested first was served to all of them for the next 15 minutes.
function priceCacheKey(lat, lon, r, fuel, benzinType) {
  const grade = normalizeFuel(fuel) === 'benzin' ? `_${benzinType ?? 'e5'}` : '';
  return `${fuel}${grade}_${Number(lat).toFixed(2)}_${Number(lon).toFixed(2)}_${Math.round(r)}`;
}

function readPriceCache(lat, lon, r, fuel, benzinType) {
  const hit = cacheGet(priceCache, priceCacheKey(lat, lon, r, fuel, benzinType), PRICE_CACHE_TTL);
  return hit && !hit.stale ? hit.data : null;
}

function writePriceCache(lat, lon, r, fuel, benzinType, data) {
  cacheSet(priceCache, priceCacheKey(lat, lon, r, fuel, benzinType), data);
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

// One refresh per cache key at a time: without this, every request arriving
// during a 26 s Overpass sweep would start its own.
const stationRefreshes = new Map();

function refreshStations(key, lat, lon, radius, fuel) {
  const running = stationRefreshes.get(key);
  if (running) return running;

  const task = queryOverpass(lat, lon, radius, fuel)
    .then((stations) => {
      cacheSet(stationCache, key, stations);
      return stations;
    })
    .catch((err) => {
      console.error(`[stations] refresh failed for ${key}: ${err.message}`);
      return null;
    })
    .finally(() => stationRefreshes.delete(key));

  stationRefreshes.set(key, task);
  return task;
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

  // Stale-while-revalidate. While Overpass is unhealthy every cold key burned
  // the full mirror budget before falling back, and clients hit their own
  // timeout first and showed an empty list. A stale entry or the bundled
  // snapshot is real OSM data that is at most weeks old, so it is served
  // immediately and the refresh runs behind the response.
  const fallback = hit?.data?.length ? hit.data : seedStations(lat, lon, radius, normalizedFuel);
  if (fallback.length) {
    refreshStations(key, lat, lon, radius, normalizedFuel);
    return res.json(fallback);
  }

  // Nothing to fall back on — this one has to wait for Overpass.
  const stations = await refreshStations(key, lat, lon, radius, normalizedFuel);
  if (stations) return res.json(stations);
  res.status(503).json({ error: 'station discovery unavailable' });
});

// ── Place search ─────────────────────────────────────────────────────────────
//
// Two geocoders, because they are good at different things:
//
// Photon (OSM, by Komoot) does prefix matching, which is what a search field
// needs — "Brunec" finds Bruneck. Nominatim's /search matches whole terms, so
// a half-typed name finds nothing useful: "Brun" returns hamlets literally
// called Brun and never Bruneck. Nominatim stays as the fallback because it is
// the more complete gazetteer once a full name is typed.
//
// Both run through the proxy rather than the browser so their usage policies
// are actually met: descriptive User-Agent, throttling, cached results. Place
// coordinates barely change, so a long TTL costs nothing.

const geocodeCache = new Map();
const GEOCODE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const NOMINATIM_MIN_INTERVAL_MS = 1100;
// The app's coverage area: DE/AT/CH plus Italy (South Tyrol) and the small
// neighbours travellers cross into.
const GEOCODE_COUNTRIES = 'de,at,ch,it,li,lu,nl,be,fr,cz,pl,dk,si';
// minLon,minLat,maxLon,maxLat — DACH plus Italy down to Sicily
const PLACE_BBOX = '5.5,35.4,19.5,55.5';

let nominatimChain = Promise.resolve();
let lastNominatimCall = 0;

/** Serialises Nominatim calls and spaces them out, as their policy requires. */
function scheduleNominatim(task) {
  const run = nominatimChain.then(async () => {
    const wait = lastNominatimCall + NOMINATIM_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatimCall = Date.now();
    return task();
  });
  // Keep the chain alive even when one call rejects
  nominatimChain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Turns a Nominatim hit into a short label plus a disambiguating detail line,
 * because display_name is a comma-salad far too long for a suggestion row.
 */
function toPlace(hit) {
  const lat = parseFloat(hit.lat);
  const lng = parseFloat(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const a = hit.address ?? {};
  const name =
    a.city ?? a.town ?? a.village ?? a.hamlet ?? a.municipality ??
    a.suburb ?? a.county ?? String(hit.display_name ?? '').split(',')[0].trim();

  // County/state give the context that tells two same-named towns apart
  const detail = [a.county, a.state, a.country].filter(Boolean);
  const unique = detail.filter((part, i) => part !== name && detail.indexOf(part) === i);

  return {
    label: name || String(hit.display_name ?? '').split(',')[0].trim(),
    detail: unique.join(', '),
    lat,
    lng,
  };
}

// Settlements first: someone searching for a town wants the town, not a street
// of the same name in another country.
const PLACE_TYPE_RANK = { city: 0, town: 1, municipality: 1, village: 2, district: 3, locality: 4 };

/** Converts one Photon GeoJSON feature into the compact shape the app uses. */
function photonToPlace(feature) {
  const [lng, lat] = feature?.geometry?.coordinates ?? [];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const p = feature.properties ?? {};
  const label = p.name;
  if (!label) return null;

  const detail = [p.district && p.district !== label ? p.district : null, p.state, p.country]
    .filter(Boolean)
    .filter((part, i, arr) => part !== label && arr.indexOf(part) === i);

  return {
    label,
    detail: detail.join(', '),
    lat,
    lng,
    _rank: PLACE_TYPE_RANK[p.type] ?? 9,
  };
}

async function searchPhoton(q, limit) {
  const { data } = await axios.get('https://photon.komoot.io/api/', {
    params: {
      q,
      limit: Math.min(limit * 3, 25), // room to drop streets and duplicates
      lang: 'de',
      bbox: PLACE_BBOX,
    },
    timeout: 9000,
    headers: { 'User-Agent': 'cng-app/2.0 (CNG station finder)' },
  });

  const ranked = (data?.features ?? [])
    .map(photonToPlace)
    .filter(Boolean)
    .sort((a, b) => a._rank - b._rank);

  // One town often appears several times — bilingual names, a district of the
  // same name, the boundary and the centre. Drop later entries that sit on top
  // of one already kept; the first is the best-ranked of the group.
  const kept = [];
  for (const place of ranked) {
    if (kept.some((k) => haversineKm(k.lat, k.lng, place.lat, place.lng) < 3)) continue;
    kept.push(place);
    if (kept.length === limit) break;
  }
  return kept.map(({ _rank, ...place }) => place);
}

async function searchNominatim(q, limit) {
  const { data } = await scheduleNominatim(() =>
    axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        q,
        format: 'json',
        limit,
        addressdetails: 1,
        countrycodes: GEOCODE_COUNTRIES,
        'accept-language': 'de',
      },
      timeout: 10_000,
      headers: { 'User-Agent': 'cng-app/2.0 (CNG station finder; contact via github.com/samabdelkhalek-code)' },
    })
  );
  return (Array.isArray(data) ? data : []).map(toPlace).filter(Boolean);
}

app.get('/geocode', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 10);
  if (q.length < 2) return res.json([]);

  const key = `${q.toLowerCase()}_${limit}`;
  const hit = cacheGet(geocodeCache, key, GEOCODE_CACHE_TTL);
  if (hit && !hit.stale) return res.json(hit.data);

  let places = [];
  try {
    places = await searchPhoton(q, limit);
  } catch (err) {
    console.error('[geocode] Photon failed:', err.message);
  }

  if (places.length === 0) {
    try {
      places = await searchNominatim(q, limit);
    } catch (err) {
      console.error('[geocode] Nominatim failed:', err.message);
      // A stale entry beats an error: place coordinates do not go bad.
      if (hit) return res.json(hit.data);
      return res.status(502).json({ error: `place search unavailable: ${err.message}` });
    }
  }

  cacheSet(geocodeCache, key, places);
  res.json(places);
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

// ── Osservaprezzi carburanti (Italien, MIMIT) ────────────────────────────────
//
// Neither gibgas nor E-Control covers Italy, so South Tyrol had no price source
// at all: around Bruneck, OSM knew four CNG stations and only one cleared the
// two-source rule. The ministry publishes every station and its prices as open
// data, which closes that gap — "Metano" is the Italian term for CNG.
//
// The two CSVs are ~7.5 MB together and are refreshed once a day, so they are
// parsed into a small index of CNG stations and cached for six hours.

const MIMIT_BASE = 'https://www.mimit.gov.it/images/exportCSV';
const MIMIT_CACHE_TTL = 6 * 60 * 60 * 1000;
const mimitCache = new Map();

/** Splits a MIMIT CSV: a header line to skip, then pipe-separated columns. */
function parseMimitCsv(text) {
  const lines = String(text).split('\n');
  const header = lines[1]?.split(';').length > 1 ? ';' : '|';
  const cols = lines[1]?.split(header).map((c) => c.trim()) ?? [];
  return lines.slice(2).flatMap((line) => {
    if (!line.trim()) return [];
    const parts = line.split(header);
    if (parts.length < cols.length) return [];
    const row = {};
    cols.forEach((c, i) => { row[c] = parts[i]?.trim(); });
    return [row];
  });
}

/** Builds { id -> {lat, lng, price} } for stations selling Metano (= CNG). */
function buildMimitIndex(anagraficaCsv, prezziCsv) {
  const prices = new Map();
  for (const row of parseMimitCsv(prezziCsv)) {
    if (!/metano/i.test(row.descCarburante ?? '')) continue;
    const price = parsePrice(row.prezzo);
    if (price === null) continue;
    // Several pumps per station: keep the cheapest quoted price
    const existing = prices.get(row.idImpianto);
    if (existing == null || price < existing) prices.set(row.idImpianto, price);
  }

  const stations = [];
  for (const row of parseMimitCsv(anagraficaCsv)) {
    const price = prices.get(row.idImpianto);
    if (price == null) continue;
    const lat = parseFloat(row.Latitudine);
    const lng = parseFloat(row.Longitudine);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    stations.push({ lat, lng, price, status: 'active', source: 'mimit' });
  }
  return stations;
}

async function loadMimitStations() {
  const hit = cacheGet(mimitCache, 'cng', MIMIT_CACHE_TTL);
  if (hit && !hit.stale) return hit.data;

  try {
    const [anagrafica, prezzi] = await Promise.all([
      axios.get(`${MIMIT_BASE}/anagrafica_impianti_attivi.csv`, { timeout: 25_000, responseType: 'text' }),
      axios.get(`${MIMIT_BASE}/prezzo_alle_8.csv`, { timeout: 25_000, responseType: 'text' }),
    ]);
    const stations = buildMimitIndex(anagrafica.data, prezzi.data);
    if (!stations.length) throw new Error('no Metano stations parsed');
    cacheSet(mimitCache, 'cng', stations);
    console.log(`[prices] MIMIT: indexed ${stations.length} Metano stations`);
    return stations;
  } catch (err) {
    console.error('[prices] MIMIT failed:', err.message);
    return hit ? hit.data : []; // stale index still beats no coverage
  }
}

// Rough bounding box for Italy incl. South Tyrol; skip the download elsewhere.
function nearItaly(lat, lon) {
  return Number(lat) >= 35.4 && Number(lat) <= 47.3 && Number(lon) >= 6.5 && Number(lon) <= 18.7;
}

async function fetchItalyCNG(lat, lon, radiusKm, fuel) {
  if (normalizeFuel(fuel) !== 'cng' || !nearItaly(lat, lon)) return [];
  const stations = await loadMimitStations();
  return stations.filter((s) => haversineKm(Number(lat), Number(lon), s.lat, s.lng) <= radiusKm);
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
  const cached = readPriceCache(lat, lon, radius, normalizedFuel, benzinType);
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
      // Official registries outrank scraped directories in their own country
      const sourceRank = { tankerkoenig: 4, econtrol: 3, mimit: 3, gibgas: 2 };
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
    // Osservaprezzi (MIMIT) — Italy incl. South Tyrol, the only CNG source there
    fetchItalyCNG(lat, lon, radius, normalizedFuel),
  ];

  const [gibgasResult, econtrolPrices, tankerkoenigPrices, italyPrices] =
    await Promise.allSettled(tasks);

  if (gibgasResult.status === 'fulfilled') {
    for (const entry of gibgasResult.value) upsert(entry);
  }
  if (econtrolPrices.status === 'fulfilled') {
    for (const entry of econtrolPrices.value) upsert(entry);
  }
  if (tankerkoenigPrices.status === 'fulfilled') {
    for (const entry of tankerkoenigPrices.value) upsert(entry);
  }
  if (italyPrices.status === 'fulfilled') {
    for (const entry of italyPrices.value) upsert(entry);
  }

  const result = [...priceMap.values()];
  if (result.length > 0) writePriceCache(lat, lon, radius, normalizedFuel, benzinType, result);
  res.json(result);
});

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    sources: ['gibgas', 'econtrol(AT)', 'tankerkoenig', 'mimit(IT)'],
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
  priceCacheKey,
  parseMimitCsv,
  buildMimitIndex,
  nearItaly,
  cacheSet,
  cacheGet,
  MAX_CACHE_ENTRIES,
};
