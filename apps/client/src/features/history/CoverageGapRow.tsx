import {
  Icon,
  Text,
  createStyles,
  radius,
  space,
  type,
  useTheme,
  visuallyHidden,
} from '@signaldock/ui';
import { View } from 'react-native';
import Svg, { Defs, Line, Pattern, Rect } from 'react-native-svg';
import { gapLabel, type CoverageGap } from './history-model';

const EXPLANATION =
  'The radio was not monitoring, so traffic may have been missed.';

/**
 * A stretch when the radio was not monitoring. Hatched and dashed so it does
 * not read as "quiet": an unmonitored gap is not evidence of no traffic.
 */
export function CoverageGapRow({
  gap,
  timeZone,
}: {
  gap: CoverageGap;
  timeZone: string;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const label = gapLabel(gap, timeZone);
  const pattern = `coverage-hatch-${gap.id.replace(/[^a-zA-Z0-9-]/g, '')}`;
  return (
    // role="note" lets web screen readers use the label (a generic div's
    // aria-label is ignored); the hidden text carries the explanation too.
    <View
      accessible
      role="note"
      accessibilityLabel={`${label}. ${EXPLANATION}`}
      style={styles.gap}
    >
      <Svg
        width="100%"
        height="100%"
        style={styles.hatch}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Defs>
          <Pattern
            id={pattern}
            width={12}
            height={12}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <Line
              x1={0}
              y1={0}
              x2={0}
              y2={12}
              stroke={colors.surfaceElevated}
              strokeWidth={6}
            />
          </Pattern>
        </Defs>
        <Rect
          x={0}
          y={0}
          width="100%"
          height="100%"
          fill={`url(#${pattern})`}
        />
      </Svg>
      <Icon name="clock" size={14} color={colors.textSecondary} />
      <Text style={styles.label}>{label}</Text>
      <Text style={visuallyHidden}>{EXPLANATION}</Text>
    </View>
  );
}

const useStyles = createStyles((c) => ({
  gap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginVertical: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: c.inputBorder,
    overflow: 'hidden',
  },
  hatch: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  label: { ...type.caption, color: c.textSecondary, flexShrink: 1 },
}));
