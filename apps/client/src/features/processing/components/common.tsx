import { Icon, Text, TextInput, useTheme, type IconName } from '@signaldock/ui';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useProcessingStyles } from './styles';

export function Field({
  label,
  value,
  onChangeText,
  hint,
  error,
  secret = false,
  multiline = false,
  readOnly = false,
  placeholder,
  icon,
  disabled = false,
}: {
  label: string;
  value: string;
  onChangeText?: (value: string) => void;
  hint?: string;
  error?: string | undefined;
  secret?: boolean;
  multiline?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  icon?: IconName;
  disabled?: boolean;
}) {
  const styles = useProcessingStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.field}>
      <View style={styles.titleRow}>
        {icon ? (
          <Icon name={icon} size={16} color={colors.textSecondary} />
        ) : null}
        <Text style={styles.label}>{label}</Text>
      </View>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        style={[
          styles.input,
          multiline && styles.multiline,
          readOnly && styles.inputReadOnly,
        ]}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secret}
        {...(secret
          ? {
              // Chrome ignores autocomplete="off" on password inputs but
              // honours new-password, so a saved station credential is never
              // filled into a provider secret (which is sent to that provider).
              autoComplete: 'new-password' as const,
              textContentType: 'none' as const,
              importantForAutofill: 'no' as const,
            }
          : {})}
        editable={!readOnly && !disabled}
        value={value}
        placeholder={placeholder}
        onChangeText={onChangeText}
        multiline={multiline}
      />
      {error ? (
        <Text accessibilityLiveRegion="polite" style={styles.errorCaption}>
          {error}
        </Text>
      ) : hint ? (
        <Text style={styles.caption}>{hint}</Text>
      ) : null}
    </View>
  );
}

export function Notice({
  tone = 'neutral',
  icon,
  children,
}: {
  tone?: 'neutral' | 'warning' | 'error';
  icon?: IconName;
  children: ReactNode;
}) {
  const styles = useProcessingStyles();
  const { colors } = useTheme();
  const color =
    tone === 'warning'
      ? colors.warning
      : tone === 'error'
        ? colors.error
        : colors.textSecondary;
  return (
    <View
      style={[
        styles.notice,
        tone === 'warning' && styles.noticeWarning,
        tone === 'error' && styles.noticeError,
      ]}
    >
      <Icon
        name={icon ?? (tone === 'neutral' ? 'note' : 'alert')}
        size={16}
        color={color}
      />
      <Text
        style={[
          tone === 'neutral' ? styles.caption : styles.warning,
          tone === 'error' && { color: colors.error },
          { flex: 1 },
        ]}
      >
        {children}
      </Text>
    </View>
  );
}

/** Lifecycle position bar; the text label next to it carries the meaning. */
export function ProgressBar({
  fraction,
  tone = 'primary',
  label,
}: {
  fraction: number;
  tone?: 'primary' | 'warning' | 'error';
  label: string;
}) {
  const styles = useProcessingStyles();
  const percent = Math.round(Math.min(Math.max(fraction, 0), 1) * 100);
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: percent }}
      style={styles.progressTrack}
    >
      <View
        style={[
          styles.progressFill,
          tone === 'warning' && styles.progressWarning,
          tone === 'error' && styles.progressError,
          { width: `${percent}%` },
        ]}
      />
    </View>
  );
}

export function IconBox({
  name,
  selected = false,
}: {
  name: IconName;
  selected?: boolean;
}) {
  const styles = useProcessingStyles();
  const { colors } = useTheme();
  return (
    <View style={[styles.iconBox, selected && styles.iconBoxSelected]}>
      <Icon
        name={name}
        size={18}
        color={selected ? colors.onPrimary : colors.primary}
      />
    </View>
  );
}
