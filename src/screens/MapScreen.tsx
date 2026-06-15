import React, { useMemo } from 'react';
import { View, ActivityIndicator, Text, StyleSheet } from 'react-native';
import { useAppStore } from '../store/useAppStore';
import { useStations, FUEL_META } from '../services/gibgas';
import StationMap from '../components/StationMap';
import { haversineKm } from '../utils/geo';

export default function MapScreen() {
  const { userLocation, searchLocation, selectedRadius, selectedFuel } = useAppStore();
  const activeLocation = searchLocation
    ? { latitude: searchLocation.latitude, longitude: searchLocation.longitude }
    : userLocation;

  const { data: stations = [] } = useStations(
    activeLocation?.latitude ?? null,
    activeLocation?.longitude ?? null,
    selectedRadius,
    selectedFuel
  );

  const filteredStations = useMemo(() => {
    if (!activeLocation) return [];
    return stations.filter(s =>
      haversineKm(activeLocation.latitude, activeLocation.longitude, s.lat, s.lng) <= selectedRadius
    );
  }, [stations, activeLocation, selectedRadius]);

  if (!activeLocation) {
    return (
      <View style={s.center}>
        <ActivityIndicator color={FUEL_META[selectedFuel].accent} size="large" />
        <Text style={s.hint}>Standort wird ermittelt…</Text>
      </View>
    );
  }

  return (
    <View style={s.fill}>
      <StationMap
        userLat={activeLocation.latitude}
        userLng={activeLocation.longitude}
        stations={filteredStations}
      />
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 14, backgroundColor: '#111' },
  hint: { color: '#666', fontSize: 14 },
});
