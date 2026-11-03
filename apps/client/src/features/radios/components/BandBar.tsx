import { Pressable, Text, space, type, useTheme } from '@signaldock/ui';
import { useMemo, useState } from 'react';
import { Platform, View, type GestureResponderEvent } from 'react-native';
import Svg, { Line, Rect, Text as SvgText } from 'react-native-svg';
import {
  clampToRanges,
  formatFrequency,
  formatRange,
  snapToStep,
  type FrequencyRange,
} from '../../station/station-model';
import {
  bandAccessibilityLabel,
  bandEdgeLabels,
  createBandScale,
  type BandSegment,
} from './tuning-model';

/** Hidden from assistive technology (`aria-hidden` on web, where the native props would reach the DOM). */
const decorative =
  Platform.OS === 'web'
    ? ({ 'aria-hidden': true } as const)
    : ({
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no-hide-descendants',
      } as const);

export interface BandBarProps {
  /** The driver's `capabilities.tuning.ranges`. */
  ranges: readonly FrequencyRange[];
  /** Frequency the radio reports (solid marker). */
  confirmedHz?: number;
  /** Requested frequency while the radio has not confirmed it (amber dashed marker). */
  desiredHz?: number;
  /** Local draft (hollow marker). */
  draftHz?: number;
  /** Taps snap the draft to this grid. */
  stepHz?: number;
  /** Moves the draft only; the bar never sends a command. */
  onSelectHz?: (hz: number) => void;
  disabled?: boolean;
}

const HEIGHT = 44;
const BAR_Y = 12;
const BAR_HEIGHT = 10;
const LABEL_Y = 40;
const TAP_HEIGHT = 34;

/**
 * Strip of the radio's tuning ranges on a piecewise scale (every range stays
 * visible), with markers for the reported, requested and draft frequencies.
 */
export function BandBar({
  ranges,
  confirmedHz,
  desiredHz,
  draftHz,
  stepHz,
  onSelectHz,
  disabled = false,
}: BandBarProps) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const scale = useMemo(
    () => createBandScale(ranges, width, { gap: 12 }),
    [ranges, width],
  );
  const labels = useMemo(() => bandEdgeLabels(scale.segments), [scale]);
  const showDesired = desiredHz !== undefined && desiredHz !== confirmedHz;
  const showDraft =
    draftHz !== undefined && draftHz !== confirmedHz && draftHz !== desiredHz;
  const interactive = Boolean(onSelectHz) && !disabled;
  const summary = bandAccessibilityLabel(ranges, {
    ...(confirmedHz === undefined ? {} : { confirmedHz }),
    ...(desiredHz === undefined ? {} : { desiredHz }),
    ...(draftHz === undefined ? {} : { draftHz }),
  });

  function select(segment: BandSegment, event: GestureResponderEvent) {
    if (!onSelectHz) return;
    const native = event.nativeEvent as {
      locationX?: number;
      offsetX?: number;
    };
    const local =
      typeof native.locationX === 'number' && Number.isFinite(native.locationX)
        ? native.locationX
        : typeof native.offsetX === 'number' && Number.isFinite(native.offsetX)
          ? native.offsetX
          : undefined;
    const range = [{ minHz: segment.minHz, maxHz: segment.maxHz }];
    // Keyboard / screen-reader activation has no position: move the draft to
    // the closest frequency inside this range.
    const picked =
      local === undefined
        ? clampToRanges(draftHz ?? confirmedHz ?? segment.minHz, range)
        : scale.hzAt(segment.x0 + local);
    if (picked === undefined) return;
    const snapped = stepHz && stepHz > 0 ? snapToStep(picked, stepHz) : picked;
    const next = clampToRanges(snapped, range);
    if (next !== undefined) onSelectHz(next);
  }

  const marker = (hz: number | undefined) =>
    hz === undefined ? undefined : scale.x(hz);
  const confirmedX = marker(confirmedHz);
  const desiredX = showDesired ? marker(desiredHz) : undefined;
  const draftX = showDraft ? marker(draftHz) : undefined;

  return (
    <View style={{ gap: space.xs }}>
      <View
        accessible={!interactive}
        accessibilityRole={interactive ? undefined : 'image'}
        accessibilityLabel={interactive ? undefined : summary}
        onLayout={(event) =>
          setWidth(Math.floor(event.nativeEvent.layout.width))
        }
        style={{ height: HEIGHT, width: '100%' }}
      >
        {width > 0 && (
          <Svg width={width} height={HEIGHT} {...decorative}>
            <Rect
              x={0}
              y={BAR_Y}
              width={width}
              height={BAR_HEIGHT}
              rx={2}
              fill={colors.surfaceElevated}
            />
            {scale.segments.map((segment) => (
              <Rect
                key={`${segment.minHz}-${segment.maxHz}`}
                x={segment.x0}
                y={BAR_Y}
                width={Math.max(segment.x1 - segment.x0, 2)}
                height={BAR_HEIGHT}
                rx={2}
                fill={colors.secondary}
                opacity={0.55}
              />
            ))}
            {draftX !== undefined && (
              <Rect
                x={draftX - 3}
                y={BAR_Y - 6}
                width={6}
                height={BAR_HEIGHT + 12}
                rx={1}
                fill="none"
                stroke={colors.textPrimary}
                strokeWidth={1.5}
              />
            )}
            {desiredX !== undefined && (
              <Line
                x1={desiredX}
                x2={desiredX}
                y1={BAR_Y - 8}
                y2={BAR_Y + BAR_HEIGHT + 8}
                stroke={colors.warning}
                strokeWidth={2.5}
                strokeDasharray="3 2"
              />
            )}
            {confirmedX !== undefined && (
              <Rect
                x={confirmedX - 1.5}
                y={BAR_Y - 7}
                width={3}
                height={BAR_HEIGHT + 14}
                fill={colors.primary}
              />
            )}
            {labels.map((label) => (
              <SvgText
                key={`${label.x}-${label.text}`}
                x={label.x}
                y={LABEL_Y}
                fontSize={10}
                fontFamily={type.frequency.fontFamily}
                fill={colors.textSecondary}
                textAnchor={label.anchor}
              >
                {label.text}
              </SvgText>
            ))}
          </Svg>
        )}
        {interactive ? (
          // The container has no name when interactive, and RN-web drops the
          // hints: read the marker summary before the tap targets.
          <Text style={visuallyHidden}>{summary}</Text>
        ) : null}
        {interactive &&
          width > 0 &&
          scale.segments.map((segment) => (
            <Pressable
              key={`tap-${segment.minHz}-${segment.maxHz}`}
              accessibilityRole="button"
              accessibilityLabel={`Move draft into ${formatRange(segment)} (draft only, the radio is not tuned until you apply)`}
              accessibilityHint={`${summary} Changes the draft only; the radio is not tuned until you apply.`}
              onPress={(event) => select(segment, event)}
              style={{
                position: 'absolute',
                left: segment.x0,
                top: 0,
                width: Math.max(segment.x1 - segment.x0, 24),
                height: TAP_HEIGHT,
                minHeight: TAP_HEIGHT,
                borderRadius: 4,
              }}
            />
          ))}
      </View>
      <Legend
        confirmedHz={confirmedHz}
        desiredHz={showDesired ? desiredHz : undefined}
        draftHz={showDraft ? draftHz : undefined}
      />
    </View>
  );
}

