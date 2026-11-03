import {
  Heading,
  Icon,
  layout,
  LoadingState,
  Overlay,
  Pressable,
  space,
  Text,
  type,
  useTheme,
} from '@signaldock/ui';
import { requireOptionalNativeModule } from 'expo';
import { lazy, Suspense, useState } from 'react';
import { View } from 'react-native';
import type { QrScanButtonProps } from './QrScanButton';

export type { QrScanButtonProps } from './QrScanButton';

/**
 * The camera module is loaded only when the native binary includes it, so an
 * older development build without expo-camera falls back to typing the
 * address instead of crashing.
 */
const cameraAvailable = Boolean(requireOptionalNativeModule('ExpoCamera'));
const CameraScanner = lazy(() => import('./CameraScanner'));

/** Native "Scan QR": opens the camera to read a station address. */
export function QrScanButton({ onScanned, disabled }: QrScanButtonProps) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  if (!cameraAvailable) return null;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Scan QR code"
        accessibilityHint="Opens the camera to read a station address shared by an administrator."
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          alignSelf: 'flex-start',
          gap: space.sm,
          minHeight: layout.touch,
          paddingHorizontal: space.lg,
          backgroundColor: colors.surfaceElevated,
        }}
      >
        <Icon name="camera" color={colors.primary} />
        <Text style={[type.label, { color: colors.primary }]}>Scan QR</Text>
      </Pressable>
      <Overlay
        visible={open}
        onClose={() => setOpen(false)}
        accessibilityLabel="Scan station QR code"
        maxWidth={420}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: space.sm,
          }}
        >
          <Heading>Scan station QR code</Heading>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close scanner"
            onPress={() => setOpen(false)}
            style={{ width: layout.touch, alignItems: 'center' }}
          >
            <Icon name="close" color={colors.textSecondary} />
          </Pressable>
        </View>
        {open && (
          <Suspense fallback={<LoadingState label="Starting camera…" />}>
            <CameraScanner
              onScanned={(url) => {
                setOpen(false);
                onScanned(url);
              }}
              onCancel={() => setOpen(false)}
            />
          </Suspense>
        )}
      </Overlay>
    </>
  );
}
