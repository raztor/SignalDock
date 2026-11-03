import {
  Pressable,
  Text,
  createStyles,
  layout,
  radius,
  space,
  type,
  useTheme,
  visuallyHidden,
} from '@signaldock/ui';
import { memo, useCallback, useRef, useState, type ReactNode } from 'react';
import { Platform, ScrollView, View, useWindowDimensions } from 'react-native';
import {
  HEATMAP_LEVELS,
  communicationCount,
  heatmapKeyMove,
  heatmapTabStop,
  type Heatmap,
  type HeatmapCell,
  type HeatmapLevel,
  type HeatmapPosition,
} from './history-model';

export interface ActivityHeatmapProps {
  heatmap: Heatmap;
  /** `endsAt` of the hour currently used as the `before` filter. */
  selectedEndsAt?: string;
  onSelect(cell: HeatmapCell): void;
}

/** Fill strength of each level over the elevated surface. */
const LEVEL_OPACITY: Record<HeatmapLevel, number> = {
  0: 0,
  1: 0.25,
  2: 0.45,
  3: 0.7,
  4: 1,
};
const HOUR_LABELS = [0, 6, 12, 18];
const CELL_GAP = 2;
/** Compact cells: 32 pt plus 2 pt slop on each side gives a 36 pt target. */
const COMPACT_CELL = 32;
const WIDE_CELL_HEIGHT = 20;
const HEADER_HEIGHT = 14;
const DAY_LABEL_WIDTH = 30;

type Focusable = { focus?: () => void };
const web = Platform.OS === 'web';
const key = (position: HeatmapPosition) => `${position.row}:${position.hour}`;

/**
 * Days × 24 h grid of communication counts. Tapping an hour asks the
 * timeline to show what happened up to the end of that hour. On phones the
 * hours scroll sideways so each cell stays large enough to tap. On web the
 * grid is one Tab stop: arrow keys move by hour and day, Home/End jump to
 * the start and end of the row.
 */
export function ActivityHeatmap({
  heatmap,
  selectedEndsAt,
  onSelect,
}: ActivityHeatmapProps) {
  const styles = useStyles();
  const { width } = useWindowDimensions();
  const compact = width < layout.compact;
  const cellHeight = compact ? COMPACT_CELL : WIDE_CELL_HEIGHT;
  const nodes = useRef(new Map<string, Focusable>());
  const [focused, setFocused] = useState<HeatmapPosition>();
  const registerCell = useCallback(
    (row: number, hour: number, node: Focusable | null) => {
      if (node) nodes.current.set(key({ row, hour }), node);
      else nodes.current.delete(key({ row, hour }));
    },
    [],
  );
  const focusCell = useCallback(
    (row: number, hour: number) =>
      setFocused((previous) =>
        previous?.row === row && previous.hour === hour
          ? previous
          : { row, hour },
      ),
    [],
  );
  const stillValid =
    focused && heatmap.rows[focused.row]?.cells[focused.hour]?.future === false;
  const tabStop = stillValid
    ? focused
    : heatmapTabStop(heatmap, selectedEndsAt);

  const onKeyDown = (event: {
    key?: string;
    preventDefault(): void;
    nativeEvent?: { key?: string };
  }) => {
    const pressed = event.key ?? event.nativeEvent?.key;
    if (!pressed || !tabStop) return;
    const next = heatmapKeyMove(pressed, tabStop, heatmap);
    if (!next) return;
    event.preventDefault();
    setFocused(next);
    nodes.current.get(key(next))?.focus?.();
  };

  const header = (
    <View
      style={[styles.hours, { height: HEADER_HEIGHT }]}
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      {Array.from({ length: 24 }, (_, hour) => (
        <Text
          key={hour}
          style={[styles.hourLabel, compact && styles.compactWidth]}
          numberOfLines={1}
        >
          {HOUR_LABELS.includes(hour) ? String(hour).padStart(2, '0') : ''}
        </Text>
      ))}
    </View>
  );
  const grid = (
    <View
      style={[
        styles.grid,
        compact && { width: 24 * (COMPACT_CELL + CELL_GAP) },
      ]}
      {...(web
        ? ({
            role: 'grid',
            'aria-label': 'Activity, last 7 days',
            onKeyDown,
          } as object)
        : {})}
    >
      {header}
      {heatmap.rows.map((row, rowIndex) => (
        <View
          key={row.day}
          style={[styles.hours, { height: cellHeight }]}
          {...(web ? ({ role: 'row' } as object) : {})}
        >
          {web ? (
            <Text role="rowheader" style={visuallyHidden}>
              {row.shortLabel}
            </Text>
          ) : null}
          {row.cells.map((cell) => (
            <HeatCell
              key={cell.hour}
              row={rowIndex}
              cell={cell}
              height={cellHeight}
              compact={compact}
              selected={cell.endsAt === selectedEndsAt}
              tabStop={tabStop?.row === rowIndex && tabStop.hour === cell.hour}
              registerCell={registerCell}
              onFocusCell={focusCell}
              onSelect={onSelect}
            />
          ))}
        </View>
      ))}
    </View>
  );
  // Day labels sit outside the (sideways scrolling) hours so they stay put.
  const labels = (
    <View
      style={styles.labels}
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      <View style={{ height: HEADER_HEIGHT }} />
      {heatmap.rows.map((row) => (
        <View
          key={row.day}
          style={{ height: cellHeight, justifyContent: 'center' }}
        >
          <Text style={styles.dayLabel} numberOfLines={1}>
            {row.shortLabel}
          </Text>
        </View>
      ))}
    </View>
  );
  let hours: ReactNode = <View style={styles.wideHours}>{grid}</View>;
  if (compact)
    hours = (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        style={styles.wideHours}
        accessibilityLabel="Activity hours, scroll sideways for more"
      >
        {grid}
      </ScrollView>
    );
  return (
    <View style={styles.root}>
      <View style={styles.body}>
        {labels}
        {hours}
      </View>
      <View style={styles.legend}>
        <Text style={styles.caption}>
          {heatmap.total === 0
            ? 'No communications in the last 7 days.'
            : `${communicationCount(heatmap.total)} · busiest hour: ${communicationCount(heatmap.max)}`}
        </Text>
        <View
          style={styles.scale}
          accessible
          accessibilityLabel="Colour scale from less to more communications"
        >
          <Text style={styles.caption}>Less</Text>
          {Array.from({ length: HEATMAP_LEVELS + 1 }, (_, level) => (
            <Swatch key={level} level={level as HeatmapLevel} size={12} />
          ))}
          <Text style={styles.caption}>More</Text>
        </View>
      </View>
    </View>
  );
}

