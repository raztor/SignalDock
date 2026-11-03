import {
  Heading,
  Icon,
  NumberField,
  SegmentedControl,
  SettingToggle,
  Text,
  createStyles,
  radius,
  space,
  type,
  useTheme,
} from '@signaldock/ui';
import { View } from 'react-native';
import { FrequencyFilterPicker } from './FrequencyFilterPicker';
import { QuietHoursPicker } from './QuietHoursPicker';
import { TimeZonePicker } from './TimeZonePicker';
import {
  COOLDOWN_MAX_SECONDS,
  COOLDOWN_OPTIONS,
  NOTIFICATION_CATEGORIES,
  cooldownError,
  cooldownLabel,
  cooldownSecondsFor,
  toggleCategory,
  type FrequencyOption,
  type PreferenceDraft,
} from './notification-model';

export interface NotificationPreferencesProps {
  draft: PreferenceDraft;
  onChange: (draft: PreferenceDraft) => void;
  /** This device's IANA zone, the default for quiet hours. */
  deviceZone: string;
  frequencyOptions: readonly FrequencyOption[];
  disabled?: boolean;
}

/**
 * Notification preference editor: master switch, one card per category,
 * frequency filter, quiet hours (with their time zone), cooldown and the
 * listening rule. It only edits the draft; the screen saves it.
 */
export function NotificationPreferences({
  draft,
  onChange,
  deviceZone,
  frequencyOptions,
  disabled = false,
}: NotificationPreferencesProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const update = (patch: Partial<PreferenceDraft>) =>
    onChange({ ...draft, ...patch });
  const cooldownSeconds = cooldownSecondsFor(
    draft.cooldownChoice,
    draft.customCooldownSeconds,
  );
  const customError =
    draft.cooldownChoice === 'custom'
      ? cooldownError(draft.customCooldownSeconds)
      : undefined;

  return (
    <View style={styles.root}>
      <View style={styles.section}>
        <SettingToggle
          label="Notifications enabled"
          value={draft.enabled}
          disabled={disabled}
          onValueChange={(enabled) => update({ enabled })}
        />
        {!draft.enabled && (
          <Text style={styles.warning}>
            Paused. New updates stay in station history but do not alert you.
          </Text>
        )}
      </View>

      <View style={styles.section}>
        <Heading>Categories</Heading>
        <View style={styles.cards}>
          {NOTIFICATION_CATEGORIES.map((info) => {
            const on = draft.categories.includes(info.category);
            return (
              <View
                key={info.category}
                style={[styles.card, on && styles.cardOn]}
              >
                <View style={styles.cardHeader}>
                  <View style={[styles.cardIcon, on && styles.cardIconOn]}>
                    <Icon
                      name={info.icon}
                      size={18}
                      color={on ? colors.primary : colors.textSecondary}
                    />
                  </View>
                  <View style={styles.grow}>
                    <SettingToggle
                      label={info.label}
                      value={on}
                      disabled={disabled}
                      onValueChange={(enabled) =>
                        update({
                          categories: toggleCategory(
                            draft.categories,
                            info.category,
                            enabled,
                          ),
                        })
                      }
                    />
                  </View>
                </View>
                <Text style={styles.caption}>{info.description}</Text>
              </View>
            );
          })}
        </View>
      </View>

      <View style={styles.section}>
        <Heading>Frequency</Heading>
        <FrequencyFilterPicker
          value={draft.frequencyHz}
          onChange={(frequencyHz) => update({ frequencyHz })}
          options={frequencyOptions}
          disabled={disabled}
        />
      </View>

      <View style={styles.section}>
        <QuietHoursPicker
          value={draft.quiet}
          onChange={(quiet) => update({ quiet })}
          timeZone={draft.timeZone}
          disabled={disabled}
        />
        {draft.quiet.enabled && (
          <TimeZonePicker
            value={draft.timeZone}
            onChange={(timeZone) => update({ timeZone })}
            deviceZone={deviceZone}
            disabled={disabled}
          />
        )}
      </View>

      <View style={styles.section}>
        <Heading>Cooldown</Heading>
        <Text style={styles.caption}>
          Minimum time between alerts. Everything is still kept in station
          history.
        </Text>
        <SegmentedControl
          accessibilityLabel="Cooldown between alerts"
          options={COOLDOWN_OPTIONS}
          value={draft.cooldownChoice}
          disabled={disabled}
          onChange={(cooldownChoice) =>
            update({
              cooldownChoice,
              ...(cooldownChoice === 'custom' &&
              draft.customCooldownSeconds === undefined
                ? { customCooldownSeconds: 120 }
                : {}),
            })
          }
        />
        {draft.cooldownChoice === 'custom' && (
          <View style={styles.custom}>
            <NumberField
              accessibilityLabel="Custom cooldown in seconds"
              value={draft.customCooldownSeconds}
              onChange={(customCooldownSeconds) =>
                update({ customCooldownSeconds })
              }
              min={0}
              max={COOLDOWN_MAX_SECONDS}
              step={30}
              integer
              unit="s"
              disabled={disabled}
            />
            {customError ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {customError}
              </Text>
            ) : (
              cooldownSeconds !== undefined && (
                <Text style={styles.caption}>
                  {cooldownLabel(cooldownSeconds)} between alerts.
                </Text>
              )
            )}
          </View>
        )}
      </View>

      <View style={styles.section}>
        <SettingToggle
          label="Quiet while listening"
          value={draft.suppressWhileListening}
          disabled={disabled}
          onValueChange={(suppressWhileListening) =>
            update({ suppressWhileListening })
          }
        />
        <Text style={styles.caption}>
          Skips alerts for a radio you are listening to. Incidents still alert
          you.
        </Text>
      </View>
    </View>
  );
}

const useStyles = createStyles((c) => ({
  root: { gap: space.xl },
  section: { gap: space.md },
  cards: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  card: {
    flexGrow: 1,
    flexBasis: 240,
    minWidth: 0,
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  cardOn: { borderColor: c.primary, backgroundColor: c.selected },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  cardIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.surfaceElevated,
  },
  cardIconOn: { backgroundColor: c.surface },
  grow: { flex: 1, minWidth: 0 },
  caption: { ...type.caption, color: c.textSecondary },
  warning: { ...type.body, color: c.warning },
  error: { ...type.body, color: c.error },
  custom: { gap: space.xs },
}));
