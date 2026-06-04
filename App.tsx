import React, { useState } from 'react';
import { View, Text, StyleSheet, Platform, TouchableOpacity } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLocation } from './src/hooks/useLocation';
import { FUEL_META } from './src/services/gibgas';
import { useAppStore } from './src/store/useAppStore';
import StationList from './src/screens/PriceScreen';
import MapScreen from './src/screens/MapScreen';
import InfoScreen from './src/screens/InfoScreen';

const queryClient = new QueryClient();

type Tab = 'list' | 'map' | 'info';

function TabBar({ activeTab, onSelect }: { activeTab: Tab; onSelect: (t: Tab) => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[tab.bar, { paddingBottom: insets.bottom }]}>
      <TouchableOpacity
        style={[tab.btn, activeTab === 'list' && tab.btnActive]}
        onPress={() => onSelect('list')}
      >
        <Text style={[tab.txt, activeTab === 'list' && tab.txtActive]}>Liste</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[tab.btn, activeTab === 'map' && tab.btnActive]}
        onPress={() => onSelect('map')}
      >
        <Text style={[tab.txt, activeTab === 'map' && tab.txtActive]}>Karte</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[tab.btn, activeTab === 'info' && tab.btnActive]}
        onPress={() => onSelect('info')}
      >
        <Text style={[tab.txt, activeTab === 'info' && tab.txtActive]}>Info</Text>
      </TouchableOpacity>
    </View>
  );
}

function AppContent() {
  const { status } = useLocation();
  const selectedFuel = useAppStore((s) => s.selectedFuel);
  const [activeTab, setActiveTab] = useState<Tab>('list');
  const ready = status === 'approximate' || status === 'precise';
  const fuelLabel = FUEL_META[selectedFuel].label;

  const renderScreen = () => {
    switch (activeTab) {
      case 'list': return <StationList />;
      case 'map': return <MapScreen />;
      case 'info': return <InfoScreen />;
      default: return <StationList />;
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>⛽ {fuelLabel} Stationen</Text>
        {status === 'approximate' && (
          <Text style={styles.headerApprox}>ungefährer Standort</Text>
        )}
      </View>

      {status === 'waiting' && (
        <View style={styles.center}>
          <Text style={styles.promptIcon}>📍</Text>
          <Text style={styles.promptTitle}>Standort erforderlich</Text>
          <Text style={styles.promptHint}>
            Bitte den Standortzugriff im Browser erlauben, damit die nächsten {fuelLabel}-Stationen gefunden werden können.
          </Text>
        </View>
      )}

      {status === 'denied' && (
        <View style={styles.center}>
          <Text style={styles.promptIcon}>🚫</Text>
          <Text style={styles.promptTitle}>Standort verweigert</Text>
          <Text style={styles.promptHint}>
            Standortzugriff wurde blockiert. Bitte in den Browser-Einstellungen erlauben und die Seite neu laden.
          </Text>
          <TouchableOpacity
            style={styles.reloadBtn}
            onPress={() => { if (Platform.OS === 'web') window.location.reload(); }}
          >
            <Text style={styles.reloadTxt}>Seite neu laden</Text>
          </TouchableOpacity>
        </View>
      )}

      {ready && (
        <>
          <View style={styles.screen}>
            {renderScreen()}
          </View>
          <TabBar activeTab={activeTab} onSelect={setActiveTab} />
        </>
      )}
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AppContent />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111' },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: '#1A1A1A',
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: { color: '#FFF', fontSize: 18, fontWeight: '800' },
  headerApprox: { color: '#FF6B00', fontSize: 11, fontWeight: '600' },
  screen: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 36, gap: 16 },
  promptIcon: { fontSize: 48 },
  promptTitle: { color: '#EEE', fontSize: 20, fontWeight: '800', textAlign: 'center' },
  promptHint: { color: '#777', fontSize: 14, textAlign: 'center', lineHeight: 22, maxWidth: 320 },
  reloadBtn: { marginTop: 8, paddingHorizontal: 24, paddingVertical: 12, backgroundColor: '#FF6B00', borderRadius: 10 },
  reloadTxt: { color: '#FFF', fontWeight: '700', fontSize: 15 },
});

const tab = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: '#1A1A1A',
    borderTopWidth: 1,
    borderTopColor: '#2A2A2A',
  },
  btn: {
    flex: 1,
    height: 52,
    justifyContent: 'center',
    alignItems: 'center',
    borderTopWidth: 2,
    borderTopColor: 'transparent',
  },
  btnActive: { borderTopColor: '#FF6B00' },
  txt: { color: '#555', fontSize: 13, fontWeight: '700' },
  txtActive: { color: '#FF6B00' },
});
