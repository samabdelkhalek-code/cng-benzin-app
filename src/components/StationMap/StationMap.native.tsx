import React from 'react';
import { StyleSheet } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import { FUEL_META, type Station } from '../../services/gibgas';

interface Props {
  userLat: number;
  userLng: number;
  stations: Station[];
  onStationPress?: (station: Station) => void;
}

export default function StationMap({ userLat, userLng, stations, onStationPress }: Props) {
  return (
    <MapView
      style={StyleSheet.absoluteFill}
      provider={PROVIDER_GOOGLE}
      initialRegion={{
        latitude: userLat,
        longitude: userLng,
        latitudeDelta: 0.4,
        longitudeDelta: 0.4,
      }}
      showsUserLocation
      showsMyLocationButton
    >
      {stations.map((s) => (
        <Marker
          key={s.id}
          coordinate={{ latitude: s.lat, longitude: s.lng }}
          title={s.name}
          description={s.price !== null ? `${s.price.toFixed(3)} €/${FUEL_META[s.fuel].unit}` : 'Preis unbekannt'}
          pinColor={FUEL_META[s.fuel].accent}
          onCalloutPress={() => onStationPress?.(s)}
        />
      ))}
    </MapView>
  );
}
