import { apiRequest } from '@signaldock/client-sdk';
import type {
  Communication,
  Conversation,
  FeatureScreenProps,
} from '@signaldock/contracts';
import {
  Button,
  Disclosure,
  ScrollView,
  Text,
  TextInput,
  space as uiSpace,
  useFeatureStyles,
  useTheme,
} from '@signaldock/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, View } from 'react-native';
import RecordingPlayer from './RecordingPlayer';

type Page = {
  items: Communication[];
  nextCursor?: { id: string; startedAt: string };
};
export function HistoryScreen(props: FeatureScreenProps) {
  return (
    <HistoryWorkspace
      key={`${props.session.baseUrl}:${props.session.instanceId}:${props.session.user.id}:${props.session.accessToken}`}
      {...props}
    />
  );
}
function HistoryWorkspace({ session, radioId }: FeatureScreenProps) {
  const { colors } = useTheme();
  const styles = useFeatureStyles('history');
  const [page, setPage] = useState<Page>({ items: [] }),
    [conversations, setConversations] = useState<Conversation[]>([]),
    [conversation, setConversation] = useState<Conversation | null>(null);
  const [search, setSearch] = useState(''),
    [appliedSearch, setAppliedSearch] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [newNote, setNewNote] = useState('');
  const request = useRef({ generation: 0, controller: new AbortController() });
  const load = useCallback(
    async (append = false) => {
      request.current.controller.abort();
      const current = {
        generation: request.current.generation + 1,
        controller: new AbortController(),
      };
      request.current = current;
      setBusy(true);
      setError('');
      const params = new URLSearchParams({ limit: '30' });
      if (conversation) params.set('conversationId', conversation.id);
      const selectedRadio = conversation?.radioId ?? radioId;
      if (selectedRadio) params.set('radioId', selectedRadio);
      if (conversation?.frequencyHz)
        params.set('frequencyHz', String(conversation.frequencyHz));
      if (appliedSearch) params.set('search', appliedSearch);
      if (append && page.nextCursor) {
        params.set('beforeId', page.nextCursor.id);
        params.set('beforeStartedAt', page.nextCursor.startedAt);
      }
      try {
        const [data, groups] = await Promise.all([
          apiRequest<Page>(
            session,
            `communications?${params.toString().replace(/\+/g, '%20')}`,
            {
              signal: current.controller.signal,
            },
          ),
          apiRequest<{ items: Conversation[] }>(session, 'conversations', {
            signal: current.controller.signal,
          }),
        ]);
        if (request.current.generation !== current.generation) return;
        const filtered = data.items;
        setPage((prior) => ({
          ...data,
          items: append
            ? [
                ...prior.items,
                ...filtered.filter(
                  (item) =>
                    !prior.items.some((existing) => existing.id === item.id),
                ),
              ]
            : filtered,
        }));
        setConversations(groups.items);
      } catch (failure) {
        if (!current.controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : 'History could not be loaded.',
          );
      } finally {
        if (request.current.generation === current.generation) setBusy(false);
      }
    },
    [session, radioId, conversation, appliedSearch, page.nextCursor],
  );
  // Page cursors never restart first-page loading; only source/filter changes do.
  useEffect(() => {
    setPage({ items: [] });
    setConversations([]);
    void load();
    return () => {
      request.current.controller.abort();
      request.current.generation++;
    };
  }, [
    session.baseUrl,
    session.instanceId,
    session.accessToken,
    radioId,
    conversation?.id,
    appliedSearch,
  ]);
  function canWrite(radio: string) {
    return (
      session.user.role === 'administrator' ||
      session.user.radioPermissions.some(
        (grant) =>
          grant.radioId === radio &&
          grant.permissions.includes('history.write'),
      )
    );
  }
  async function mutate(path: string, method: string, body?: unknown) {
    setError('');
    try {
      await apiRequest(session, path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      await load();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'The change could not be saved.',
      );
    }
  }
  async function saveNote() {
    const selected = conversation?.radioId ?? radioId;
    if (!selected || !newNote.trim()) return;
    await mutate('communications/notes', 'POST', {
      radioId: selected,
      text: newNote.trim(),
      ...(conversation?.frequencyHz
        ? { frequencyHz: conversation.frequencyHz }
        : {}),
    });
    setNewNote('');
  }
  return (
    <FlatList
      data={page.items}
      keyExtractor={(item) => `${session.instanceId}:${item.id}`}
      renderItem={({ item }) => (
        <CommunicationCard
          item={item}
          session={session}
          canWrite={canWrite(item.radioId)}
          onMutate={mutate}
        />
      )}
      style={styles.screen}
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={styles.section}>
          <View style={styles.row}>
            <View style={{ flex: 1, gap: uiSpace.sm }}>
              <Text style={styles.eyebrow}>Station archive</Text>
              <Text accessibilityRole="header" style={styles.title}>
                Communications
              </Text>
              <Text style={styles.muted}>
                Audio, transcripts, and notes grouped by their recorded source.
              </Text>
            </View>
            <Button
              label="Refresh"
              onPress={() => void load()}
              disabled={busy}
            />
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filters}
          >
            <Button
              label="All frequencies"
              onPress={() => setConversation(null)}
              active={!conversation}
            />
            {conversations
              .filter((group) => !radioId || group.radioId === radioId)
              .map((group) => (
                <Button
                  key={group.id}
                  label={`${frequency(group.frequencyHz)} · ${group.radioId.slice(0, 6)}`}
                  onPress={() => setConversation(group)}
                  active={conversation?.id === group.id}
                />
              ))}
          </ScrollView>
          <View style={styles.row}>
            <TextInput
              accessibilityLabel="Search transcripts and notes"
              placeholder="Search transcripts, tags, or notes"
              value={search}
              onChangeText={setSearch}
              onSubmitEditing={() => setAppliedSearch(search)}
              style={[styles.input, { flex: 1 }]}
            />
            <Button label="Search" onPress={() => setAppliedSearch(search)} />
          </View>
          {!!error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          {busy && <ActivityIndicator color={colors.primary} />}
          {(conversation?.radioId ?? radioId) &&
            canWrite((conversation?.radioId ?? radioId)!) && (
              <Disclosure title="Add station note">
                <TextInput
                  accessibilityLabel="New station note"
                  placeholder="Add a note for this radio and frequency"
                  multiline
                  value={newNote}
                  onChangeText={setNewNote}
                  style={styles.input}
                />
                <Button
                  label="Add note"
                  onPress={() => void saveNote()}
                  disabled={!newNote.trim()}
                />
              </Disclosure>
            )}
          {!busy && !page.items.length && (
            <View style={styles.empty}>
              <Text accessibilityRole="header" style={styles.heading}>
                No communications yet
              </Text>
              <Text style={styles.muted}>
                Recordings appear when the connected radio receives or
                transmits. Only the tuned frequency is monitored.
              </Text>
            </View>
          )}
        </View>
      }
      ListFooterComponent={
        <>
          {!!page.nextCursor && (
            <Button
              label="Load earlier communications"
              onPress={() => void load(true)}
              disabled={busy}
            />
          )}
        </>
      }
    />
  );
}
export default HistoryScreen;

