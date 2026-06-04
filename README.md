# CNG-App

Android-App zur Anzeige von CNG- und Benzin-Tankstellen in der Umgebung. Zeigt Preise, Öffnungszeiten und ermöglicht die Navigation zu Stationen.

## Features

- Interaktive Google Maps Karte mit dunklem Theme
- Tabs für CNG und Benzin mit denselben Listen-, Karten- und Filterfunktionen
- Stationen als Marker mit Echtzeit-Preisanzeige
- Automatisches Marker-Clustering ab 10+ Stationen im Sichtbereich
- Bottom Sheet bei Station-Auswahl: Name, Adresse, Preis, Öffnungszeiten
- In-App Navigation mit Polylinien-Route
- Preisliste sortiert nach günstigstem Preis
- Radius-Filter: 10 / 25 / 50 km
- Pull-to-Refresh, 5-Minuten-Cache via React Query

## Tech Stack

| Bibliothek | Zweck |
|---|---|
| Expo SDK 54 | Build-System & native Module |
| React Native Maps | Google Maps Integration |
| expo-location | GPS-Standortabfrage |
| @tanstack/react-query | Datenfetching & Caching |
| axios | HTTP-Client |
| zustand | Globaler State |
| @gorhom/bottom-sheet | Station-Detailansicht |
| supercluster | Marker-Clustering-Algorithmus |

## Voraussetzungen

- Node.js 18+
- Android Studio (für Android-Emulator) oder physisches Android-Gerät
- Google Maps API Key (mit Maps SDK for Android + Directions API aktiviert)
- gibgas.de API Key

## Setup

### 1. Repository klonen & Dependencies installieren

```bash
git clone <repo-url>
cd cng-app
npm install
```

### 2. API Keys konfigurieren

```bash
cp .env.example .env
```

`.env` befüllen:

```
EXPO_PUBLIC_GIBGAS_API_KEY=dein-gibgas-api-key
EXPO_PUBLIC_GOOGLE_MAPS_API_KEY=dein-google-maps-api-key
```

### 3. Google Maps Key in app.json eintragen

In `app.json` den Platzhalter ersetzen:

```json
"android": {
  "config": {
    "googleMaps": {
      "apiKey": "DEIN_ECHTER_API_KEY"
    }
  }
}
```

### 4. Native Android-Projekt generieren

```bash
npx expo prebuild --platform android
```

### 5. App starten

**Entwicklungsmodus:**
```bash
npx expo start
```

**Auf Android-Gerät/Emulator:**
```bash
npx expo run:android
```

## Projektstruktur

```
cng-app/
├── src/
│   ├── screens/
│   │   ├── MapScreen.tsx           # Karte mit Clustering & Navigation
│   │   └── PriceScreen.tsx         # Preisliste mit Filter
│   ├── components/
│   │   ├── StationMarker.tsx        # Custom Map Marker + Cluster Marker
│   │   └── StationBottomSheet.tsx   # Station-Detailansicht
│   ├── services/
│   │   ├── gibgas.ts                # API-Client für Stationen & Preise
│   │   └── maps.ts                  # Google Directions API
│   └── store/
│       └── useAppStore.ts           # Globaler Zustand (Zustand)
├── App.tsx                          # Root: Navigation + Provider
├── app.json                         # Expo-Konfiguration
├── .env.example                     # Vorlage für Umgebungsvariablen
└── .gitignore
```

## Umgebungsvariablen

| Variable | Beschreibung |
|---|---|
| `EXPO_PUBLIC_OPENCHARGEMAP_API_KEY` | API-Key für OpenChargeMap (kostenlos) |
| `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` | Google Maps API Key (Maps + Directions) |

> `EXPO_PUBLIC_`-Präfix ist bei Expo erforderlich, damit Variablen im App-Bundle verfügbar sind.

## Google Maps API aktivieren

In der [Google Cloud Console](https://console.cloud.google.com/):

1. APIs aktivieren: **Maps SDK for Android** + **Directions API**
2. API Key erstellen und auf Android-Paket `de.cngapp` beschränken

## OpenChargeMap API

Kostenloser API-Key unter [openchargemap.io](https://openchargemap.io/site/develop/api).  
Die App verwendet Overpass/OSM zur Stationssuche und reichert Preise über den Proxy mit gibgas.de, clever-tanken.de und E-Control an. CNG wird als `€/kg`, Benzin als `€/L` angezeigt.
