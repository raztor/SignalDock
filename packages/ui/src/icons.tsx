import { Platform } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from './theme';
export type IconName =
  | 'radio'
  | 'history'
  | 'map'
  | 'bell'
  | 'more'
  | 'settings'
  | 'users'
  | 'session'
  | 'alert'
  | 'server'
  | 'sun'
  | 'moon'
  | 'arrow'
  | 'headphones'
  | 'mic';
const paths: Partial<Record<IconName, string>> = {
  radio:
    'M5 9h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Zm1 0L18 3M15 13h3m-3 4h3',
  history: 'M3 11a9 9 0 1 1 2.5 7M3 5v6h6m3-4v5l3 2',
  map: 'm3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6',
  users:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3a4 4 0 0 1 0 8',
  session: 'M9 21h6m-3-4v4M4 3h16v14H4V3Z',
  alert: 'm12 3 10 18H2L12 3Zm0 6v5m0 3v.1',
  server: 'M4 3h16v7H4V3Zm0 11h16v7H4v-7Zm4-7h.01M8 18h.01',
  sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5',
  moon: 'M21 13a9 9 0 0 1-10-10A9 9 0 1 0 21 13Z',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  headphones: 'M3 15v-3a9 9 0 0 1 18 0v3M3 13h4v8H3v-8Zm14 0h4v8h-4v-8Z',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-3 6v1a6 6 0 0 0 12 0v-1m-6 7v4m-4 0h8',
};
export function Icon({
  name,
  size = 20,
  color,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  const { colors } = useTheme();
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? colors.textSecondary}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(Platform.OS === 'web'
        ? { 'aria-hidden': true }
        : {
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants' as const,
          })}
    >
      {paths[name] && <Path d={paths[name]} />}
      {name === 'radio' && <Circle cx={8} cy={15} r={2} />}
      {name === 'sun' && <Circle cx={12} cy={12} r={4} />}
      {name === 'users' && <Circle cx={9} cy={7} r={4} />}
      {name === 'more' && (
        <>
          <Circle cx={5} cy={12} r={1} />
          <Circle cx={12} cy={12} r={1} />
          <Circle cx={19} cy={12} r={1} />
        </>
      )}
    </Svg>
  );
}
