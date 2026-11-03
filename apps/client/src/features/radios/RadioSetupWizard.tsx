import { apiRequest } from '@signaldock/client-sdk';
import type {
  ClientSession,
  InstalledDriver,
  RadioConfiguration,
} from '@signaldock/contracts';
import {
  Badge,
  Button,
  ChipInput,
  ConfirmDialog,
  ErrorState,
  Icon,
  LoadingState,
  Pressable,
  SchemaForm,
  SegmentedControl,
  SettingToggle,
  Stepper,
  Text,
  TextInput,
  asFormSchema,
  createStyles,
  radius,
  space,
  type,
  useTheme,
  useToast,
  validateSchemaValue,
  type ControlTone,
  type IconName,
} from '@signaldock/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { useFocusOnChange, type FocusTarget } from '../../shared/accessibility';
import { useRadioGroupKeyboard } from '../../shared/radio-group';
import { verificationLabel } from '../station/station-model';
import { operationId } from './radio-input';
import {
  RESOURCE_GROUP_LIMIT,
  SETUP_STEPS,
  STEP_ACCESS,
  STEP_DRIVER,
  STEP_IDENTITY,
  STEP_REVIEW,
  STEP_SETTINGS,
  buildConfigurationBody,
  currentConfig,
  describesSettings,
  driverAccessibilityLabel,
  driverCapabilities,
  endpointMode,
  endpointNotice,
  formatConfigJson,
  initialSetupState,
  initialStep,
  parseConfigJson,
  prefillFromConfiguration,
  reviewRows,
  saveConfirmation,
  selectDriver,
  settingsIssues,
  sortDrivers,
  stepIssues,
  switchSettingsMode,
  transportLabel,
  validateDisplayName,
  validateEndpoint,
  validateResourceGroup,
  type DriverCapabilityKey,
  type RadioSetupState,
  type SettingsMode,
  type StepContext,
} from './radio-setup-model';

export interface RadioSetupWizardProps {
  session: ClientSession;
  /** Installed drivers from `GET radios/drivers`. */
  drivers: readonly InstalledDriver[];
  /** Why the driver list could not be loaded, if it failed. */
  driversError?: string;
  onRetryDrivers?: () => void;
  /** The driver list is being fetched again after an error. */
  driversLoading?: boolean;
  /** Configuration to edit; the wizard then opens at Identity & connection. */
  existing?: RadioConfiguration;
  /** Called after `POST radios` succeeds with the stored configuration. */
  onSaved: (configuration: RadioConfiguration) => void;
  onClose: () => void;
  /** Opens Users & access; without it the Access step explains where to go. */
  onOpenAccess?: () => void;
}

const capabilityIcons: Record<DriverCapabilityKey, IconName> = {
  rx: 'rx',
  tx: 'tx',
  memories: 'pin',
  tuning: 'knob',
};
const verificationTone: Record<InstalledDriver['verification'], ControlTone> = {
  hardware_verified: 'primary',
  experimental: 'warning',
  simulated: 'neutral',
};
const monospace = type.frequency.fontFamily;
const DRIVER_CARD_MIN_WIDTH = 220;

const useStyles = createStyles((c) => ({
  wizard: { gap: space.lg },
  header: { gap: space.sm },
  title: { ...type.heading, color: c.textPrimary },
  muted: { ...type.body, color: c.textSecondary },
  caption: { ...type.caption, color: c.textSecondary },
  label: { ...type.label, color: c.textPrimary },
  error: { ...type.caption, color: c.error },
  warning: { ...type.caption, color: c.warning },
  section: { gap: space.md },
  field: { gap: space.xs },
  labelRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: space.sm,
  },
  drivers: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  driver: {
    flexGrow: 1,
    flexBasis: DRIVER_CARD_MIN_WIDTH,
    minWidth: 0,
    justifyContent: 'flex-start',
    padding: space.md,
    gap: space.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  driverSelected: {
    borderWidth: 2,
    borderColor: c.primary,
    backgroundColor: c.selected,
  },
  driverTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  driverName: { ...type.label, color: c.textPrimary, flex: 1 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  capabilities: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: space.md,
    rowGap: space.xs,
  },
  capability: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  json: {
    minHeight: 200,
    fontFamily: monospace,
    fontSize: 13,
    lineHeight: 19,
  },
  jsonStatus: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  review: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  reviewRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderTopWidth: 1,
    borderColor: c.border,
  },
  reviewFirst: { borderTopWidth: 0 },
  reviewLabel: { ...type.caption, color: c.textSecondary, width: 128 },
  reviewValue: { ...type.body, color: c.textPrimary, flex: 1, minWidth: 160 },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: c.surfaceElevated,
  },
  noteText: { ...type.body, color: c.textPrimary, flex: 1 },
  issues: { gap: space.xs },
  footer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderColor: c.border,
  },
  spacer: { flexGrow: 1 },
  done: { alignItems: 'flex-start', gap: space.md },
}));

