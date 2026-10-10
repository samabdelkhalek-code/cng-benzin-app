# CNG-App

Findet CNG- und Benzin-Tankstellen in Deutschland, Österreich und Italien —
mit Preisen, Öffnungszeiten und Navigation. Läuft als Web-App und als
Android-App aus derselben Codebasis.

**Live:** [cng-app-web.onrender.com](https://cng-app-web.onrender.com)

## Was die App besonders macht

Eine Station wird **nur angezeigt, wenn zwei unabhängige Quellen sie
bestätigen**: ein OSM-Kraftstoff-Tag *und* eine Preisquelle in höchstens 1 km
Entfernung. Das ist keine Spielerei — OpenStreetMap-Tags sind im Feld
nachweislich falsch. Die Aral in Schwäbisch Gmünd und die Eni in Bruneck sind
als CNG getaggt, verkaufen laut den amtlichen Preisregistern aber keines. Ohne
diese Regel schickt die App Leute zu Zapfsäulen, die es nicht gibt.

Der Preis dafür: Die Liste ist kürzer als bei anderen Apps. Das ist Absicht.

## Features

- Ortssuche mit Vorschlägen schon während des Tippens („Brunec" findet Bruneck)
- Umkreissuche mit 10 / 20 / 50 km
- Getrennte Tabs für CNG (€/kg) und Benzin (€/L), jeweils mit eigener Akzentfarbe
- Benzinsorten E5, E10 und Diesel
- Liste und Karte, sortierbar nach Entfernung oder Preis
- Öffnungszeiten inklusive Nachtöffnung und Mittagspause, Filter „Nur Offene"
- Preistrend der letzten sieben Tage
- Navigation über Google Maps

## Datenquellen

| Quelle | Rolle | Abdeckung |
|---|---|---|
| OpenStreetMap (Overpass) | Stationssuche | alle |
| gibgas.de | CNG-Preise | DE, AT |
| Osservaprezzi (MIMIT) | CNG-Preise | IT inkl. Südtirol |
| Tankerkönig (MTS-K) | Benzinpreise | DE |
| E-Control | Preise | AT |
| Photon / Nominatim | Ortssuche | alle |

Alle Abrufe laufen über den Proxy in `server/`, nie direkt aus dem Browser —
sonst wären weder Nutzungsbedingungen (Nominatim erlaubt eine Anfrage pro
Sekunde) noch gemeinsames Caching einzuhalten.

## Technik

Expo SDK 54 mit React Native, React Query fürs Fetching, Zustand für den State.
Die Karte ist plattformabhängig: Leaflet im Web, react-native-maps auf Android.
Der Proxy ist ein Express-Server ohne Datenbank — alle Caches liegen im
Arbeitsspeicher, dazu zwei eingebettete Datensätze als Rückfallebene.

## Entwicklung

```bash
npm install
npm run web                    # Web-Entwicklungsserver

cd server && npm install
cd server && npm start         # Proxy auf :3001
```

Ohne eigenen Proxy nutzt die App den öffentlichen unter
`https://cng-proxy.onrender.com`. Für einen lokalen Proxy:

```bash
echo "EXPO_PUBLIC_PROXY_URL=http://localhost:3001" > .env
```

### Tests

```bash
npm test                       # Client (src/**/*.test.ts)
npm run test:server            # Proxy
```

Keine Testbibliothek, nur Nodes eingebautes `node:test`.

### Android

```bash
npx expo prebuild --platform android
npx expo run:android
```

Dafür wird ein Google-Maps-Key benötigt (Maps SDK for Android), der in
`app.json` unter `android.config.googleMaps.apiKey` den Platzhalter ersetzt.
Die Web-Version braucht ihn nicht.

### Datensätze auffrischen

```bash
cd server && npm run seed
```

Erneuert `osm-seed.json` und `it-cng-seed.json` — die Rückfallebene, falls
Overpass oder Osservaprezzi ausfallen. Beide Dienste sind unzuverlässig oder
langsam genug, dass die App sonst zeitweise leere Listen zeigen würde.

## Deployment

Zwei Render-Services aus diesem Repository: `cng-app-web` (statisch) und
`cng-proxy` (`rootDir: server`). Der Expo-Build übersteigt Renders kostenlose
Stufe, deshalb liegt **`dist/` fertig gebaut im Repository** — nach jeder
Frontend-Änderung `npm run build:web` ausführen und `dist/` mitcommitten, sonst
bleibt die alte Version live.

Für echte Benzinpreise muss `TANKERKOENIG_API_KEY` in den Render-Einstellungen
des Proxys gesetzt sein (kostenlos über
[onboarding.tankerkoenig.de](https://onboarding.tankerkoenig.de/)). Ohne ihn
zeigt die App Stationen, aber keine Preise — der öffentliche Demo-Key liefert
für alle Stationen denselben Platzhalterwert, der bewusst unterdrückt wird.

Status prüfen:

```bash
curl -s https://cng-proxy.onrender.com/health
```

## Lizenz & Daten

Stationsdaten aus OpenStreetMap (ODbL). Benzinpreise von Tankerkönig
(CC BY 4.0), CNG-Preise von gibgas.de, Osservaprezzi (MIMIT) und E-Control.
