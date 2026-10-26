import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { randomUUID } from 'expo-crypto';
import { apiRequest } from '@signaldock/client-sdk';
import {
  CommunicationSchema,
  IdSchema,
  TimestampSchema,
  PacketRecordSchema,
  PositionRecordSchema,
  type Communication,
  type FeatureScreenProps,
  type PacketRecord,
  type PositionRecord,
  type JobState,
} from '@signaldock/contracts';
import type { AudioDecodeResult } from '@signaldock/digital-decoders';
import AprsMap from './AprsMap';
import { latestStations, positionAge } from './map-model';

type DecoderProgress = {
  instanceId: string;
  radioId: string;
  artifactId: string;
  runId: string;
  state: JobState;
  result?: AudioDecodeResult;
  error?: string;
};
const sources = ['all', 'native', 'recording', 'aprs_is'] as const;
const terminal = new Set<JobState>([
  'completed',
  'failed',
  'cancelled',
  'requires_configuration',
]);

export function AprsScreen(
  props: FeatureScreenProps & { mapStyleUrl?: string },
) {
  return (
    <AprsScreenContent
      key={`${props.session.baseUrl}:${props.session.instanceId}:${props.session.user.id}:${props.radioId ?? 'all'}`}
      {...props}
    />
  );
}
function AprsScreenContent({
  session,
  radioId,
  mapStyleUrl,
}: FeatureScreenProps & { mapStyleUrl?: string }) {
  const [packets, setPackets] = useState<PacketRecord[]>([]);
  const [positions, setPositions] = useState<PositionRecord[]>([]);
  const [recordings, setRecordings] = useState<Communication[]>([]);
  const [selectedRecording, setSelectedRecording] = useState<string>();
  const [selectedPacket, setSelectedPacket] = useState<PacketRecord>();
  const [frameExpanded, setFrameExpanded] = useState(false);
  const [source, setSource] = useState<(typeof sources)[number]>('all');
  const [callsign, setCallsign] = useState('');
  const [filterCallsign, setFilterCallsign] = useState('');
  const [hours, setHours] = useState(6);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [nextCursor, setNextCursor] = useState<string>();
  const [generatedAt, setGeneratedAt] = useState(Date.now());
  const [clock, setClock] = useState(Date.now());
  const [lastSync, setLastSync] = useState(Date.now());
  const estimatedNow = generatedAt + Math.max(0, clock - lastSync);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => setFrameExpanded(false), [selectedPacket?.packetId]);
  const [decodeMode, setDecodeMode] = useState<'AFSK1200' | 'DTMF'>('AFSK1200');
  const [run, setRun] = useState<DecoderProgress>();
  const [submitting, setSubmitting] = useState(false);
  const generation = useRef(0);
  const selection = useRef(0);
  const poll = useRef<AbortController | null>(null);
  const context = `${session.instanceId}:${session.baseUrl}:${radioId ?? 'all'}`;

  const scopePacket = useCallback(
    (input: unknown) => {
      const packet = PacketRecordSchema.parse(input);
      if (
        packet.instanceId !== session.instanceId ||
        (radioId && packet.radioId !== radioId)
      )
        throw new Error('Packet belongs to another station context.');
      return packet;
    },
    [session.instanceId, radioId],
  );
  const scopePosition = useCallback(
    (input: unknown) => {
      const position = PositionRecordSchema.parse(input);
      if (
        position.instanceId !== session.instanceId ||
        (radioId && position.radioId !== radioId)
      )
        throw new Error('Position belongs to another station context.');
      return position;
    },
    [session.instanceId, radioId],
  );

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    poll.current?.abort();
    setSubmitting(false);
    setPackets([]);
    setPositions([]);
    setSelectedPacket(undefined);
    setNextCursor(undefined);
    setError('');
    setLoading(true);
    const query = new URLSearchParams({
      limit: '100',
      ...(radioId ? { radioId } : {}),
      ...(source === 'all' ? {} : { source }),
      ...(filterCallsign ? { callsign: filterCallsign } : {}),
    });
    const positionQuery = new URLSearchParams(query);
    positionQuery.set('limit', '500');
    positionQuery.set(
      'since',
      new Date(Date.now() - hours * 3600000).toISOString(),
    );
    void Promise.all([
      apiRequest<{ items: unknown[]; nextCursor?: string }>(
        session,
        `packets?${query}`,
        { signal: controller.signal },
      ),
      apiRequest<{ items: unknown[]; generatedAt: string }>(
        session,
        `positions?${positionQuery}`,
        { signal: controller.signal },
      ),
    ])
      .then(([packetPage, positionPage]) => {
        if (current !== generation.current) return;
        if (
          !Array.isArray(packetPage.items) ||
          !Array.isArray(positionPage.items)
        )
          throw new Error('Unsupported packet response.');
        setPackets(packetPage.items.map(scopePacket));
        setPositions(positionPage.items.map(scopePosition));
        setNextCursor(packetPage.nextCursor);
        setGeneratedAt(
          Date.parse(TimestampSchema.parse(positionPage.generatedAt)),
        );
        setLastSync(Date.now());
        setClock(Date.now());
      })
      .catch((failure) => {
        if (!controller.signal.aborted && current === generation.current)
          setError(message(failure));
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
    return () => controller.abort();
  }, [
    session.baseUrl,
    session.instanceId,
    session.accessToken,
    radioId,
    source,
    filterCallsign,
    hours,
    refresh,
    scopePacket,
    scopePosition,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    setSubmitting(false);
    setRecordings([]);
    setSelectedRecording(undefined);
    setHistoryError('');
    setRun(undefined);
    poll.current?.abort();
    const query = new URLSearchParams({
      limit: '20',
      ...(radioId ? { radioId } : {}),
    });
    void apiRequest<{ items: unknown[] }>(session, `communications?${query}`, {
      signal: controller.signal,
    })
      .then((page) => {
        if (controller.signal.aborted) return;
        const items = page.items
          .map((item) => CommunicationSchema.parse(item))
          .filter(
            (item) =>
              item.instanceId === session.instanceId &&
              (!radioId || item.radioId === radioId) &&
              item.recording?.state === 'available' &&
              !item.deletedAt,
          );
        setRecordings(items);
        setSelectedRecording(items[0]?.id);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setHistoryError(message(failure));
      });
    return () => {
      controller.abort();
      poll.current?.abort();
    };
  }, [session.baseUrl, session.instanceId, session.accessToken, radioId]);

  async function choosePacket(packetId: string) {
    const current = generation.current;
    const selected = ++selection.current;
    try {
      IdSchema.parse(packetId);
      const packet = scopePacket(
        await apiRequest(session, `packets/${packetId}`),
      );
      if (current === generation.current && selected === selection.current)
        setSelectedPacket(packet);
    } catch (failure) {
      if (current === generation.current) setError(message(failure));
    }
  }
  async function more() {
    if (!nextCursor) return;
    const current = generation.current;
    setLoading(true);
    try {
      const query = new URLSearchParams({
        limit: '100',
        cursor: nextCursor,
        ...(radioId ? { radioId } : {}),
        ...(source === 'all' ? {} : { source }),
        ...(filterCallsign ? { callsign: filterCallsign } : {}),
      });
      const page = await apiRequest<{ items: unknown[]; nextCursor?: string }>(
        session,
        `packets?${query}`,
      );
      if (current !== generation.current) return;
      const rows = page.items.map(scopePacket);
      setPackets((previous) => [
        ...previous,
        ...rows.filter(
          (row) => !previous.some((item) => item.packetId === row.packetId),
        ),
      ]);
      setNextCursor(page.nextCursor);
    } catch (failure) {
      if (current === generation.current) setError(message(failure));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  async function decode() {
    const recording = recordings.find(
      (item) => item.id === selectedRecording,
    )?.recording;
    if (!recording) return;
    const current = generation.current;
    const controller = new AbortController();
    poll.current?.abort();
    poll.current = controller;
    setSubmitting(true);
    setError('');
    try {
      const created = await apiRequest<{ runId: string }>(
        session,
        'decodings',
        {
          method: 'POST',
          body: JSON.stringify({
            operationId: randomUUID(),
            artifactId: recording.artifactId,
            mode: decodeMode,
          }),
          signal: controller.signal,
        },
      );
      IdSchema.parse(created.runId);
      for (let attempt = 0; attempt < 50; attempt++) {
        const progress = await apiRequest<DecoderProgress>(
          session,
          `decodings/${created.runId}`,
          { signal: controller.signal },
        );
        if (current !== generation.current || controller.signal.aborted) return;
        if (
          progress.instanceId !== session.instanceId ||
          progress.runId !== created.runId ||
          progress.artifactId !== recording.artifactId ||
          (radioId && progress.radioId !== radioId)
        )
          throw new Error(
            'Decoder result belongs to another recording context.',
          );
        setRun(progress);
        if (terminal.has(progress.state)) {
          if (progress.state === 'completed') setRefresh((value) => value + 1);
          return;
        }
        await abortableDelay(1500, controller.signal);
      }
      throw new Error(
        'The decoder is still queued. Check its status from the recording later.',
      );
    } catch (failure) {
      if (!controller.signal.aborted && current === generation.current)
        setError(message(failure));
    } finally {
      if (current === generation.current) setSubmitting(false);
    }
  }
  async function cancel() {
    if (!run) return;
    const current = generation.current;
    try {
      await apiRequest(session, `decodings/${run.runId}`, { method: 'DELETE' });
      if (current !== generation.current) return;
      poll.current?.abort();
      setSubmitting(false);
      setRun((previous) =>
        previous ? { ...previous, state: 'cancelled' } : previous,
      );
    } catch (failure) {
      if (current === generation.current) setError(message(failure));
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>APRS and digital</Text>
          <Text style={styles.muted}>
            Received positions, packets, and recording evidence
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          style={styles.button}
          disabled={loading}
          onPress={() => setRefresh((value) => value + 1)}
        >
          <Text style={styles.buttonText}>Refresh</Text>
        </Pressable>
      </View>
      <View style={styles.filters}>
        <TextInput
          accessibilityLabel="Filter callsign"
          style={styles.input}
          value={callsign}
          onChangeText={(value) => setCallsign(value.toUpperCase())}
          placeholder="Callsign"
          placeholderTextColor="#7890aa"
          autoCapitalize="characters"
          onSubmitEditing={() => setFilterCallsign(callsign.trim())}
        />
        <Pressable
          accessibilityRole="button"
          style={styles.secondary}
          onPress={() => setFilterCallsign(callsign.trim())}
        >
          <Text style={styles.text}>Apply</Text>
        </Pressable>
        {sources.map((value) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityState={{ selected: source === value }}
            style={[styles.secondary, source === value && styles.selected]}
            onPress={() => setSource(value)}
          >
            <Text style={styles.text}>
              {value === 'all'
                ? 'All sources'
                : value === 'aprs_is'
                  ? 'APRS-IS'
                  : value === 'native'
                    ? 'Native packets'
                    : 'Recordings'}
            </Text>
          </Pressable>
        ))}
        {[1, 6, 24].map((value) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityState={{ selected: hours === value }}
            style={[styles.secondary, hours === value && styles.selected]}
            onPress={() => setHours(value)}
          >
            <Text style={styles.text}>{value}h</Text>
          </Pressable>
        ))}
      </View>
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
      {loading && <ActivityIndicator color="#50dfc2" />}
      <AprsMap
        key={context}
        positions={positions}
        referenceTime={estimatedNow}
        {...(mapStyleUrl ? { styleUrl: mapStyleUrl } : {})}
        onPacketSelect={(packetId) => {
          void choosePacket(packetId);
        }}
      />
      <Text style={styles.muted}>
        Latest received positions · Updated{' '}
        {new Date(generatedAt).toLocaleTimeString()}
      </Text>
      <View style={styles.grid}>
        {latestStations(positions).map((position) => {
          const age = positionAge(position, estimatedNow);
          return (
            <Pressable
              key={`${position.radioId}:${position.callsign}`}
              accessibilityRole="button"
              style={styles.card}
              onPress={() => {
                void choosePacket(position.packetId);
              }}
            >
              <Text style={styles.heading}>{position.callsign}</Text>
              <Text style={styles.text}>
                {position.lat.toFixed(5)}, {position.lon.toFixed(5)}
              </Text>
              <Text
                style={
                  age.stale || age.clockSkew ? styles.warning : styles.muted
                }
              >
                {age.clockSkew
                  ? 'Timestamp is ahead of server time'
                  : `${age.ageSeconds}s old${age.stale ? ' · stale' : ''}`}
              </Text>
              <Text style={styles.muted}>{position.source}</Text>
            </Pressable>
          );
        })}
      </View>
      {!positions.length && !loading && (
        <Text style={styles.muted}>
          No positions in this time window. Packets without a supported position
          remain in the packet list.
        </Text>
      )}
      <Text style={styles.heading}>Packets</Text>
      {packets.map((packet) => (
        <Pressable
          key={packet.packetId}
          accessibilityRole="button"
          style={styles.packet}
          onPress={() => setSelectedPacket(packet)}
        >
          <Text style={styles.text}>
            {packet.callsign ?? 'Unparsed source'} →{' '}
            {packet.destination ?? 'Unknown destination'} · {packet.kind}
          </Text>
          <Text style={styles.muted}>
            {new Date(packet.receivedAt).toLocaleString()} · {packet.source} ·{' '}
            {packet.frequencyHz
              ? `${(packet.frequencyHz / 1e6).toFixed(6)} MHz`
              : 'Frequency unknown'}
            {packet.attribution !== 'confirmed'
              ? ` (${packet.attribution})`
              : ''}
          </Text>
        </Pressable>
      ))}
      {!packets.length && !loading && (
        <Text style={styles.muted}>No packets received for this filter.</Text>
      )}
      {!!nextCursor && (
        <Pressable
          accessibilityRole="button"
          style={styles.secondary}
          onPress={() => {
            void more();
          }}
          disabled={loading}
        >
          <Text style={styles.text}>Older packets</Text>
        </Pressable>
      )}
      {selectedPacket && (
        <View style={styles.card}>
          <Text style={styles.heading}>Packet evidence</Text>
          <Text selectable style={styles.text}>
            {selectedPacket.rawText ??
              'Binary packet; see stored frame evidence.'}
          </Text>
          {selectedPacket.rawFrameBase64 && (
            <>
              <Pressable
                accessibilityRole="button"
                onPress={() => setFrameExpanded((value) => !value)}
              >
                <Text style={styles.link}>
                  {frameExpanded
                    ? 'Hide original frame'
                    : 'Show original AX.25 frame'}
                </Text>
              </Pressable>
              {frameExpanded && (
                <Text selectable style={styles.muted}>
                  {selectedPacket.rawFrameBase64}
                </Text>
              )}
            </>
          )}
          <Text style={styles.muted}>
            Route: {selectedPacket.path.join(' → ') || 'Direct'} · Parser{' '}
            {selectedPacket.parserVersion}
          </Text>
          <Text style={styles.muted}>
            Received {new Date(selectedPacket.receivedAt).toLocaleString()} ·{' '}
            {selectedPacket.attribution} frequency attribution
          </Text>
          {selectedPacket.position && (
            <Text style={styles.text}>
              Received position {selectedPacket.position.lat.toFixed(5)},{' '}
              {selectedPacket.position.lon.toFixed(5)}
            </Text>
          )}
          {typeof selectedPacket.parsed?.['error'] === 'string' && (
            <Text style={styles.warning}>{selectedPacket.parsed['error']}</Text>
          )}
          <Pressable
            accessibilityRole="button"
            onPress={() => setSelectedPacket(undefined)}
          >
            <Text style={styles.link}>Close evidence</Text>
          </Pressable>
        </View>
      )}
      <View style={styles.card}>
        <Text style={styles.heading}>Decode a recording</Text>
        <Text style={styles.muted}>
          Select captured audio. Decoding creates evidence; it never transmits.
        </Text>
        {!!historyError && <Text style={styles.warning}>{historyError}</Text>}
        {recordings.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityState={{ selected: selectedRecording === item.id }}
            style={[
              styles.secondary,
              selectedRecording === item.id && styles.selected,
            ]}
            onPress={() => setSelectedRecording(item.id)}
          >
            <Text style={styles.text}>
              {new Date(item.startedAt).toLocaleString()} ·{' '}
              {item.frequencyHz
                ? `${(item.frequencyHz / 1e6).toFixed(4)} MHz`
                : 'Frequency unknown'}{' '}
              · {item.direction.toUpperCase()}
            </Text>
          </Pressable>
        ))}
        {!recordings.length && (
          <Text style={styles.muted}>
            No available recordings in the recent history.
          </Text>
        )}
        <View style={styles.filters}>
          {(['AFSK1200', 'DTMF'] as const).map((mode) => (
            <Pressable
              key={mode}
              accessibilityRole="button"
              accessibilityState={{ selected: decodeMode === mode }}
              style={[styles.secondary, decodeMode === mode && styles.selected]}
              onPress={() => setDecodeMode(mode)}
            >
              <Text style={styles.text}>{mode}</Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            style={styles.button}
            disabled={!selectedRecording || submitting}
            onPress={() => {
              void decode();
            }}
          >
            <Text style={styles.buttonText}>
              {submitting ? 'Decoding…' : 'Decode selected recording'}
            </Text>
          </Pressable>
          {submitting && run && (
            <Pressable
              accessibilityRole="button"
              style={styles.secondary}
              onPress={() => {
                void cancel();
              }}
            >
              <Text style={styles.text}>Cancel</Text>
            </Pressable>
          )}
        </View>
        {run && (
          <View style={{ gap: 8 }}>
            <Text style={styles.text}>Decoder status: {run.state}</Text>
            {run.error && <Text style={styles.error}>{run.error}</Text>}
            {run.result && (
              <>
                <Text style={styles.text}>
                  {run.result.packets.length} decoded packets
                </Text>
                {run.result.tones.map((tone, index) => (
                  <Text key={index} style={styles.text}>
                    {tone.symbol} · {(tone.startMs / 1000).toFixed(2)}–
                    {(tone.endMs / 1000).toFixed(2)} seconds
                  </Text>
                ))}
                <Text style={styles.muted}>
                  Decoder {run.result.decoderId} {run.result.decoderVersion}
                </Text>
              </>
            )}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'The digital data could not be loaded.';
}
function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
const styles = StyleSheet.create({
  page: { padding: 20, gap: 16, backgroundColor: '#0b1220' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    flexWrap: 'wrap',
  },
  title: { fontSize: 28, fontWeight: '700', color: '#eef5ff' },
  heading: { fontSize: 18, fontWeight: '600', color: '#eef5ff' },
  text: { fontSize: 14, lineHeight: 21, color: '#d2e1f1' },
  muted: { fontSize: 12, lineHeight: 18, color: '#94a9c1' },
  warning: { fontSize: 13, color: '#f6d38a' },
  error: { color: '#ffb4a9' },
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
  },
  input: {
    minWidth: 150,
    padding: 10,
    borderWidth: 1,
    borderColor: '#354b66',
    borderRadius: 8,
    color: '#eef5ff',
  },
  button: { padding: 12, borderRadius: 8, backgroundColor: '#50dfc2' },
  buttonText: { color: '#06131b', fontWeight: '700' },
  secondary: {
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#354b66',
  },
  selected: { borderColor: '#50dfc2', backgroundColor: '#173b3c' },
  card: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#263951',
    backgroundColor: '#131f32',
    gap: 8,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  packet: {
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#263951',
    gap: 5,
  },
  link: { color: '#50dfc2', paddingVertical: 8 },
});
