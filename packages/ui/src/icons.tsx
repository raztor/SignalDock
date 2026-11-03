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
  | 'mic'
  | 'chevron-up'
  | 'chevron-down'
  | 'chevron-right'
  | 'close'
  | 'check'
  | 'plus'
  | 'minus'
  | 'search'
  | 'play'
  | 'pause'
  | 'rx'
  | 'tx'
  | 'note'
  | 'lock'
  | 'knob'
  | 'signal'
  | 'wave'
  | 'command'
  | 'trash'
  | 'pin'
  | 'filter'
  | 'clock'
  | 'qr'
  | 'camera'
  | 'copy'
  | 'user';
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
  'chevron-up': 'm6 15 6-6 6 6',
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-right': 'm9 6 6 6-6 6',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12.5 4.5 4.5L19 7',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  search: 'm20 20-4.2-4.2',
  play: 'M7 4.5v15l12-7.5-12-7.5Z',
  pause: 'M8 5v14M16 5v14',
  rx: 'M12 3v8m-3.5-3.5L12 11l3.5-3.5M5 14a10 10 0 0 0 14 0M12 17v4m-3 0h6',
  tx: 'M12 11V3M8.5 6.5 12 3l3.5 3.5M5 14a10 10 0 0 0 14 0M12 17v4m-3 0h6',
  note: 'M6 3h9l4 4v14H6V3Zm9 0v4h4M9 12h7m-7 4h5',
  lock: 'M6 11h12v10H6V11Zm2 0V8a4 4 0 0 1 8 0v3m-4 4v2',
  knob: 'M12 13V8.5M12 2v2M4.2 5.2l1.4 1.4m12.8-1.4-1.4 1.4',
  signal: 'M4 20v-3m5 3v-7m5 7V9m5 11V4',
  wave: 'M2 12h2l2-5 3 10 3-14 3 14 3-8 2 3h2',
  command:
    'M9 9h6v6H9V9Zm0 0V6a3 3 0 1 0-3 3h3Zm6 0V6a3 3 0 1 1 3 3h-3Zm0 6v3a3 3 0 1 0 3-3h-3Zm-6 0v3a3 3 0 1 1-3-3h3Z',
  trash: 'M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3',
  pin: 'M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12Z',
  filter: 'M4 5h16l-6 7.5V19l-4 2v-8.5L4 5Z',
  clock: 'M12 7v5l3 2',
  qr: 'M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h2v2h-2v-2Zm4 0h2m-6 4v2m4-2h2v2h-2v-2Z',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4V8Z',
  copy: 'M9 9h11v11H9V9ZM5 15H4V4h11v1',
  user: 'M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1',
};
const circles: Partial<
  Record<IconName, readonly { cx: number; cy: number; r: number }[]>
> = {
  radio: [{ cx: 8, cy: 15, r: 2 }],
  sun: [{ cx: 12, cy: 12, r: 4 }],
  users: [{ cx: 9, cy: 7, r: 4 }],
  more: [
    { cx: 5, cy: 12, r: 1 },
    { cx: 12, cy: 12, r: 1 },
    { cx: 19, cy: 12, r: 1 },
  ],
  search: [{ cx: 11, cy: 11, r: 7 }],
  knob: [{ cx: 12, cy: 13, r: 7 }],
  pin: [{ cx: 12, cy: 9, r: 2.5 }],
  clock: [{ cx: 12, cy: 12, r: 9 }],
  camera: [{ cx: 12, cy: 13, r: 3.5 }],
  user: [{ cx: 12, cy: 8, r: 4 }],
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
  const path = paths[name];
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
      {path && <Path d={path} />}
      {circles[name]?.map((circle) => (
        <Circle
          key={`${circle.cx}-${circle.cy}`}
          cx={circle.cx}
          cy={circle.cy}
          r={circle.r}
        />
      ))}
    </Svg>
  );
}
