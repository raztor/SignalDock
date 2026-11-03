import type { RadioView } from '@signaldock/contracts';
import {
  Badge,
  Pressable,
  StatusIndicator,
  Text,
  radius,
  space,
  type,
  useTheme,
  type ControlTone,
} from '@signaldock/ui';
import type { ReactNode } from 'react';
import { Platform, View, type TextStyle } from 'react-native';
import Svg, { Line } from 'react-native-svg';
import {
  activeMemory,
  confidencePresentation,
  connectionPresentation,
  controlPresentation,
  formatFrequency,
  formatOffset,
  formatTuning,
  frequencyParts,
  offsetOf,
  TxPill,
  txPresentation,
  useStation,
  verificationLabel,
  type Verification,
} from '../../station';
import { pendingTuning } from './tuning-model';

/** Hidden from assistive technology (`aria-hidden` on web, where the native props would reach the DOM). */
const decorative =
  Platform.OS === 'web'
    ? ({ 'aria-hidden': true } as const)
    : ({
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no-hide-descendants',
      } as const);

export interface RadioFaceplateProps {
  radio: RadioView;
  /** This radio is the workspace selection. */
  selected?: boolean;
  /** List variant only: selects the radio. Selecting never retunes it. */
  onPress?: () => void;
  variant: 'list' | 'hero';
}

/**
 * A radio's "front panel": connection, name, verification, the reported
 * frequency with its confidence, TX state, offset, active memory and who
 * holds control. `list` is compact and pressable; `hero` is large and static.
 */
export function RadioFaceplate({
  radio,
  selected = false,
  onPress,
  variant,
}: RadioFaceplateProps) {
  const { colors } = useTheme();
  const station = useStation();
  const hero = variant === 'hero';
  const snapshot = radio.snapshot;
  const capabilities = radio.descriptor?.capabilities;
  const connection = connectionPresentation(radio);
  const tx = snapshot ? txPresentation(snapshot.txState) : undefined;
  const tuning = snapshot?.observedTuning;
  const confidence = confidencePresentation(
    tuning ? snapshot?.tuningConfidence : 'unknown',
  );
  const pending = pendingTuning(snapshot);
  // In the hero layout TuningPanel owns the pending row; it has none when the
  // driver cannot tune freely (memories only), so the faceplate keeps it then.
  const showPending = !hero || capabilities?.tuning.writable !== true;
  const isStationRadio = station.selected?.radioId === radio.radioId;
  const memory = isStationRadio
    ? activeMemory(station.memories, snapshot)
    : undefined;
  // The selected radio uses the station's own result so the chip and the
  // ownership row can never disagree; other radios use the same helper.
  const control = isStationRadio
    ? station.control
    : controlPresentation(radio, {
        userId: station.session.user.id,
        userEnabled: station.session.user.enabled,
        leaseGrantId:
          station.lease?.radioId === radio.radioId
            ? station.lease.grantId
            : undefined,
        ownGrantIds: station.ownControlGrants,
        radioPermissions: station.session.user.radioPermissions,
        // Compared at render time; the station refreshes the list every few seconds.
        now: Date.now(),
      });
  // Nothing useful to say when control is impossible and nobody holds it.
  const chip = control.state === 'unavailable' ? undefined : control;
  const offsetHz = tuning ? offsetOf(tuning) : undefined;
  const showOffset =
    offsetHz !== undefined && (capabilities?.txAudio || offsetHz !== 0);

  const fontSize = hero ? 44 : 26;
  const frequency = (
    <FrequencyReadout
      hz={tuning?.rxHz}
      mode={tuning?.mode}
      fontSize={fontSize}
      confidence={confidence.style}
    />
  );

  const meta: string[] = [];
  meta.push(tuning ? confidence.label : 'Frequency unknown');
  if (showOffset && offsetHz !== undefined)
    meta.push(offsetHz === 0 ? 'TX simplex' : `TX ${formatOffset(offsetHz)}`);
  if (memory) meta.push(`Memory: ${memory.name || memory.memoryId}`);
  else if (snapshot?.selectedMemoryId && hero)
    meta.push(`Memory ${snapshot.selectedMemoryId}`);

  const content: ReactNode = (
    <View style={{ gap: hero ? space.md : space.sm, minWidth: 0 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: space.sm,
        }}
      >
        <StatusIndicator
          tone={connection.tone}
          label={connection.label}
          pulse={connection.pulse}
          size={hero ? 'regular' : 'compact'}
        />
        <Text
          numberOfLines={1}
          style={[
            hero ? type.heading : type.label,
            { color: colors.textPrimary, flexShrink: 1 },
          ]}
        >
          {radio.displayName}
        </Text>
        <View style={{ flexGrow: 1 }} />
        <VerificationBadge verification={capabilities?.verification} />
      </View>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: space.md,
        }}
      >
        {frequency}
        {tx && snapshot?.txState !== 'idle' && (
          <TxPill presentation={tx} size={hero ? 'regular' : 'compact'} />
        )}
      </View>

      {pending && showPending && (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <StatusIndicator
            tone="pending"
            size="compact"
            pulse
            label={`Requested ${formatTuning(pending)} · waiting for radio confirmation`}
          />
        </View>
      )}

      <Text
        numberOfLines={hero ? undefined : 2}
        style={[type.caption, { color: colors.textSecondary }]}
      >
        {meta.join(' · ')}
      </Text>

      {chip && <Badge label={chip.label} tone={chip.tone} icon={chip.icon} />}
    </View>
  );

  const frame = {
    padding: hero ? space.xl : space.lg,
    borderRadius: radius.lg,
    borderWidth: selected && !hero ? 2 : 1,
    borderColor: selected && !hero ? colors.primary : colors.border,
    backgroundColor: colors.surface,
  } as const;

  if (hero || !onPress) return <View style={frame}>{content}</View>;

  const spoken = [
    radio.displayName,
    connection.label,
    tuning
      ? `${formatFrequency(tuning.rxHz)} MHz ${tuning.mode}, ${confidence.label.toLowerCase()}`
      : 'frequency unknown',
    tx && snapshot?.txState !== 'idle' ? tx.label : undefined,
    chip?.label,
    selected ? 'selected' : undefined,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint={
        selected
          ? 'Selected radio.'
          : 'Selects this radio. Selecting does not retune it.'
      }
      // aria-selected is not valid on a button: web uses aria-pressed.
      {...(Platform.OS === 'web'
        ? { 'aria-pressed': selected }
        : { accessibilityState: { selected } })}
      onPress={onPress}
      style={{
        ...frame,
        justifyContent: 'flex-start',
        backgroundColor: selected ? colors.selected : colors.surface,
      }}
    >
      {content}
    </Pressable>
  );
}

