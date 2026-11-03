import type { ClientSession } from '@signaldock/contracts';
import {
  Badge,
  Button,
  ConfirmDialog,
  Disclosure,
  Heading,
  Icon,
  Pressable,
  Text,
  TextInput,
  radius,
  space,
  type,
  useTheme,
} from '@signaldock/ui';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { moveFocus, type FocusTarget } from '../../shared/accessibility';
import RecordingPlayer from '../history/RecordingPlayer';
import { formatFrequency } from '../station/station-model';
import type { IncidentCardInfo } from './IncidentBoard';
import type {
  EvidenceSource,
  IncidentDetailView,
} from './data/incident-client';
import {
  DECISION_NOTE_MAX,
  STATE_LABELS,
  attributionSuffix,
  evidenceCountLabel,
  formatIncidentAge,
  priorityPresentation,
  transitionActions,
  type TransitionAction,
} from './incident-model';

/** Loaded source, still loading, or failed (with the reason). */
export type EvidenceSourceState =
  | { status: 'loading' }
  | { status: 'ready'; source: EvidenceSource }
  | { status: 'error'; error: string };

export interface IncidentDetailProps {
  session: ClientSession;
  detail: IncidentDetailView;
  info: IncidentCardInfo;
  sources: Readonly<Record<string, EvidenceSourceState>>;
  now: number;
  busy: boolean;
  error: string;
  onClose: () => void;
  onTransition: (action: TransitionAction) => void;
  onAssignToMe: () => void;
  onRetentionHold: (hold: boolean) => void;
  /** Resolves true when the note was saved. */
  onSaveNote: (note: string) => Promise<boolean>;
  onSelectRadio?: (() => void) | undefined;
}

/** Incident detail: moves, ownership, playable evidence and history. */
export function IncidentDetail({
  session,
  detail,
  info,
  sources,
  now,
  busy,
  error,
  onClose,
  onTransition,
  onAssignToMe,
  onRetentionHold,
  onSaveNote,
  onSelectRadio,
}: IncidentDetailProps) {
  const { colors } = useTheme();
  const { incident } = detail;
  const [note, setNote] = useState('');
  const [confirmRelease, setConfirmRelease] = useState(false);
  const heading = useRef<FocusTarget>(null);
  useEffect(() => {
    setNote('');
    setConfirmRelease(false);
    // Opening an incident (which may replace the board) moves focus here.
    moveFocus(heading.current);
  }, [incident.id]);
  const priority = priorityPresentation(incident.priority);
  const actions = info.canManage ? transitionActions(incident.state) : [];
  const mine = incident.ownerUserId === session.user.id;
  const caption = [type.caption, { color: colors.textSecondary }];
  return (
    <View
      accessibilityLabel={`Incident ${incident.title}`}
      style={{
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        padding: space.lg,
        gap: space.lg,
      }}
    >
      <View style={{ gap: space.sm }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: space.sm,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: space.sm,
              flexShrink: 1,
            }}
          >
            <Badge
              label={`${priority.glyph} ${priority.label}`}
              tone={priority.tone}
            />
            <Badge label={STATE_LABELS[incident.state]} />
            {incident.retentionHold && (
              <Badge label="Evidence held" icon="lock" tone="primary" />
            )}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close incident details"
            onPress={onClose}
            style={{ width: 48, alignItems: 'center' }}
          >
            <Icon name="close" size={20} color={colors.textSecondary} />
          </Pressable>
        </View>
        <Heading
          ref={(node) => {
            heading.current = node as FocusTarget;
          }}
          selectable
          {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})}
        >
          {incident.title}
        </Heading>
        <Text style={caption}>
          {info.radioName}
          {info.frequencyHz !== undefined
            ? ` · ${formatFrequency(info.frequencyHz)} MHz${attributionSuffix(info.frequencyAttribution)}`
            : ''}
          {' · opened '}
          {formatIncidentAge(incident.createdAt, now)}
          {formatIncidentAge(incident.createdAt, now) === 'just now'
            ? ''
            : ' ago'}
          {' · '}
          {evidenceCountLabel(incident.evidence.length)}
        </Text>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: space.sm,
          }}
        >
          <Icon name="user" size={16} color={colors.textSecondary} />
          <Text style={[type.caption, { color: colors.textPrimary }]}>
            {info.owner ? info.owner.label : 'Unassigned'}
          </Text>
          <Text style={caption}>· Revision {incident.revision}</Text>
        </View>
      </View>

      {actions.length > 0 && (
        <View style={{ gap: space.sm }}>
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}
          >
            {actions.map((action) => (
              <Button
                key={action.target}
                label={action.needsNote ? `${action.label}…` : action.label}
                variant={action.variant}
                disabled={busy}
                onPress={() => onTransition(action)}
              />
            ))}
          </View>
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}
          >
            {!mine && (
              <Button
                label="Assign to me"
                variant="quiet"
                disabled={busy}
                onPress={onAssignToMe}
              />
            )}
            <Button
              label={
                incident.retentionHold
                  ? 'Release evidence hold'
                  : 'Hold evidence'
              }
              variant="quiet"
              disabled={busy}
              onPress={() => {
                if (incident.retentionHold) setConfirmRelease(true);
                else onRetentionHold(true);
              }}
            />
            {onSelectRadio && (
              <Button
                label="Select source radio"
                variant="quiet"
                disabled={busy}
                onPress={onSelectRadio}
              />
            )}
          </View>
        </View>
      )}
      {!info.canManage && onSelectRadio && (
        <Button
          label="Select source radio"
          variant="quiet"
          onPress={onSelectRadio}
        />
      )}
      {busy && (
        <ActivityIndicator
          accessibilityLabel="Saving incident"
          color={colors.primary}
        />
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      )}

      <View style={{ gap: space.md }}>
        <Heading>Evidence</Heading>
        {incident.evidence.length === 0 && (
          <Text style={caption}>No source evidence is attached.</Text>
        )}
        {incident.evidence.map((entry, index) => (
          <EvidenceClip
            key={`${entry.communicationId}:${entry.transcriptRevisionId ?? ''}:${index}`}
            session={session}
            quote={entry.quote}
            transcriptRevisionId={entry.transcriptRevisionId}
            state={sources[entry.communicationId]}
          />
        ))}
        <Text style={caption}>
          Callsigns and spoken locations are candidates; they do not
          authenticate the speaker or confirm a geographic position.
        </Text>
      </View>

      {info.canManage && (
        <Disclosure title="Add operator note">
          <TextInput
            accessibilityLabel="Operator note"
            placeholder="Note for the incident history"
            value={note}
            onChangeText={setNote}
            editable={!busy}
            maxLength={DECISION_NOTE_MAX}
            multiline
            style={{ minHeight: 72 }}
          />
          <Button
            label="Save note"
            disabled={busy || !note.trim()}
            onPress={() => {
              void onSaveNote(note.trim()).then((saved) => {
                if (saved) setNote('');
              });
            }}
          />
        </Disclosure>
      )}

      <View style={{ gap: space.sm }}>
        <Heading>History</Heading>
        {detail.actions.length === 0 && (
          <Text style={caption}>No operator actions yet.</Text>
        )}
        {detail.actions.map((action) => (
          <View
            key={action.id}
            style={{
              borderLeftWidth: 2,
              borderLeftColor: colors.border,
              paddingLeft: space.md,
              gap: space.xs,
            }}
          >
            <Text style={caption}>
              {action.kind.replaceAll('_', ' ')} ·{' '}
              {new Date(action.occurredAt).toLocaleString()}
              {action.actorUserId === session.user.id ? ' · you' : ''}
            </Text>
            {!!action.note && (
              <Text
                selectable
                style={[type.body, { color: colors.textPrimary }]}
              >
                {action.note}
              </Text>
            )}
          </View>
        ))}
      </View>

      {detail.assessments.length > 0 && (
        <Disclosure title="Assessments and provenance">
          {detail.assessments.map((assessment) => (
            <View key={assessment.id} style={{ gap: space.xs }}>
              <Text style={caption}>
                {assessment.connectorId} ·{' '}
                {new Date(assessment.createdAt).toLocaleString()}
              </Text>
              <Text
                selectable
                style={[
                  type.caption,
                  {
                    color: colors.textPrimary,
                    fontFamily: type.frequency.fontFamily,
                  },
                ]}
              >
                {JSON.stringify(assessment.result, null, 2)}
              </Text>
            </View>
          ))}
        </Disclosure>
      )}
      <ConfirmDialog
        visible={confirmRelease}
        title="Release evidence hold?"
        message="The source recordings and transcripts can then be removed by normal retention. The incident record stays."
        confirmLabel="Release hold"
        onCancel={() => setConfirmRelease(false)}
        onConfirm={() => {
          setConfirmRelease(false);
          onRetentionHold(false);
        }}
      />
    </View>
  );
}

