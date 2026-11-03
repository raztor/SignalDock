import type { ClientSession, Communication } from '@signaldock/contracts';
import {
  Badge,
  Button,
  Chip,
  ChipGroup,
  ConfirmDialog,
  Icon,
  Overlay,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  createStyles,
  layout,
  radius,
  space,
  type,
  useTheme,
  type IconName,
} from '@signaldock/ui';
import { memo, useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { moveFocus, type FocusTarget } from '../../shared/accessibility';
import RecordingPlayer from './RecordingPlayer';
import { Waveform } from './Waveform';
import type { WaveformLoader } from './history-api';
import {
  communicationDurationMs,
  formatClock,
  formatDuration,
  frequencyAccessibilityLabel,
  frequencyChipLabel,
  kindPresentation,
  transcriptPreview,
  type WaveformData,
} from './history-model';

/** Runs a write, reloads on success and reports whether it succeeded. */
export type HistoryMutation = (
  path: string,
  method: string,
  body?: unknown,
  success?: string,
) => Promise<boolean>;

export interface CommunicationRowProps {
  item: Communication;
  session: ClientSession;
  timeZone: string;
  /** `history.write` on the item's radio (or administrator). */
  canWrite: boolean;
  /** Retention holds and deletion are administrator-only. */
  isAdministrator: boolean;
  waveforms: WaveformLoader;
  onMutate: HistoryMutation;
  /** Radio name, shown when the timeline spans several radios. */
  radioLabel?: string;
}

/** One timeline entry: icon, time, waveform, frequency, transcript, actions. */
export const CommunicationRow = memo(function CommunicationRow({
  item,
  session,
  timeZone,
  canWrite,
  isAdministrator,
  waveforms,
  onMutate,
  radioLabel,
}: CommunicationRowProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const kind = kindPresentation(item);
  const latest = item.transcripts.at(-1);
  const durationMs = communicationDurationMs(item);
  const playable = item.recording?.state === 'available';
  const [editing, setEditing] = useState(false),
    [text, setText] = useState(''),
    [saving, setSaving] = useState(false),
    [menu, setMenu] = useState<'closed' | 'actions' | 'provenance'>('closed'),
    [confirmDelete, setConfirmDelete] = useState(false),
    [expanded, setExpanded] = useState(false),
    [waveform, setWaveform] = useState<WaveformData | null | undefined>(
      undefined,
    );

  // Switching between the action list and provenance replaces the focused
  // button: move focus to the sheet title instead of losing it.
  const sheetTitle = useRef<FocusTarget>(null);
  useEffect(() => {
    if (menu === 'closed') return;
    const timer = setTimeout(() => moveFocus(sheetTitle.current), 0);
    return () => clearTimeout(timer);
  }, [menu]);

  useEffect(() => {
    if (!playable) return;
    let current = true;
    void waveforms.load(item.id).then((data) => {
      if (current) setWaveform(data);
    });
    return () => {
      current = false;
    };
  }, [waveforms, item.id, playable]);

  const time = formatClock(Date.parse(item.startedAt), timeZone);
  const frequency = frequencyChipLabel(item.frequencyHz);
  const preview = latest ? transcriptPreview(latest.text) : undefined;
  const hasActions = item.transcripts.length > 0 || canWrite || isAdministrator;
  const summary = `${kind.label} · ${frequency} · ${time}`;

  function startEditing() {
    setMenu('closed');
    setText(latest?.text ?? '');
    setEditing(true);
  }
  async function saveRevision() {
    setSaving(true);
    try {
      const saved = await onMutate(
        `communications/${item.id}/transcripts`,
        'POST',
        { expectedRevision: item.revision, text },
        'Transcript revision saved.',
      );
      if (saved) setEditing(false);
    } finally {
      setSaving(false);
    }
  }
  function toggleHold() {
    setMenu('closed');
    void onMutate(
      `communications/${item.id}`,
      'PATCH',
      { expectedRevision: item.revision, retentionHold: !item.retentionHold },
      item.retentionHold ? 'Retention hold released.' : 'Retention hold set.',
    );
  }

  return (
    <View style={styles.row}>
      <Text style={styles.time}>{time}</Text>
      <View
        style={[styles.direction, kind.transmit && styles.directionTx]}
        accessible
        accessibilityRole="image"
        accessibilityLabel={kind.label}
      >
        <Icon
          name={kind.icon}
          size={14}
          color={kind.transmit ? colors.error : colors.textSecondary}
        />
      </View>
      <View style={styles.body}>
        <View style={styles.lead}>
          <View style={styles.leadMain}>
            {playable ? (
              <Waveform
                peaks={waveform?.peaks}
                durationMs={waveform?.durationMs || durationMs}
                transmit={kind.transmit}
                loading={waveform === undefined}
              />
            ) : (
              <Meta
                item={item}
                kind={kind.label}
                durationMs={durationMs}
                radioLabel={radioLabel}
              />
            )}
          </View>
          {hasActions && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Actions for ${summary}`}
              hitSlop={6}
              onPress={() => setMenu('actions')}
              style={styles.more}
            >
              <Icon name="more" size={18} color={colors.textSecondary} />
            </Pressable>
          )}
        </View>
        {playable && (
          <Meta
            item={item}
            kind={kind.label}
            durationMs={durationMs}
            radioLabel={radioLabel}
          />
        )}

        {latest && preview ? (
          <View style={styles.transcript}>
            <Text selectable style={styles.transcriptText}>
              {latest.text
                ? expanded
                  ? latest.text
                  : preview.text
                : '(Empty transcript)'}
            </Text>
            <View style={styles.transcriptMeta}>
              <Text style={styles.caption}>
                Transcript v{latest.revision} ·{' '}
                {latest.source === 'human'
                  ? 'corrected by operator'
                  : 'automatic'}
                {latest.language ? ` · ${latest.language}` : ''}
              </Text>
              {preview.truncated && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  accessibilityLabel={
                    expanded ? 'Show less transcript' : 'Show full transcript'
                  }
                  hitSlop={8}
                  onPress={() => setExpanded(!expanded)}
                  style={styles.inlineLink}
                >
                  <Text style={styles.link}>
                    {expanded ? 'Show less' : 'Show more'}
                  </Text>
                </Pressable>
              )}
            </View>
          </View>
        ) : (
          item.kind !== 'note' && (
            <Text style={styles.caption}>No transcript available.</Text>
          )
        )}

        {item.notes.map((note, index) => (
          <Text
            selectable
            key={index}
            style={item.kind === 'note' ? styles.noteMain : styles.note}
          >
            {note}
          </Text>
        ))}

        {!!item.tags.length && (
          <ChipGroup accessibilityLabel="Tags">
            {item.tags.map((tag) => (
              <Chip key={tag} label={`#${tag}`} />
            ))}
          </ChipGroup>
        )}

        {item.recording && (
          <RecordingPlayer
            key={`${session.instanceId}:${session.accessToken}:${item.recording.id}`}
            session={session}
            recording={item.recording}
          />
        )}

        {editing && (
          <View style={styles.editor}>
            <Text style={styles.label}>
              {latest ? 'Correct transcript' : 'Add transcript'}
            </Text>
            <TextInput
              accessibilityLabel="Transcript correction"
              autoFocus
              multiline
              value={text}
              onChangeText={setText}
              style={styles.input}
            />
            <Text style={styles.caption}>
              Saving adds a new revision; earlier revisions stay in the
              provenance.
            </Text>
            <View style={styles.actionsRow}>
              <Button
                variant="primary"
                label="Save new revision"
                loading={saving}
                onPress={() => void saveRevision()}
              />
              <Button
                variant="quiet"
                label="Cancel"
                disabled={saving}
                onPress={() => setEditing(false)}
              />
            </View>
          </View>
        )}
      </View>

      <Overlay
        visible={menu !== 'closed'}
        onClose={() => setMenu('closed')}
        accessibilityLabel={
          menu === 'provenance'
            ? `Transcript provenance for ${summary}`
            : `Actions for ${summary}`
        }
        maxWidth={layout.form}
      >
        <Text
          ref={(node) => {
            sheetTitle.current = node as FocusTarget;
          }}
          accessibilityRole="header"
          {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})}
          style={styles.sheetTitle}
        >
          {menu === 'provenance' ? 'Transcript provenance' : summary}
        </Text>
        {menu === 'provenance' ? (
          <>
            <ScrollView
              style={styles.provenance}
              contentContainerStyle={styles.provenanceContent}
            >
              {[...item.transcripts].reverse().map((revision) => (
                <View key={revision.id} style={styles.revision}>
                  <Text style={styles.label}>
                    v{revision.revision} ·{' '}
                    {revision.source === 'human' ? 'Operator' : 'Provider'}
                    {revision.language ? ` · ${revision.language}` : ''}
                  </Text>
                  <Text style={styles.caption}>
                    {new Date(revision.createdAt).toLocaleString()}
                  </Text>
                  <Text selectable style={styles.transcriptText}>
                    {revision.text || '(Empty transcript)'}
                  </Text>
                  <Text selectable style={styles.mono}>
                    {JSON.stringify(revision.provenance)}
                  </Text>
                </View>
              ))}
            </ScrollView>
            <View style={styles.actionsRow}>
              <Button label="Back" onPress={() => setMenu('actions')} />
              <Button
                variant="quiet"
                label="Close"
                onPress={() => setMenu('closed')}
              />
            </View>
          </>
        ) : (
          <View style={styles.menu}>
            {item.transcripts.length > 0 && (
              <MenuItem
                icon="history"
                label="Transcript provenance"
                detail={`${item.transcripts.length} revision${item.transcripts.length === 1 ? '' : 's'}`}
                onPress={() => setMenu('provenance')}
              />
            )}
            {canWrite && (
              <MenuItem
                icon="note"
                label={latest ? 'Correct transcript' : 'Add transcript'}
                onPress={startEditing}
              />
            )}
            {isAdministrator && (
              <MenuItem
                icon="lock"
                label={item.retentionHold ? 'Release hold' : 'Hold retention'}
                detail={
                  item.retentionHold
                    ? 'Retention hold active'
                    : 'Keep this communication past retention'
                }
                onPress={toggleHold}
              />
            )}
            {isAdministrator && (
              <MenuItem
                icon="trash"
                label="Delete"
                destructive
                disabled={item.retentionHold}
                detail={
                  item.retentionHold
                    ? 'Release the retention hold before deleting.'
                    : 'Permanently removes the recording and transcripts'
                }
                onPress={() => {
                  setMenu('closed');
                  setConfirmDelete(true);
                }}
              />
            )}
            <Button
              variant="quiet"
              label="Close"
              onPress={() => setMenu('closed')}
            />
          </View>
        )}
      </Overlay>

      <ConfirmDialog
        visible={confirmDelete}
        title="Delete communication?"
        message={`${summary} will be permanently deleted, including its recording, transcripts and notes. This cannot be undone.`}
        confirmLabel="Confirm permanent deletion"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          if (!isAdministrator || item.retentionHold) return;
          void onMutate(
            `communications/${item.id}`,
            'DELETE',
            undefined,
            'Communication deleted.',
          );
        }}
      />
    </View>
  );
});

