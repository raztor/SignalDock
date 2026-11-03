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
  useReducedMotion,
  useToast,
} from '@signaldock/ui';
import { useRef, useState, type ComponentRef } from 'react';
import {
  View,
  useWindowDimensions,
  type ScrollView as NativeScrollView,
} from 'react-native';
import { useRadioMedia } from '../media/MediaProvider';
import { LivePanel } from '../media/components/LivePanel';
import { SetupChecklist } from '../admin/SetupChecklist';
import { useStation, type ControlState } from '../station';
import { RadioConfigurationList } from './RadioConfigurationList';
import { MemoryGrid } from './components/MemoryGrid';
import { RadioFaceplate } from './components/RadioFaceplate';
import { TuningPanel } from './components/TuningPanel';

/** Narrowest list faceplate before the grid drops a column. */
const FACEPLATE_MIN_WIDTH = 280;

export interface RadioDashboardScreenProps {
  /**
   * Opens Users & access. Used by the administrator setup checklist and the
   * radio setup wizard's Access step; without it they explain where to go.
   */
  onOpenAccess?: () => void;
}

/**
 * Radio operation for the workspace's selected radio: a grid of radio
 * faceplates (selecting never retunes), then the selected radio's hero
 * faceplate, control ownership, tuning, channel memories and live audio. All
 * state and writes come from `StationProvider` / `MediaProvider`.
 * Administrators also get the setup checklist and the radio configuration
 * list with its setup wizard.
 */
export function RadioDashboardScreen({
  onOpenAccess,
}: RadioDashboardScreenProps = {}) {
  const styles = useStyles();
  const station = useStation();
  const media = useRadioMedia();
  const { width } = useWindowDimensions();
  const { session, radios, loaded, error, selected, radioId } = station;
  // Wide layouts keep live audio in a right-hand rail next to the controls.
  const rail = Boolean(selected && media.available && width >= layout.wide);
  const administrator = session.user.role === 'administrator';
  const reducedMotion = useReducedMotion();
  const scroll = useRef<ComponentRef<typeof NativeScrollView>>(null);
  const configurationY = useRef(0);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  // The configuration list loads drivers and configurations: mount it on the
  // first open only (a closed Disclosure keeps its children mounted).
  const [configurationUsed, setConfigurationUsed] = useState(false);
  if (configurationOpen && !configurationUsed) setConfigurationUsed(true);
  const [createRequest, setCreateRequest] = useState(0);
  const [configurationRevision, setConfigurationRevision] = useState(0);
  /** Setup checklist: open the configuration section with a new-radio wizard. */
  const configureRadio = () => {
    setConfigurationOpen(true);
    setCreateRequest((request) => request + 1);
    // Wait for the expanded section to lay out before scrolling to it.
    setTimeout(() => {
      scroll.current?.scrollTo({
        y: Math.max(0, configurationY.current - space.lg),
        animated: !reducedMotion,
      });
    }, 0);
  };

  return (
    <View style={[styles.layout, { flexDirection: rail ? 'row' : 'column' }]}>
      <ScrollView
        ref={scroll}
        style={styles.main}
        contentContainerStyle={styles.page}
      >
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
        {administrator ? (
          <SetupChecklist
            onConfigureRadio={configureRadio}
            refreshKey={configurationRevision}
            {...(onOpenAccess ? { onAssignAccess: onOpenAccess } : {})}
          />
        ) : null}
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

        {administrator ? (
          <View
            onLayout={(event) => {
              configurationY.current = event.nativeEvent.layout.y;
            }}
          >
            <Disclosure
              title="Station radio configuration"
              open={configurationOpen}
              onOpenChange={setConfigurationOpen}
            >
              {configurationUsed || configurationOpen ? (
                <RadioConfigurationList
                  session={session}
                  createRequest={createRequest}
                  onChanged={() =>
                    setConfigurationRevision((revision) => revision + 1)
                  }
                  {...(onOpenAccess ? { onOpenAccess } : {})}
                />
              ) : null}
            </Disclosure>
          </View>
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
            onPress={() => void station.selectRadio(radio.radioId)}
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

const controlCopy: Record<ControlState, { title?: string; detail: string }> = {
  mine: {
    detail:
      'Other operators can listen. Release control when you are done; it stays with you while you use other sections.',
  },
  other: {
    detail:
      'You can follow the radio, but tuning and memories stay locked until control is released.',
  },
  available: {
    detail: 'Take control to tune the radio and use its memories.',
  },
  unavailable: {
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
  const { control, canControl, busy } = station;
  const controlState = control.state;
  const controlOwnerLabel = control.label;
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
          name={control.icon}
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
