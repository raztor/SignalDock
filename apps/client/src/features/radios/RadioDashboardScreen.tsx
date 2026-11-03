import type { RadioView } from '@signaldock/contracts';
import {
  Button,
  Disclosure,
  Icon,
  LoadingState,
  ScrollView,
  StatusIndicator,
  Text,
  createStyles,
  layout,
  radius,
  space,
  type,
  useTheme,
  useToast,
  type IconName,
} from '@signaldock/ui';
import { useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useRadioMedia } from '../media/MediaProvider';
import { LivePanel } from '../media/components/LivePanel';
import { useStation, type ControlState } from '../station';
import { RadioConfigurationPanel } from './RadioConfigurationPanel';
import { MemoryGrid } from './components/MemoryGrid';
import { RadioFaceplate } from './components/RadioFaceplate';
import { TuningPanel } from './components/TuningPanel';

/** Narrowest list faceplate before the grid drops a column. */
const FACEPLATE_MIN_WIDTH = 280;

/**
 * Radio operation for the workspace's selected radio: a grid of radio
 * faceplates (selecting never retunes), then the selected radio's hero
 * faceplate, control ownership, tuning, channel memories and live audio. All
 * state and writes come from `StationProvider` / `MediaProvider`.
 */
export function RadioDashboardScreen() {
  const styles = useStyles();
  const station = useStation();
  const media = useRadioMedia();
  const { width } = useWindowDimensions();
  const { session, radios, loaded, error, selected, radioId } = station;
  // Wide layouts keep live audio in a right-hand rail next to the controls.
  const rail = Boolean(selected && media.available && width >= layout.wide);

  return (
    <View style={[styles.layout, { flexDirection: rail ? 'row' : 'column' }]}>
      <ScrollView style={styles.main} contentContainerStyle={styles.page}>
        <View style={styles.titleRow}>
          <Text accessibilityRole="header" style={styles.title}>
            Radios
          </Text>
          {loaded && (
            <StatusIndicator
              size="compact"
              tone={station.liveUpdates ? 'ok' : 'off'}
              label={station.liveUpdates ? 'Live updates' : 'Periodic refresh'}
            />
          )}
        </View>
        <Text style={styles.muted}>
          Select a radio to view its confirmed state. Selection never changes
          its frequency.
        </Text>
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {!loaded && !error && <LoadingState label="Loading station radios…" />}
        {loaded && !radios.length ? (
          <Text style={styles.muted}>
            No radios are assigned to this account. An administrator can
            configure a radio and assign its permissions.
          </Text>
        ) : null}
        <RadioGrid radios={radios} selectedId={radioId} />

        {selected ? (
          <SelectedRadio radio={selected} inlineAudio={!rail} />
        ) : radioId && loaded ? (
          <Text accessibilityRole="alert" style={styles.warning}>
            The selected radio is unavailable to this account.
          </Text>
        ) : loaded && radios.length ? (
          <View style={styles.hint}>
            <Icon name="knob" size={20} />
            <Text style={styles.muted}>
              Select a radio to tune it, use its memories and go live.
            </Text>
          </View>
        ) : null}

        {session.user.role === 'administrator' ? (
          <Disclosure title="Station radio configuration">
            <RadioConfigurationPanel session={session} />
          </Disclosure>
        ) : null}
      </ScrollView>
      {rail && (
        <ScrollView
          style={styles.rail}
          contentContainerStyle={styles.railContent}
        >
          <LivePanel />
        </ScrollView>
      )}
    </View>
  );
}

/** Responsive grid of list faceplates. Pressing one only selects it. */
function RadioGrid({
  radios,
  selectedId,
}: {
  radios: RadioView[];
  selectedId: string | undefined;
}) {
  const styles = useStyles();
  const station = useStation();
  const [width, setWidth] = useState(0);
  if (!radios.length) return null;
  const columns = width
    ? Math.max(
        1,
        Math.floor((width + space.md) / (FACEPLATE_MIN_WIDTH + space.md)),
      )
    : 1;
  const itemWidth = width
    ? Math.floor((width - space.md * (columns - 1)) / columns)
    : undefined;
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={styles.grid}
    >
      {radios.map((radio) => (
        <View
          key={radio.radioId}
          style={
            itemWidth === undefined ? styles.gridItem : { width: itemWidth }
          }
        >
          <RadioFaceplate
            variant="list"
            radio={radio}
            selected={radio.radioId === selectedId}
            onPress={() => station.selectRadio(radio.radioId)}
          />
        </View>
      ))}
    </View>
  );
}