function Meta({
  item,
  kind,
  durationMs,
  radioLabel,
}: {
  item: Communication;
  kind: string;
  durationMs: number;
  radioLabel?: string | undefined;
}) {
  const styles = useStyles();
  const unconfirmed = item.frequencyAttribution !== 'confirmed';
  return (
    <View style={styles.meta}>
      <Chip
        label={frequencyChipLabel(item.frequencyHz)}
        monospace
        dashed={unconfirmed}
        tone={item.frequencyAttribution === 'unknown' ? 'warning' : 'neutral'}
        accessibilityLabel={frequencyAccessibilityLabel(
          item.frequencyHz,
          item.frequencyAttribution,
        )}
      />
      {unconfirmed && (
        <Text style={styles.warning}>
          {item.frequencyAttribution === 'inferred' ? 'Inferred' : 'Unknown'}{' '}
          source
        </Text>
      )}
      {item.kind !== 'note' && (
        <Text style={styles.caption}>{formatDuration(durationMs)}</Text>
      )}
      <Text style={styles.caption}>{kind}</Text>
      {!!radioLabel && <Text style={styles.caption}>{radioLabel}</Text>}
      {item.kind !== 'note' && item.notes.length > 0 && (
        <Text style={styles.caption}>
          {item.notes.length} note{item.notes.length === 1 ? '' : 's'}
        </Text>
      )}
      {item.retentionHold && (
        <Badge label="Retention hold" tone="warning" icon="lock" />
      )}
    </View>
  );
}

