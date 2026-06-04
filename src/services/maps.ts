import axios from 'axios';

export interface Coordinate {
  latitude: number;
  longitude: number;
}

export interface RouteResult {
  polyline: Coordinate[];
  distance: string;
  duration: string;
}

// Decode Google encoded polyline format
const decodePolyline = (encoded: string): Coordinate[] => {
  const coords: Coordinate[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let b: number;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return coords;
};

export const getRoute = async (
  origin: Coordinate,
  destination: Coordinate
): Promise<RouteResult> => {
  const apiKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error('Google Maps API Key fehlt');

  const { data } = await axios.get(
    'https://maps.googleapis.com/maps/api/directions/json',
    {
      params: {
        origin: `${origin.latitude},${origin.longitude}`,
        destination: `${destination.latitude},${destination.longitude}`,
        key: apiKey,
        language: 'de',
        mode: 'driving',
      },
    }
  );

  if (data.status !== 'OK') throw new Error(`Directions API: ${data.status}`);

  const route = data.routes[0];
  const leg = route.legs[0];

  return {
    polyline: decodePolyline(route.overview_polyline.points),
    distance: leg.distance.text,
    duration: leg.duration.text,
  };
};
