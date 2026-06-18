import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  TextInput,
} from 'react-native';
import axios from 'axios';
import { FUEL_META, useStations, Station } from '../services/gibgas';
import { FuelType, useAppStore, Radius } from '../store/useAppStore';
import { haversineKm, fmtTime } from '../utils/geo';
import { analyzePriceTrend, PriceTrend } from '../utils/priceHistory';
import { isOpenNow, fmtOpeningHours } from '../utils/openingHours';

// ── Helpers ───────────────────────────────────────────────────────────────────

const RADIUS_OPTIONS: Radius[] = [10, 20, 50];
const FUEL_OPTIONS: FuelType[] = ['cng', 'benzin'];
type Sort = 'distance' | 'price';

function navigate(lat: number, lng: number) {
  const url =
    Platform.OS === 'web'
      ? `http://maps.google.com/maps?daddr=${lat},${lng}`
      : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
  Linking.openURL(url);
}

function fmtPrice(p: number): string {
  return p.toFixed(3).replace('.', ',');
}

function fmtDelta(delta: number): string {
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(3).replace('.', ',')}`;
}

// ── Search Bar ───────────────────────────────────────────────────────────────

function SearchBar() {
  const { setSearchLocation, searchLocation } = useAppStore();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const { data } = await axios.get(`https://nominatim.openstreetmap.org/search`, {
        params: { q: query, format: 'json', limit: 1 },
      });
      if (data && data[0]) {
        setSearchLocation({
          latitude: parseFloat(data[0].lat),
          longitude: parseFloat(data[0].lon),
          label: data[0].display_name,
        });
      }
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={search.wrap}>
      <TextInput
        style={search.input}
        placeholder="Ort suchen (z.B. Wien, München)..."
        placeholderTextColor="#555"
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={handleSearch}
        returnKeyType="search"
      />
      {loading ? (
        <ActivityIndicator color="#FF6B00" style={search.icon} />
      ) : (
        <TouchableOpacity onPress={handleSearch} style={search.btn}>
          <Text style={search.btnText}>Suchen</Text>
        </TouchableOpacity>
      )}
      {searchLocation && (
        <TouchableOpacity onPress={() => { setQuery(''); setSearchLocation(null); }} style={search.clear}>
          <Text style={search.clearText}>✕</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Row {
  station: Station;
  distanceKm: number;
  trend: PriceTrend | null;
  isOpen: boolean | null;
}

// ── Station card ──────────────────────────────────────────────────────────────

function StationCard({ row, unit }: { row: Row; unit: string }) {
  const { station, distanceKm, trend, isOpen } = row;
  const isOutOfOrder = station.status === 'out_of_order';
  
  const show7d =
    trend !== null &&
    trend.min7d !== null &&
    trend.max7d !== null &&
    trend.min7d !== trend.max7d;

  return (
    <View style={card.wrap}>
      <View style={card.body}>
        <View style={card.info}>

          {/* Name row + open/closed dot */}
          <View style={card.nameRow}>
            <Text style={card.name} numberOfLines={1}>{station.name}</Text>
            {isOutOfOrder ? (
              <View style={[card.openBadge, card.oooBadge]}>
                <Text style={card.oooText}>AUẞER BETRIEB</Text>
              </View>
            ) : (
              <>
                {isOpen === true && (
                  <View style={card.openBadge}>
                    <View style={[card.dot, card.dotGreen]} />
                    <Text style={card.openText}>Offen</Text>
                  </View>
                )}
                {isOpen === false && (
                  <View style={card.openBadge}>
                    <View style={[card.dot, card.dotRed]} />
                    <Text style={card.closedText}>Geschl.</Text>
                  </View>
                )}
              </>
            )}
          </View>

          <Text style={card.addr} numberOfLines={1}>
            {[station.address, station.city].filter(Boolean).join(', ') || '–'}
          </Text>

          {/* Badges row */}
          <View style={card.badges}>
            <View style={card.badge}>
              <Text style={card.badgeText}>{distanceKm.toFixed(1)} km</Text>
            </View>
            <View style={card.badge}>
              <Text style={card.badgeText}>{fmtTime(distanceKm)}</Text>
            </View>

            {station.price !== null ? (
              <View style={[card.badge, card.priceBadge, isOutOfOrder && card.priceBadgeMuted]}>
                <Text style={card.priceBadgeText}>{fmtPrice(station.price)} €/{unit}</Text>
              </View>
            ) : (
              <View style={card.badge}>
                <Text style={card.badgeTextMuted}>k.A.</Text>
              </View>
            )}

            {/* Trend badge */}
            {trend && trend.direction === 'up' && trend.delta !== null && (
              <View style={[card.badge, card.trendUpBadge]}>
                <Text style={card.trendUpText}>▲ {fmtDelta(trend.delta)}</Text>
              </View>
            )}
            {trend && trend.direction === 'down' && trend.delta !== null && (
              <View style={[card.badge, card.trendDownBadge]}>
                <Text style={card.trendDownText}>▼ {fmtDelta(trend.delta)}</Text>
              </View>
            )}

            {station.verified && (
              <View style={[card.badge, card.verifiedBadge]}>
                <Text style={card.verifiedText}>✓ verifiziert</Text>
              </View>
            )}
          </View>

          {/* 7-day range */}
          {show7d && (
            <Text style={card.rangeText}>
              7 Tage: {fmtPrice(trend!.min7d!)} – {fmtPrice(trend!.max7d!)} €/{unit}
            </Text>
          )}

          {/* Opening hours */}
          {station.openingHours && (
            <Text style={card.hoursText} numberOfLines={1}>
              {fmtOpeningHours(station.openingHours)}
            </Text>
          )}

        </View>
      </View>

      <Pressable
        style={({ pressed }) => [card.navBtn, pressed && card.navBtnPressed]}
        onPress={() => navigate(station.lat, station.lng)}
      >
        <Text style={card.navText}>In Google Maps navigieren →</Text>
      </Pressable>
    </View>
  );
}

// ── Best-stations banner ──────────────────────────────────────────────────────

function BestBanner({ rows, unit }: { rows: Row[]; unit: string }) {
  const activeRows = rows.filter(r => r.station.status !== 'out_of_order');
  const withPrice = activeRows.filter((r) => r.station.price !== null);
  
  const nearest = activeRows.length > 0 ? activeRows.reduce((a, b) => (a.distanceKm <= b.distanceKm ? a : b)) : null;
  const cheapest =
    withPrice.length > 0 ? withPrice.reduce((a, b) => (a.station.price! <= b.station.price! ? a : b)) : null;

  if (!nearest && !cheapest) return null;

  return (
    <View style={banner.wrap}>
      {nearest && (
        <Pressable
          style={({ pressed }) => [banner.card, banner.blue, pressed && { opacity: 0.75 }]}
          onPress={() => navigate(nearest.station.lat, nearest.station.lng)}
        >
          <Text style={[banner.label, banner.labelBlue]}>NÄCHSTE</Text>
          <Text style={banner.stName} numberOfLines={1}>{nearest.station.name}</Text>
          <Text style={[banner.value, banner.valueBlue]}>
            {nearest.distanceKm.toFixed(1)} km · {fmtTime(nearest.distanceKm)}
            {nearest.station.price !== null ? ` · ${fmtPrice(nearest.station.price)} €/${unit}` : ''}
          </Text>
        </Pressable>
      )}
      {cheapest && (
        <Pressable
          style={({ pressed }) => [banner.card, banner.orange, pressed && { opacity: 0.75 }]}
          onPress={() => navigate(cheapest.station.lat, cheapest.station.lng)}
        >
          <Text style={[banner.label, banner.labelOrange]}>GÜNSTIGSTE</Text>
          <Text style={banner.stName} numberOfLines={1}>{cheapest.station.name}</Text>
          <Text style={[banner.value, banner.valueOrange]}>
            {fmtPrice(cheapest.station.price!)} €/{unit} · {cheapest.distanceKm.toFixed(1)} km
          </Text>
        </Pressable>
      )}
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function StationList() {
  const {
    userLocation,
    searchLocation,
    selectedRadius,
    selectedFuel,
    setSelectedRadius,
    setSelectedFuel,
    filterOpen,
    setFilterOpen,
  } = useAppStore();
  const [sort, setSort] = useState<Sort>('distance');

  const activeLocation = searchLocation || userLocation;
  const fuelMeta = FUEL_META[selectedFuel];

  const { data: stations = [], isLoading, isFetching, refetch, error } = useStations(
    activeLocation?.latitude ?? null,
    activeLocation?.longitude ?? null,
    selectedRadius,
    selectedFuel
  );

  const rows = useMemo((): Row[] => {
    if (!activeLocation) return [];
    let base = stations.map((s) => ({
      station: s,
      distanceKm: haversineKm(activeLocation.latitude, activeLocation.longitude, s.lat, s.lng),
      trend: s.price !== null ? analyzePriceTrend(s.lat, s.lng, s.price, selectedFuel) : null,
      isOpen: isOpenNow(s.openingHours),
    }));

    // Filter by radius client-side (important since fetch uses a buffer)
    base = base.filter(r => r.distanceKm <= selectedRadius);

    if (filterOpen) {
      base = base.filter(r => r.isOpen !== false);
    }
    return base;
  }, [stations, activeLocation, filterOpen, selectedRadius, selectedFuel]);

  // Only stations confirmed by 2+ sources (OSM + a matching price source)
  // go into the main list.
  const verifiedRows = useMemo(() => rows.filter((r) => r.station.verified), [rows]);

  const sorted = useMemo((): Row[] => {
    if (sort === 'distance') return [...verifiedRows].sort((a, b) => a.distanceKm - b.distanceKm);
    return [...verifiedRows].sort((a, b) => {
      if (a.station.price === null) return 1;
      if (b.station.price === null) return -1;
      return a.station.price - b.station.price;
    });
  }, [verifiedRows, sort]);

  const renderItem = useCallback(({ item }: { item: Row }) => <StationCard row={item} unit={fuelMeta.unit} />, [fuelMeta.unit]);
  const keyExtractor = useCallback((item: Row) => item.station.id, []);

  if (!activeLocation) {
    return (
      <View style={s.center}>
        <ActivityIndicator color="#FF6B00" size="large" />
        <Text style={s.hint}>Standort wird ermittelt…</Text>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <SearchBar />

      <View style={fuelTabs.wrap}>
        {FUEL_OPTIONS.map((fuel) => (
          <TouchableOpacity
            key={fuel}
            style={[fuelTabs.btn, selectedFuel === fuel && fuelTabs.btnOn]}
            onPress={() => setSelectedFuel(fuel)}
          >
            <Text style={[fuelTabs.txt, selectedFuel === fuel && fuelTabs.txtOn]}>
              {FUEL_META[fuel].label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      
      {searchLocation && (
        <View style={s.searchLocBox}>
          <Text style={s.searchLocTxt} numberOfLines={1}>📍 Zeige Stationen bei: {searchLocation.label}</Text>
        </View>
      )}

      {!isLoading && verifiedRows.length > 0 && <BestBanner rows={verifiedRows} unit={fuelMeta.unit} />}

      <View style={s.bar}>
        <Text style={s.barLabel}>Radius</Text>
        {RADIUS_OPTIONS.map((r) => (
          <TouchableOpacity
            key={r}
            style={[s.chip, selectedRadius === r && s.chipOn]}
            onPress={() => setSelectedRadius(r)}
          >
            <Text style={[s.chipTxt, selectedRadius === r && s.chipTxtOn]}>{r} km</Text>
          </TouchableOpacity>
        ))}
        <View style={s.sep} />
        <TouchableOpacity
          style={[s.chip, filterOpen && s.chipOn]}
          onPress={() => setFilterOpen(!filterOpen)}
        >
          <Text style={[s.chipTxt, filterOpen && s.chipTxtOn]}>Nur Offene</Text>
        </TouchableOpacity>
        <View style={s.sep} />
        <TouchableOpacity
          style={[s.chip, sort === 'distance' && s.chipOn]}
          onPress={() => setSort('distance')}
        >
          <Text style={[s.chipTxt, sort === 'distance' && s.chipTxtOn]}>Entfernung</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.chip, sort === 'price' && s.chipOn]}
          onPress={() => setSort('price')}
        >
          <Text style={[s.chipTxt, sort === 'price' && s.chipTxtOn]}>Preis</Text>
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <View style={s.center}>
          <ActivityIndicator color="#FF6B00" size="large" />
          <Text style={s.hint}>Lade Stationen…</Text>
        </View>
      ) : error ? (
        <View style={s.center}>
          <Text style={s.errorTitle}>Fehler beim Laden</Text>
          <Text style={s.hint}>Bitte Internetverbindung prüfen.</Text>
          <TouchableOpacity style={s.retryBtn} onPress={() => refetch()}>
            <Text style={s.retryTxt}>Erneut versuchen</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={sorted}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={s.list}
          refreshControl={
            <RefreshControl
              refreshing={isFetching && !isLoading}
              onRefresh={refetch}
              tintColor="#FF6B00"
              colors={['#FF6B00']}
            />
          }
          ListEmptyComponent={
            <View style={s.center}>
              <Text style={s.hint}>
                Keine verifizierten {fuelMeta.label}-Stationen im Umkreis.{'\n'}
                Nur Stationen mit bestätigter {fuelMeta.label}-Verfügbarkeit werden angezeigt.
              </Text>
              <TouchableOpacity style={s.retryBtn} onPress={() => setSelectedRadius(50)}>
                <Text style={s.retryTxt}>Radius auf 50 km erweitern</Text>
              </TouchableOpacity>
            </View>
          }
        />
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const search = StyleSheet.create({
  wrap: { flexDirection: 'row', backgroundColor: '#1A1A1A', padding: 10, alignItems: 'center', gap: 8, borderBottomWidth: 1, borderBottomColor: '#2A2A2A' },
  input: { flex: 1, height: 40, backgroundColor: '#2A2A2A', borderRadius: 8, paddingHorizontal: 12, color: '#EEE', fontSize: 14 },
  btn: { backgroundColor: '#FF6B00', height: 40, paddingHorizontal: 16, borderRadius: 8, justifyContent: 'center' },
  btnText: { color: '#FFF', fontWeight: '700', fontSize: 13 },
  icon: { width: 40 },
  clear: { padding: 8 },
  clearText: { color: '#666', fontSize: 18, fontWeight: '700' },
});

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 14, padding: 28 },
  hint: { color: '#666', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  errorTitle: { color: '#EEE', fontSize: 17, fontWeight: '700', textAlign: 'center' },
  retryBtn: {
    marginTop: 4,
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: '#FF6B00',
    borderRadius: 10,
  },
  retryTxt: { color: '#FFF', fontWeight: '700', fontSize: 14 },
  searchLocBox: { backgroundColor: '#222', paddingVertical: 6, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: '#333' },
  searchLocTxt: { color: '#AAA', fontSize: 11, fontWeight: '600' },
  bar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#1A1A1A',
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
  },
  barLabel: { color: '#666', fontSize: 12 },
  chip: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14, backgroundColor: '#2A2A2A' },
  chipOn: { backgroundColor: '#FF6B00' },
  chipTxt: { color: '#777', fontSize: 12, fontWeight: '600' },
  chipTxtOn: { color: '#FFF' },
  sep: { width: 1, height: 16, backgroundColor: '#333' },
  list: { padding: 12, gap: 10 },
});

const fuelTabs = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#141414',
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
  },
  btn: {
    flex: 1,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#242424',
    borderWidth: 1,
    borderColor: '#303030',
  },
  btnOn: { backgroundColor: '#FF6B00', borderColor: '#FF6B00' },
  txt: { color: '#888', fontSize: 13, fontWeight: '800' },
  txtOn: { color: '#FFF' },
});

const banner = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    gap: 10,
    padding: 12,
    backgroundColor: '#141414',
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
  },
  card: { flex: 1, borderWidth: 1, borderRadius: 10, padding: 11 },
  blue: { backgroundColor: '#001829', borderColor: '#3B82F6' },
  orange: { backgroundColor: '#1A0C00', borderColor: '#FF6B00' },
  label: { fontSize: 9, fontWeight: '800', letterSpacing: 1, marginBottom: 4 },
  labelBlue: { color: '#60A5FA' },
  labelOrange: { color: '#FF6B00' },
  stName: { color: '#EEE', fontSize: 13, fontWeight: '700', marginBottom: 3 },
  value: { fontSize: 13, fontWeight: '700' },
  valueBlue: { color: '#60A5FA' },
  valueOrange: { color: '#FF6B00' },
});