function EvidenceClip({
  session,
  quote,
  transcriptRevisionId,
  state,
}: {
  session: ClientSession;
  quote: string | undefined;
  transcriptRevisionId: string | undefined;
  state: EvidenceSourceState | undefined;
}) {
  const { colors } = useTheme();
  const source = state?.status === 'ready' ? state.source : undefined;
  const transcript = source?.transcripts.find(
    (entry) => entry.id === transcriptRevisionId,
  )?.text;
  const showTranscript =
    !!transcript && transcript.trim() !== (quote ?? '').trim();
  return (
    <View
      style={{
        gap: space.sm,
        padding: space.md,
        borderRadius: radius.md,
        backgroundColor: colors.surfaceElevated,
      }}
    >
      <View
        style={{
          borderLeftWidth: 3,
          borderLeftColor: colors.primary,
          paddingLeft: space.md,
        }}
      >
        <Text
          selectable
          style={[
            type.body,
            {
              color: colors.textPrimary,
              fontStyle: quote ? 'italic' : 'normal',
            },
          ]}
        >
          {quote
            ? `“${quote}”`
            : 'Source reference retained without a text quote.'}
        </Text>
      </View>
      {showTranscript && (
        <Text
          selectable
          style={[type.caption, { color: colors.textSecondary }]}
        >
          Transcript: {transcript}
        </Text>
      )}
      {source && (
        <Text style={[type.caption, { color: colors.textSecondary }]}>
          {new Date(source.startedAt).toLocaleString()}
          {source.frequencyHz !== undefined
            ? ` · ${formatFrequency(source.frequencyHz)} MHz${attributionSuffix(
                source.frequencyAttribution,
              )}`
            : ''}
        </Text>
      )}
      {state === undefined || state.status === 'loading' ? (
        <ActivityIndicator
          accessibilityLabel="Loading source clip"
          color={colors.primary}
        />
      ) : state.status === 'error' ? (
        <Text style={[type.caption, { color: colors.warning }]}>
          Source clip unavailable: {state.error}
        </Text>
      ) : state.source.recording ? (
        <RecordingPlayer session={session} recording={state.source.recording} />
      ) : (
        <Text style={[type.caption, { color: colors.textSecondary }]}>
          No recording was kept for this communication.
        </Text>
      )}
    </View>
  );
}
