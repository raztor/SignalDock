import {
  Button,
  Heading,
  Icon,
  Overlay,
  Pressable,
  Text,
  TextInput,
  createStyles,
  space,
  type,
  useTheme,
} from '@signaldock/ui';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import {
  filterTimeZones,
  isKnownTimeZone,
  supportedTimeZones,
  timeZoneOffsetLabel,
} from './notification-model';

export interface TimeZonePickerProps {
  value: string;
  onChange: (zone: string) => void;
  /** This device's zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). */
  deviceZone: string;
  disabled?: boolean;
}

const RESULT_LIMIT = 60;

/**
 * The quiet-hours time zone as text with a "Change" button. The sheet lists
 * `Intl.supportedValuesOf('timeZone')` with search; runtimes that cannot list
 * zones get a validated text field instead.
 */
export function TimeZonePicker({
  value,
  onChange,
  deviceZone,
  disabled = false,
}: TimeZonePickerProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const zones = useMemo(() => supportedTimeZones(), []);
  const results = useMemo(
    () =>
      zones
        ? filterTimeZones(zones, query, RESULT_LIMIT, [value, deviceZone])
        : [],
    [zones, query, value, deviceZone],
  );
  const matches = useMemo(
    () =>
      zones && query ? filterTimeZones(zones, query, zones.length).length : 0,
    [zones, query],
  );
  const offset = timeZoneOffsetLabel(value, Date.now());
  const isDevice = value === deviceZone;

  const close = () => {
    setOpen(false);
    setQuery('');
    setError('');
  };
  const choose = (zone: string) => {
    onChange(zone);
    close();
  };
  const applyTyped = () => {
    const zone = typed.trim();
    if (!isKnownTimeZone(zone)) {
      setError(
        'This device does not recognise that time zone. Use a name like America/Santiago.',
      );
      return;
    }
    choose(zone);
  };

  return (
    <View style={styles.row}>
      <Icon name="clock" size={20} />
      <View style={styles.text}>
        <Text style={styles.zone}>{value}</Text>
        <Text style={styles.muted}>
          {[offset, isDevice ? 'This device' : 'Differs from this device']
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
      <Button
        label="Change"
        disabled={disabled}
        onPress={() => {
          setTyped(value);
          setOpen(true);
        }}
      />
      <Overlay
        visible={open}
        onClose={close}
        accessibilityLabel="Choose a time zone"
        placement="top"
      >
        <Heading>Time zone for quiet hours</Heading>
        {zones ? (
          <>
            <TextInput
              accessibilityLabel="Search time zones"
              placeholder="Search a city or region"
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            {!isDevice && (
              <Button
                label={`Use this device's zone (${deviceZone})`}
                onPress={() => choose(deviceZone)}
              />
            )}
            <ScrollView
              style={styles.list}
              keyboardShouldPersistTaps="handled"
              accessibilityLabel="Time zones"
            >
              {results.map((zone) => {
                const selected = zone === value;
                return (
                  <Pressable
                    key={zone}
                    accessibilityRole="button"
                    // aria-selected is ignored on buttons: say it in the label.
                    accessibilityLabel={`${zone}${zone === deviceZone ? ', this device' : ''}${selected ? ', selected' : ''}`}
                    accessibilityState={{ selected }}
                    onPress={() => choose(zone)}
                    style={[styles.option, selected && styles.optionSelected]}
                  >
                    <View style={styles.optionRow}>
                      <Text style={styles.optionText}>{zone}</Text>
                      {zone === deviceZone && (
                        <Text style={styles.muted}>This device</Text>
                      )}
                      {selected && (
                        <Icon name="check" size={18} color={colors.primary} />
                      )}
                    </View>
                  </Pressable>
                );
              })}
              {!results.length && (
                <Text style={styles.muted}>
                  No time zone matches “{query}”.
                </Text>
              )}
            </ScrollView>
            {matches > RESULT_LIMIT && (
              <Text style={styles.muted}>
                Showing {RESULT_LIMIT} of {matches}. Keep typing to narrow the
                list.
              </Text>
            )}
          </>
        ) : (
          <>
            <Text style={styles.muted}>
              This device cannot list time zones. Type an IANA name such as
              America/Santiago.
            </Text>
            <TextInput
              accessibilityLabel="Time zone name"
              value={typed}
              onChangeText={(text) => {
                setTyped(text);
                setError('');
              }}
              onSubmitEditing={applyTyped}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            {!!error && (
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            )}
            <View style={styles.actions}>
              <Button
                label="Use time zone"
                variant="primary"
                onPress={applyTyped}
              />
              {!isDevice && (
                <Button
                  label={`Use ${deviceZone}`}
                  onPress={() => choose(deviceZone)}
                />
              )}
            </View>
          </>
        )}
        <Button label="Cancel" variant="quiet" onPress={close} />
      </Overlay>
    </View>
  );
}

const useStyles = createStyles((c) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.md,
  },
  text: { flex: 1, minWidth: 160, gap: 2 },
  zone: { ...type.label, color: c.textPrimary },
  muted: { ...type.caption, color: c.textSecondary },
  error: { ...type.body, color: c.error },
  list: { maxHeight: 320, flexGrow: 0 },
  option: {
    paddingHorizontal: space.md,
    borderRadius: 0,
    borderBottomWidth: 1,
    borderColor: c.border,
  },
  optionSelected: { backgroundColor: c.selected },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  optionText: { ...type.body, color: c.textPrimary, flex: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
}));
