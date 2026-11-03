import type { IncidentRecord } from '@signaldock/contracts';
import {
  Button,
  Pressable,
  SegmentedControl,
  Text,
  radius,
  space,
  type,
  useTheme,
} from '@signaldock/ui';
import { useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, View } from 'react-native';
import { formatFrequency } from '../station/station-model';
import {
  INCIDENT_COLUMNS,
  STATE_LABELS,
  attributionSuffix,
  columnCountLabel,
  evidenceCountLabel,
  formatIncidentAge,
  incidentCardLabel,
  primaryTransition,
  priorityPresentation,
  type IncidentColumn,
  type FrequencyAttribution,
  type OwnerPresentation,
  type TransitionAction,
} from './incident-model';

/** A focusable card node (web DOM element or native host component). */
export type FocusableCard = { focus?: () => void };

/** What the board needs to know about a card beyond the incident record. */
export interface IncidentCardInfo {
  radioName: string;
  /** From the first evidence communication, once loaded. */
  frequencyHz?: number | undefined;
  /** How the communication's frequency was attributed, once loaded. */
  frequencyAttribution?: FrequencyAttribution | undefined;
  owner?: OwnerPresentation | undefined;
  /** The user may move this incident (incident.manage on its radio). */
  canManage: boolean;
}

export interface IncidentBoardProps {
  groups: Record<IncidentColumn, IncidentRecord[]>;
  /** Columns with more pages on the server. */
  hasMore: Record<IncidentColumn, boolean>;
  /** Column shown by the compact (single column) layout. */
  column: IncidentColumn;
  onColumnChange: (column: IncidentColumn) => void;
  info: (incident: IncidentRecord) => IncidentCardInfo;
  now: number;
  selectedId?: string | undefined;
  /** Incident with a request in flight (its buttons are disabled). */
  busyId?: string | undefined;
  /** Any request in flight (disables every move). */
  busy: boolean;
  loading: boolean;
  onOpen: (incident: IncidentRecord) => void;
  onTransition: (incident: IncidentRecord, action: TransitionAction) => void;
  onLoadMore: (column: IncidentColumn) => void;
  /** Receives each card's open button (to return focus to it later). */
  registerCard?: ((id: string, node: FocusableCard | null) => void) | undefined;
}

const COLUMN_MIN_WIDTH = 176;
const COMPACT_BELOW = 720;

/**
 * New → Acknowledged → In progress → Closed. Wide: four columns (scrolling
 * sideways when narrow); compact: one column picked with a segmented control.
 * Every move is an explicit button; nothing depends on dragging.
 */
