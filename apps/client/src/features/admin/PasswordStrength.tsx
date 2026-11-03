import {
  Text,
  createStyles,
  radius,
  space,
  type,
  useTheme,
} from '@signaldock/ui';
import { View } from 'react-native';
import {
  passwordStrength,
  passwordStrengthLabel,
  type PasswordStrength as Strength,
} from './password-strength';

export interface PasswordStrengthProps {
  password: string;
  /** Predictable words for this account, e.g. the username. */
  context?: readonly string[];
}

const SEGMENTS = [1, 2, 3, 4] as const;

/**
 * Four-segment strength meter with a text label and a hint. The label always
 * names the level, so the meter never relies on colour alone.
 */
export function PasswordStrength({
  password,
  context = [],
}: PasswordStrengthProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  // Cheap and pure: recomputed on each render.
  const strength: Strength = passwordStrength(password, context);
  const fill =
    strength.tone === 'error'
      ? colors.error
      : strength.tone === 'warning'
        ? colors.warning
        : colors.primary;
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={passwordStrengthLabel(strength)}
      accessibilityLiveRegion="polite"
      style={styles.container}
    >
      <View style={styles.meter}>
        {SEGMENTS.map((segment) => (
          <View
            key={segment}
            style={[
              styles.segment,
              segment <= strength.score
                ? { backgroundColor: fill, borderColor: fill }
                : null,
            ]}
          />
        ))}
      </View>
      <View style={styles.textRow}>
        <Text
          style={[
            styles.label,
            { color: password ? fill : colors.textSecondary },
          ]}
        >
          {password ? strength.label : 'Password strength'}
        </Text>
        <Text style={styles.hint}>{strength.hint}</Text>
      </View>
    </View>
  );
}

const useStyles = createStyles((colors) => ({
  container: { gap: space.xs },
  meter: { flexDirection: 'row', gap: space.xs },
  segment: {
    flex: 1,
    height: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.inputBorder,
    backgroundColor: colors.surfaceElevated,
  },
  textRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: space.sm,
    alignItems: 'baseline',
  },
  label: { ...type.label, fontSize: 13 },
  hint: { ...type.caption, color: colors.textSecondary },
}));
