import axios from 'axios';
import { Platform } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { haversineKm } from '../utils/geo';
import { storage } from '../utils/storage';
import { recordPrice } from '../utils/priceHistory';
import type { FuelType } from '../store/useAppStore';

export const FUEL_META: Record<
  FuelType,
  { label: string; stationLabel: string; unit: string; accent: string; accentDark: string }
> = {
  cng: { label: 'CNG', stationLabel: 'CNG Tankstelle', unit: 'kg', accent: '#FF6B00', accentDark: '#CC5200' },
  benzin: { label: 'Benzin', stationLabel: 'Benzin Tankstelle', unit: 'L', accent: '#16A34A', accentDark: '#15803D' },
};

export interface Station {
  id: string;
  name: string;
  address: string;
  city: string;
  lat: number;
  lng: number;
  price: number | null;
  openingHours: string | null;
  /** true = confirmed by both OSM fuel tags AND a price source */
  verified: boolean;
  status: 'active' | 'out_of_order' | 'closed' | 'unknown';
  priceDate?: string | null;
  fuel: FuelType;
}

interface CTStation {
  lat: number;
  lng: number;
  price: number | null;
  name?: string;
  address?: string;
  city?: string;
  status?: 'active' | 'out_of_order' | 'closed' | 'unknown';
  priceDate?: string | null;
  source?: string;
}

// ── Overpass API ──────────────────────────────────────────────────────────────

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

