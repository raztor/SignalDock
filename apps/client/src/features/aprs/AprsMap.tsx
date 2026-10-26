import { Text, View } from 'react-native';
import type { AprsMapProps } from './AprsMap.types';

export default function AprsMap(_props: AprsMapProps) {
  return (
    <View
      accessibilityLabel="APRS map availability"
      style={{ padding: 20, borderRadius: 12, backgroundColor: '#152337' }}
    >
      <Text style={{ color: '#c7d8ed' }}>
        The interactive map is currently available in the web client. Received
        positions and packets remain available below.
      </Text>
    </View>
  );
}
