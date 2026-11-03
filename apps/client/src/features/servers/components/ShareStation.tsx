import type { ClientSession } from '@signaldock/contracts';
import {
  Button,
  Heading,
  Icon,
  layout,
  Overlay,
  Pressable,
  space,
  Text,
  type,
  useTheme,
  useToast,
} from '@signaldock/ui';
import { useState } from 'react';
import { Platform, useWindowDimensions, View } from 'react-native';
import { displayAddress } from '../server-model';
import { shareLinkLabel, shareStationLink } from '../share-link';
import { StationQrCode } from './StationQrCode';

export interface ShareStationButtonProps {
  session: ClientSession;
  /** Station display name from discovery. */
  displayName: string;
}

const MONOSPACE = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

/**
 * "Share station" for administrators: a QR code of the station address that
 * the SignalDock app can scan, plus a copy/share link fallback. Renders
 * nothing for other roles. Sharing the address grants no access by itself.
 */
export function ShareStationButton({
  session,
  displayName,
}: ShareStationButtonProps) {
  const { colors } = useTheme();
  const toast = useToast();
  const { width } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState('');
  if (session.user.role !== 'administrator') return null;
  const url = session.baseUrl;
  const side = Math.max(160, Math.min(240, width - space.xxxl * 2));
  const share = async () => {
    setNotice('');
    const result = await shareStationLink(url, displayName);
    if (result === 'copied')
      toast.show({ message: 'Station link copied.', tone: 'success' });
    else if (result === 'unavailable')
      setNotice(
        Platform.OS === 'web'
          ? 'Copying is not available in this browser. Select the address above and copy it.'
          : 'Sharing is not available. Select the address above and copy it.',
      );
  };
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Share station"
        accessibilityHint="Shows a QR code and link with this station's address."
        onPress={() => {
          setNotice('');
          setOpen(true);
        }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          alignSelf: 'flex-start',
          gap: space.sm,
          paddingHorizontal: space.lg,
          backgroundColor: colors.surfaceElevated,
        }}
      >
        <Icon name="qr" color={colors.primary} />
        <Text style={[type.label, { color: colors.primary }]}>
          Share station
        </Text>
      </Pressable>
      <Overlay
        visible={open}
        onClose={() => setOpen(false)}
        accessibilityLabel="Share station"
        maxWidth={420}
        scroll
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: space.sm,
          }}
        >
          <Heading>Share station</Heading>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            onPress={() => setOpen(false)}
            style={{ width: layout.touch, alignItems: 'center' }}
          >
            <Icon name="close" color={colors.textSecondary} />
          </Pressable>
        </View>
        <Text style={{ color: colors.textSecondary }}>
          Scan this code with the SignalDock app to fill in the station address.
          Everyone still signs in with their own account.
        </Text>
        <StationQrCode
          value={url}
          size={side}
          accessibilityLabel={`QR code for ${displayAddress(url)}`}
        />
        <View style={{ gap: space.xs, alignItems: 'center' }}>
          <Text style={[type.label, { textAlign: 'center' }]}>
            {displayName}
          </Text>
          <Text
            selectable
            style={[
              type.caption,
              {
                color: colors.textSecondary,
                fontFamily: MONOSPACE,
                textAlign: 'center',
              },
            ]}
          >
            {url}
          </Text>
        </View>
        {!!notice && (
          <Text accessibilityRole="alert" style={{ color: colors.warning }}>
            {notice}
          </Text>
        )}
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: space.md,
            justifyContent: 'center',
          }}
        >
          <Button
            label={shareLinkLabel}
            variant="primary"
            onPress={() => {
              void share();
            }}
          />
          <Button label="Done" onPress={() => setOpen(false)} />
        </View>
      </Overlay>
    </>
  );
}
