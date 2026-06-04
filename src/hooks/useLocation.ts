import { useState, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useAppStore } from '../store/useAppStore';

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

async function ipGeo(signal: AbortSignal): Promise<Coords | null> {
  for (const svc of IP_SERVICES) {
    if (signal.aborted) return null;
    try {
      const loc = await svc(signal);
      if (typeof loc.latitude === 'number' && typeof loc.longitude === 'number') return loc;
    } catch {}
  }
  return null;
}

export function useLocation() {
  const setUserLocation = useAppStore((s) => s.setUserLocation);
  const [status, setStatus] = useState<LocationStatus>('waiting');
  const hasLocation = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let mounted = true;

    const applyLoc = (coords: Coords, nextStatus: LocationStatus) => {
      if (!mounted) return;
      // Never downgrade precise → approximate after GPS has resolved.
      if (nextStatus === 'approximate' && hasLocation.current) return;
      hasLocation.current = true;
      setUserLocation(coords);
      setStatus(nextStatus);
    };

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
          if (mounted && !hasLocation.current) setStatus('denied');
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
          if (mounted && !hasLocation.current) setStatus('denied');
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