function MenuItem({
  icon,
  label,
  detail,
  destructive = false,
  disabled = false,
  onPress,
}: {
  icon: IconName;
  label: string;
  detail?: string;
  destructive?: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const color = destructive ? colors.error : colors.textPrimary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={detail ? `${label}. ${detail}` : label}
      disabled={disabled}
      onPress={onPress}
      style={styles.menuItem}
    >
      <Icon name={icon} size={18} color={color} />
      <View style={styles.menuText}>
        <Text style={[styles.label, { color }]}>{label}</Text>
        {!!detail && <Text style={styles.caption}>{detail}</Text>}
      </View>
    </Pressable>
  );
}

const useStyles = createStyles((c) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
    paddingVertical: space.md,
    borderTopWidth: 1,
    borderColor: c.border,
  },
  time: {
    ...type.caption,
    width: 44,
    paddingTop: 5,
    color: c.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  direction: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.surfaceElevated,
    borderWidth: 1,
    borderColor: c.surfaceElevated,
  },
  directionTx: { borderColor: c.error, backgroundColor: c.surface },
  body: { flex: 1, minWidth: 0, gap: space.sm },
  lead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  leadMain: { flex: 1, minWidth: 0, minHeight: 28, justifyContent: 'center' },
  more: {
    width: 36,
    minHeight: 36,
    height: 36,
    marginTop: -4,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  meta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
  },
  caption: { ...type.caption, color: c.textSecondary },
  warning: { ...type.caption, color: c.warning },
  label: { ...type.label, color: c.textPrimary },
  transcript: { gap: space.xs },
  transcriptText: {
    ...type.body,
    fontSize: 14,
    lineHeight: 21,
    color: c.textPrimary,
  },
  transcriptMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
  },
  inlineLink: { minHeight: 24, borderRadius: radius.sm },
  link: { ...type.caption, fontWeight: '600', color: c.primary },
  note: {
    ...type.body,
    fontSize: 14,
    lineHeight: 21,
    color: c.textPrimary,
    paddingLeft: space.md,
    borderLeftWidth: 2,
    borderColor: c.border,
  },
  noteMain: {
    ...type.body,
    fontSize: 14,
    lineHeight: 21,
    color: c.textPrimary,
  },
  editor: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: c.surfaceElevated,
  },
  input: {
    ...type.body,
    color: c.textPrimary,
    minHeight: 96,
    textAlignVertical: 'top',
    backgroundColor: c.surface,
    borderColor: c.inputBorder,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.md,
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
  },
  sheetTitle: { ...type.heading, color: c.textPrimary },
  menu: { gap: space.xs },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  menuText: { flex: 1, minWidth: 0, gap: 2 },
  provenance: { maxHeight: 420, backgroundColor: c.surface },
  provenanceContent: { gap: space.md },
  revision: {
    gap: space.xs,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderColor: c.border,
  },
  mono: {
    ...type.caption,
    fontFamily: type.frequency.fontFamily,
    color: c.textSecondary,
  },
}));
