import type { RecentServer } from '@signaldock/contracts';
import {
  createStyles,
  Icon,
  layout,
  Pressable,
  radius,
  space,
  StatusIndicator,
  Text,
  type,
  useTheme,
} from '@signaldock/ui';
import { ActivityIndicator, View } from 'react-native';
import {
  displayAddress,
  healthPresentation,
  lastUsedLabel,
  stationCardLabel,
  type StationHealth,
} from '../server-model';

export interface RecentStationCardProps {
  server: RecentServer;
  health: StationHealth | undefined;
  /** Epoch ms used for "Last used …" so a list shares one clock. */
  now: number;
  /** This card's connection attempt is running. */
  connecting: boolean;
  /** Another connection attempt is running. */
  disabled: boolean;
  onConnect: () => void;
  onForget: () => void;
}

/**
 * Saved station: name, address, live health (shape + text, never colour
 * alone) and last use. Tapping the card connects; the trash button asks to
 * forget it (the parent shows the confirmation).
 */
export function RecentStationCard({
  server,
  health,
  now,
  connecting,
  disabled,
  onConnect,
  onForget,
}: RecentStationCardProps) {
  const { colors } = useTheme();
  const styles = useCardStyles();
  const status = healthPresentation(health);
  return (
    <View style={[styles.card, connecting && styles.active]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={stationCardLabel(server, health, now)}
        accessibilityState={{ busy: connecting }}
        disabled={disabled || connecting}
        onPress={onConnect}
        style={styles.main}
      >
        <View style={styles.top}>
          <View style={styles.icon}>
            <Icon name="server" color={colors.primary} />
          </View>
          <View style={styles.identity}>
            <Text numberOfLines={1} style={styles.name}>
              {server.alias}
            </Text>
            <Text numberOfLines={1} style={styles.address}>
              {displayAddress(server.baseUrl)}
            </Text>
          </View>
          {connecting ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <Icon name="chevron-right" color={colors.textSecondary} />
          )}
        </View>
        <View style={styles.meta}>
          <StatusIndicator
            tone={status.tone}
            label={connecting ? 'Connecting…' : status.label}
            pulse={connecting || status.pulse}
            size="compact"
          />
          <View style={styles.used}>
            <Icon name="clock" size={14} color={colors.textSecondary} />
            <Text style={styles.caption}>
              {lastUsedLabel(server.lastConnectedAt, now)}
            </Text>
          </View>
        </View>
        {!!status.detail && !connecting && (
          <Text
            style={[
              styles.caption,
              status.tone === 'error' && { color: colors.error },
              status.tone === 'warning' && { color: colors.warning },
            ]}
          >
            {status.detail}
          </Text>
        )}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Forget ${server.alias}`}
        disabled={connecting}
        onPress={onForget}
        style={styles.forget}
      >
        <Icon name="trash" color={colors.textSecondary} />
      </Pressable>
    </View>
  );
}

const useCardStyles = createStyles((c) => ({
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.xs,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.lg,
    paddingLeft: space.md,
    paddingVertical: space.xs,
  },
  active: { borderColor: c.primary, backgroundColor: c.selected },
  main: {
    flex: 1,
    minWidth: 0,
    gap: space.sm,
    paddingVertical: space.sm,
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  icon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.surfaceElevated,
  },
  identity: { flex: 1, minWidth: 0, gap: 2 },
  name: { ...type.label, color: c.textPrimary },
  address: { ...type.caption, color: c.textSecondary },
  meta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space.lg,
    rowGap: space.xs,
  },
  used: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  caption: { ...type.caption, color: c.textSecondary },
  forget: {
    width: layout.touch,
    minHeight: layout.touch,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
