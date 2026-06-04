import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Linking, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppStore } from '../store/useAppStore';
import { FUEL_META } from '../services/gibgas';

export default function InfoScreen() {
  const insets = useSafeAreaInsets();
  const selectedFuel = useAppStore((state) => state.selectedFuel);
  const fuelLabel = FUEL_META[selectedFuel].label;

  const openURL = (url: string) => {
    Linking.openURL(url);
  };

  return (
    <ScrollView style={s.root} contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}>
      <View style={s.section}>
        <Text style={s.title}>CNG & Benzin App</Text>
        <Text style={s.version}>Version 1.0.0</Text>
        <Text style={s.description}>
          Finde schnell und einfach die nächsten {fuelLabel}-Tankstellen in deiner Umgebung mit aktuellen Preisen und Öffnungszeiten. Wechsle jederzeit zwischen CNG und Benzin.
        </Text>
      </View>

      <View style={s.section}>
        <Text style={s.label}>Datenquellen</Text>
        <Text style={s.text}>• Stationen: OpenStreetMap (Overpass API)</Text>
        <Text style={s.text}>• Preise: gibgas.de & clever-tanken.de</Text>
        <Text style={s.text}>• Österreich-Preise: E-Control</Text>
      </View>

      <View style={s.section}>
        <Text style={s.label}>Rechtliches</Text>
        <TouchableOpacity onPress={() => openURL('https://cng-app.de/privacy')}>
          <Text style={s.link}>Datenschutzerklärung</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => openURL('https://cng-app.de/terms')}>
          <Text style={s.link}>Nutzungsbedingungen</Text>
        </TouchableOpacity>
      </View>

      <View style={s.section}>
        <Text style={s.label}>Support</Text>
        <Text style={s.text}>Bei Fragen oder Problemen wende dich bitte an:</Text>
        <TouchableOpacity onPress={() => openURL('mailto:support@cng-app.de')}>
          <Text style={s.link}>support@cng-app.de</Text>
        </TouchableOpacity>
      </View>

      <View style={s.footer}>
        <Text style={s.footerText}>© 2026 CNG-App. Alle Rechte vorbehalten.</Text>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111', padding: 20 },
  section: { marginBottom: 30 },
  title: { color: '#FFF', fontSize: 24, fontWeight: '800', marginBottom: 4 },
  version: { color: '#666', fontSize: 14, marginBottom: 12 },
  description: { color: '#AAA', fontSize: 15, lineHeight: 22 },
  label: { color: '#FF6B00', fontSize: 12, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 },
  text: { color: '#EEE', fontSize: 14, marginBottom: 6, lineHeight: 20 },
  link: { color: '#3B82F6', fontSize: 15, fontWeight: '600', marginBottom: 12 },
  footer: { marginTop: 20, alignItems: 'center' },
  footerText: { color: '#444', fontSize: 12 },
});
