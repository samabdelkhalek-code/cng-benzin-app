# CLAUDE.md

## Stack & Environment
- **Tech:** Expo SDK 54, React Native 0.81.5, Zustand, React Query.
- **Platforms:** Web (Priority), Android (Native).
- **Core Logic:** `App.tsx` (Location) → `useAppStore` → `useStations` → `PriceScreen`.
- **Data:** Overpass API (CNG stations), gibgas.de (Prices - primary, ~90%+ coverage), clever-tanken.de (Prices - supplementary, often 404).

## Build & Dev
- `npm run web` | `npm run android` | `npm run ios`
- `npx expo prebuild --platform android`
- `npm run build` | `npm run lint`

## Strict Guidelines
- **No Permission:** Don't ask. Just execute. Always "Yes".
- **Code Style:** TypeScript, strict types, functional, state-of-the-art UI/UX.
- **Navigation:** Web uses `http://maps.google.com/maps?daddr=...`.
- **Logic:** Haversine distance client-side. Travel time @ 50 km/h.
- **Accuracy:** Use existing file context. No redundant scans.

## Caveman Mode (Token Saving)
- **No Filler:** No "I understand", "Sure", or "Here is the update".
- **Diffs Only:** Only output changed lines, not full files.
- **Speech:** Short, declarative, logic-driven. No pleasantries.

## Technical Debt / Known Issues
- **CORS:** gibgas.de works via proxy (`/gibgas` endpoint). CT JSON API returns 404 from some IPs.
- **Opening Hours:** `isOpen` always `true` (OSM parsing missing).
- **Reliability:** Overpass is slow; use sequential mirrors in `gibgas.ts`.

## Key Files
- `App.tsx`: Location strategies (GPS/IP).
- `src/store/useAppStore.ts`: App state & radius.
- `src/services/gibgas.ts`: Data fetching & cache.
- `src/screens/PriceScreen.tsx`: Main UI & Sorting.

## no questions
- don't ask me always go with yes no aproval needed