/** Monospace MHz.kHz with small Hz digits, unit, mode and a confidence underline. */
export function FrequencyReadout({
  hz,
  mode,
  fontSize,
  confidence,
}: {
  hz: number | undefined;
  mode: string | undefined;
  fontSize: number;
  confidence: 'solid' | 'dotted' | 'none';
}) {
  const { colors } = useTheme();
  const numberStyle: TextStyle = {
    ...type.frequency,
    fontSize,
    lineHeight: Math.round(fontSize * 1.15),
    letterSpacing: fontSize > 30 ? -1 : -0.5,
    color: colors.textPrimary,
  };
  const smallSize = Math.round(fontSize * 0.5);
  const parts = hz === undefined ? undefined : safeParts(hz);
  return (
    <View
      accessible
      // RN-web maps role "text" to a generic div, where a name is ignored and
      // the dash glyphs would be read instead: use an image role there.
      {...(Platform.OS === 'web'
        ? { role: 'img' as const }
        : { accessibilityRole: 'text' as const })}
      accessibilityLabel={
        parts
          ? `${parts.mhz}.${parts.khz}${parts.hz === '000' ? '' : parts.hz} MHz${mode ? ` ${mode}` : ''}`
          : 'Frequency unknown'
      }
      style={{
        flexDirection: 'row',
        alignItems: 'flex-end',
        flexWrap: 'wrap',
        gap: space.sm,
      }}
    >
      <View style={{ gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
          <Text style={numberStyle}>
            {parts ? `${parts.mhz}.${parts.khz}` : '———.———'}
          </Text>
          <Text
            style={[
              numberStyle,
              {
                fontSize: smallSize,
                lineHeight: Math.round(smallSize * 1.2),
                letterSpacing: 0,
                color: colors.textSecondary,
                marginLeft: 2,
              },
            ]}
          >
            {parts ? parts.hz : '———'}
          </Text>
        </View>
        <ConfidenceUnderline style={confidence} />
      </View>
      <Text
        style={[
          type.caption,
          {
            color: colors.textSecondary,
            marginBottom: Math.round(fontSize * 0.22),
          },
        ]}
      >
        MHz
      </Text>
      {mode && (
        <View
          style={{
            marginBottom: Math.round(fontSize * 0.2),
            paddingHorizontal: space.sm,
            paddingVertical: 1,
            borderWidth: 1.5,
            borderColor: colors.textPrimary,
            borderRadius: radius.sm,
          }}
        >
          <Text
            style={[
              type.caption,
              {
                fontWeight: '700',
                letterSpacing: 0.5,
                color: colors.textPrimary,
              },
            ]}
          >
            {mode}
          </Text>
        </View>
      )}
    </View>
  );
}

function safeParts(hz: number) {
  try {
    return frequencyParts(hz);
  } catch {
    return undefined;
  }
}

/** Solid = confirmed, dotted = inferred, '— — —' = unknown (never blank). */
function ConfidenceUnderline({
  style,
}: {
  style: 'solid' | 'dotted' | 'none';
}) {
  const { colors } = useTheme();
  if (style === 'none')
    return (
      <Text
        {...decorative}
        style={[
          type.caption,
          { color: colors.textSecondary, lineHeight: 12, letterSpacing: 2 },
        ]}
      >
        — — —
      </Text>
    );
  // Absolutely positioned so the drawing never widens the readout (web gives
  // a percentage-width SVG a 300 px intrinsic width).
  return (
    <View style={{ height: 4, alignSelf: 'stretch' }} {...decorative}>
      <Svg
        width="100%"
        height={4}
        style={{ position: 'absolute', left: 0, top: 0, right: 0 }}
      >
        <Line
          x1="0"
          y1="2"
          x2="100%"
          y2="2"
          stroke={style === 'solid' ? colors.primary : colors.warning}
          strokeWidth={2}
          strokeLinecap={style === 'dotted' ? 'round' : 'butt'}
          strokeDasharray={style === 'dotted' ? '0.1 5' : undefined}
        />
      </Svg>
    </View>
  );
}

function VerificationBadge({
  verification,
}: {
  verification: Verification | undefined;
}) {
  const label = verificationLabel(verification);
  const tone: ControlTone =
    verification === 'hardware_verified'
      ? 'primary'
      : verification === 'experimental'
        ? 'warning'
        : 'neutral';
  return (
    <Badge
      label={label}
      tone={tone}
      {...(verification === 'hardware_verified'
        ? { icon: 'check' as const }
        : verification === 'experimental'
          ? { icon: 'alert' as const }
          : {})}
    />
  );
}
