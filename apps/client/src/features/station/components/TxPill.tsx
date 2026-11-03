import { Icon, Text, space, type, useTheme } from '@signaldock/ui';
import { View } from 'react-native';
import { txPillTone, type TxPresentation } from '../station-model';

export interface TxPillProps {
  presentation: TxPresentation;
  size?: 'compact' | 'regular';
}

/**
 * Radio-reported TX state, the same on every surface. On air is filled with
 * the error colour; pending, stopping and unknown states are amber; an
 * unconfirmed carrier state adds a dashed border. Always icon plus text.
 */
export function TxPill({ presentation, size = 'compact' }: TxPillProps) {
  const { colors } = useTheme();
  const tone = txPillTone(presentation);
  const compact = size === 'compact';
  const foreground =
    tone === 'on-air'
      ? colors.surface
      : tone === 'caution'
        ? colors.warning
        : colors.textSecondary;
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={presentation.label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'center',
        gap: space.xs,
        paddingHorizontal: compact ? space.sm : space.md,
        paddingVertical: compact ? 2 : space.xs,
        borderRadius: 999,
        borderWidth: 1.5,
        borderStyle: presentation.uncertain ? 'dashed' : 'solid',
        // On a filled pill the dashes use the text colour so they stay visible.
        borderColor:
          tone === 'on-air'
            ? presentation.uncertain
              ? colors.surface
              : colors.error
            : foreground,
        backgroundColor: tone === 'on-air' ? colors.error : colors.surface,
      }}
    >
      <Icon name="tx" size={compact ? 12 : 14} color={foreground} />
      <Text
        numberOfLines={1}
        style={[
          type.caption,
          { fontWeight: '700', color: foreground, letterSpacing: 0.3 },
        ]}
      >
        {presentation.label}
      </Text>
    </View>
  );
}
