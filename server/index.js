'use strict';

const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

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
  const { lat, lon, r = 25, fuel } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });
  const normalizedFuel = normalizeFuel(fuel);
  const cfg = fuelConfig(normalizedFuel);

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
      const sourceRank = { econtrol: 3, gibgas: 2, ct: 1 };
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
          params: { gimme: 'radius_pois', lat, lng: lon, r },
          timeout: 12_000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; cng-proxy/2.0)', Accept: 'application/json' },
        })
      : Promise.resolve(null),
    // Source 2: clever-tanken — supplementary
    axios.get('https://www.clever-tanken.de/tankstelle_liste_json', {
      params: { lat, lon, r, kraftstoff: cfg.ct },
      timeout: 10_000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; cng-proxy/2.0)', Accept: 'application/json, text/plain, */*' },
    }),
    // Source 3: E-Control (AT only, but we call it anyway as it's fast)
    fetchEControl(lat, lon, normalizedFuel)
  ];

  const [gibgasResult, ctResult, econtrolPrices] = await Promise.allSettled(priceTasks);

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

  res.json([...priceMap.values()]);
});

app.get('/health', (_req, res) => res.json({ ok: true, sources: ['gibgas', 'ct', 'econtrol'] }));

app.listen(PORT, () => console.log(`CNG proxy listening on :${PORT}`));
