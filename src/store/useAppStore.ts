import { create } from 'zustand';

export type Radius = 10 | 20 | 50;
export type FuelType = 'cng' | 'benzin';

export interface SearchLocation {
  latitude: number;
  longitude: number;
  label: string;
}

interface AppState {
  userLocation: { latitude: number; longitude: number } | null;
  searchLocation: SearchLocation | null;
  selectedRadius: Radius;
  selectedFuel: FuelType;
  filterOpen: boolean;
  setUserLocation: (loc: { latitude: number; longitude: number }) => void;
  setSearchLocation: (loc: SearchLocation | null) => void;
  setSelectedRadius: (r: Radius) => void;
  setSelectedFuel: (fuel: FuelType) => void;
  setFilterOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  userLocation: null,
  searchLocation: null,
  selectedRadius: 20,
  selectedFuel: 'cng',
  filterOpen: false,
  setUserLocation: (loc) => set({ userLocation: loc }),
  setSearchLocation: (loc) => set({ searchLocation: loc }),
  setSelectedRadius: (r) => set({ selectedRadius: r }),
  setSelectedFuel: (fuel) => set({ selectedFuel: fuel }),
  setFilterOpen: (open) => set({ filterOpen: open }),
}));
