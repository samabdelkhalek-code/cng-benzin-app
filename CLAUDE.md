# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run web            # Expo dev server (web is the primary platform)
npm run android        # native build; run `npx expo prebuild --platform android` first if needed
npm run build:web      # expo export -p web → dist/   (see Deployment: dist/ is committed)

npm test               # client tests (src/**/*.test.ts)
npm run test:server    # proxy tests (server/index.test.js)
node --test --test-name-pattern "overnight" src/utils/openingHours.test.ts   # a single test

cd server && npm start      # proxy on :3001
cd server && npm run seed   # refresh osm-seed.json + it-cng-seed.json (slow, network-bound)
```

There is no lint script and no test framework beyond `node:test` — tests are
plain files with no build step, and client tests rely on Node's TypeScript
stripping, so their imports need explicit `.ts` extensions.

## Architecture

Two deployables in one repo: an Expo app (`App.tsx`, `src/`) and an Express
proxy (`server/`) that every upstream call goes through.

**Request path:** `App.tsx` resolves a location (GPS, else IP) → `useAppStore`
holds radius, fuel and petrol grade → `useStations` in `src/services/gibgas.ts`
(despite the name it owns all fetching, caching and the verification merge) →
`PriceScreen` renders the list. `MapScreen` reads the same hook, so both views
always agree.

**The two-source rule is the core invariant.** A station is listed only when two
independent sources confirm it: an OSM `fuel:cng` / `fuel:octane_95` tag **and**
a price source within `MATCH_KM` (1 km). `mergeAndVerify` sets `verified`, and
both screens filter on it. OSM fuel tags are demonstrably wrong in the field —
the Aral in Schwäbisch Gmünd and the Eni in Bruneck are tagged CNG but sell
none — and this rule is what hides them. Do not relax it to raise the hit count.

**Sources** (`server/index.js`): discovery from Overpass via `/stations`; CNG
prices from gibgas (DE/AT) and Osservaprezzi/MIMIT (IT, incl. South Tyrol);
petrol from Tankerkönig; E-Control for Austria; place search via `/geocode`
(Photon first because it does prefix matching, Nominatim as fallback).

**Every upstream is slow, flaky or both, so none is awaited on the hot path.**
This is the hardest-won property here and the cause of most past outages; each
fix took the same shape, and a new source should follow it:

| Upstream | Failure seen | Mitigation |
|---|---|---|
| Overpass | all mirrors 504; a cold key cost 26 s | 24 h cache, 4 s grace window, then `osm-seed.json`; refresh continues behind the response |
| MIMIT | two CSVs ≈ 7.5 MB, measured 93 s cold | `it-cng-seed.json` fallback, background refresh, 10 min failure backoff |
| gibgas | ignores `r`, always returns the 12 nearest POIs | `sampleCenters` queries a ring of offset centres |
| Nominatim | 1 req/s policy; matches whole terms only | capped serialised queue; Photon handles type-ahead |
| Tankerkönig | demo key returns one placeholder price | price withheld; a rejected real key falls back to demo (stations only) |
| clever-tanken | 404 everywhere | removed |

Clients cache for 20 minutes, so answering from a snapshot when live data was
available pins stale results for a whole session — hence the grace window rather
than an unconditional fallback.

## Deployment (Render)

Two services from GitHub `cng-benzin-app`/main: `cng-app-web` (static) and
`cng-proxy` (`rootDir: server`). The Expo build exceeds the free tier, so
**`dist/` is built locally and committed** — a frontend change means running
`npm run build:web` and committing `dist/` in the same commit, or the old bundle
stays live. Deploys have repeatedly lagged hours behind a push: verify with the
bundle hash at the site root and `/health` on the proxy rather than assuming.

`TANKERKOENIG_API_KEY` (free, from onboarding.tankerkoenig.de) must be set in the
Render dashboard for real petrol prices. `/health` reports whether the key
actually works, not merely whether one is set.

## Gotchas

- `server/` is **a nested git repo** (`cng-station-agent`). Check `git remote -v`
  before committing from inside it — commits made there never reach the app.
- `RATE_LIMIT_MAX` (default 120/min per IP) guards the unauthenticated proxy.
- `README.md` is stale: it describes marker clustering, a bottom sheet and
  in-app polyline routing that no longer exist, and radii that do not match.
  `supercluster` and `@gorhom/bottom-sheet` remain in `package.json` but are
  imported nowhere; the web map is Leaflet, native is react-native-maps. Trust
  the code over it.

## User preferences

- **No permission:** don't ask, just execute.
- **Code style:** TypeScript, strict types, functional.
- **Navigation:** web uses `http://maps.google.com/maps?daddr=...`.
- **Logic:** Haversine distance client-side; travel time at 50 km/h.
- **Speech:** short and declarative, no filler; show diffs rather than whole files.
