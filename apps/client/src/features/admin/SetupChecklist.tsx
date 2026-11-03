import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiRequest } from '@signaldock/client-sdk';
import { PublicUserSchema, SignalDockError } from '@signaldock/contracts';
import {
  Button,
  Icon,
  Pressable,
  Text,
  createStyles,
  radius,
  space,
  type,
  useScreenActive,
  useTheme,
} from '@signaldock/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useRadioMedia } from '../media/MediaProvider';
import { useStation } from '../station';
import { hasNonAdminAssignment } from './permission-model';
import {
  DEFAULT_SETUP_FLAGS,
  currentSetupStep,
  parseSetupFlags,
  serializeSetupFlags,
  setupProgress,
  setupStorageKey,
  setupSteps,
  showSetupChecklist,
  type SetupFlags,
  type SetupStep,
} from './setup-checklist-model';

export interface SetupChecklistProps {
  /** Opens the radio configuration flow, when the host can. */
  onConfigureRadio?: () => void;
  /** Navigates to Users & access, when the host can. */
  onAssignAccess?: () => void;
  /** Changing it re-checks progress (for example after a radio is saved). */
  refreshKey?: number;
}

interface SetupData {
  configurations: number | undefined;
  assigned: boolean | undefined;
}

/**
 * Administrator first-run checklist for the Radios screen: configure a radio,
 * assign radio access, test live audio. Progress comes from the station
 * (configurations, user grants) plus local per-device flags (listened once,
 * skipped steps, dismissed). Renders nothing for non-administrators, once
 * every step is done or skipped, or after it is dismissed.
 *
 * Must be rendered inside StationProvider and MediaProvider.
 */
