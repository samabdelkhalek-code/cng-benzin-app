# CLAUDE.md

## Stack & Environment
- **Tech:** Expo SDK 54, React Native 0.81.5, Zustand, React Query.
- **Platforms:** Web (Priority), Android (Native).
- **Core Logic:** `App.tsx` (Location) → `useAppStore` → `useStations` → `PriceScreen`.
- **Data:** All upstream calls go through the proxy in `server/`. Discovery: Overpass/OSM via `/stations`. Prices: gibgas.de (CNG, primary), Tankerkönig (Benzin), E-Control (AT only).
- **Verification:** A station is only listed when two independent sources confirm it — OSM fuel tag **and** a matching price source within 1 km (`MATCH_KM`). Unverified stations are never shown.

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

## Deployment (Render)
- Two services from GitHub `cng-benzin-app`/main: `cng-app-web` (static) and `cng-proxy` (`rootDir: server`).
- The Expo build fails on Render's free tier, so **`dist/` is built locally and committed**. Frontend change → `npm run build:web` → commit `dist/` in the same commit, otherwise the old bundle stays live.

## Technical Debt / Known Issues
- **Overpass:** frequently 504s. `/stations` caches 24 h, serves stale data during outages, and falls back to `server/osm-seed.json`. Refresh that snapshot with `npm run seed` in `server/`.
- **gibgas:** ignores the `r` parameter and always returns the 12 nearest POIs — `sampleCenters` queries a ring of offset centres so wider radii are covered.
- **clever-tanken:** dead (404 everywhere), removed from `/prices`.
- **Tankerkönig:** runs on the public demo key, which returns real stations but a placeholder price. Prices are therefore withheld for Benzin until a real `TANKERKOENIG_API_KEY` env var is set on the proxy.
- **Accent colours:** `FUEL_META` defines a green accent for Benzin, but `PriceScreen.tsx` still hardcodes the CNG orange.

## Key Files
- `App.tsx`: Location strategies (GPS/IP).
- `src/store/useAppStore.ts`: App state & radius.
- `src/services/gibgas.ts`: Fetching, verification merge & client cache.
- `src/screens/PriceScreen.tsx`: Main UI & Sorting.
- `server/index.js`: Proxy — `/stations`, `/prices`, caching.
- `server/seed.js`: Refreshes the bundled OSM snapshot.

## no questions
- don't ask me always go with yes no aproval needed
