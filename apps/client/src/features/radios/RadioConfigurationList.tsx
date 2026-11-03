import { apiRequest } from '@signaldock/client-sdk';
import type {
  ClientSession,
  InstalledDriver,
  RadioConfiguration,
} from '@signaldock/contracts';
import {
  Badge,
  Button,
  Chip,
  ChipGroup,
  ErrorState,
  Icon,
  LoadingState,
  Pressable,
  StatusIndicator,
  Text,
  createStyles,
  radius,
  space,
  type,
  useTheme,
} from '@signaldock/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { moveFocus, type FocusTarget } from '../../shared/accessibility';
import { useStation } from '../station';
import { verificationLabel } from '../station/station-model';
import { RadioSetupWizard } from './RadioSetupWizard';
import { configurationStatus, sortConfigurations } from './radio-setup-model';

export interface RadioConfigurationListProps {
  session: ClientSession;
  /** Opens Users & access from the wizard's last step, when the host can. */
  onOpenAccess?: () => void;
  /**
   * Incrementing request to open the wizard for a new radio (for example
   * from the setup checklist). An open wizard is never replaced.
   */
  createRequest?: number;
  /** Called after a configuration is saved. */
  onChanged?: () => void;
}

type Editing =
  | { mode: 'create'; key: number }
  | { mode: 'edit'; key: number; configuration: RadioConfiguration };

interface DriverList {
  /** The first load finished (successfully or not). */
  loaded: boolean;
  items: InstalledDriver[];
  error: string;
  /** Fetching again after an error; the open wizard stays mounted. */
  retrying: boolean;
}

const NO_DRIVERS: DriverList = {
  loaded: false,
  items: [],
  error: '',
  retrying: false,
};
/** Focus key of the "Add radio" button (cards use their radio ID). */
const ADD_OPENER = '\0add';

const CARD_MIN_WIDTH = 260;
const monospace = type.frequency.fontFamily;

const useStyles = createStyles((c) => ({
  panel: { gap: space.lg },
  header: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  title: { ...type.heading, color: c.textPrimary },
  muted: { ...type.body, color: c.textSecondary },
  caption: { ...type.caption, color: c.textSecondary },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  card: {
    flexGrow: 1,
    flexBasis: CARD_MIN_WIDTH,
    minWidth: 0,
    justifyContent: 'flex-start',
    padding: space.md,
    gap: space.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  cardDisabled: { borderStyle: 'dashed' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  name: { ...type.label, color: c.textPrimary, flex: 1 },
  meta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
  },
  endpoint: { ...type.caption, color: c.textSecondary, fontFamily: monospace },
  edit: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    gap: space.xs,
  },
  editText: { ...type.label, color: c.primary },
  empty: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: c.inputBorder,
  },
}));

const message = (failure: unknown, fallback: string) =>
  failure instanceof Error && failure.message ? failure.message : fallback;

/**
 * Administrator radio configuration: cards for every configured radio (with
 * live status when this account can see the radio) and the setup wizard for
 * adding or editing one. Must be rendered inside `StationProvider`.
 */
