import React, { useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import { FUEL_META, type Station } from '../../services/gibgas';

// Inject Leaflet CSS once — bundlers don't handle CSS imports from node_modules in RN web.
function useLeafletCSS() {
  useEffect(() => {
    if (document.getElementById('leaflet-css')) return;
    const link = document.createElement('link');
    link.id = 'leaflet-css';
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);
  }, []);
}

// Fix broken default icon paths when bundled.
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)['_getIconUrl'];
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

function stationIcon(label: string) {
  return L.divIcon({
    className: '',
    html: `<div style="background:#FF6B00;color:#fff;font-size:11px;font-weight:700;padding:3px 7px;border-radius:6px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.4)">⛽ ${label}</div>`,
    iconAnchor: [22, 12],
  });
}

function RecenterMap({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView([lat, lng]);
  }, [lat, lng, map]);
  return null;
}

interface Props {
  userLat: number;
  userLng: number;
  stations: Station[];
  onStationPress?: (station: Station) => void;
}

export default function StationMap({ userLat, userLng, stations, onStationPress }: Props) {
  useLeafletCSS();

  return (
    <MapContainer
      center={[userLat, userLng]}
      zoom={11}
      style={{ width: '100%', height: '100%' }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <RecenterMap lat={userLat} lng={userLng} />
      {stations.map((s) => (
        <Marker
          key={s.id}
          position={[s.lat, s.lng]}
          icon={stationIcon(FUEL_META[s.fuel].label)}
          eventHandlers={{ click: () => onStationPress?.(s) }}
        >
          <Popup>
            <strong>{s.name}</strong>
            <br />
            {[s.address, s.city].filter(Boolean).join(', ')}
            <br />
            {s.price !== null ? `${s.price.toFixed(3)} €/${FUEL_META[s.fuel].unit}` : 'Preis unbekannt'}
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
