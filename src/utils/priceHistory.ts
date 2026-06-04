import { storage } from './storage';
import type { FuelType } from '../store/useAppStore';

interface PriceRecord {
  ts: number;
  price: number;
}

const MAX_RECORDS = 48;
const MIN_INTERVAL_MS = 14 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PREFIX = 'ph2_';

function histKey(lat: number, lng: number, fuel: FuelType): string {
  return `${PREFIX}${fuel}_${lat.toFixed(3)}_${lng.toFixed(3)}`;
}

function readHistory(k: string): PriceRecord[] {
  try {
    const raw = storage.getItem(k);
    return raw ? (JSON.parse(raw) as PriceRecord[]) : [];
  } catch {
    return [];
  }
}

export function recordPrice(lat: number, lng: number, price: number, fuel: FuelType): void {
  const k = histKey(lat, lng, fuel);
  const history = readHistory(k);
  const now = Date.now();

  if (history.length > 0) {
    const last = history[history.length - 1];
    if (now - last.ts < MIN_INTERVAL_MS) {
      if (last.price !== price) {
        history[history.length - 1] = { ts: now, price };
        storage.setItem(k, JSON.stringify(history));
      }
      return;
    }
  }

  history.push({ ts: now, price });
  if (history.length > MAX_RECORDS) history.splice(0, history.length - MAX_RECORDS);
  storage.setItem(k, JSON.stringify(history));
}

export interface PriceTrend {
  direction: 'up' | 'down' | 'stable' | 'new';
  delta: number | null;
  min7d: number | null;
  max7d: number | null;
  lastSeenMs: number | null;
}

export function analyzePriceTrend(lat: number, lng: number, currentPrice: number, fuel: FuelType): PriceTrend {
  const history = readHistory(histKey(lat, lng, fuel));
  const now = Date.now();

  const w7 = history.filter((r) => now - r.ts <= WEEK_MS).map((r) => r.price);
  const min7d = w7.length > 0 ? Math.min(...w7) : null;
  const max7d = w7.length > 0 ? Math.max(...w7) : null;
  const lastSeenMs = history.length > 0 ? history[history.length - 1].ts : null;

  if (history.length < 2) {
    return { direction: 'new', delta: null, min7d, max7d, lastSeenMs };
  }

  let prevPrice: number | null = null;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].price !== currentPrice) {
      prevPrice = history[i].price;
      break;
    }
  }

  if (prevPrice === null) {
    return { direction: 'stable', delta: null, min7d, max7d, lastSeenMs };
  }

  const delta = currentPrice - prevPrice;
  return { direction: delta > 0 ? 'up' : 'down', delta, min7d, max7d, lastSeenMs };
}
