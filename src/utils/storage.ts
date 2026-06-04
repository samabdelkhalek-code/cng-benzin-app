import { Platform } from 'react-native';

// In-memory fallback for native (no localStorage) — survives app session, not restarts.
// For persistence on native, swap memCache for AsyncStorage.
const memCache = new Map<string, string>();

export const storage = {
  getItem(key: string): string | null {
    if (Platform.OS === 'web') {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    }
    return memCache.get(key) ?? null;
  },

  setItem(key: string, value: string): void {
    if (Platform.OS === 'web') {
      try {
        localStorage.setItem(key, value);
      } catch {}
    } else {
      memCache.set(key, value);
    }
  },
};
