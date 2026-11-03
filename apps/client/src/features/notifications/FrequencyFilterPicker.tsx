import {
  Button,
  Chip,
  ChipGroup,
  Text,
  TextInput,
  createStyles,
  space,
  type,
} from '@signaldock/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { formatFrequency, parseFrequencyInput } from '../station/station-model';
import type { FrequencyOption } from './notification-model';

export interface FrequencyFilterPickerProps {
  /** Exact frequency in Hz, or undefined for any frequency. */
  value: number | undefined;
  onChange: (hz: number | undefined) => void;
  /** From `buildFrequencyOptions` (it always includes `value`). */
  options: readonly FrequencyOption[];
  disabled?: boolean;
}

/**
 * Frequency filter as chips: Any frequency, known frequencies (channel
 * memories, radios' current frequencies, recent activity) and Custom, which
 * reveals a field read with `parseFrequencyInput`.
 */
export function FrequencyFilterPicker({
  value,
  onChange,
  options,
  disabled = false,
}: FrequencyFilterPickerProps) {
  const styles = useStyles();
  const [custom, setCustom] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  const apply = () => {
    const parsed = parseFrequencyInput(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    onChange(parsed.hz);
    setCustom(false);
    setText('');
    setError('');
  };

  return (
    <View style={styles.root}>
      <ChipGroup accessibilityLabel="Frequency filter">
        <Chip
          label="Any frequency"
          selected={value === undefined}
          disabled={disabled}
          onPress={() => {
            setCustom(false);
            onChange(undefined);
          }}
        />
        {options.map((option) => (
          <Chip
            key={option.hz}
            label={
              option.detail
                ? `${option.frequency} · ${option.detail}`
                : `${option.frequency} MHz`
            }
            accessibilityLabel={option.accessibilityLabel}
            selected={value === option.hz}
            disabled={disabled}
            onPress={() => {
              setCustom(false);
              onChange(option.hz);
            }}
          />
        ))}
        <Chip
          label="Custom"
          icon="plus"
          selected={custom}
          disabled={disabled}
          accessibilityLabel="Custom frequency"
          onPress={() => {
            setCustom(!custom);
            setError('');
          }}
        />
      </ChipGroup>
      {custom && (
        <View style={styles.custom}>
          <TextInput
            accessibilityLabel="Custom frequency"
            placeholder="146.520 MHz"
            value={text}
            onChangeText={(next) => {
              setText(next);
              setError('');
            }}
            onSubmitEditing={apply}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            style={styles.input}
          />
          <Button label="Use frequency" variant="primary" onPress={apply} />
        </View>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      <Text style={styles.muted}>
        {value === undefined
          ? 'Updates on every frequency can notify you.'
          : `Only updates recorded on ${formatFrequency(value)} MHz notify you. Updates without a recorded frequency are skipped.`}
      </Text>
    </View>
  );
}

const useStyles = createStyles((c) => ({
  root: { gap: space.sm },
  custom: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
  },
  input: { flex: 1, minWidth: 160 },
  error: { ...type.body, color: c.error },
  muted: { ...type.caption, color: c.textSecondary },
}));
