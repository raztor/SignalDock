import {
  Text,
  radius as uiRadius,
  space as uiSpace,
  useTheme,
} from '@signaldock/ui';
import { View } from 'react-native';
import type { AprsMapProps } from './AprsMap.types';

export default function AprsMap(_props: AprsMapProps) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityLabel="APRS map availability"
      style={{
        padding: uiSpace.xl,
        borderRadius: uiRadius.lg,
        backgroundColor: colors.surfaceElevated,
      }}
    >
      <Text style={{ color: colors.textPrimary }}>
        The interactive map is currently available in the web client. Received
        positions and packets remain available below.
      </Text>
    </View>
  );
}
