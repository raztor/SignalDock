import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewProps,
} from 'react-native';
import type { PropsWithChildren } from 'react';

export const theme = {
  background: '#0b1220',
  surface: '#152238',
  border: '#2c405c',
  text: '#edf4ff',
  muted: '#aabbd2',
  accent: '#50dfc2',
  danger: '#ffb4a9',
};
export function Action({
  label,
  onPress,
  active,
  disabled,
}: {
  label: string;
  onPress: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{
        selected: Boolean(active),
        disabled: Boolean(disabled),
      }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.action,
        active && styles.active,
        disabled && { opacity: 0.5 },
      ]}
    >
      <Text
        style={{
          color: active ? theme.background : theme.text,
          fontWeight: '600',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
export function Panel({
  children,
  style,
  ...props
}: PropsWithChildren<ViewProps>) {
  return (
    <View {...props} style={[styles.panel, style]}>
      {children}
    </View>
  );
}
const styles = StyleSheet.create({
  action: {
    minHeight: 42,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.border,
  },
  active: { backgroundColor: theme.accent, borderColor: theme.accent },
  panel: {
    borderRadius: 14,
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
});
