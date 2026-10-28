import { useState, type ComponentProps, type PropsWithChildren } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Pressable as NativePressable,
  ScrollView as NativeScrollView,
  Text as NativeText,
  TextInput as NativeTextInput,
  Platform,
  View,
  type ScrollViewProps,
  type TextInputProps,
  type TextProps,
  type ViewProps,
} from 'react-native';
import { useTheme } from './theme';
import { layout, radius, space, type } from './tokens';

export function Text({ style, ...props }: TextProps) {
  const { colors } = useTheme();
  return (
    <NativeText
      {...props}
      style={[type.body, { color: colors.textPrimary, flexShrink: 1 }, style]}
    />
  );
}
export function Heading(props: TextProps) {
  return (
    <Text
      accessibilityRole="header"
      {...props}
      style={[type.heading, props.style]}
    />
  );
}
export function TextInput({
  style,
  onFocus,
  onBlur,
  ...props
}: TextInputProps) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <NativeTextInput
      placeholderTextColor={colors.textSecondary}
      selectionColor={colors.primary}
      {...props}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      style={[
        type.body,
        {
          minHeight: layout.touch,
          color: colors.textPrimary,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.inputBorder,
          borderRadius: radius.md,
          padding: space.md,
          textAlignVertical: props.multiline ? 'top' : 'center',
        },
        style,
        focused && {
          borderColor: colors.focus,
          outlineColor: colors.focus,
          outlineWidth: 2,
          outlineStyle: 'solid',
        },
      ]}
    />
  );
}
/** Keeps feedback consistent for existing feature actions as well as navigation. */
export function Pressable({
  style,
  disabled,
  accessibilityState,
  ...props
}: ComponentProps<typeof NativePressable>) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <NativePressable
      {...props}
      disabled={disabled}
      accessibilityState={{
        ...accessibilityState,
        disabled: Boolean(disabled),
      }}
      {...(Platform.OS === 'web'
        ? {
            'aria-busy': accessibilityState?.busy,
            'aria-checked': accessibilityState?.checked,
            'aria-expanded': accessibilityState?.expanded,
            'aria-selected': accessibilityState?.selected,
            'aria-disabled': Boolean(disabled),
          }
        : {})}
      onFocus={(event) => {
        setFocused(true);
        props.onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        props.onBlur?.(event);
      }}
      style={(state) => [
        {
          minHeight: layout.touch,
          justifyContent: 'center',
          borderRadius: radius.md,
        },
        typeof style === 'function' ? style(state) : style,
        state.pressed && { opacity: 0.75 },
        disabled && { opacity: 0.45 },
        focused && {
          outlineColor: colors.focus,
          outlineWidth: 2,
          outlineStyle: 'solid',
        },
      ]}
    />
  );
}
export interface ButtonProps {
  label?: string;
  title?: string;
  onPress: () => void;
  active?: boolean;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
}
export function Button({
  label,
  title,
  onPress,
  active = false,
  disabled = false,
  loading = false,
  variant = 'secondary',
}: ButtonProps) {
  const { colors } = useTheme();
  const filled = variant === 'primary';
  const foreground = filled
    ? colors.onPrimary
    : variant === 'danger'
      ? colors.error
      : colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? title}
      accessibilityState={{ selected: active, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={{
        alignSelf: 'flex-start',
        maxWidth: '100%',
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        backgroundColor: filled
          ? colors.primary
          : active
            ? colors.selected
            : variant === 'quiet'
              ? 'transparent'
              : colors.surfaceElevated,
      }}
    >
      {loading ? (
        <ActivityIndicator color={foreground} />
      ) : (
        <Text style={[type.label, { color: foreground }]}>
          {label ?? title}
        </Text>
      )}
    </Pressable>
  );
}
export const Action = Button;
export function Panel({
  children,
  style,
  ...props
}: PropsWithChildren<ViewProps>) {
  const { colors } = useTheme();
  return (
    <View
      {...props}
      style={[
        {
          padding: space.xl,
          gap: space.md,
          backgroundColor: colors.surface,
          borderRadius: radius.md,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
export function ScrollView(props: ScrollViewProps) {
  const { colors } = useTheme();
  return (
    <NativeScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets
      contentInsetAdjustmentBehavior="automatic"
      {...props}
      style={[{ backgroundColor: colors.background }, props.style]}
    />
  );
}
export function FormLayout({ children }: PropsWithChildren) {
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {children}
    </KeyboardAvoidingView>
  );
}
export function Divider() {
  const { colors } = useTheme();
  return <View style={{ height: 1, backgroundColor: colors.border }} />;
}
export function EmptyState({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <View style={{ paddingVertical: space.xxl, gap: space.sm }}>
      <Heading>{title}</Heading>
      <Text>{message}</Text>
    </View>
  );
}
export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingVertical: space.lg,
      }}
    >
      <ActivityIndicator color={colors.primary} />
      <Text>{label}</Text>
    </View>
  );
}
export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityRole="alert"
      style={{
        gap: space.md,
        padding: space.lg,
        backgroundColor: colors.surface,
      }}
    >
      <Text style={{ color: colors.error }}>{message}</Text>
      {onRetry && <Button label="Try again" onPress={onRetry} />}
    </View>
  );
}
export function Disclosure({
  title,
  children,
  initialOpen = false,
}: PropsWithChildren<{ title: string; initialOpen?: boolean }>) {
  const [open, setOpen] = useState(initialOpen);
  const { colors } = useTheme();
  return (
    <View
      style={{
        borderTopWidth: 1,
        borderColor: colors.border,
        paddingTop: space.md,
        gap: space.md,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: space.md,
        }}
      >
        <Heading>{title}</Heading>
        <Text>{open ? '−' : '+'}</Text>
      </Pressable>
      <View style={{ display: open ? 'flex' : 'none', gap: space.md }}>
        {children}
      </View>
    </View>
  );
}
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onCancel}
    >
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          padding: space.xl,
          backgroundColor: colors.background,
        }}
      >
        <View
          accessibilityViewIsModal
          style={{
            width: '100%',
            maxWidth: layout.form,
            backgroundColor: colors.surface,
            padding: space.xl,
            gap: space.lg,
            borderRadius: radius.md,
          }}
        >
          <Heading>{title}</Heading>
          <Text>{message}</Text>
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}
          >
            <Button label="Cancel" onPress={onCancel} />
            <Button variant="danger" label={confirmLabel} onPress={onConfirm} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** Destructive actions reuse one confirmation pattern before invoking their existing handler. */
export function ConfirmButton({
  confirmation,
  onPress,
  ...props
}: ButtonProps & {
  confirmation: { title: string; message: string; confirmLabel?: string };
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button {...props} onPress={() => setOpen(true)} />
      <ConfirmDialog
        visible={open}
        title={confirmation.title}
        message={confirmation.message}
        confirmLabel={
          confirmation.confirmLabel ?? props.label ?? props.title ?? 'Confirm'
        }
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          onPress();
        }}
      />
    </>
  );
}