/**
 * Five-step radio setup: Driver → Identity & connection → Settings (schema
 * form or Advanced JSON) → Review & save (`POST radios`) → Access. New radios
 * get a generated UUID; editing opens at Identity & connection.
 */
export function RadioSetupWizard({
  session,
  drivers,
  driversError,
  onRetryDrivers,
  driversLoading = false,
  existing,
  onSaved,
  onClose,
  onOpenAccess,
}: RadioSetupWizardProps) {
  const styles = useStyles();
  const toast = useToast();
  const sorted = useMemo(() => sortDrivers(drivers), [drivers]);
  const [state, setState] = useState<RadioSetupState>(() =>
    existing
      ? prefillFromConfiguration(
          existing,
          drivers.find((driver) => driver.driverId === existing.driverId),
        )
      : initialSetupState(operationId()),
  );
  const [step, setStep] = useState(() => initialStep(state));
  const [attempted, setAttempted] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [modeError, setModeError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState<RadioConfiguration>();
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);

  const driver = drivers.find((entry) => entry.driverId === state.driverId);
  const schema = useMemo(
    () => asFormSchema(driver?.configSchema),
    [driver?.configSchema],
  );
  const context: StepContext = useMemo(
    () => ({
      driver,
      ...(schema
        ? { validate: (value: unknown) => validateSchemaValue(schema, value) }
        : {}),
    }),
    [driver, schema],
  );
  const issues = stepIssues(step, state, context);
  // Each step change moves focus to the title, which names the step: the
  // control that was focused (Back, Save) may have unmounted.
  const titleRef = useFocusOnChange(step);
  const previous = existing ?? saved;
  const update = (next: Partial<RadioSetupState>) =>
    setState((current) => ({ ...current, ...next }));
  const goTo = (next: number) => {
    setAttempted(false);
    setModeError('');
    setSaveError('');
    setStep(next);
  };
  const next = () => {
    if (issues.length) {
      setAttempted(true);
      return;
    }
    goTo(step + 1);
  };

  const save = async () => {
    setConfirming(false);
    const built = buildConfigurationBody(state, driver);
    if (!built.ok) {
      setSaveError(built.error);
      return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setSaving(true);
    setSaveError('');
    try {
      const result = await apiRequest<RadioConfiguration>(session, 'radios', {
        method: 'POST',
        body: JSON.stringify(built.body),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setSaved(result);
      setState((current) => ({ ...current, mode: 'edit' }));
      goTo(STEP_ACCESS);
      toast.show({ message: `Saved ${result.displayName}.`, tone: 'success' });
      onSaved(result);
    } catch (failure) {
      if (!controller.signal.aborted) setSaveError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  };
  const requestSave = () => {
    if (issues.length) {
      setAttempted(true);
      return;
    }
    if (saveConfirmation(state, previous)) setConfirming(true);
    else void save();
  };
  const confirmation = saveConfirmation(state, previous);
  const title = existing
    ? `Edit ${existing.displayName}`
    : saved
      ? `Set up ${saved.displayName}`
      : 'Add a radio';

  return (
    <View style={styles.wizard}>
      <View style={styles.header}>
        <Text
          ref={(node) => {
            titleRef.current = node as FocusTarget;
          }}
          accessibilityRole="header"
          accessibilityLabel={`${title} · Step ${step + 1} of ${
            SETUP_STEPS.length
          }: ${SETUP_STEPS[step] ?? ''}`}
          {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})}
          style={styles.title}
        >
          {title}
        </Text>
        <Stepper steps={SETUP_STEPS} current={step} />
      </View>

      {step === STEP_DRIVER && (
        <DriverStep
          drivers={sorted}
          selectedId={state.driverId}
          error={driversError}
          onRetry={onRetryDrivers}
          loading={driversLoading}
          onSelect={(entry) => {
            setState((current) => selectDriver(current, entry));
            setAttempted(false);
          }}
        />
      )}
      {step === STEP_IDENTITY && (
        <IdentityStep
          state={state}
          driver={driver}
          showAll={attempted}
          touched={touched}
          onTouch={(key) => setTouched((t) => ({ ...t, [key]: true }))}
          onChange={update}
        />
      )}
      {step === STEP_SETTINGS && (
        <SettingsStep
          state={state}
          driver={driver}
          context={context}
          showAll={attempted}
          modeError={modeError}
          onMode={(mode) => {
            const result = switchSettingsMode(state, mode);
            if (result.ok) {
              setModeError('');
              setState(result.state);
            } else setModeError(result.error);
          }}
          onChange={update}
        />
      )}
      {step === STEP_REVIEW && (
        <ReviewStep
          state={state}
          driver={driver}
          onEdit={(target) => goTo(target)}
        />
      )}
      {step === STEP_ACCESS && saved && (
        <AccessStep configuration={saved} onOpenAccess={onOpenAccess} />
      )}

      {attempted && issues.length > 0 && step !== STEP_SETTINGS && (
        <View accessibilityRole="alert" style={styles.issues}>
          {issues.map((issue) => (
            <Text key={issue} style={styles.error}>
              {issue}
            </Text>
          ))}
        </View>
      )}
      {saveError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {saveError}
        </Text>
      ) : null}

      <View style={styles.footer}>
        {step === STEP_ACCESS ? (
          <>
            <View style={styles.spacer} />
            <Button variant="primary" label="Done" onPress={onClose} />
          </>
        ) : (
          <>
            {/* Kept mounted (disabled on the first step) so focus is not lost. */}
            <Button
              label={
                step === STEP_IDENTITY && state.mode === 'edit'
                  ? 'Change driver'
                  : 'Back'
              }
              disabled={saving || step === STEP_DRIVER}
              onPress={() => goTo(Math.max(STEP_DRIVER, step - 1))}
            />
            <Button
              variant="quiet"
              label="Cancel"
              disabled={saving}
              onPress={onClose}
            />
            <View style={styles.spacer} />
            {step === STEP_REVIEW ? (
              <Button
                variant="primary"
                label={state.mode === 'edit' ? 'Save changes' : 'Save radio'}
                loading={saving}
                onPress={requestSave}
              />
            ) : (
              <Button
                variant="primary"
                label={`Next: ${SETUP_STEPS[step + 1] ?? ''}`}
                disabled={step === STEP_DRIVER && !state.driverId}
                onPress={next}
              />
            )}
          </>
        )}
      </View>

      <ConfirmDialog
        visible={confirming && Boolean(confirmation)}
        title={confirmation?.title ?? ''}
        message={confirmation?.message ?? ''}
        confirmLabel={confirmation?.confirmLabel ?? 'Save'}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void save()}
      />
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 1 — Driver                                                            */
/* -------------------------------------------------------------------------- */

function DriverStep({
  drivers,
  selectedId,
  error,
  onRetry,
  loading,
  onSelect,
}: {
  drivers: readonly InstalledDriver[];
  selectedId: string | undefined;
  error: string | undefined;
  onRetry: (() => void) | undefined;
  loading: boolean;
  onSelect: (driver: InstalledDriver) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const missing =
    selectedId && !drivers.some((driver) => driver.driverId === selectedId);
  const keyboard = useRadioGroupKeyboard({
    enabled: drivers.map(() => true),
    checkedIndex: drivers.findIndex((driver) => driver.driverId === selectedId),
    onSelect: (index) => {
      const driver = drivers[index];
      if (driver) onSelect(driver);
    },
  });
  return (
    <View style={styles.section}>
      <Text style={styles.muted}>
        Choose the installed driver that talks to this radio.
      </Text>
      {loading ? (
        <LoadingState label="Loading installed drivers…" />
      ) : error ? (
        <ErrorState
          message={`Installed drivers could not be loaded. ${error}`}
          {...(onRetry ? { onRetry } : {})}
        />
      ) : !drivers.length ? (
        <Text style={styles.muted}>
          No drivers are installed on this station. Install a driver connector
          on the server first.
        </Text>
      ) : null}
      {missing ? (
        <View style={styles.note}>
          <Icon name="alert" size={18} color={colors.warning} />
          <Text style={styles.noteText}>
            This radio uses {selectedId}, which is not installed on this
            station. Keep it to edit the stored settings in Advanced JSON, or
            choose an installed driver.
          </Text>
        </View>
      ) : null}
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="Installed drivers"
        {...keyboard.group}
        style={styles.drivers}
      >
        {drivers.map((driver, index) => {
          const selected = driver.driverId === selectedId;
          return (
            <Pressable
              key={driver.driverId}
              {...keyboard.item(index)}
              accessibilityRole="radio"
              accessibilityLabel={driverAccessibilityLabel(driver)}
              accessibilityState={{ checked: selected }}
              onPress={() => onSelect(driver)}
              style={[styles.driver, selected && styles.driverSelected]}
            >
              <View style={styles.driverTitleRow}>
                <Icon
                  name={driver.transport === 'simulator' ? 'wave' : 'radio'}
                  size={20}
                  color={selected ? colors.primary : colors.textSecondary}
                />
                <Text style={styles.driverName}>{driver.displayName}</Text>
                {selected && (
                  <Icon name="check" size={18} color={colors.primary} />
                )}
              </View>
              <View style={styles.badges}>
                <Badge
                  label={verificationLabel(driver.verification)}
                  tone={verificationTone[driver.verification]}
                />
                <Badge label={transportLabel(driver)} />
              </View>
              {driver.description ? (
                <Text style={styles.caption}>{driver.description}</Text>
              ) : null}
              <View style={styles.capabilities}>
                {driverCapabilities(driver).map((capability) => (
                  <View key={capability.key} style={styles.capability}>
                    <Icon
                      name={capabilityIcons[capability.key]}
                      size={14}
                      color={colors.textSecondary}
                    />
                    <Text style={styles.caption}>{capability.label}</Text>
                  </View>
                ))}
                {driver.capabilitiesSummary.modes.length > 0 && (
                  <Text style={[styles.caption, { fontFamily: monospace }]}>
                    {driver.capabilitiesSummary.modes.join(' · ')}
                  </Text>
                )}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 2 — Identity & connection                                             */
/* -------------------------------------------------------------------------- */

function FieldLabel({
  label,
  optional = false,
}: {
  label: string;
  optional?: boolean;
}) {
  const styles = useStyles();
  return (
    <View style={styles.labelRow}>
      <Text style={styles.label}>{label}</Text>
      {optional && <Text style={styles.caption}>Optional</Text>}
    </View>
  );
}

function IdentityStep({
  state,
  driver,
  showAll,
  touched,
  onTouch,
  onChange,
}: {
  state: RadioSetupState;
  driver: InstalledDriver | undefined;
  showAll: boolean;
  touched: Record<string, boolean>;
  onTouch: (key: string) => void;
  onChange: (next: Partial<RadioSetupState>) => void;
}) {
  const styles = useStyles();
  const mode = endpointMode(driver);
  const nameError =
    showAll || touched['name'] ? validateDisplayName(state.displayName) : '';
  const endpointError =
    (showAll || touched['endpoint']) &&
    (mode === 'required' || state.endpoint.trim())
      ? validateEndpoint(state.endpoint)
      : '';
  const config = currentConfig(state);
  const notice = endpointNotice(
    state.endpoint,
    config.ok ? config.value : {},
    driver,
  );
  return (
    <View style={styles.section}>
      <View style={styles.field}>
        <FieldLabel label="Display name" />
        <Text style={styles.caption}>
          Shown to operators on radio cards and in history.
        </Text>
        <TextInput
          value={state.displayName}
          onChangeText={(displayName) => onChange({ displayName })}
          onBlur={() => onTouch('name')}
          maxLength={100}
          accessibilityLabel="Radio display name"
          placeholder="Base station"
        />
        {nameError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {nameError}
          </Text>
        ) : null}
      </View>

      {mode !== 'none' && (
        <View style={styles.field}>
          <FieldLabel
            label="Private driver endpoint"
            optional={mode === 'optional'}
          />
          <Text style={styles.caption}>
            Where the station reaches the driver service: host:port or
            unix:/absolute/socket/path. It is never shown to operators.
          </Text>
          <TextInput
            value={state.endpoint}
            onChangeText={(endpoint) => onChange({ endpoint })}
            onBlur={() => onTouch('endpoint')}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel="Private driver endpoint"
            placeholder="192.168.1.20:50051"
            style={{ fontFamily: monospace }}
          />
          {endpointError ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {endpointError}
            </Text>
          ) : notice ? (
            <Text style={styles.warning}>{notice}</Text>
          ) : null}
        </View>
      )}

      <View style={styles.field}>
        <FieldLabel label="Shared resource groups" optional />
        <Text style={styles.caption}>
          Radios that share hardware (for example one Bluetooth adapter) use the
          same group, so only one of them is operated at a time.
        </Text>
        <ChipInput
          values={state.resourceGroupIds}
          onChange={(resourceGroupIds) => onChange({ resourceGroupIds })}
          placeholder="Add a group and press Enter"
          accessibilityLabel="Shared resource groups"
          validate={validateResourceGroup}
          maxItems={RESOURCE_GROUP_LIMIT}
        />
      </View>

      <SettingToggle
        label="Radio enabled"
        value={state.enabled}
        onValueChange={(enabled) => onChange({ enabled })}
      />
      <Text style={styles.caption}>
        {state.enabled
          ? 'The station connects to the radio after saving.'
          : 'The configuration is stored but the station does not connect.'}
      </Text>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 3 — Settings                                                          */
/* -------------------------------------------------------------------------- */

function SettingsStep({
  state,
  driver,
  context,
  showAll,
  modeError,
  onMode,
  onChange,
}: {
  state: RadioSetupState;
  driver: InstalledDriver | undefined;
  context: StepContext;
  showAll: boolean;
  modeError: string;
  onMode: (mode: SettingsMode) => void;
  onChange: (next: Partial<RadioSetupState>) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const schema = asFormSchema(driver?.configSchema);
  const formAvailable = Boolean(schema) && describesSettings(driver);
  const errors = settingsIssues(state, context.validate);
  // Before the first Next, only report settings that already have a value.
  const visibleErrors = Object.fromEntries(
    Object.entries(errors).filter(
      ([key]) =>
        showAll ||
        key.startsWith('$') ||
        (state.settingsMode === 'json'
          ? true
          : state.config[key] !== undefined),
    ),
  );
  const parsed = parseConfigJson(state.configText);
  const settingCount = parsed.ok ? Object.keys(parsed.value).length : 0;
  return (
    <View style={styles.section}>
      <SegmentedControl<SettingsMode>
        accessibilityLabel="Settings editor"
        value={state.settingsMode}
        onChange={onMode}
        options={[
          {
            value: 'form',
            label: 'Form',
            disabled: !formAvailable,
            accessibilityLabel: formAvailable
              ? 'Form'
              : 'Form (this driver does not describe its settings)',
          },
          { value: 'json', label: 'Advanced JSON' },
        ]}
      />
      {modeError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {modeError}
        </Text>
      ) : null}
      {state.settingsMode === 'form' && schema ? (
        <>
          <SchemaForm
            schema={schema}
            value={state.config}
            onChange={(config) => onChange({ config })}
            errors={visibleErrors}
          />
          {/* Problems the form has no field for, e.g. an inline secret. */}
          {Object.entries(visibleErrors).some(
            ([key]) => !schema.properties?.[key],
          ) && (
            <View accessibilityRole="alert" style={styles.issues}>
              {Object.entries(visibleErrors)
                .filter(([key]) => !schema.properties?.[key])
                .map(([key, message]) => (
                  <Text key={key} style={styles.error}>
                    {message} Use Advanced JSON to change it.
                  </Text>
                ))}
            </View>
          )}
        </>
      ) : (
        <View style={styles.field}>
          <Text style={styles.caption}>
            {formAvailable
              ? 'Edit the driver settings as a JSON object.'
              : 'This driver does not describe its settings. Enter them as a JSON object.'}{' '}
            Reference stored credentials by name; inline tokens and passwords
            are rejected.
          </Text>
          <TextInput
            value={state.configText}
            onChangeText={(configText) => onChange({ configText })}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            accessibilityLabel="Driver settings JSON"
            style={styles.json}
          />
          <View style={styles.jsonStatus}>
            {Object.keys(visibleErrors).length ? (
              <View accessibilityRole="alert" style={styles.issues}>
                {Object.values(visibleErrors).map((message) => (
                  <Text key={message} style={styles.error}>
                    {message}
                  </Text>
                ))}
              </View>
            ) : (
              <>
                <Icon name="check" size={16} color={colors.primary} />
                <Text style={styles.caption}>
                  Valid JSON object ·{' '}
                  {settingCount === 1
                    ? '1 setting'
                    : `${settingCount} settings`}
                </Text>
              </>
            )}
          </View>
          {parsed.ok && (
            <Button
              variant="quiet"
              label="Format JSON"
              onPress={() =>
                onChange({ configText: formatConfigJson(parsed.value) })
              }
            />
          )}
        </View>
      )}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 4 — Review & save                                                     */
/* -------------------------------------------------------------------------- */

function ReviewStep({
  state,
  driver,
  onEdit,
}: {
  state: RadioSetupState;
  driver: InstalledDriver | undefined;
  onEdit: (step: number) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const rows = reviewRows(state, driver);
  return (
    <View style={styles.section}>
      <View style={styles.review}>
        {rows.map((row, index) => (
          <View
            key={row.label}
            style={[styles.reviewRow, index === 0 && styles.reviewFirst]}
          >
            <Text style={styles.reviewLabel}>{row.label}</Text>
            <Text
              selectable
              style={[
                styles.reviewValue,
                row.monospace ? { fontFamily: monospace } : null,
              ]}
            >
              {row.value}
            </Text>
          </View>
        ))}
      </View>
      <View style={styles.drivers}>
        <Button
          variant="quiet"
          label="Change driver"
          onPress={() => onEdit(STEP_DRIVER)}
        />
        <Button
          variant="quiet"
          label="Edit connection"
          onPress={() => onEdit(STEP_IDENTITY)}
        />
        <Button
          variant="quiet"
          label="Edit settings"
          onPress={() => onEdit(STEP_SETTINGS)}
        />
      </View>
      <View style={styles.note}>
        <Icon name="lock" size={18} color={colors.textSecondary} />
        <Text style={styles.noteText}>
          Configuring a radio does not grant operational access.
          {state.mode === 'edit'
            ? ' Saving reconnects the radio; control and live audio on it stop.'
            : ''}
        </Text>
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Step 5 — Access                                                            */
/* -------------------------------------------------------------------------- */

function AccessStep({
  configuration,
  onOpenAccess,
}: {
  configuration: RadioConfiguration;
  onOpenAccess: (() => void) | undefined;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.done}>
      <View style={styles.jsonStatus}>
        <Icon name="check" size={20} color={colors.primary} />
        <Text style={styles.label}>
          {configuration.displayName} is saved
          {configuration.enabled ? ' and connecting.' : ' (disabled).'}
        </Text>
      </View>
      <Text style={styles.muted}>
        Configuring a radio does not grant operational access. Give operators
        listen, control or transmit permission for this radio in Users & access.
      </Text>
      {onOpenAccess ? (
        <Button label="Open Users & access" onPress={onOpenAccess} />
      ) : (
        <Text style={styles.caption}>
          Open Users & access from the navigation to assign permissions.
        </Text>
      )}
    </View>
  );
}

function errorMessage(failure: unknown): string {
  return failure instanceof Error && failure.message
    ? failure.message
    : 'The radio configuration could not be saved.';
}