/** Text legend so markers are never distinguished by colour alone. */
function Legend({
  confirmedHz,
  desiredHz,
  draftHz,
}: {
  confirmedHz: number | undefined;
  desiredHz: number | undefined;
  draftHz: number | undefined;
}) {
  const { colors } = useTheme();
  const items: {
    key: string;
    label: string;
    mark: 'solid' | 'dashed' | 'hollow';
  }[] = [];
  if (confirmedHz !== undefined)
    items.push({
      key: 'radio',
      label: `Radio ${formatFrequency(confirmedHz)}`,
      mark: 'solid',
    });
  if (desiredHz !== undefined)
    items.push({
      key: 'requested',
      label: `Requested ${formatFrequency(desiredHz)}`,
      mark: 'dashed',
    });
  if (draftHz !== undefined)
    items.push({
      key: 'draft',
      label: `Draft ${formatFrequency(draftHz)}`,
      mark: 'hollow',
    });
  if (items.length < 2) return null;
  return (
    <View
      {...decorative}
      style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}
    >
      {items.map((item) => (
        <View
          key={item.key}
          style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}
        >
          <View
            style={{
              width: item.mark === 'hollow' ? 6 : 3,
              height: 12,
              borderRadius: 1,
              backgroundColor:
                item.mark === 'solid' ? colors.primary : 'transparent',
              borderWidth: item.mark === 'solid' ? 0 : 1.5,
              borderStyle: item.mark === 'dashed' ? 'dashed' : 'solid',
              borderColor:
                item.mark === 'dashed' ? colors.warning : colors.textPrimary,
            }}
          />
          <Text
            style={[
              type.caption,
              {
                color: colors.textSecondary,
                fontFamily: type.frequency.fontFamily,
              },
            ]}
          >
            {item.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Read by assistive technology but not drawn. */
const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  opacity: 0,
} as const;
