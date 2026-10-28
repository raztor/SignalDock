import { EmptyState } from '@signaldock/ui';
import {
  Text,
  radius as uiRadius,
  space as uiSpace,
  type as uiType,
  useTheme,
} from '@signaldock/ui';
import type {
  GeoJSONSource,
  Map as MapLibreMap,
  MapMouseEvent,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import type { AprsMapProps } from './AprsMap.types';
import {
  latestStations,
  positionCollection,
  trackCollection,
} from './map-model';

export default function AprsMap({
  positions,
  styleUrl,
  referenceTime = Date.now(),
  onPacketSelect,
}: AprsMapProps) {
  const { colors } = useTheme();
  const hasMapContent = Boolean(styleUrl || positions.length);
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const current = useRef({ positions, onPacketSelect, referenceTime });
  current.current = { positions, onPacketSelect, referenceTime };
  const [error, setError] = useState('');
  const fitted = useRef(false);
  useEffect(() => {
    if (!hasMapContent) return;
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
                paint: { 'background-color': colors.background },
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
        const resize = new ResizeObserver(() => instance.resize());
        resize.observe(container.current);
        instance.on('remove', () => resize.disconnect());
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
              'line-color': colors.secondary,
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
                colors.textSecondary,
                colors.primary,
              ],
              'circle-stroke-color': colors.surface,
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
              padding: uiSpace.xxxl,
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
  }, [styleUrl, hasMapContent]);
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const apply = () => {
      if (instance.getLayer('background') && !styleUrl)
        instance.setPaintProperty(
          'background',
          'background-color',
          colors.background,
        );
      if (instance.getLayer('received-tracks'))
        instance.setPaintProperty(
          'received-tracks',
          'line-color',
          colors.secondary,
        );
      if (instance.getLayer('received-stations')) {
        instance.setPaintProperty('received-stations', 'circle-color', [
          'case',
          ['any', ['get', 'stale'], ['get', 'clockSkew']],
          colors.textSecondary,
          colors.primary,
        ]);
        instance.setPaintProperty(
          'received-stations',
          'circle-stroke-color',
          colors.surface,
        );
      }
    };
    if (instance.isStyleLoaded()) apply();
    else instance.on('load', apply);
    return () => {
      instance.off('load', apply);
    };
  }, [colors, styleUrl]);
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
        { padding: uiSpace.xxxl, maxZoom: 12, duration: 0 },
      );
      fitted.current = true;
    }
  }, [positions, referenceTime]);
  if (!hasMapContent)
    return (
      <EmptyState
        title="No received positions"
        message="Positions will appear when your station receives APRS packets. Packets without a supported position remain available below."
      />
    );
  return (
    <View style={{ gap: uiSpace.sm }}>
      <div
        ref={container}
        aria-label="Received APRS positions"
        style={{ height: 360, borderRadius: uiRadius.lg, overflow: 'hidden' }}
      />
      {!styleUrl && (
        <Text
          style={{
            color: colors.textSecondary,
            fontSize: uiType.caption.fontSize,
          }}
        >
          Position overlay only. A station administrator can configure a
          base-map style and its attribution.
        </Text>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      )}
    </View>
  );
}