function SelectedRadio({
  radio,
  inlineAudio,
}: {
  radio: RadioView;
  inlineAudio: boolean;
}) {
  const styles = useStyles();
  const station = useStation();
  const capabilities = radio.descriptor?.capabilities;
  return (
    <View style={styles.selected}>
      <Text accessibilityRole="header" style={styles.heading}>
        Operate {radio.displayName}
      </Text>
      <RadioFaceplate variant="hero" radio={radio} selected />
      <ControlOwnership />
      {station.operationError ? (
        <View accessibilityRole="alert" style={styles.errorRow}>
          <Text style={[styles.error, styles.grow]}>
            {station.operationError}
          </Text>
          <Button
            label="Dismiss"
            variant="quiet"
            onPress={station.clearOperationError}
          />
        </View>
      ) : null}
      <View style={styles.card}>
        <TuningPanel />
      </View>
      {capabilities?.memories?.read ? (
        <View style={styles.card}>
          <MemoryGrid />
        </View>
      ) : null}
      {inlineAudio ? <LivePanel /> : null}
    </View>
  );
}

const controlCopy: Record<
  ControlState,
  { icon: IconName; title?: string; detail: string }
> = {
  mine: {
    icon: 'lock',
    detail:
      'Other operators can listen. Release control when you are done; it stays with you while you use other sections.',
  },
  other: {
    icon: 'lock',
    detail:
      'You can follow the radio, but tuning and memories stay locked until control is released.',
  },
  available: {
    icon: 'user',
    detail: 'Take control to tune the radio and use its memories.',
  },
  unavailable: {
    icon: 'user',
    title: 'Control unavailable',
    detail: '',
  },
};

/** Who holds the selected radio's control lease, with Take / Release. */
function ControlOwnership() {
  const styles = useStyles();
  const { colors } = useTheme();
  const toast = useToast();
  const station = useStation();
  const [working, setWorking] = useState(false);
  const { controlState, controlOwnerLabel, canControl, busy } = station;
  const copy = controlCopy[controlState];
  const mine = controlState === 'mine';
  const title = copy.title ?? controlOwnerLabel;
  const detail =
    controlState === 'unavailable' ? controlOwnerLabel : copy.detail;
  const run = async (action: () => ReturnType<typeof station.takeControl>) => {
    setWorking(true);
    try {
      const result = await action();
      toast.show(
        result.ok
          ? { message: result.message, tone: 'success' }
          : { message: result.error, tone: 'error' },
      );
    } finally {
      setWorking(false);
    }
  };
  // Listener-only accounts never see an enabled write control.
  const showButton = mine || canControl;
  return (
    <View style={[styles.owner, mine && styles.ownerMine]}>
      <View style={[styles.ownerIcon, mine && styles.ownerIconMine]}>
        <Icon
          name={copy.icon}
          size={16}
          color={
            mine
              ? colors.onPrimary
              : controlState === 'other'
                ? colors.warning
                : colors.textSecondary
          }
        />
      </View>
      <View style={styles.grow}>
        <Text style={styles.ownerTitle}>{title}</Text>
        {detail ? <Text style={styles.small}>{detail}</Text> : null}
      </View>
      {showButton ? (
        <Button
          label={mine ? 'Release control' : 'Take control'}
          variant={mine ? 'secondary' : 'primary'}
          loading={working}
          disabled={busy || (!mine && controlState !== 'available')}
          onPress={() =>
            void run(mine ? station.releaseControl : station.takeControl)
          }
        />
      ) : null}
    </View>
  );
}

const useStyles = createStyles((c) => ({
  layout: { flex: 1, minHeight: 0 },
  main: { flex: 1 },
  page: {
    width: '100%',
    maxWidth: layout.content,
    alignSelf: 'center',
    padding: space.lg,
    gap: space.lg,
    paddingBottom: space.xxxl,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: space.md,
  },
  title: { ...type.title, color: c.textPrimary },
  heading: { ...type.heading, color: c.textPrimary },
  muted: { ...type.body, color: c.textSecondary, flexShrink: 1 },
  small: { ...type.caption, color: c.textSecondary },
  error: { ...type.body, color: c.error },
  warning: { ...type.body, color: c.warning },
  hint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: c.border,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  gridItem: { flexGrow: 1, flexBasis: FACEPLATE_MIN_WIDTH },
  selected: {
    gap: space.lg,
    paddingTop: space.lg,
    borderTopWidth: 1,
    borderColor: c.border,
  },
  card: {
    padding: space.lg,
    gap: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  owner: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  ownerMine: { backgroundColor: c.selected, borderColor: c.selected },
  ownerIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.surfaceElevated,
  },
  ownerIconMine: { backgroundColor: c.primary },
  ownerTitle: { ...type.label, color: c.textPrimary },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.error,
    backgroundColor: c.surface,
  },
  grow: { flex: 1, minWidth: 160 },
  rail: {
    width: layout.audio,
    flexGrow: 0,
    backgroundColor: c.surface,
    borderLeftWidth: 1,
    borderColor: c.border,
  },
  railContent: { padding: space.md },
}));

export default RadioDashboardScreen;
