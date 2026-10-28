import { Checkbox as ExpoCheckbox, Host, Switch } from '@expo/ui';
import type { PropsWithChildren } from 'react';
import { useTheme } from './theme';
import { layout } from './tokens';
interface BooleanFieldProps {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}
function NativeControlHost({ children }: PropsWithChildren) {
  const { colors, mode } = useTheme();
  return (
    <Host
      matchContents={{ vertical: true }}
      colorScheme={mode}
      seedColor={colors.primary}
      ignoreSafeArea="all"
      style={{
        width: '100%',
        minHeight: layout.touch,
        justifyContent: 'center',
      }}
    >
      {children}
    </Host>
  );
}
/** Official SwiftUI/Compose setting controls, with Expo's web implementations. */
export function SettingToggle(props: BooleanFieldProps) {
  return (
    <NativeControlHost>
      <Switch {...props} />
    </NativeControlHost>
  );
}
export function Checkbox(props: BooleanFieldProps) {
  return (
    <NativeControlHost>
      <ExpoCheckbox {...props} />
    </NativeControlHost>
  );
}
