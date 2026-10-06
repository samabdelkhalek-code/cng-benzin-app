import { create } from 'zustand';

export type Radius = 10 | 20 | 50;
export type FuelType = 'cng' | 'benzin';
/** Petrol grades Tankerkönig reports; CNG has no equivalent split. */
export type BenzinType = 'e5' | 'e10' | 'diesel';

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
  selectedBenzinType: BenzinType;
  filterOpen: boolean;
  setUserLocation: (loc: { latitude: number; longitude: number }) => void;
  setSearchLocation: (loc: SearchLocation | null) => void;
  setSelectedRadius: (r: Radius) => void;
  setSelectedFuel: (fuel: FuelType) => void;
  setSelectedBenzinType: (t: BenzinType) => void;
  setFilterOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  userLocation: null,
  searchLocation: null,
  selectedRadius: 20,
  selectedFuel: 'cng',
  selectedBenzinType: 'e5',
  filterOpen: false,
  setUserLocation: (loc) => set({ userLocation: loc }),
  setSearchLocation: (loc) => set({ searchLocation: loc }),
  setSelectedRadius: (r) => set({ selectedRadius: r }),
  setSelectedFuel: (fuel) => set({ selectedFuel: fuel }),
  setSelectedBenzinType: (t) => set({ selectedBenzinType: t }),
  setFilterOpen: (open) => set({ filterOpen: open }),
}));
