import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type {
  FeatureScreenProps,
  IncidentRecord,
  IncidentState,
} from '@signaldock/contracts';
import {
  IncidentClient,
  type IncidentDetailView,
  type RuleSummary,
} from './data/incident-client';

const states: readonly IncidentState[] = [
  'new',
  'acknowledged',
  'in_progress',
  'resolved',
  'dismissed',
];
const nextStates: Record<IncidentState, readonly IncidentState[]> = {
  new: ['acknowledged', 'in_progress', 'resolved', 'dismissed'],
  acknowledged: ['in_progress', 'resolved', 'dismissed'],
  in_progress: ['resolved', 'dismissed'],
  resolved: ['acknowledged'],
  dismissed: ['acknowledged'],
};
const label = (state: string) => state.replaceAll('_', ' ');
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The request failed.';

function ActionButton({
  title,
  onPress,
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && styles.disabled]}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

export function IncidentsScreen({
  session,
  radioId,
  onSelectRadio,
}: FeatureScreenProps) {
  const client = useMemo(
    () => new IncidentClient(session),
    [
      session.baseUrl,
      session.instanceId,
      session.accessToken,
      session.onUnauthorized,
    ],
  );
  const [filter, setFilter] = useState<IncidentState | undefined>();
  const [records, setRecords] = useState<IncidentRecord[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [detail, setDetail] = useState<IncidentDetailView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [ruleRows, setRuleRows] = useState<RuleSummary[] | null>(null);
  const [ruleName, setRuleName] = useState('');
  const [rulePhrases, setRulePhrases] = useState('');
  const [minHz, setMinHz] = useState('');
  const [maxHz, setMaxHz] = useState('');
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const canManage = detail
    ? session.user.radioPermissions.some(
        (grant) =>
          grant.radioId === detail.incident.radioId &&
          grant.permissions.includes('incident.manage'),
      )
    : false;

  useEffect(() => {
    generation.current++;
    const current = generation.current;
    request.current?.abort();
    detailRequest.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setRecords([]);
    setCursor(undefined);
    setDetail(null);
    setRuleRows(null);
    setNote('');
    setError('');
    setSaving(false);
    setLoading(true);
    void client
      .list(
        {
          ...(radioId ? { radioId } : {}),
          ...(filter ? { state: filter } : {}),
        },
        controller.signal,
      )
      .then((page) => {
        if (current === generation.current) {
          setRecords(page.items);
          setCursor(page.nextCursor);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted && current === generation.current)
          setError(message(failure));
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
      controller.abort();
      detailRequest.current?.abort();
    };
  }, [client, radioId, filter, refresh]);

  async function openIncident(id: string) {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    const current = generation.current;
    setError('');
    setNote('');
    try {
      const response = await client.detail(id, controller.signal);
      if (current === generation.current && !controller.signal.aborted)
        setDetail(response);
    } catch (failure) {
      if (current === generation.current && !controller.signal.aborted)
        setError(message(failure));
    }
  }

  async function update(input: {
    state?: IncidentState;
    retentionHold?: boolean;
    ownerUserId?: string | null;
  }) {
    if (!detail) return;
    const current = generation.current;
    const controller = new AbortController();
    detailRequest.current?.abort();
    detailRequest.current = controller;
    setSaving(true);
    setError('');
    try {
      const result = await client.update(
        detail.incident.id,
        {
          expectedRevision: detail.incident.revision,
          ...input,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        controller.signal,
      );
      const response = await client.detail(result.id, controller.signal);
      if (current === generation.current && !controller.signal.aborted) {
        setDetail(response);
        setRecords((previous) =>
          previous.map((item) => (item.id === result.id ? result : item)),
        );
        setNote('');
      }
    } catch (failure) {
      if (current === generation.current && !controller.signal.aborted)
        setError(message(failure));
    } finally {
      if (current === generation.current) setSaving(false);
    }
  }

  async function loadMore() {
    if (!cursor) return;
    const current = generation.current;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setLoading(true);
    try {
      const page = await client.list(
        {
          cursor,
          ...(radioId ? { radioId } : {}),
          ...(filter ? { state: filter } : {}),
        },
        controller.signal,
      );
      if (current === generation.current) {
        setRecords((previous) => [
          ...previous,
          ...page.items.filter(
            (item) => !previous.some((existing) => existing.id === item.id),
          ),
        ]);
        setCursor(page.nextCursor);
      }
    } catch (failure) {
      if (current === generation.current && !controller.signal.aborted)
        setError(message(failure));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }

  async function rulesAction(action?: () => Promise<void>) {
    const current = generation.current;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setSaving(true);
    setError('');
    try {
      await action?.();
      const rows = await client.rules(controller.signal);
      if (current === generation.current) setRuleRows(rows);
    } catch (failure) {
      if (current === generation.current && !controller.signal.aborted)
        setError(message(failure));
    } finally {
      if (current === generation.current) setSaving(false);
    }
  }

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Incidents</Text>
      <Text style={styles.secondary}>
        Review source evidence and record operator decisions. Detection does not
        provide complete emergency coverage.
      </Text>
      <View style={styles.row}>
        <ActionButton
          title="All states"
          disabled={loading || saving}
          onPress={() => setFilter(undefined)}
        />
        {states.map((state) => (
          <ActionButton
            key={state}
            title={label(state)}
            disabled={loading || saving || filter === state}
            onPress={() => setFilter(state)}
          />
        ))}
        <ActionButton
          title="Refresh"
          disabled={saving}
          onPress={() => setRefresh((value) => value + 1)}
        />
      </View>
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {loading && (
        <ActivityIndicator
          accessibilityLabel="Loading incidents"
          color="#50dfc2"
        />
      )}
      {!loading && !records.length && (
        <Text style={styles.secondary}>
          No incidents match this filter in your permitted radios.
        </Text>
      )}
      {records.map((incident) => (
        <Pressable
          key={incident.id}
          accessibilityRole="button"
          disabled={saving}
          onPress={() => {
            void openIncident(incident.id);
          }}
          style={styles.card}
        >
          <Text style={styles.cardTitle}>{incident.title}</Text>
          <Text style={styles.secondary}>
            {incident.priority.toUpperCase()} · {label(incident.state)} ·{' '}
            {new Date(incident.updatedAt).toLocaleString()}
          </Text>
          <Text selectable style={styles.small}>
            Radio {incident.radioId} · Revision {incident.revision}
          </Text>
        </Pressable>
      ))}
      {!!cursor && (
        <ActionButton
          title="Load more"
          disabled={loading || saving}
          onPress={() => {
            void loadMore();
          }}
        />
      )}
      {detail && (
        <View style={styles.card}>
          <Text style={styles.heading}>{detail.incident.title}</Text>
          <Text style={styles.secondary}>
            {detail.incident.priority.toUpperCase()} ·{' '}
            {label(detail.incident.state)}
          </Text>
          <Text style={styles.small}>
            Owner: {detail.incident.ownerUserId ?? 'Unassigned'} · Source
            retention hold: {detail.incident.retentionHold ? 'on' : 'off'}
          </Text>
          <ActionButton
            title="Select source radio"
            onPress={() => onSelectRadio?.(detail.incident.radioId)}
            disabled={!onSelectRadio || saving}
          />
          <Text style={styles.heading}>Source evidence</Text>
          {detail.incident.evidence.map((entry, index) => (
            <View
              key={`${entry.communicationId}:${entry.transcriptRevisionId}:${index}`}
              style={styles.evidence}
            >
              <Text selectable style={styles.body}>
                {entry.quote ??
                  'Source reference retained without a text quote.'}
              </Text>
              <Text selectable style={styles.small}>
                Communication {entry.communicationId}
                {entry.transcriptRevisionId
                  ? ` · Transcript ${entry.transcriptRevisionId}`
                  : ''}
              </Text>
            </View>
          ))}
          <Text style={styles.secondary}>
            Callsigns and spoken locations are candidates; they do not
            authenticate the speaker or confirm a geographic position.
          </Text>
          {canManage && (
            <View style={styles.section}>
              <TextInput
                accessibilityLabel="Incident decision note"
                placeholder="Decision note (required to resolve or dismiss)"
                placeholderTextColor="#8095ad"
                value={note}
                onChangeText={setNote}
                multiline
                style={styles.input}
              />
              <View style={styles.row}>
                {nextStates[detail.incident.state].map((state) => (
                  <ActionButton
                    key={state}
                    title={
                      state === 'acknowledged' &&
                      ['resolved', 'dismissed'].includes(detail.incident.state)
                        ? 'Reopen and acknowledge'
                        : label(state)
                    }
                    disabled={
                      saving ||
                      (['resolved', 'dismissed'].includes(state) &&
                        !note.trim())
                    }
                    onPress={() => {
                      void update({ state });
                    }}
                  />
                ))}
              </View>
              <View style={styles.row}>
                <ActionButton
                  title="Assign to me"
                  disabled={saving}
                  onPress={() => {
                    void update({ ownerUserId: session.user.id });
                  }}
                />
                <ActionButton
                  title={
                    detail.incident.retentionHold
                      ? 'Release source retention hold'
                      : 'Hold source evidence'
                  }
                  disabled={saving}
                  onPress={() => {
                    void update({
                      retentionHold: !detail.incident.retentionHold,
                    });
                  }}
                />
                <ActionButton
                  title="Save note"
                  disabled={saving || !note.trim()}
                  onPress={() => {
                    void update({});
                  }}
                />
              </View>
            </View>
          )}
          <Text style={styles.heading}>Assessments and provenance</Text>
          {detail.assessments.map((assessment) => (
            <View key={assessment.id} style={styles.evidence}>
              <Text style={styles.secondary}>
                {assessment.connectorId} ·{' '}
                {new Date(assessment.createdAt).toLocaleString()}
              </Text>
              <Text selectable style={styles.small}>
                {JSON.stringify(assessment.result, null, 2)}
              </Text>
            </View>
          ))}
          <Text style={styles.heading}>Operator and assessment history</Text>
          {detail.actions.map((action) => (
            <View key={action.id} style={styles.evidence}>
              <Text style={styles.secondary}>
                {label(action.kind)} ·{' '}
                {new Date(action.occurredAt).toLocaleString()}
              </Text>
              <Text selectable style={styles.body}>
                {action.note}
              </Text>
            </View>
          ))}
        </View>
      )}
      {session.user.role === 'administrator' && (
        <View style={styles.card}>
          <Text style={styles.heading}>Local detection rules</Text>
          <Text style={styles.secondary}>
            Literal phrases, optional radio/frequency scope. No custom
            executable expressions. Removing the last configured rule disables
            local incident detection by default.
          </Text>
          <ActionButton
            title="Load detection rules"
            disabled={saving}
            onPress={() => {
              void rulesAction();
            }}
          />
          {ruleRows?.map((rule) => (
            <View key={rule.id} style={styles.evidence}>
              <Text style={styles.cardTitle}>{rule.name}</Text>
              <Text style={styles.secondary}>
                {rule.enabled ? 'Enabled' : 'Disabled'} · {rule.priority} ·{' '}
                {rule.phrases.join('; ')}
              </Text>
              <ActionButton
                title={`Remove rule ${rule.name}`}
                disabled={saving}
                onPress={() => {
                  void rulesAction(() => client.removeRule(rule.id));
                }}
              />
            </View>
          ))}
          <TextInput
            accessibilityLabel="Rule name"
            value={ruleName}
            onChangeText={setRuleName}
            placeholder="Rule name"
            placeholderTextColor="#8095ad"
            style={styles.input}
          />
          <TextInput
            accessibilityLabel="Distress phrases"
            value={rulePhrases}
            onChangeText={setRulePhrases}
            placeholder="Phrases separated by semicolons"
            placeholderTextColor="#8095ad"
            style={styles.input}
          />
          <View style={styles.row}>
            <TextInput
              accessibilityLabel="Minimum frequency in Hz"
              value={minHz}
              onChangeText={setMinHz}
              placeholder="Minimum Hz (optional)"
              placeholderTextColor="#8095ad"
              style={styles.input}
              keyboardType="numeric"
            />
            <TextInput
              accessibilityLabel="Maximum frequency in Hz"
              value={maxHz}
              onChangeText={setMaxHz}
              placeholder="Maximum Hz (optional)"
              placeholderTextColor="#8095ad"
              style={styles.input}
              keyboardType="numeric"
            />
          </View>
          <Text style={styles.small}>
            {radioId
              ? `New rules are scoped to selected radio ${radioId}.`
              : 'No radio selected: new rules apply across this instance.'}
          </Text>
          <ActionButton
            title="Add high-priority review rule"
            disabled={saving || !ruleName.trim() || !rulePhrases.trim()}
            onPress={() => {
              const body = {
                name: ruleName.trim(),
                phrases: rulePhrases
                  .split(';')
                  .map((value) => value.trim())
                  .filter(Boolean),
                priority: 'high',
                enabled: true,
                ...(radioId ? { radioIds: [radioId] } : {}),
                ...(minHz ? { minHz: Number(minHz) } : {}),
                ...(maxHz ? { maxHz: Number(maxHz) } : {}),
              };
              void rulesAction(() => client.saveRule(body));
            }}
          />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#0b1220' },
  content: {
    padding: 24,
    gap: 18,
    maxWidth: 1100,
    width: '100%',
    alignSelf: 'center',
  },
  title: { color: '#eef5ff', fontSize: 30, fontWeight: '700' },
  heading: { color: '#eef5ff', fontSize: 19, fontWeight: '600' },
  cardTitle: { color: '#eef5ff', fontSize: 17, fontWeight: '600' },
  secondary: { color: '#a0b2ca', fontSize: 14, lineHeight: 21 },
  body: { color: '#e2eaf6', fontSize: 15, lineHeight: 23 },
  small: { color: '#8fa5bf', fontSize: 12, lineHeight: 18 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  section: { gap: 12 },
  card: {
    borderWidth: 1,
    borderColor: '#2c405b',
    backgroundColor: '#132034',
    padding: 20,
    borderRadius: 14,
    gap: 12,
  },
  evidence: {
    borderLeftWidth: 2,
    borderLeftColor: '#387f76',
    paddingLeft: 12,
    gap: 6,
  },
  button: {
    backgroundColor: '#244337',
    borderWidth: 1,
    borderColor: '#3e7867',
    borderRadius: 8,
    padding: 12,
  },
  buttonText: {
    color: '#b8f3df',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  disabled: { opacity: 0.45 },
  input: {
    borderWidth: 1,
    borderColor: '#3b526e',
    borderRadius: 8,
    backgroundColor: '#0b1525',
    color: '#eef5ff',
    padding: 12,
    minWidth: 150,
  },
  error: { color: '#ffb4a9', fontSize: 14, lineHeight: 21 },
});

export default IncidentsScreen;