export function SetupChecklist({
  onConfigureRadio,
  onAssignAccess,
  refreshKey,
}: SetupChecklistProps = {}) {
  const styles = useStyles();
  const station = useStation();
  const media = useRadioMedia();
  const active = useScreenActive();
  const { session } = station;
  const administrator = session.user.role === 'administrator';
  const storageKey = setupStorageKey(session.instanceId, session.user.id);
  // Token refreshes keep the same account, so progress is not reset.
  const contextKey = `${session.baseUrl}:${session.instanceId}:${session.user.id}`;
  const context = useRef(contextKey);
  context.current = contextKey;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const [flags, setFlags] = useState<SetupFlags>(DEFAULT_SETUP_FLAGS);
  const [flagsLoaded, setFlagsLoaded] = useState(false);
  const [data, setData] = useState<SetupData>({
    configurations: undefined,
    assigned: undefined,
  });
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  // Local flags, per station instance and account.
  useEffect(() => {
    let current = true;
    setFlagsLoaded(false);
    setFlags(DEFAULT_SETUP_FLAGS);
    if (!administrator) return;
    void AsyncStorage.getItem(storageKey)
      .then((raw) => {
        if (current) setFlags(parseSetupFlags(raw));
      })
      .catch(() => {})
      .finally(() => {
        if (current) setFlagsLoaded(true);
      });
    return () => {
      current = false;
    };
  }, [administrator, storageKey]);

  const updateFlags = useCallback(
    (patch: Partial<SetupFlags>) => {
      setFlags((old) => {
        const next = { ...old, ...patch };
        void AsyncStorage.setItem(storageKey, serializeSetupFlags(next)).catch(
          () => {},
        );
        return next;
      });
    },
    [storageKey],
  );

  // Station data: configurations and whether any non-admin holds a grant.
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const key = contextKey;
      setChecking(true);
      try {
        const [configurations, users] = await Promise.all([
          apiRequest<unknown>(sessionRef.current, 'radios/configurations', {
            ...(signal ? { signal } : {}),
          }).catch((failure: unknown) => {
            if (
              failure instanceof SignalDockError &&
              failure.code === 'NOT_FOUND'
            )
              return [];
            throw failure;
          }),
          apiRequest<{ users: unknown }>(sessionRef.current, 'admin/users', {
            ...(signal ? { signal } : {}),
          }),
        ]);
        if (signal?.aborted || context.current !== key) return;
        setData({
          // Only the count matters here; the configuration list validates rows.
          configurations: Array.isArray(configurations)
            ? configurations.length
            : 0,
          assigned: hasNonAdminAssignment(
            PublicUserSchema.array().parse(users.users),
          ),
        });
        setError('');
      } catch (failure) {
        if (signal?.aborted || context.current !== key) return;
        setError(
          failure instanceof Error
            ? failure.message
            : 'Setup progress could not be checked.',
        );
      } finally {
        if (!signal?.aborted && context.current === key) setChecking(false);
      }
    },
    // `contextKey` identifies the session the request runs against.
    [contextKey],
  );

  const radioCount = station.radios.length;
  useEffect(() => {
    if (!administrator || !active) return;
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [administrator, active, load, radioCount, refreshKey]);

  // Reset station data when the account or station changes.
  useEffect(() => {
    setData({ configurations: undefined, assigned: undefined });
    setError('');
  }, [contextKey]);

  // "Listened once": recorded the first time live audio starts on this device.
  const listening = media.state.listening;
  useEffect(() => {
    if (administrator && flagsLoaded && listening && !flags.listened)
      updateFlags({ listened: true });
  }, [administrator, flagsLoaded, listening, flags.listened, updateFlags]);

  const steps = setupSteps({
    configurations: data.configurations,
    assigned: data.assigned,
    mediaConfigured: media.configured,
    mediaSupported: media.supported,
    flags,
  });
  if (!showSetupChecklist({ administrator, flagsLoaded, flags, steps, error }))
    return null;
  const progress = setupProgress(steps);
  const current = currentSetupStep(steps);

  const checkAgain = (
    <Button
      label={checking ? 'Checking…' : 'Check again'}
      variant="quiet"
      disabled={checking}
      onPress={() => {
        void load();
      }}
    />
  );

  const actionsFor = (step: SetupStep) => {
    if (step.status !== 'todo') return null;
    switch (step.id) {
      case 'configure':
        return (
          <View style={styles.actions}>
            {onConfigureRadio ? (
              <Button
                label="Configure a radio"
                variant="primary"
                onPress={onConfigureRadio}
              />
            ) : null}
            {error ? null : checkAgain}
          </View>
        );
      case 'assign':
        return (
          <View style={styles.actions}>
            {onAssignAccess ? (
              <Button
                label="Open Users & access"
                variant="primary"
                onPress={onAssignAccess}
              />
            ) : (
              <Text style={styles.hint}>
                Open Users &amp; access from the navigation.
              </Text>
            )}
            <Button
              label="Skip"
              variant="quiet"
              onPress={() => updateFlags({ accessSkipped: true })}
            />
          </View>
        );
      case 'audio': {
        const canListen =
          media.available && media.access.canListen && !media.state.listening;
        const reason = !media.available
          ? ''
          : !station.selected
            ? 'Select a radio first.'
            : media.access.canListen
              ? ''
              : media.access.listenReason;
        return (
          <View style={styles.actions}>
            {media.available ? (
              <Button
                label="Start listening"
                variant="primary"
                disabled={!canListen}
                onPress={() => media.listen()}
              />
            ) : null}
            <Button
              label="Skip"
              variant="quiet"
              onPress={() => updateFlags({ audioSkipped: true })}
            />
            {reason ? <Text style={styles.hint}>{reason}</Text> : null}
          </View>
        );
      }
    }
  };

  return (
    <View
      accessibilityRole="summary"
      accessibilityLabel={`Station setup, ${progress.label}`}
      style={styles.card}
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text accessibilityRole="header" style={styles.title}>
            Finish setting up your station
          </Text>
          <Text style={styles.muted}>{progress.label}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Hide setup checklist"
          hitSlop={8}
          onPress={() => updateFlags({ dismissed: true })}
          style={styles.close}
        >
          <Icon name="close" size={18} />
        </Pressable>
      </View>
      <ProgressBar resolved={progress.resolved} total={progress.total} />
      {error ? (
        <View style={styles.actions}>
          <Text
            accessibilityRole="alert"
            style={[styles.error, { flexShrink: 1 }]}
          >
            {error}
          </Text>
          {checkAgain}
        </View>
      ) : null}
      <View style={styles.steps}>
        {steps.map((step, index) => (
          <View
            key={step.id}
            style={[styles.step, index === current && styles.currentStep]}
          >
            <StepMark step={step} index={index} current={index === current} />
            <View style={styles.stepBody}>
              <View style={styles.stepTitleRow}>
                <Text
                  style={[
                    styles.stepTitle,
                    step.status === 'done' || step.status === 'skipped'
                      ? styles.resolvedTitle
                      : null,
                  ]}
                >
                  {step.title}
                </Text>
                <Text style={styles.statusText}>{step.statusLabel}</Text>
              </View>
              <Text style={styles.muted}>{step.description}</Text>
              {actionsFor(step)}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

function ProgressBar({ resolved, total }: { resolved: number; total: number }) {
  const styles = useStyles();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Setup progress"
      accessibilityValue={{ min: 0, max: total, now: resolved }}
      style={styles.progress}
    >
      {Array.from({ length: total }, (_, index) => (
        <View
          key={index}
          style={[
            styles.progressSegment,
            index < resolved && styles.progressDone,
          ]}
        />
      ))}
    </View>
  );
}

/**
 * Numbered circle matching `Stepper`: the current step is filled, done steps
 * show a check on the selected tint, skipped steps a dash (shape, not colour).
 */
function StepMark({
  step,
  index,
  current,
}: {
  step: SetupStep;
  index: number;
  current: boolean;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  if (step.status === 'done')
    return (
      <View style={[styles.mark, styles.markDone]}>
        <Icon name="check" size={16} color={colors.primary} />
      </View>
    );
  if (step.status === 'skipped')
    return (
      <View style={[styles.mark, styles.markSkipped]}>
        <Icon name="minus" size={16} color={colors.textSecondary} />
      </View>
    );
  return (
    <View style={[styles.mark, current && styles.markCurrent]}>
      <Text style={[styles.markText, current && styles.markTextCurrent]}>
        {index + 1}
      </Text>
    </View>
  );
}

const useStyles = createStyles((colors) => ({
  card: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  headerText: { flex: 1, gap: 2 },
  title: { ...type.heading, color: colors.textPrimary },
  muted: { ...type.body, color: colors.textSecondary },
  hint: { ...type.caption, color: colors.textSecondary, alignSelf: 'center' },
  error: { ...type.body, color: colors.error },
  close: {
    minHeight: 36,
    minWidth: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  progress: { flexDirection: 'row', gap: space.xs },
  progressSegment: {
    flex: 1,
    height: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceElevated,
  },
  progressDone: { backgroundColor: colors.primary },
  steps: { gap: space.sm },
  step: {
    flexDirection: 'row',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
  },
  currentStep: { backgroundColor: colors.selected },
  stepBody: { flex: 1, gap: space.xs, minWidth: 0 },
  stepTitleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: space.sm,
  },
  stepTitle: { ...type.label, color: colors.textPrimary },
  resolvedTitle: { color: colors.textSecondary },
  statusText: { ...type.caption, color: colors.textSecondary },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.xs,
  },
  mark: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: colors.inputBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markCurrent: { backgroundColor: colors.primary, borderColor: colors.primary },
  markDone: { backgroundColor: colors.selected, borderColor: colors.primary },
  markSkipped: { borderStyle: 'dashed' },
  markText: { ...type.caption, fontWeight: '600', color: colors.textSecondary },
  markTextCurrent: { color: colors.onPrimary },
}));
