import type { NotificationRecord } from '@signaldock/contracts';
import {
  Badge,
  Button,
  Heading,
  Icon,
  Text,
  createStyles,
  radius,
  space,
  type,
  useTheme,
} from '@signaldock/ui';
import { memo } from 'react';
import { View } from 'react-native';
import {
  categoryInfo,
  deliveryPresentation,
  groupNotificationsByDay,
  notificationLabel,
  notificationTime,
} from './notification-model';

export interface NotificationInboxProps {
  items: readonly NotificationRecord[];
  /** Zone the day groups and times are shown in (the device's). */
  timeZone: string;
  now: number;
  relayConfigured: boolean;
  /** Display name of a radio this account can see, else undefined. */
  radioName: (radioId: string) => string | undefined;
  /** Rows with a request in flight. */
  busyIds: ReadonlySet<string>;
  onMarkRead: (record: NotificationRecord) => void;
  /** Present when the workspace can open a radio; marks the row read first. */
  onOpenRadio?: (record: NotificationRecord) => void;
}

/** Notification history grouped by day, with explicit row buttons. */
export function NotificationInbox({
  items,
  timeZone,
  now,
  relayConfigured,
  radioName,
  busyIds,
  onMarkRead,
  onOpenRadio,
}: NotificationInboxProps) {
  const styles = useStyles();
  const days = groupNotificationsByDay(items, timeZone, now);
  return (
    <View style={styles.root}>
      {days.map((day) => (
        <View key={day.day} style={styles.day}>
          <View style={styles.dayHeader}>
            <Heading style={styles.dayHeading}>{day.heading}</Heading>
            {day.unread > 0 && (
              <Text style={styles.caption}>{day.unread} unread</Text>
            )}
          </View>
          <View style={styles.rows}>
            {day.items.map((record) => {
              const name = record.radioId
                ? radioName(record.radioId)
                : undefined;
              return (
                <NotificationRow
                  key={record.id}
                  record={record}
                  timeZone={timeZone}
                  relayConfigured={relayConfigured}
                  radioName={name}
                  unknownRadio={Boolean(record.radioId) && !name}
                  busy={busyIds.has(record.id)}
                  onMarkRead={onMarkRead}
                  onOpenRadio={name ? onOpenRadio : undefined}
                />
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

interface NotificationRowProps {
  record: NotificationRecord;
  timeZone: string;
  relayConfigured: boolean;
  radioName: string | undefined;
  unknownRadio: boolean;
  busy: boolean;
  onMarkRead: (record: NotificationRecord) => void;
  onOpenRadio: ((record: NotificationRecord) => void) | undefined;
}

const NotificationRow = memo(function NotificationRow({
  record,
  timeZone,
  relayConfigured,
  radioName,
  unknownRadio,
  busy,
  onMarkRead,
  onOpenRadio,
}: NotificationRowProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const info = categoryInfo(record.category);
  const unread = !record.readAt;
  const delivery = deliveryPresentation(record.deliveryState, relayConfigured);
  const meta = [
    notificationTime(record, timeZone),
    radioName ?? (unknownRadio ? 'Radio no longer visible' : undefined),
    info.label,
  ].filter(Boolean);
  return (
    <View style={[styles.row, unread && styles.rowUnread]}>
      <View
        accessible
        accessibilityLabel={notificationLabel(record, {
          timeZone,
          relayConfigured,
          ...(radioName ? { radioName } : {}),
        })}
        style={styles.main}
      >
        <View style={styles.marker}>
          {unread && <View style={styles.dot} />}
        </View>
        <View style={[styles.icon, unread && styles.iconUnread]}>
          <Icon
            name={info.icon}
            size={18}
            color={unread ? colors.primary : colors.textSecondary}
          />
        </View>
        <View style={styles.text}>
          <View style={styles.titleRow}>
            <Text style={[styles.title, unread && styles.titleUnread]}>
              {info.title}
            </Text>
            {unread && <Badge label="Unread" tone="primary" />}
          </View>
          <Text style={styles.caption}>{meta.join(' · ')}</Text>
          <Text
            style={[
              styles.caption,
              delivery.tone === 'warning' && styles.warning,
            ]}
          >
            {delivery.tone === 'warning' ? '⚠ ' : ''}
            {delivery.label}
          </Text>
        </View>
      </View>
      {(unread || onOpenRadio) && (
        <View style={styles.actions}>
          {unread && (
            <Button
              label="Mark read"
              variant="quiet"
              disabled={busy}
              onPress={() => onMarkRead(record)}
            />
          )}
          {onOpenRadio && (
            <Button
              label={radioName ? `Open ${radioName}` : 'Open radio'}
              disabled={busy}
              onPress={() => onOpenRadio(record)}
            />
          )}
        </View>
      )}
    </View>
  );
});

const useStyles = createStyles((c) => ({
  root: { gap: space.xl },
  day: { gap: space.sm },
  dayHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space.md,
  },
  dayHeading: { ...type.label, color: c.textSecondary },
  rows: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    overflow: 'hidden',
    backgroundColor: c.surface,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    padding: space.md,
    borderBottomWidth: 1,
    borderColor: c.border,
  },
  rowUnread: { backgroundColor: c.selected },
  main: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    flexGrow: 1,
    flexBasis: 240,
    minWidth: 0,
  },
  marker: { width: 8, paddingTop: 14, alignItems: 'center' },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: c.primary,
  },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.surfaceElevated,
  },
  iconUnread: { backgroundColor: c.surface },
  text: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  title: { ...type.body, color: c.textPrimary },
  titleUnread: { fontWeight: '600' },
  caption: { ...type.caption, color: c.textSecondary },
  warning: { color: c.warning },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginLeft: 'auto',
  },
}));
