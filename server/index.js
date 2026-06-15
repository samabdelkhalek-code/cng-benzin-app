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

// ── E-Control (Official Austrian Spritpreisrechner) ──────────────────────────
function normalizeFuel(fuel) {
  return fuel === 'benzin' ? 'benzin' : 'cng';
}

function fuelConfig(fuel) {
  return normalizeFuel(fuel) === 'benzin'
    ? { econtrol: 'SUP', ct: 1 }
    : { econtrol: 'GAS', ct: 31 };
}

async function fetchEControl(lat, lon, fuel = 'cng') {
  try {
    const cfg = fuelConfig(fuel);
    const url = `https://api.e-control.at/sprit/1.0/search/gas-stations/by-address?latitude=${lat}&longitude=${lon}&fuelType=${cfg.econtrol}&includeClosed=true`;
    const { data } = await axios.get(url, { timeout: 8000, headers: { 'User-Agent': 'cng-app/1.0' } });
    return (data || []).map(s => ({
      lat: s.location.latitude,
      lng: s.location.longitude,
      price: s.prices?.[0]?.amount ?? null,
      status: s.open === false ? 'closed' : 'active', // E-Control status is about opening hours
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
function parseTankerkoenigStations(data) {
  if (!data?.ok || !Array.isArray(data.stations)) return [];
  return data.stations
    .map((s) => ({
      lat: s.lat,
      lng: s.lng,
      price: typeof s.price === 'number' && s.price > 0 ? s.price : parsePrice(s.price),
      status: s.isOpen === false ? 'closed' : 'active',
      source: 'tankerkoenig',
    }))
    .filter((s) => s.lat != null && s.lng != null);
}

async function fetchTankerkoenig(lat, lon, r = 10, benzinType = 'e5') {
  try {
    const rad = Math.min(Number(r) || 10, 25); // API hard limit
    const type = ['e5', 'e10', 'diesel'].includes(benzinType) ? benzinType : 'e5';
    const url = `https://creativecommons.tankerkoenig.de/json/list.php?lat=${lat}&lng=${lon}&rad=${rad}&sort=dist&type=${type}&apikey=${TANKERKOENIG_API_KEY}`;
    const { data } = await axios.get(url, { timeout: 9000, headers: { 'User-Agent': 'cng-app/1.0' } });
    return parseTankerkoenigStations(data);
  } catch (err) {
    console.error('[prices] Tankerkönig failed:', err.message);
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
  const cfg = fuelConfig(normalizedFuel);
  const radius = Math.round(Number(r) || 25);

  console.log(`[prices] ${normalizedFuel} around ${lat},${lon} r=${radius} (${r})`);

  // key = "lat3_lng3" (3dp ≈ 110m grid), value = best price entry
  const priceMap = new Map();

  const upsert = (entry) => {
    if (!entry?.lat || !entry?.lng) return;
    const key = `${Number(entry.lat).toFixed(3)}_${Number(entry.lng).toFixed(3)}`;
    const existing = priceMap.get(key);
    
    // Priority: econtrol > gibgas > ct
    // Also prefer entries with status 'out_of_order' to warn users
    if (!existing) {
      priceMap.set(key, entry);
    } else {
      // Benzin: Tankerkönig (official MTS-K) is most accurate. CNG: gibgas/econtrol.
      const sourceRank = { tankerkoenig: 4, econtrol: 3, gibgas: 2, ct: 1 };
      const currentRank = sourceRank[entry.source] || 0;
      const existingRank = sourceRank[existing.source] || 0;
      
      if (entry.status === 'out_of_order') {
        priceMap.set(key, { ...entry, price: existing.price || entry.price });
      } else if (currentRank > existingRank) {
        priceMap.set(key, entry);
      }
    }
  };

  const priceTasks = [
    // Source 1: gibgas.de — primary, ~90%+ coverage
    normalizedFuel === 'cng'
      ? axios.get('https://www.gibgas.de/server.php', {
          params: { gimme: 'radius_pois', lat, lng: lon, r: radius },
          timeout: 12_000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; cng-proxy/2.0)', Accept: 'application/json' },
        })
      : Promise.resolve(null),
    // Source 2: clever-tanken — supplementary
    axios.get('https://www.clever-tanken.de/tankstelle_liste_json', {
      params: { lat, lon, r: radius, kraftstoff: cfg.ct },
      timeout: 10_000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; cng-proxy/2.0)', Accept: 'application/json, text/plain, */*' },
    }),
    // Source 3: E-Control (AT only, but we call it anyway as it's fast)
    fetchEControl(lat, lon, normalizedFuel),
    // Source 4: Tankerkönig — primary German petrol prices (benzin only).
    // Gated on a real key: the demo key returns fake fixed prices, so we'd
    // rather show "k.A." than mislead.
    normalizedFuel === 'benzin' && TANKERKOENIG_API_KEY !== TANKERKOENIG_DEMO_KEY
      ? fetchTankerkoenig(lat, lon, radius, benzinType)
      : Promise.resolve([])
  ];

  const [gibgasResult, ctResult, econtrolPrices, tankerkoenigPrices] = await Promise.allSettled(priceTasks);

  if (normalizedFuel === 'cng' && gibgasResult.status === 'fulfilled' && gibgasResult.value) {
    for (const entry of parseGibgasData(gibgasResult.value.data)) upsert(entry);
  }

  if (ctResult.status === 'fulfilled') {
    const raw = ctResult.value.data;
    const list = Array.isArray(raw) ? raw : (raw?.stations ?? raw?.list ?? raw?.data ?? []);
    for (const entry of list) {
      const elat = entry.latitude ?? entry.lat ?? entry.breite;
      const elng = entry.longitude ?? entry.lon ?? entry.lng ?? entry.laenge;
      let price = null;
      if (Array.isArray(entry.kraftstoffe)) {
        const selected = entry.kraftstoffe.find((k) => Number(k.kraftstoff_id ?? k.id) === cfg.ct);
        if (selected) price = parsePrice(String(selected.preis ?? selected.price ?? ''));
      }
      if (price === null) price = parsePrice(String(entry.preis ?? entry.kraftstoffPreis ?? entry.price ?? ''));
      upsert({ lat: elat, lng: elng, price, source: 'ct', status: 'active' });
    }
  }

  if (econtrolPrices.status === 'fulfilled') {
    for (const entry of econtrolPrices.value) upsert(entry);
  }

  if (tankerkoenigPrices.status === 'fulfilled') {
    for (const entry of tankerkoenigPrices.value) upsert(entry);
  }

  res.json([...priceMap.values()]);
});

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    sources: ['gibgas', 'ct', 'econtrol', 'tankerkoenig'],
    tankerkoenigKey: TANKERKOENIG_API_KEY === TANKERKOENIG_DEMO_KEY ? 'demo' : 'configured',
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
};