const parsePrice = (text: string | null | undefined): number | null => {
  if (!text) return null;
  const m = text.replace(/,/g, '.').match(/(\d+\.\d{1,4})/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n >= 0.5 && n <= 5.0 ? n : null;
};

function priceFromTags(tags: Record<string, string>, fuel: FuelType): number | null {
  if (fuel === 'cng') {
    return parsePrice(
      tags['fuel:cng:retail_price'] ??
        tags['fuel:cng:price'] ??
        tags['fuel:CNG:retail_price'] ??
        tags.charge ??
        null
    );
  }
  return parsePrice(
    tags['fuel:octane_95:retail_price'] ??
      tags['fuel:octane_95:price'] ??
      tags['fuel:e10:retail_price'] ??
      tags['fuel:e10:price'] ??
      tags['fuel:octane_98:retail_price'] ??
      tags['fuel:octane_98:price'] ??
      tags.charge ??
      null
  );
}

function parseOverpassElements(elements: OverpassElement[], fuel: FuelType): Omit<Station, 'verified'>[] {
  return elements
    .map((el): Omit<Station, 'verified'> | null => {
      const t = el.tags ?? {};
      const slat = el.type === 'node' ? el.lat : el.center?.lat;
      const slng = el.type === 'node' ? el.lon : el.center?.lon;
      if (slat == null || slng == null) return null;
      const street = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
      const city = t['addr:city'] ?? t['addr:town'] ?? t['addr:village'] ?? '';
      return {
        id: `osm-${el.type}-${el.id}`,
        name: t.name ?? t.brand ?? t.operator ?? FUEL_META[fuel].stationLabel,
        address: street,
        city,
        lat: slat,
        lng: slng,
        price: priceFromTags(t, fuel),
        openingHours: t['opening_hours'] ?? null,
        status: 'active',
        fuel,
      };
    })
    .filter((s): s is Omit<Station, 'verified'> => s !== null);
}

function overpassFuelFilter(fuel: FuelType): string {
  if (fuel === 'cng') return '["fuel:cng"="yes"]';
  return '["fuel:octane_95"="yes"]';
}

async function queryOverpass(
  lat: number,
  lng: number,
  radiusKm: number,
  fuel: FuelType
): Promise<Omit<Station, 'verified'>[]> {
  const fuelFilter = overpassFuelFilter(fuel);
  const q =
    `[out:json][timeout:25];` +
    `(node["amenity"="fuel"]${fuelFilter}(around:${radiusKm * 1000},${lat},${lng});` +
    `way["amenity"="fuel"]${fuelFilter}(around:${radiusKm * 1000},${lat},${lng});` +
    `relation["amenity"="fuel"]${fuelFilter}(around:${radiusKm * 1000},${lat},${lng});` +
    `);` +
    `out center tags;`;

  const controller = new AbortController();
  try {
    return await Promise.any(
      OVERPASS_MIRRORS.map((mirror) =>
        axios
          .get<OverpassResponse>(mirror, {
            params: { data: q },
            timeout: 20000,
            signal: controller.signal,
            headers: { 'User-Agent': 'CNG-App/2.0 (Mobile; discovery)' },
          })
          .then(({ data }) => {
            if (!data || !data.elements) throw new Error('Invalid Overpass response');
            controller.abort();
            return parseOverpassElements(data.elements, fuel);
          })
      )
    );
  } catch (err) {
    if (err instanceof AggregateError) throw err.errors[err.errors.length - 1];
    throw err;
  }
}

// ── Price sources ─────────────────────────────────────────────────────────────
//
// gibgas.de: CNG-specific, ~90%+ price coverage, works on native + via proxy on web.
// clever-tanken: supplementary, kept as fallback.
//
// Native: direct HTTP — no CORS restriction.
// Web: own proxy server (EXPO_PUBLIC_PROXY_URL/{gibgas,ct}) — set in .env.

const CT_LIST_URL = 'https://www.clever-tanken.de/tankstelle_liste_json';
const GIBGAS_URL = 'https://www.gibgas.de/server.php';
const PROXY_BASE = process.env.EXPO_PUBLIC_PROXY_URL ?? 'https://cng-proxy.onrender.com';

function extractCNGPrice(entry: Record<string, unknown>): number | null {
  // Case 1: nested kraftstoffe array — find the CNG entry (id=31) explicitly
  if (Array.isArray(entry.kraftstoffe)) {
    const cngFuel = (entry.kraftstoffe as Record<string, unknown>[]).find(
      (k) => Number(k.kraftstoff_id ?? k.id ?? k.kraftstoffId) === 31
    );
    if (!cngFuel) return null; // station has no CNG fuel listed
    return parsePrice(String(cngFuel.preis ?? cngFuel.price ?? ''));
  }

  // Case 2: flat entry with explicit kraftstoff_id — reject anything that isn't CNG
  if (entry.kraftstoff_id !== undefined || entry.kraftstoffId !== undefined) {
    if (Number(entry.kraftstoff_id ?? entry.kraftstoffId) !== 31) return null;
    return parsePrice(String(entry.preis ?? entry.price ?? entry.kraftstoffPreis ?? ''));
  }

  // Case 3: flat entry, no type field — trust the selected fuel URL filter, prefer
  // a CNG-specific field name over a generic "preis" that might be any fuel
  return parsePrice(
    String(entry.kraftstoffPreis ?? entry.cng_preis ?? entry.erdgas_preis ?? entry.preis ?? entry.price ?? '')
  );
}

function parseCTResponse(data: unknown): CTStation[] {
  const raw = data as Record<string, unknown>;
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : ((raw?.stations ?? raw?.list ?? raw?.data ?? raw?.result ?? []) as unknown[]);

  return list.flatMap((e) => {
    const entry = e as Record<string, unknown>;
    const elat = entry.latitude ?? entry.lat ?? entry.breite;
    const elng = entry.longitude ?? entry.lon ?? entry.lng ?? entry.laenge;
    if (elat == null || elng == null) return [];

    const price = extractCNGPrice(entry);
    if (price === null) return [];

    return [
      {
        lat: Number(elat),
        lng: Number(elng),
        price,
        name: (entry.name ?? entry.tankstelle_name ?? entry.bezeichnung ?? undefined) as string | undefined,
        address:
          ([entry.strasse ?? entry.street, entry.hausnummer ?? entry.house_number]
            .filter(Boolean)
            .join(' ') || undefined) as string | undefined,
        city: (entry.ort ?? entry.stadt ?? entry.city ?? entry.place ?? undefined) as string | undefined,
      },
    ];
  });
}

async function fetchCTStations(
  lat: number,
  lng: number,
  radiusKm: number,
  fuel: FuelType = 'cng'
): Promise<CTStation[]> {
  const kraftstoff = fuel === 'benzin' ? 1 : 31;
  const directUrl = `${CT_LIST_URL}?lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}&r=${radiusKm}&kraftstoff=${kraftstoff}`;
  const proxyUrl = `${PROXY_BASE}/ct?lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}&r=${radiusKm}&fuel=${fuel}`;
  const url = Platform.OS === 'web' ? proxyUrl : directUrl;
  try {
    const { data } = await axios.get(url, { timeout: 12_000 });
    return parseCTResponse(data);
  } catch {
    return [];
  }
}

// ── gibgas.de price fetcher ───────────────────────────────────────────────────

function parseGibgasResponse(data: unknown): CTStation[] {
  const raw = data as { vector?: string[]; pois?: Record<string, { lat: unknown; lng: unknown; info?: string }> };
  if (!raw?.vector || !raw?.pois) return [];
  return raw.vector.flatMap((id) => {
    const poi = raw.pois![id];
    if (!poi?.lat || !poi?.lng || !poi?.info) return [];
    const pm = poi.info.match(/<span class="preis">([\d,]+)\s*€\/kg<\/span>/);
    if (!pm) return [];
    const price = parsePrice(pm[1]);
    if (price === null) return [];
    return [{ lat: parseFloat(String(poi.lat)), lng: parseFloat(String(poi.lng)), price }];
  });
}

async function fetchGibgasStations(lat: number, lng: number, radiusKm: number): Promise<CTStation[]> {
  try {
    if (Platform.OS === 'web') {
      const { data } = await axios.get<CTStation[]>(
        `${PROXY_BASE}/gibgas?lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}&r=${radiusKm}`,
        { timeout: 15_000 }
      );
      return Array.isArray(data) ? data : [];
    }
    // Native: call gibgas.de directly
    const { data } = await axios.get(GIBGAS_URL, {
      params: { gimme: 'radius_pois', lat: lat.toFixed(5), lng: lng.toFixed(5), r: radiusKm },
      timeout: 12_000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    return parseGibgasResponse(data);
  } catch {
    return [];
  }
}

// ── Price enrichment merge ────────────────────────────────────────────────────
//
// Overpass fuel tags are the ONLY source of station discovery.
// Price sources (gibgas + CT) enrich prices by proximity match.
// Match radius 0.5 km: gibgas/OSM may have slightly different pin positions.

const MATCH_KM = 0.5;

function mergeAndVerify(
  osmStations: Omit<Station, 'verified' | 'status'>[],
  priceSources: CTStation[]
): Station[] {
  return osmStations.map((s) => {
    let bestPrice = s.price;
    let bestStatus: Station['status'] = 'active';
    let bestIdx = -1;
    let bestDist = MATCH_KM;
    let priceDate = null;

    priceSources.forEach((ps, i) => {
      const d = haversineKm(s.lat, s.lng, ps.lat, ps.lng);
      if (d < bestDist) {
        bestDist = d;
        bestPrice = ps.price;
        bestStatus = ps.status || 'active';
        priceDate = ps.priceDate;
        bestIdx = i;
      }
    });

    return {
      ...s,
      price: bestPrice,
      verified: bestIdx >= 0,
      status: bestStatus,
      priceDate
    };
  }).filter((s) => s.verified);
  // Require at least 2 independent sources: OSM fuel-tag discovery PLUS a
  // matching price source (gibgas/clever-tanken/E-Control/Tankerkönig).
  // Stations that only appear in OSM (single source) are dropped to avoid
  // listing stations that don't actually have the selected fuel.
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 20 * 60 * 1000;
const r1 = (n: number) => Math.round(n * 100) / 100; // Round to 2 decimal places (~1km)
const cacheKey = (lat: number, lng: number, r: number, fuel: FuelType) => `${fuel}_v2_${r1(lat)}_${r1(lng)}_${r}`;

function readCache(lat: number, lng: number, radius: number, fuel: FuelType): Station[] | null {
  const raw = storage.getItem(cacheKey(lat, lng, radius, fuel));
  if (!raw) return null;
  try {
    const { ts, data } = JSON.parse(raw);
    return Date.now() - ts < CACHE_TTL_MS ? data : null;
  } catch {
    return null;
  }
}

function writeCache(lat: number, lng: number, radius: number, fuel: FuelType, data: Station[]) {
  storage.setItem(cacheKey(lat, lng, radius, fuel), JSON.stringify({ ts: Date.now(), data }));
}

// ── Combined fetch ────────────────────────────────────────────────────────────

async function fetchStations(lat: number, lng: number, radius: number, fuel: FuelType): Promise<Station[]> {
  const cached = readCache(lat, lng, radius, fuel);
  if (cached) return cached;

  const timeout = <T>(ms: number): Promise<T> =>
    new Promise<T>((resolve) => setTimeout(() => resolve([] as unknown as T), ms));

  // Use a smaller buffer now that coordinates are precise
  const fetchRadius = radius + 0.5;

  try {
    const [osmStations, priceSources] = await Promise.all([
      queryOverpass(lat, lng, fetchRadius, fuel),
      Promise.race([
        axios.get<CTStation[]>(
          `${PROXY_BASE}/prices?lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}&r=${fetchRadius}&fuel=${fuel}`,
          { timeout: 15_000 }
        )
          .then(res => res.data),
        timeout<CTStation[]>(14_000)
      ])
    ]);

    const merged = mergeAndVerify(osmStations, priceSources || []);
    merged.forEach((s) => { if (s.price !== null) recordPrice(s.lat, s.lng, s.price, fuel); });
    
    // Only cache if we actually got discovery results from Overpass,
    // or if the list is legitimately empty (to avoid caching temporary failures).
    // Actually, if queryOverpass didn't throw, it's a "success" even if empty.
    writeCache(lat, lng, radius, fuel, merged);
    return merged;
  } catch (err) {
    console.error('[fetchStations] Error:', err);
    return [];
  }
}

// ── React Query hook ──────────────────────────────────────────────────────────

export function useStations(lat: number | null, lng: number | null, radius: number, fuel: FuelType) {
  // We use rounded coordinates for the query KEY to avoid too many redundant requests
  // but we use REAL coordinates for the actual FETCH logic to ensure precision.
  const rlat = lat !== null ? r1(lat) : null;
  const rlng = lng !== null ? r1(lng) : null;

  return useQuery({
    queryKey: ['stations', fuel, rlat, rlng, radius],
    queryFn: () => fetchStations(lat!, lng!, radius, fuel),
    enabled: lat !== null && lng !== null,
    staleTime: CACHE_TTL_MS,
    gcTime: 30 * 60 * 1000,
    retry: 2,
  });
}