export function RadioConfigurationList({
  session,
  onOpenAccess,
  createRequest,
  onChanged,
}: RadioConfigurationListProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const station = useStation();
  const [configurations, setConfigurations] = useState<RadioConfiguration[]>(
    [],
  );
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [drivers, setDrivers] = useState<DriverList>(NO_DRIVERS);
  const [editing, setEditing] = useState<Editing>();
  // The card or button that opened the wizard gets focus back on close.
  const opener = useRef<string | undefined>(undefined);
  const openers = useRef(new Map<string, FocusTarget>());
  const openerRef = (id: string) => (node: FocusTarget) => {
    if (node) openers.current.set(id, node);
    else openers.current.delete(id);
  };
  const nextKey = useRef(0);
  // Token refreshes replace the session object; only a different account resets.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const sessionKey = `${session.baseUrl}\0${session.instanceId}\0${session.user.id}`;

  const loadConfigurations = useCallback(async (signal: AbortSignal) => {
    try {
      const items = await apiRequest<RadioConfiguration[]>(
        sessionRef.current,
        'radios/configurations',
        { signal },
      );
      if (signal.aborted) return;
      setConfigurations(items);
      setError('');
    } catch (failure) {
      if (!signal.aborted)
        setError(message(failure, 'Radio configurations could not load.'));
    } finally {
      if (!signal.aborted) setLoaded(true);
    }
  }, []);
  const loadDrivers = useCallback(async (signal: AbortSignal) => {
    try {
      const items = await apiRequest<InstalledDriver[]>(
        sessionRef.current,
        'radios/drivers',
        { signal },
      );
      if (!signal.aborted)
        setDrivers({ loaded: true, items, error: '', retrying: false });
    } catch (failure) {
      if (!signal.aborted)
        setDrivers({
          loaded: true,
          items: [],
          error: message(failure, 'The driver list is unavailable.'),
          retrying: false,
        });
    }
  }, []);
  const controllers = useRef(new Set<AbortController>());
  const run = useCallback((work: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController();
    controllers.current.add(controller);
    void work(controller.signal).finally(() =>
      controllers.current.delete(controller),
    );
  }, []);

  useEffect(() => {
    setConfigurations([]);
    setLoaded(false);
    setError('');
    setDrivers(NO_DRIVERS);
    setEditing(undefined);
    opener.current = undefined;
    run(loadConfigurations);
    run(loadDrivers);
    const active = controllers.current;
    return () => {
      for (const controller of active) controller.abort();
      active.clear();
    };
  }, [sessionKey, loadConfigurations, loadDrivers, run]);

  const open = (configuration?: RadioConfiguration) => {
    opener.current = configuration?.radioId ?? ADD_OPENER;
    setEditing(
      configuration
        ? { mode: 'edit', configuration, key: ++nextKey.current }
        : { mode: 'create', key: ++nextKey.current },
    );
  };
  useEffect(() => {
    if (editing || !opener.current) return;
    const id = opener.current;
    opener.current = undefined;
    moveFocus(openers.current.get(id));
  }, [editing]);
  useEffect(() => {
    if (!createRequest) return;
    setEditing(
      (current) => current ?? { mode: 'create', key: ++nextKey.current },
    );
  }, [createRequest]);
  const driverFor = (driverId: string) =>
    drivers.items.find((driver) => driver.driverId === driverId);

  if (editing)
    return (
      <View style={styles.panel}>
        {!drivers.loaded ? (
          <LoadingState label="Loading installed drivers…" />
        ) : (
          <RadioSetupWizard
            key={editing.key}
            session={session}
            drivers={drivers.items}
            driversLoading={drivers.retrying}
            {...(drivers.error
              ? {
                  driversError: drivers.error,
                  onRetryDrivers: () => {
                    // Keep the wizard (and everything typed) mounted.
                    setDrivers((current) => ({
                      ...current,
                      error: '',
                      retrying: true,
                    }));
                    run(loadDrivers);
                  },
                }
              : {})}
            {...(editing.mode === 'edit'
              ? { existing: editing.configuration }
              : {})}
            {...(onOpenAccess ? { onOpenAccess } : {})}
            onSaved={(saved) => {
              setConfigurations((current) => [
                ...current.filter((item) => item.radioId !== saved.radioId),
                saved,
              ]);
              run(loadConfigurations);
              station.refresh();
              onChanged?.();
            }}
            onClose={() => setEditing(undefined)}
          />
        )}
      </View>
    );

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>
          Radio configuration
        </Text>
        <Button
          ref={openerRef(ADD_OPENER)}
          variant="primary"
          label="Add radio"
          disabled={!loaded}
          onPress={() => open()}
        />
      </View>
      <Text style={styles.muted}>
        Install a driver connector before configuring it. Configuring a radio
        does not grant operational access.
      </Text>
      {error ? (
        <ErrorState
          message={error}
          onRetry={() => {
            setLoaded(false);
            run(loadConfigurations);
          }}
        />
      ) : null}
      {!loaded && !error && (
        <LoadingState label="Loading radio configurations…" />
      )}
      {loaded && !error && !configurations.length ? (
        <View style={styles.empty}>
          <Text style={styles.muted}>
            No radios are configured yet. Add one to choose its driver,
            connection and settings.
          </Text>
        </View>
      ) : null}
      <View style={styles.grid}>
        {sortConfigurations(configurations).map((configuration) => {
          const view = station.radios.find(
            (radio) => radio.radioId === configuration.radioId,
          );
          const status = configurationStatus(configuration, view);
          const driver = driverFor(configuration.driverId);
          const driverNote = driver
            ? `, ${driver.displayName}`
            : drivers.loaded && !drivers.error
              ? ', driver not installed'
              : '';
          return (
            <Pressable
              key={configuration.radioId}
              ref={openerRef(configuration.radioId)}
              accessibilityRole="button"
              // React Native Web drops accessibilityHint and aria-label hides
              // the card's text, so the label carries status and driver.
              accessibilityLabel={`${configuration.displayName}, ${status.label}${driverNote}. Edit`}
              accessibilityHint="Opens setup at Identity & connection."
              onPress={() => open(configuration)}
              style={[
                styles.card,
                !configuration.enabled && styles.cardDisabled,
              ]}
            >
              <View style={styles.titleRow}>
                <Icon
                  name="radio"
                  size={20}
                  color={
                    configuration.enabled
                      ? colors.primary
                      : colors.textSecondary
                  }
                />
                <Text style={styles.name} numberOfLines={2}>
                  {configuration.displayName}
                </Text>
              </View>
              <StatusIndicator
                size="compact"
                tone={status.tone}
                label={status.label}
                pulse={status.pulse}
              />
              <View style={styles.meta}>
                <Text style={styles.caption}>
                  {driver?.displayName ?? configuration.driverId}
                </Text>
                {driver ? (
                  <Badge label={verificationLabel(driver.verification)} />
                ) : drivers.loaded && !drivers.error ? (
                  <Badge label="Driver not installed" tone="warning" />
                ) : null}
              </View>
              {configuration.endpoint ? (
                <Text style={styles.endpoint} numberOfLines={1}>
                  {configuration.endpoint}
                </Text>
              ) : null}
              {configuration.resourceGroupIds.length > 0 && (
                <ChipGroup accessibilityLabel="Shared resource groups">
                  {configuration.resourceGroupIds.map((group) => (
                    <Chip key={group} label={group} />
                  ))}
                </ChipGroup>
              )}
              <View style={styles.edit}>
                <Text style={styles.editText}>Edit</Text>
                <Icon name="chevron-right" size={16} color={colors.primary} />
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
