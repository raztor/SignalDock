import { useEffect, useRef, useState } from 'react';
import type {
  GeoJSONSource,
  Map as MapLibreMap,
  MapMouseEvent,
} from 'maplibre-gl';
import { Text, View } from 'react-native';
import {
  latestStations,
  positionCollection,
  trackCollection,
} from './map-model';
import type { AprsMapProps } from './AprsMap.types';
import 'maplibre-gl/dist/maplibre-gl.css';

export default function AprsMap({
  positions,
  styleUrl,
  referenceTime = Date.now(),
  onPacketSelect,
}: AprsMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const current = useRef({ positions, onPacketSelect, referenceTime });
  current.current = { positions, onPacketSelect, referenceTime };
  const [error, setError] = useState('');
  const fitted = useRef(false);
  useEffect(() => {
    let disposed = false;
    fitted.current = false;
    setError('');
    void import('maplibre-gl')
      .then((module) => {
        if (disposed || !container.current) return;
        if (styleUrl && !/^https:\/\//.test(styleUrl))
          throw new Error('Map styles require a configured HTTPS URL.');
        const instance = new module.Map({
          container: container.current,
          style: styleUrl ?? {
            version: 8,
            sources: {},
            layers: [
              {
                id: 'background',
                type: 'background',
                paint: { 'background-color': '#101c2b' },
              },
            ],
          },
          center: [0, 0],
          zoom: 1,
          attributionControl: { compact: true },
          renderWorldCopies: false,
        });
        map.current = instance;
        instance.addControl(new module.NavigationControl());
        instance.on('error', () => {
          if (!disposed)
            setError(
              'The base map could not be loaded. Packet data remains available.',
            );
        });
        instance.on('load', () => {
          if (disposed) return;
          instance.addSource('stations', {
            type: 'geojson',
            data: positionCollection(
              current.current.positions,
              current.current.referenceTime,
            ),
          });
          instance.addSource('tracks', {
            type: 'geojson',
            data: trackCollection(current.current.positions),
          });
          instance.addLayer({
            id: 'received-tracks',
            type: 'line',
            source: 'tracks',
            paint: {
              'line-color': '#3f7f9e',
              'line-width': 2,
              'line-opacity': 0.6,
            },
          });
          instance.addLayer({
            id: 'received-stations',
            type: 'circle',
            source: 'stations',
            paint: {
              'circle-radius': 7,
              'circle-color': [
                'case',
                ['any', ['get', 'stale'], ['get', 'clockSkew']],
                '#8394aa',
                '#50dfc2',
              ],
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 1.5,
            },
          });
          instance.on(
            'click',
            'received-stations',
            (
              event: MapMouseEvent & {
                features?: { properties: Record<string, unknown> | null }[];
              },
            ) => {
              const feature = event.features?.[0];
              if (!feature?.properties) return;
              const packetId = feature.properties['packetId'];
              if (typeof packetId === 'string')
                current.current.onPacketSelect?.(packetId);
            },
          );
          const stations = latestStations(current.current.positions);
          if (stations.length) {
            const bounds = new module.LngLatBounds();
            for (const position of stations)
              bounds.extend([position.lon, position.lat]);
            instance.fitBounds(bounds, {
              padding: 48,
              maxZoom: 12,
              duration: 0,
            });
            fitted.current = true;
          }
        });
      })
      .catch((failure) => {
        if (!disposed)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Interactive mapping is unavailable.',
          );
      });
    return () => {
      disposed = true;
      map.current?.remove();
      map.current = null;
    };
  }, [styleUrl]);
  useEffect(() => {
    const instance = map.current;
    if (!instance || !instance.isStyleLoaded()) return;
    (instance.getSource('stations') as GeoJSONSource | undefined)?.setData(
      positionCollection(positions, referenceTime),
    );
    (instance.getSource('tracks') as GeoJSONSource | undefined)?.setData(
      trackCollection(positions),
    );
    const stations = latestStations(positions);
    if (!fitted.current && stations.length) {
      const first = stations[0]!;
      let west = first.lon,
        east = first.lon,
        south = first.lat,
        north = first.lat;
      for (const position of stations) {
        west = Math.min(west, position.lon);
        east = Math.max(east, position.lon);
        south = Math.min(south, position.lat);
        north = Math.max(north, position.lat);
      }
      instance.fitBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: 48, maxZoom: 12, duration: 0 },
      );
      fitted.current = true;
    }
  }, [positions, referenceTime]);
  return (
    <View style={{ gap: 8 }}>
      <div
        ref={container}
        aria-label="Received APRS positions"
        style={{ height: 360, borderRadius: 12, overflow: 'hidden' }}
      />
      {!styleUrl && (
        <Text style={{ color: '#92a7bf', fontSize: 12 }}>
          Position overlay only. A station administrator can configure a
          base-map style and its attribution.
        </Text>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: '#ffb4a9' }}>
          {error}
        </Text>
      )}
    </View>
  );
}
