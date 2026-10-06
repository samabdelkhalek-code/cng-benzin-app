'use strict';

/**
 * Refreshes osm-seed.json and it-cng-seed.json — the bundled snapshot of OSM fuel stations for
 * DE/AT/CH that /stations falls back to when every Overpass mirror is down.
 *
 * Run with: npm run seed
 *
 * Overpass frequently answers 504 under load, so each mirror is retried in
 * rotation until one succeeds. Re-run occasionally (stations change on a scale
 * of months) and commit the result.
 */

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

const BBOX = '45.8,5.8,55.1,17.2'; // DE + AT + CH
const FUEL_TAGS = { cng: 'fuel:cng', benzin: 'fuel:octane_95' };
const MAX_ATTEMPTS = 40;
const RETRY_DELAY_MS = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildQuery(tag) {
  return (
    '[out:json][timeout:180];' +
    `(node["amenity"="fuel"]["${tag}"="yes"](${BBOX});` +
    `way["amenity"="fuel"]["${tag}"="yes"](${BBOX});` +
    `relation["amenity"="fuel"]["${tag}"="yes"](${BBOX}););` +
    'out center tags;'
  );
}

function toStation(el) {
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) return null;
  const t = el.tags ?? {};
  return {
    id: `osm-${el.type}-${el.id}`,
    name: t.name ?? t.brand ?? t.operator ?? null,
    address: [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' '),
    city: t['addr:city'] ?? t['addr:town'] ?? t['addr:village'] ?? '',
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
    openingHours: t['opening_hours'] ?? null,
  };
}

async function fetchElements(query) {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const mirror = MIRRORS[i % MIRRORS.length];
    const host = new URL(mirror).host;
    try {
      const { data } = await axios.get(mirror, {
        params: { data: query },
        timeout: 180_000,
        headers: { 'User-Agent': 'cng-proxy/2.0 (seed refresh)' },
      });
      if (Array.isArray(data?.elements)) {
        console.log(`  ok via ${host} (attempt ${i + 1}): ${data.elements.length} elements`);
        return data.elements;
      }
      throw new Error('invalid payload');
    } catch (err) {
      console.log(`  attempt ${i + 1} via ${host} failed: ${err.message}`);
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error(`Overpass unreachable after ${MAX_ATTEMPTS} attempts`);
}

async function main() {
  const outPath = path.join(__dirname, 'osm-seed.json');
  // Keep whatever is already bundled for fuels this run cannot refresh
  let seed = {};
  try {
    seed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } catch {
    /* first run */
  }

  let failures = 0;
  for (const [fuel, tag] of Object.entries(FUEL_TAGS)) {
    console.log(`fetching ${fuel} (${tag}) …`);
    try {
      const elements = await fetchElements(buildQuery(tag));
      const stations = elements.map(toStation).filter(Boolean);
      seed[fuel] = stations;
      console.log(`  -> ${stations.length} stations with coordinates`);
    } catch (err) {
      failures++;
      const kept = seed[fuel]?.length ?? 0;
      console.error(`  !! ${fuel} failed: ${err.message} (keeping ${kept} existing)`);
    }
  }

  if (!Object.values(seed).some((v) => Array.isArray(v) && v.length)) {
    console.error('nothing to write — seed left untouched');
    process.exit(1);
  }

  fs.writeFileSync(outPath, JSON.stringify(seed));
  const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(0);
  console.log(`wrote ${outPath} (${sizeKb} kB)`);

  // Italian CNG snapshot: the cold-start fallback for Osservaprezzi, whose two
  // CSVs are far too slow to fetch inside a request.
  try {
    console.log('fetching Italian Metano prices (MIMIT) …');
    const { buildMimitIndex } = require('./index');
    const base = 'https://www.mimit.gov.it/images/exportCSV';
    const [anagrafica, prezzi] = await Promise.all([
      axios.get(`${base}/anagrafica_impianti_attivi.csv`, { timeout: 120_000, responseType: 'text' }),
      axios.get(`${base}/prezzo_alle_8.csv`, { timeout: 120_000, responseType: 'text' }),
    ]);
    const italy = buildMimitIndex(anagrafica.data, prezzi.data);
    if (!italy.length) throw new Error('no Metano stations parsed');
    const italyPath = path.join(__dirname, 'it-cng-seed.json');
    fs.writeFileSync(italyPath, JSON.stringify(italy));
    console.log(`  -> ${italy.length} Metano stations`);
  } catch (err) {
    failures++;
    console.error(`  !! Italian snapshot failed: ${err.message} (keeping existing)`);
  }

  process.exit(failures ? 1 : 0);
}

main();
