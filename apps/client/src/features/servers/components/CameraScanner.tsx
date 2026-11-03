import {
  Button,
  LoadingState,
  radius,
  space,
  Text,
  useTheme,
} from '@signaldock/ui';
import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
} from 'expo-camera';
import { useRef, useState } from 'react';
import { Linking, View } from 'react-native';
import { parseScannedStation } from '../server-model';

export interface CameraScannerProps {
  onScanned: (url: string) => void;
  onCancel: () => void;
}

/**
 * Camera view that reads one station QR code. Loaded lazily by the native
 * QrScanButton only; web never bundles it. Asks for camera permission with an
 * explanation first and offers Settings when the permission was refused.
 */
export default function CameraScanner({
  onScanned,
  onCancel,
}: CameraScannerProps) {
  const { colors } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [problem, setProblem] = useState('');
  const [failed, setFailed] = useState('');
  const done = useRef(false);
  const lastRejected = useRef('');

  const fallback = (
    <Text style={{ color: colors.textSecondary }}>
      You can also type the address shown under the QR code.
    </Text>
  );

  if (!permission) return <LoadingState label="Checking camera access…" />;

  if (!permission.granted)
    return (
      <View style={{ gap: space.md }}>
        <Text>
          {permission.canAskAgain
            ? 'SignalDock uses the camera only to read the station QR code. Nothing is recorded.'
            : 'Camera access is turned off for SignalDock. Turn it on in Settings to scan a code.'}
        </Text>
        {fallback}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
          {permission.canAskAgain ? (
            <Button
              label="Allow camera"
              variant="primary"
              onPress={() => {
                void requestPermission();
              }}
            />
          ) : (
            <Button
              label="Open Settings"
              variant="primary"
              onPress={() => {
                void Linking.openSettings();
              }}
            />
          )}
          <Button label="Type the address" onPress={onCancel} />
        </View>
      </View>
    );

  if (failed)
    return (
      <View style={{ gap: space.md }}>
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {failed}
        </Text>
        {fallback}
        <Button label="Type the address" onPress={onCancel} />
      </View>
    );

  const handle = ({ data }: BarcodeScanningResult) => {
    if (done.current) return;
    const result = parseScannedStation(data);
    if (result.ok) {
      done.current = true;
      onScanned(result.url);
      return;
    }
    // The same code is reported many times per second; announce it once.
    if (lastRejected.current === data) return;
    lastRejected.current = data;
    setProblem(result.error);
  };

  return (
    <View style={{ gap: space.md }}>
      <View
        style={{
          width: '100%',
          aspectRatio: 1,
          borderRadius: radius.md,
          overflow: 'hidden',
          backgroundColor: colors.surfaceElevated,
        }}
      >
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handle}
          onMountError={(event) =>
            setFailed(
              event.message
                ? `The camera could not start: ${event.message}`
                : 'The camera could not start.',
            )
          }
          accessibilityLabel="Camera preview for scanning a station QR code"
        />
      </View>
      <Text
        accessibilityLiveRegion="polite"
        style={{ color: problem ? colors.warning : colors.textSecondary }}
      >
        {problem || 'Point the camera at the QR code from Share station.'}
      </Text>
      <Button label="Type the address" onPress={onCancel} />
    </View>
  );
}
