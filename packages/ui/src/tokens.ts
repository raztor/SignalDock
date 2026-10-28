import { Platform, type TextStyle } from 'react-native';

export const space = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;
export const radius = { sm: 4, md: 8, lg: 12 } as const;
export const layout = {
  compact: 720,
  wide: 1100,
  content: 1120,
  form: 480,
  sidebar: 224,
  audio: 320,
  touch: 48,
} as const;
export const motion = {
  quick: 120,
  standard: 180,
  easing: 'ease-out',
} as const;
export const type = {
  display: {
    fontSize: 36,
    lineHeight: 44,
    fontWeight: '700',
    letterSpacing: -1.2,
  },
  title: {
    fontSize: 28,
    lineHeight: 36,
    fontWeight: '700',
    letterSpacing: -0.8,
  },
  heading: {
    fontSize: 18,
    lineHeight: 26,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  body: { fontSize: 15, lineHeight: 23 },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  caption: { fontSize: 12, lineHeight: 18 },
  frequency: {
    fontSize: 28,
    lineHeight: 36,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace',
    }),
    letterSpacing: -1,
  },
} satisfies Record<string, TextStyle>;
export const light = {
  primary: '#176353',
  secondary: '#455c58',
  accent: '#936027',
  background: '#f5f6f3',
  surface: '#ffffff',
  surfaceElevated: '#eaf0eb',
  textPrimary: '#192c27',
  textSecondary: '#56675f',
  border: '#d9e0da',
  inputBorder: '#85968d',
  success: '#176353',
  warning: '#805311',
  error: '#a83135',
  onPrimary: '#ffffff',
  selected: '#e0eee7',
  pressed: '#d2e4d9',
  focus: '#176353',
  disabled: '#e1e5e0',
};
export type Colors = typeof light;
export const dark: Colors = {
  primary: '#8dd5b8',
  secondary: '#b3c6bb',
  accent: '#e3bb85',
  background: '#101b18',
  surface: '#17251f',
  surfaceElevated: '#20332a',
  textPrimary: '#edf3ed',
  textSecondary: '#acbdb1',
  border: '#31443a',
  inputBorder: '#6d8374',
  success: '#8dd5b8',
  warning: '#e3bb85',
  error: '#ffb3b4',
  onPrimary: '#10271e',
  selected: '#244d3a',
  pressed: '#305b46',
  focus: '#8dd5b8',
  disabled: '#2b3a31',
};