function CommunicationCard({
  item,
  session,
  canWrite,
  onMutate,
}: {
  item: Communication;
  session: FeatureScreenProps['session'];
  canWrite: boolean;
  onMutate: (path: string, method: string, body?: unknown) => Promise<void>;
}) {
  const styles = useFeatureStyles('history');
  const [editing, setEditing] = useState(false),
    [text, setText] = useState(''),
    [confirmDelete, setConfirmDelete] = useState(false),
    [revisions, setRevisions] = useState(false);
  const latest = item.transcripts.at(-1);
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Text accessibilityRole="header" style={styles.heading}>
          {item.direction.toUpperCase()} · {frequency(item.frequencyHz)}
        </Text>
        <Text
          style={[
            styles.badge,
            item.frequencyAttribution !== 'confirmed' && styles.uncertain,
          ]}
        >
          {item.frequencyAttribution} source
        </Text>
      </View>
      <Text style={styles.muted}>
        {new Date(item.startedAt).toLocaleString()} ·{' '}
        {Math.max(
          0,
          (Date.parse(item.endedAt) - Date.parse(item.startedAt)) / 1000,
        ).toFixed(1)}{' '}
        s · Radio {item.radioId.slice(0, 8)}
      </Text>
      {item.recording && (
        <RecordingPlayer
          key={`${session.instanceId}:${session.accessToken}:${item.recording.id}`}
          session={session}
          recording={item.recording}
        />
      )}
      {latest ? (
        <View style={styles.transcript}>
          <Text selectable style={styles.body}>
            {latest.text || '(Empty transcript)'}
          </Text>
          <Text style={styles.muted}>
            Transcript v{latest.revision} · {latest.source}
            {latest.language ? ` · ${latest.language}` : ''}
          </Text>
          <Button
            label={revisions ? 'Hide revisions' : 'Transcript provenance'}
            onPress={() => setRevisions(!revisions)}
          />
          {revisions &&
            item.transcripts.map((revision) => (
              <View key={revision.id} style={{ gap: uiSpace.sm }}>
                <Text style={styles.body}>
                  v{revision.revision}: {revision.text}
                </Text>
                <Text selectable style={styles.muted}>
                  {new Date(revision.createdAt).toLocaleString()} ·{' '}
                  {JSON.stringify(revision.provenance)}
                </Text>
              </View>
            ))}
        </View>
      ) : (
        item.kind !== 'note' && (
          <Text style={styles.muted}>No transcript available.</Text>
        )
      )}
      {item.notes.map((note, index) => (
        <Text selectable key={index} style={styles.body}>
          {note}
        </Text>
      ))}
      {!!item.tags.length && (
        <Text style={styles.muted}>
          {item.tags.map((tag) => `#${tag}`).join('  ')}
        </Text>
      )}
      {item.retentionHold && (
        <Text style={styles.uncertain}>Retention hold active</Text>
      )}
      {canWrite && (
        <Button
          label={editing ? 'Cancel edit' : 'Add / correct transcript'}
          onPress={() => {
            setText(latest?.text ?? '');
            setEditing(!editing);
          }}
        />
      )}
      {editing && (
        <View style={{ gap: uiSpace.md }}>
          <TextInput
            accessibilityLabel="Transcript correction"
            multiline
            value={text}
            onChangeText={setText}
            style={styles.input}
          />
          <Button
            label="Save new revision"
            onPress={() => {
              void onMutate(`communications/${item.id}/transcripts`, 'POST', {
                expectedRevision: item.revision,
                text,
              }).then(() => setEditing(false));
            }}
          />
        </View>
      )}
      {session.user.role === 'administrator' && (
        <View style={styles.row}>
          <Button
            label={item.retentionHold ? 'Release hold' : 'Hold retention'}
            onPress={() =>
              void onMutate(`communications/${item.id}`, 'PATCH', {
                expectedRevision: item.revision,
                retentionHold: !item.retentionHold,
              })
            }
          />
          <Button
            label={confirmDelete ? 'Confirm permanent deletion' : 'Delete'}
            onPress={() => {
              if (confirmDelete)
                void onMutate(`communications/${item.id}`, 'DELETE');
              else setConfirmDelete(true);
            }}
            disabled={item.retentionHold}
          />
          {confirmDelete && (
            <Button label="Cancel" onPress={() => setConfirmDelete(false)} />
          )}
        </View>
      )}
    </View>
  );
}
function frequency(hz?: number) {
  return hz === undefined
    ? 'Unknown frequency'
    : `${(hz / 1e6).toFixed(4)} MHz`;
}
