import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  useColorScheme,
  View,
  type ImageStyle,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { dark, light, type Colors } from './tokens';
export type ThemePreference = 'system' | 'light' | 'dark';
const Context = createContext({
  colors: light,
  mode: 'light' as 'light' | 'dark',
  preference: 'system' as ThemePreference,
  setPreference: (_value: ThemePreference) => {},
});
export interface ThemeStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<unknown>;
}
export function ThemeProvider({
  children,
  storage,
}: PropsWithChildren<{ storage?: ThemeStorage }>) {
  const system = useColorScheme();
  const [preference, updatePreference] = useState<ThemePreference>('system');
  const [ready, setReady] = useState(!storage);
  useEffect(() => {
    let current = true;
    if (storage)
      void storage
        .getItem('signaldock.appearance')
        .then((value) => {
          if (
            current &&
            (value === 'light' || value === 'dark' || value === 'system')
          )
            updatePreference(value);
        })
        .catch(() => {})
        .finally(() => {
          if (current) setReady(true);
        });
    return () => {
      current = false;
    };
  }, [storage]);
  const setPreference = useCallback(
    (value: ThemePreference) => {
      updatePreference(value);
      void storage?.setItem('signaldock.appearance', value).catch(() => {});
    },
    [storage],
  );
  const mode =
    preference === 'system'
      ? system === 'dark'
        ? 'dark'
        : 'light'
      : preference;
  const value = useMemo(
    () => ({
      colors: mode === 'dark' ? dark : light,
      mode,
      preference,
      setPreference,
    }),
    [mode, preference, setPreference],
  );
  return (
    <Context.Provider value={value}>
      {ready ? (
        children
      ) : (
        <View
          style={{
            flex: 1,
            backgroundColor: value.colors.background,
            justifyContent: 'center',
          }}
        >
          <ActivityIndicator color={value.colors.primary} />
        </View>
      )}
    </Context.Provider>
  );
}
export const useTheme = () => useContext(Context);
export function createStyles<
  T extends Record<string, ViewStyle | TextStyle | ImageStyle>,
>(factory: (colors: Colors) => T) {
  return function useStyles(): T {
    const { colors } = useTheme();
    return useMemo(() => StyleSheet.create(factory(colors)), [colors]);
  };
}
