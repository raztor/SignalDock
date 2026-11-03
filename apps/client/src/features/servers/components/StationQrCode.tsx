import { light, radius, Text, useTheme } from '@signaldock/ui';
import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { qrMatrix, qrPath, qrViewBoxSize } from '../qr-model';

export interface StationQrCodeProps {
  /** Text to encode, normally the station's canonical base URL. */
  value: string;
  /** Rendered side length in points, quiet zone included. */
  size: number;
  accessibilityLabel: string;
}

/**
 * QR code drawn with react-native-svg. It always uses the light theme's
 * surface and text tokens: many scanners cannot read inverted (light on dark)
 * codes, so the symbol stays dark-on-light in dark mode too.
 */
export function StationQrCode({
  value,
  size,
  accessibilityLabel,
}: StationQrCodeProps) {
  const { colors } = useTheme();
  const symbol = useMemo(() => {
    try {
      const matrix = qrMatrix(value);
      return { path: qrPath(matrix), side: qrViewBoxSize(matrix) };
    } catch {
      return undefined;
    }
  }, [value]);
  if (!symbol)
    return (
      <Text style={{ color: colors.error }}>
        This address is too long for a QR code. Share the link instead.
      </Text>
    );
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={{
        width: size,
        height: size,
        alignSelf: 'center',
        borderRadius: radius.md,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <Svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${symbol.side} ${symbol.side}`}
      >
        <Rect
          x={0}
          y={0}
          width={symbol.side}
          height={symbol.side}
          fill={light.surface}
        />
        <Path d={symbol.path} fill={light.textPrimary} />
      </Svg>
    </View>
  );
}