const HeatCell = memo(function HeatCell({
  row,
  cell,
  height,
  compact,
  selected,
  tabStop,
  registerCell,
  onFocusCell,
  onSelect,
}: {
  row: number;
  cell: HeatmapCell;
  height: number;
  compact: boolean;
  selected: boolean;
  tabStop: boolean;
  registerCell(row: number, hour: number, node: Focusable | null): void;
  onFocusCell(row: number, hour: number): void;
  onSelect(cell: HeatmapCell): void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <Pressable
      ref={(node: Focusable | null) => registerCell(row, cell.hour, node)}
      // Web: a grid cell (aria-selected is valid there) with a roving Tab
      // stop. Native: a button with the selected state.
      {...(web
        ? ({ role: 'gridcell', tabIndex: tabStop ? 0 : -1 } as object)
        : { accessibilityRole: 'button' as const })}
      accessibilityLabel={cell.future ? `${cell.label}, upcoming` : cell.label}
      accessibilityHint="Shows communications up to the end of this hour"
      accessibilityState={{ selected }}
      disabled={cell.future}
      feedback="none"
      hitSlop={2}
      onFocus={() => onFocusCell(row, cell.hour)}
      onPress={() => onSelect(cell)}
      style={[
        styles.cell,
        compact && styles.compactWidth,
        { height, minHeight: height },
        cell.future && styles.future,
        selected && { borderColor: colors.textPrimary, borderWidth: 2 },
      ]}
    >
      <View
        style={[
          styles.fill,
          {
            opacity: LEVEL_OPACITY[cell.level],
            backgroundColor: colors.primary,
          },
        ]}
      />
    </Pressable>
  );
});

function Swatch({ level, size }: { level: HeatmapLevel; size: number }) {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <View style={[styles.cell, styles.swatch, { width: size, height: size }]}>
      <View
        style={[
          styles.fill,
          { opacity: LEVEL_OPACITY[level], backgroundColor: colors.primary },
        ]}
      />
    </View>
  );
}

const useStyles = createStyles((c) => ({
  root: { gap: space.xs },
  body: { flexDirection: 'row', gap: space.xs },
  labels: { width: DAY_LABEL_WIDTH, gap: CELL_GAP },
  wideHours: { flex: 1, minWidth: 0 },
  grid: { gap: CELL_GAP },
  dayLabel: {
    ...type.caption,
    fontSize: 11,
    lineHeight: 14,
    color: c.textSecondary,
  },
  hours: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: CELL_GAP,
    minWidth: 0,
  },
  hourLabel: {
    ...type.caption,
    fontSize: 10,
    lineHeight: 14,
    flex: 1,
    minWidth: 0,
    overflow: 'visible',
    color: c.textSecondary,
  },
  compactWidth: { flex: 0, width: COMPACT_CELL, minWidth: COMPACT_CELL },
  cell: {
    flex: 1,
    minWidth: 0,
    borderRadius: radius.sm,
    backgroundColor: c.surfaceElevated,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: c.surfaceElevated,
  },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  future: { borderStyle: 'dashed', borderColor: c.border, opacity: 0.5 },
  swatch: { flex: 0 },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.xs,
  },
  scale: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  caption: { ...type.caption, color: c.textSecondary },
}));