const card = StyleSheet.create({
  wrap: { backgroundColor: '#1A1A1A', borderRadius: 12, overflow: 'hidden' },
  body: { flexDirection: 'row', padding: 14, gap: 12, alignItems: 'flex-start' },
  info: { flex: 1 },

  nameRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 },
  name: { color: '#EEE', fontSize: 15, fontWeight: '700', flex: 1 },
  openBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 8 },
  oooBadge: { backgroundColor: '#450a0a', borderColor: '#ef4444', borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  oooText: { color: '#ef4444', fontSize: 10, fontWeight: '900' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  dotGreen: { backgroundColor: '#22C55E' },
  dotRed: { backgroundColor: '#EF4444' },
  openText: { color: '#22C55E', fontSize: 11, fontWeight: '700' },
  closedText: { color: '#EF4444', fontSize: 11, fontWeight: '700' },

  addr: { color: '#666', fontSize: 12, marginBottom: 8 },

  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  badge: { backgroundColor: '#2A2A2A', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 7 },
  badgeText: { color: '#AAA', fontSize: 12, fontWeight: '600' },
  badgeTextMuted: { color: '#444', fontSize: 12, fontWeight: '600' },

  priceBadge: { backgroundColor: '#FF6B00' },
  priceBadgeMuted: { backgroundColor: '#444' },
  priceBadgeText: { color: '#FFF', fontSize: 13, fontWeight: '800' },

  trendDownBadge: { backgroundColor: '#0D2B0D', borderWidth: 1, borderColor: '#22C55E' },
  trendDownText: { color: '#22C55E', fontSize: 12, fontWeight: '700' },
  trendUpBadge: { backgroundColor: '#2B0D0D', borderWidth: 1, borderColor: '#EF4444' },
  trendUpText: { color: '#EF4444', fontSize: 12, fontWeight: '700' },

  verifiedBadge: { backgroundColor: '#0D2B0D', borderWidth: 1, borderColor: '#22C55E' },
  verifiedText: { color: '#22C55E', fontSize: 11, fontWeight: '700' },

  rangeText: { color: '#555', fontSize: 11, marginTop: 6 },
  hoursText: { color: '#555', fontSize: 11, marginTop: 3 },

  navBtn: { backgroundColor: '#FF6B00', paddingVertical: 11, alignItems: 'center' },
  navBtnPressed: { backgroundColor: '#CC5200' },
  navText: { color: '#FFF', fontSize: 14, fontWeight: '700', letterSpacing: 0.2 },
});