export function IncidentBoard(props: IncidentBoardProps) {
  const [width, setWidth] = useState(0);
  const compact = width > 0 && width < COMPACT_BELOW;
  const counts = Object.fromEntries(
    INCIDENT_COLUMNS.map((column) => [
      column.key,
      columnCountLabel(
        props.groups[column.key].length,
        props.hasMore[column.key],
      ),
    ]),
  ) as Record<IncidentColumn, string>;
  const columnWidth = Math.max(
    COLUMN_MIN_WIDTH,
    Math.floor((width - space.md * (INCIDENT_COLUMNS.length - 1)) / 4),
  );
  return (
    <View
      onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width))}
      style={{ gap: space.md, minWidth: 0 }}
    >
      {compact ? (
        <>
          <SegmentedControl
            accessibilityLabel="Incident column"
            size="compact"
            value={props.column}
            onChange={props.onColumnChange}
            options={INCIDENT_COLUMNS.map((column) => ({
              value: column.key,
              label: `${column.label} ${counts[column.key]}`,
              accessibilityLabel: `${column.label}, ${counts[column.key]} incidents`,
            }))}
          />
          <Column
            {...props}
            column={props.column}
            count={counts[props.column]}
            showHeading={false}
          />
        </>
      ) : width > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator
          contentContainerStyle={{ gap: space.md, alignItems: 'flex-start' }}
        >
          {INCIDENT_COLUMNS.map((column) => (
            <View key={column.key} style={{ width: columnWidth }}>
              <Column
                {...props}
                column={column.key}
                count={counts[column.key]}
                showHeading
              />
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

function Column({
  column,
  count,
  showHeading,
  groups,
  hasMore,
  loading,
  busy,
  onLoadMore,
  ...card
}: IncidentBoardProps & {
  column: IncidentColumn;
  count: string;
  showHeading: boolean;
}) {
  const { colors } = useTheme();
  const definition = INCIDENT_COLUMNS.find((entry) => entry.key === column)!;
  const records = groups[column];
  return (
    <View style={{ gap: space.sm }}>
      {showHeading && (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingHorizontal: space.xs,
            paddingBottom: space.xs,
            borderBottomWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Text
            accessibilityRole="header"
            style={[type.label, { color: colors.textSecondary }]}
          >
            {definition.label}
          </Text>
          <Text
            accessibilityLabel={`${count} incidents`}
            style={[
              type.label,
              {
                color: colors.textSecondary,
                fontVariant: ['tabular-nums'],
              },
            ]}
          >
            {count}
          </Text>
        </View>
      )}
      {records.length === 0 && !loading && (
        <Text
          style={[
            type.caption,
            {
              color: colors.textSecondary,
              padding: space.md,
              borderWidth: 1,
              borderStyle: 'dashed',
              borderColor: colors.border,
              borderRadius: radius.md,
              textAlign: 'center',
            },
          ]}
        >
          {column === 'closed' ? 'Nothing closed yet.' : 'No incidents.'}
        </Text>
      )}
      {records.length > 0 && (
        <View
          role="list"
          aria-label={`${definition.label} incidents`}
          accessibilityLabel={`${definition.label} incidents`}
          style={{ gap: space.sm }}
        >
          {records.map((incident) => (
            <IncidentCard
              key={incident.id}
              incident={incident}
              busy={busy}
              {...card}
            />
          ))}
        </View>
      )}
      {hasMore[column] && (
        <Button
          label={`Load more ${definition.label.toLowerCase()}`}
          variant="quiet"
          disabled={loading}
          onPress={() => onLoadMore(column)}
        />
      )}
    </View>
  );
}

function IncidentCard({
  incident,
  info,
  now,
  selectedId,
  busyId,
  busy,
  onOpen,
  onTransition,
  registerCard,
}: Pick<
  IncidentBoardProps,
  | 'info'
  | 'now'
  | 'selectedId'
  | 'busyId'
  | 'onOpen'
  | 'onTransition'
  | 'registerCard'
> & { incident: IncidentRecord; busy: boolean }) {
  const { colors } = useTheme();
  const details = info(incident);
  const priority = priorityPresentation(incident.priority);
  const priorityColor =
    priority.tone === 'error'
      ? colors.error
      : priority.tone === 'warning'
        ? colors.warning
        : colors.textSecondary;
  const closed =
    incident.state === 'resolved' || incident.state === 'dismissed';
  const selected = selectedId === incident.id;
  const next = details.canManage
    ? primaryTransition(incident.state)
    : undefined;
  const caption = [type.caption, { color: colors.textSecondary }];
  const unconfirmed =
    details.frequencyAttribution !== undefined &&
    details.frequencyAttribution !== 'confirmed';
  return (
    <View
      role="listitem"
      style={{
        borderWidth: 1,
        borderColor: selected ? colors.primary : colors.border,
        borderLeftWidth: selected ? 3 : 1,
        borderRadius: radius.md,
        backgroundColor: selected ? colors.selected : colors.surface,
        opacity: closed && !selected ? 0.8 : 1,
      }}
    >
      <Pressable
        ref={(node: FocusableCard | null) => registerCard?.(incident.id, node)}
        accessibilityRole="button"
        accessibilityLabel={incidentCardLabel({
          incident,
          radioName: details.radioName,
          frequencyHz: details.frequencyHz,
          frequencyAttribution: details.frequencyAttribution,
          now,
          owner: details.owner,
        })}
        accessibilityHint="Opens the incident details."
        // aria-selected is not valid on a button: web marks the open card
        // with aria-current; native keeps the selected state.
        {...(Platform.OS === 'web'
          ? { 'aria-current': selected ? ('true' as const) : undefined }
          : { accessibilityState: { selected } })}
        onPress={() => onOpen(incident)}
        style={{
          padding: space.sm,
          gap: space.xs,
          justifyContent: 'flex-start',
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: space.sm,
          }}
        >
          <Text
            style={[
              type.caption,
              { color: priorityColor, fontWeight: '700', flexShrink: 1 },
            ]}
          >
            {priority.glyph} {priority.label}
          </Text>
          {details.owner ? (
            <View
              style={{
                minWidth: 26,
                height: 26,
                paddingHorizontal: space.xs,
                borderRadius: 13,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: details.owner.mine
                  ? colors.selected
                  : colors.surfaceElevated,
              }}
            >
              <Text
                style={[
                  type.caption,
                  {
                    fontWeight: '700',
                    color: details.owner.mine
                      ? colors.primary
                      : colors.textSecondary,
                  },
                ]}
              >
                {details.owner.initials}
              </Text>
            </View>
          ) : null}
        </View>
        <Text
          numberOfLines={3}
          style={[type.label, { color: colors.textPrimary }]}
        >
          {incident.title}
        </Text>
        <Text numberOfLines={1} style={caption}>
          {details.radioName}
        </Text>
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            columnGap: space.sm,
          }}
        >
          {details.frequencyHz !== undefined && (
            <Text
              style={[
                caption,
                {
                  fontFamily: type.frequency.fontFamily,
                  fontVariant: ['tabular-nums'],
                  color: colors.textPrimary,
                },
                unconfirmed && {
                  textDecorationLine: 'underline',
                  textDecorationStyle: 'dotted',
                },
              ]}
            >
              {formatFrequency(details.frequencyHz)}
              {attributionSuffix(details.frequencyAttribution)}
            </Text>
          )}
          <Text style={caption}>
            {formatIncidentAge(incident.createdAt, now)}
          </Text>
          <Text style={caption}>
            {evidenceCountLabel(incident.evidence.length)}
          </Text>
          {closed && (
            <Text style={caption}>{STATE_LABELS[incident.state]}</Text>
          )}
        </View>
      </Pressable>
      {next && (
        <View
          style={{
            paddingHorizontal: space.sm,
            paddingBottom: space.sm,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${next.label}: ${incident.title}`}
            accessibilityState={{ busy: busyId === incident.id }}
            disabled={busy}
            onPress={() => onTransition(incident, next)}
            style={{
              alignSelf: 'flex-start',
              maxWidth: '100%',
              paddingHorizontal: space.lg,
              backgroundColor: colors.surfaceElevated,
            }}
          >
            {busyId === incident.id ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <Text style={[type.label, { color: colors.primary }]}>
                {next.label}
                {next.needsNote ? '…' : ''}
              </Text>
            )}
          </Pressable>
        </View>
      )}
    </View>
  );
}
