import { useState, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useAppStore } from '../store/useAppStore';
import { storage } from '../utils/storage';

export type LocationStatus = 'waiting' | 'approximate' | 'precise' | 'denied';

interface Coords {
  latitude: number;
  longitude: number;
}

const IP_SERVICES: Array<(signal: AbortSignal) => Promise<Coords>> = [
  async (signal) => {
    const d = await fetch('https://freeipapi.com/api/json', { signal }).then((r) => r.json());
    return { latitude: d.latitude as number, longitude: d.longitude as number };
  },
  async (signal) => {
    const d = await fetch('https://ipapi.co/json/', { signal }).then((r) => r.json());
    return { latitude: d.latitude as number, longitude: d.longitude as number };
  },
  async (signal) => {
    const d = await fetch('https://ipwho.is/', { signal }).then((r) => r.json());
    return { latitude: d.latitude as number, longitude: d.longitude as number };
  },
];

const isCoords = (c: Coords | null | undefined): c is Coords =>
  !!c && typeof c.latitude === 'number' && typeof c.longitude === 'number';

/**
 * Races the IP services instead of trying them in turn: one slow provider used
 * to hold up the whole startup, because the next was only attempted after the
 * previous had failed.
 */
async function ipGeo(signal: AbortSignal): Promise<Coords | null> {
  if (signal.aborted) return null;
  try {
    return await Promise.any(
      IP_SERVICES.map(async (svc) => {
        const loc = await svc(signal);
        if (!isCoords(loc)) throw new Error('incomplete response');
        return loc;
      })
    );
  } catch {
    return null;
  }
}

// The last known position, so a returning visitor sees stations immediately
// rather than waiting on a network round trip for coordinates they already had.
const LAST_LOCATION_KEY = 'last_location_v1';
const LAST_LOCATION_TTL = 7 * 24 * 60 * 60 * 1000;

function readLastLocation(): Coords | null {
  const raw = storage.getItem(LAST_LOCATION_KEY);
  if (!raw) return null;
  try {
    const { ts, coords } = JSON.parse(raw);
    return Date.now() - ts < LAST_LOCATION_TTL && isCoords(coords) ? coords : null;
  } catch {
    return null;
  }
}

// Higher wins. A remembered position must yield to a fresh lookup, which in
// turn yields to GPS — a single boolean could not express that and let the
// remembered coordinates block the IP result outright.
const PRECISION = { remembered: 0, approximate: 1, precise: 2 } as const;
type Precision = keyof typeof PRECISION;

export function useLocation() {
  const setUserLocation = useAppStore((s) => s.setUserLocation);
  const [status, setStatus] = useState<LocationStatus>('waiting');
  const precision = useRef(-1);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let mounted = true;

    const applyLoc = (coords: Coords, source: Precision) => {
      if (!mounted || PRECISION[source] < precision.current) return;
      precision.current = PRECISION[source];
      setUserLocation(coords);
      setStatus(source === 'remembered' ? 'approximate' : source);
      // Only persist what we actually looked up; re-saving a remembered
      // position would keep refreshing its timestamp and it would never expire.
      if (source !== 'remembered') {
        storage.setItem(LAST_LOCATION_KEY, JSON.stringify({ ts: Date.now(), coords }));
      }
    };

    // Instant path: whatever we knew last time. Overwritten the moment IP or
    // GPS answers, so a stale position only ever shows for a moment.
    const remembered = readLastLocation();
    if (remembered) applyLoc(remembered, 'remembered');

    // Fast path: IP geolocation — no permission needed, ~200 ms.
    ipGeo(signal)
      .then((loc) => { if (loc) applyLoc(loc, 'approximate'); })
      .catch(() => {});

    // Precise path: GPS / expo-location on native, browser API on web.
    if (Platform.OS !== 'web') {
      (async () => {
        const Location = await import('expo-location');
        if (!mounted || signal.aborted) return;
        const { status: perm } = await Location.requestForegroundPermissionsAsync();
        if (perm !== 'granted') {
          if (mounted && precision.current < 0) setStatus('denied');
          return;
        }
        const pos = await Location.getCurrentPositionAsync({ accuracy: 3 });
        applyLoc({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }, 'precise');
      })();
    } else if (typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          applyLoc({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }, 'precise'),
        () => {
          if (mounted && precision.current < 0) setStatus('denied');
        },
        { enableHighAccuracy: false, timeout: 10_000, maximumAge: 5 * 60 * 1000 }
      );
    }

    return () => {
      mounted = false;
      controller.abort();
    };
  }, [setUserLocation]);

  return { status };
}
