import { apiFetch, apiRequest } from '@signaldock/client-sdk';
import type {
  Communication,
  ConnectorManifest,
  FeatureScreenProps,
  ProcessingBackgroundConsentView,
  ProcessingCapability,
  ProcessingConnectionView,
  ProcessingJobView,
  ProcessingProfile,
} from '@signaldock/contracts';
import type { ProcessingTaskDefinition } from '@signaldock/processing-sdk';
import {
  Action,
  ConfirmButton,
  Disclosure,
  ScrollView,
  SettingToggle,
  Text,
  TextInput,
  useFeatureStyles,
  useScreenActive,
} from '@signaldock/ui';
import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';

type Task = Pick<ProcessingTaskDefinition, 'taskId' | 'version' | 'capability'>;
const defaults: Record<string, string> = {
  'openai-api': 'https://api.openai.com/v1',
  'openai-compatible': 'https://provider.example/v1',
  'azure-speech': 'https://REGION.api.cognitive.microsoft.com',
  ollama: 'http://ollama:11434',
};

export interface ProcessingScreenProps extends FeatureScreenProps {
  onTransmitSpeech?: (
    jobId: string,
    radioId: string,
    signal: AbortSignal,
  ) => Promise<void>;
}
export function ProcessingScreen({
  session,
  radioId,
  onTransmitSpeech,
}: ProcessingScreenProps) {
  const styles = useFeatureStyles('processing');
  const active = useScreenActive();
  const previewAudio = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (!active) previewAudio.current?.pause();
  }, [active]);
  const [connections, setConnections] = useState<ProcessingConnectionView[]>(
    [],
  );
  const [profiles, setProfiles] = useState<ProcessingProfile[]>([]);
  const [jobs, setJobs] = useState<ProcessingJobView[]>([]);
  const [connectors, setConnectors] = useState<ConnectorManifest[]>([]);
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [communications, setCommunications] = useState<Communication[]>([]);
  const [consents, setConsents] = useState<ProcessingBackgroundConsentView[]>(
    [],
  );
  const [serviceOwnerUserId, setServiceOwnerUserId] = useState(session.user.id);
  const [automaticConsent, setAutomaticConsent] = useState(false);
  const [provider, setProvider] = useState('openai-api');
  const [capabilities, setCapabilities] = useState<ProcessingCapability[]>([
    'text.structured',
    'stt.batch',
    'tts.synthesize',
  ]);
  const [endpoint, setEndpoint] = useState(defaults['openai-api']!);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [configuration, setConfiguration] = useState('{}');
  const [connectionId, setConnectionId] = useState('');
  const [taskId, setTaskId] = useState('speech.transcribe');
  const [model, setModel] = useState('');
  const [settings, setSettings] = useState('{}');
  const [allowCloud, setAllowCloud] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [communicationId, setCommunicationId] = useState('');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<string>();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const scope = useRef(new AbortController());
  const generation = useRef(0);
  const busyRef = useRef(false);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const results = await Promise.all([
        apiRequest<{ connections: ProcessingConnectionView[] }>(
          session,
          'processing/connections',
          { signal },
        ),
        apiRequest<{ profiles: ProcessingProfile[] }>(
          session,
          'processing/profiles',
          { signal },
        ),
        apiRequest<{ jobs: ProcessingJobView[] }>(session, 'processing/jobs', {
          signal,
        }),
        apiRequest<{ connectors: ConnectorManifest[]; tasks: Task[] }>(
          session,
          'processing/connectors',
          { signal },
        ),
        radioId
          ? apiRequest<{ items: Communication[] }>(
              session,
              `communications?radioId=${encodeURIComponent(radioId)}`,
              { signal },
            )
          : Promise.resolve({ items: [] as Communication[] }),
        session.user.role === 'administrator'
          ? apiRequest<{ consents: ProcessingBackgroundConsentView[] }>(
              session,
              'processing/background',
              { signal },
            )
          : Promise.resolve({
              consents: [] as ProcessingBackgroundConsentView[],
            }),
      ]);
      signal.throwIfAborted();
      setConnections(results[0].connections);
      setProfiles(results[1].profiles);
      setJobs(results[2].jobs);
      setConnectors(results[3].connectors);
      setTasks(results[3].tasks);
      setCommunications(results[4].items);
      setConsents(results[5].consents);
    },
    [session, radioId],
  );
  useEffect(() => {
    const controller = new AbortController();
    scope.current.abort();
    scope.current = controller;
    generation.current++;
    setConnections([]);
    setProfiles([]);
    setJobs([]);
    setCommunications([]);
    setSecret('');
    setText('');
    setConnectionId('');
    setProfileId('');
    setCommunicationId('');
    setPreview(undefined);
    setStatus('');
    setConsents([]);
    setAutomaticConsent(false);
    setServiceOwnerUserId(session.user.id);
    busyRef.current = false;
    setBusy(false);
    void load(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) setStatus(message(error));
    });
    return () => {
      controller.abort();
      generation.current++;
    };
  }, [load]);
  useEffect(() => {
    setAutomaticConsent(false);
  }, [profileId, radioId, profiles]);
  useEffect(
    () => () => {
      if (preview && Platform.OS === 'web') URL.revokeObjectURL(preview);
    },
    [preview],
  );
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const active = generation.current;
    const signal = AbortSignal.any([
      scope.current.signal,
      AbortSignal.timeout(40_000),
    ]);
    try {
      setStatus('');
      await action(signal);
      if (active === generation.current) await load(signal);
    } catch (error) {
      if (active === generation.current && !scope.current.signal.aborted)
        setStatus(message(error));
    } finally {
      if (active === generation.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const selectedConnection = connections.find(
    (connection) => connection.connection.connectionId === connectionId,
  );
  const selectedProfile = profiles.find(
    (profile) => profile.profileId === profileId,
  );
  const profileConnection = connections.find(
    (connection) =>
      connection.connection.connectionId === selectedProfile?.connectionId,
  );
  const selectedCommunication = communications.find(
    (communication) => communication.id === communicationId,
  );
  const selectedTask = tasks.find((task) => task.taskId === taskId);
  const createConnection = () =>
    run(async (signal) => {
      const config = parseObject(configuration);
      try {
        const saved = await apiRequest<ProcessingConnectionView>(
          session,
          'processing/connections',
          {
            method: 'POST',
            signal,
            body: JSON.stringify({
              connectorId: provider,
              displayName: name || provider,
              endpoint,
              capabilities,
              configuration: config,
              ...(secret ? { apiKey: secret } : {}),
            }),
          },
        );
        signal.throwIfAborted();
        setConnectionId(saved.connection.connectionId);
        setStatus(
          'Connection configured. A successful job confirms provider access.',
        );
      } finally {
        if (!signal.aborted) setSecret('');
      }
    });
  const createProfile = () =>
    run(async (signal) => {
      if (!selectedConnection || !selectedTask)
        throw new Error('Select a connection and supported task.');
      const profile = await apiRequest<ProcessingProfile>(
        session,
        'processing/profiles',
        {
          method: 'POST',
          signal,
          body: JSON.stringify({
            connectionId,
            capability: selectedTask.capability,
            task: taskId,
            model,
            allowCloud,
            settings: parseObject(settings),
          }),
        },
      );
      signal.throwIfAborted();
      setProfileId(profile.profileId);
      setStatus('Profile created.');
    });
  const submit = () =>
    run(async (signal) => {
      if (!selectedProfile?.task)
        throw new Error('Select a processing profile.');
      const task = tasks.find((entry) => entry.taskId === selectedProfile.task);
      if (!task) throw new Error('This profile task is unavailable.');
      const audio = task.capability === 'stt.batch';
      if (
        audio &&
        (!selectedCommunication?.recording ||
          selectedCommunication.recording.state !== 'available')
      )
        throw new Error('Select an available recording.');
      const source =
        selectedCommunication && task.capability !== 'tts.synthesize'
          ? {
              communicationId: selectedCommunication.id,
              communicationRevision: selectedCommunication.revision,
              ...(audio
                ? { artifactId: selectedCommunication.recording!.artifactId }
                : {}),
              ...(!audio && selectedCommunication.transcripts.at(-1)
                ? {
                    transcriptRevisionId:
                      selectedCommunication.transcripts.at(-1)!.id,
                  }
                : {}),
            }
          : undefined;
      const input = audio
        ? {
            kind: 'audio',
            artifactId: selectedCommunication!.recording!.artifactId,
            communicationIds: [selectedCommunication!.id],
          }
        : {
            kind: 'text',
            text:
              task.capability === 'text.structured'
                ? (selectedCommunication?.transcripts.at(-1)?.text ?? text)
                : text,
            communicationIds:
              task.capability === 'text.structured' && selectedCommunication
                ? [selectedCommunication.id]
                : [],
          };
      await apiRequest(session, 'processing/jobs', {
        method: 'POST',
        signal,
        body: JSON.stringify({
          request: {
            profileId,
            profileRevision: selectedProfile.revision,
            task: task.taskId,
            taskVersion: task.version,
            deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
            input,
          },
          idempotencyKey: `client-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          ...(radioId ? { radioId } : {}),
          ...(source ? { source } : {}),
        }),
      });
      signal.throwIfAborted();
      setStatus('Processing queued. Refresh to view the result.');
    });
  const play = (jobId: string) =>
    run(async (signal) => {
      if (Platform.OS !== 'web')
        throw new Error('Audio preview is currently available in the browser.');
      const response = await apiFetch(
        session,
        `processing/jobs/${jobId}/audio`,
        { signal },
      );
      const audio = await response.blob();
      signal.throwIfAborted();
      setPreview(URL.createObjectURL(audio));
    });
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text accessibilityRole="header" style={styles.title}>
        Processing
      </Text>
      <Text style={styles.muted}>
        Choose where recordings and messages are processed. Cloud access
        requires an enabled profile.
      </Text>
      {status ? (
        <Text accessibilityRole="alert" style={styles.status}>
          {status}
        </Text>
      ) : null}
      <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.heading}>
          Speech and message jobs
        </Text>
        <Text style={styles.muted}>
          {radioId
            ? 'Select a communication as the source for transcription or analysis.'
            : 'Select a radio from the dashboard to load recordings.'}
        </Text>
        {communications
          .filter((communication) => !communication.deletedAt)
          .map((communication) => (
            <Action
              key={communication.id}
              label={`${new Date(communication.startedAt).toLocaleString()} · ${communication.frequencyHz ? (communication.frequencyHz / 1e6).toFixed(4) + ' MHz' : 'frequency unknown'}${communication.recording ? ' · recording' : ''}`}
              active={communicationId === communication.id}
              disabled={busy}
              onPress={() => setCommunicationId(communication.id)}
            />
          ))}
        {!profiles.length && (
          <Text style={styles.muted}>
            Add a provider connection and a processing profile below to run
            speech jobs.
          </Text>
        )}
        <Field
          label="Speech text"
          value={text}
          onChangeText={setText}
          multiline
        />
        <Text style={styles.muted}>
          Synthesis produces a private preview. Transmitting it requires the
          radio's authorized PTT workflow.
        </Text>
        <Action
          label="Run selected profile"
          disabled={busy || !selectedProfile}
          onPress={() => void submit()}
        />
        <Action
          label="Refresh jobs"
          disabled={busy}
          onPress={() => void run(async () => undefined)}
        />
        {jobs.map((job) => (
          <View style={styles.item} key={job.jobId}>
            <Text style={styles.label}>
              {job.task} · {job.state}
            </Text>
            {job.error ? <Text style={styles.status}>{job.error}</Text> : null}
            {job.result?.output.kind === 'transcript' ||
            job.result?.output.kind === 'summary' ? (
              <Text style={styles.body}>
                {job.result.output.text || '(No speech detected)'}
              </Text>
            ) : null}
            {job.result?.output.kind === 'audio' ? (
              <Action
                label="Listen to preview"
                disabled={busy}
                onPress={() => void play(job.jobId)}
              />
            ) : null}
            {job.result?.output.kind === 'audio' &&
            radioId &&
            onTransmitSpeech ? (
              <Action
                label="Transmit prepared speech"
                disabled={busy}
                onPress={() =>
                  void run(async (signal) => {
                    await onTransmitSpeech(job.jobId, radioId, signal);
                  })
                }
              />
            ) : null}
            {job.state === 'queued' || job.state === 'running' ? (
              <Action
                label="Cancel job"
                disabled={busy}
                onPress={() =>
                  void run(async (signal) => {
                    await apiRequest(session, `processing/jobs/${job.jobId}`, {
                      method: 'DELETE',
                      signal,
                    });
                  })
                }
              />
            ) : null}
          </View>
        ))}
        {preview && Platform.OS === 'web'
          ? createElement('audio', {
              controls: true,
              ref: previewAudio,
              src: preview,
              style: { width: '100%' },
            })
          : null}
      </View>
      <Disclosure title="Provider connections">
        {connections.map((connection) => (
          <View key={connection.connection.connectionId} style={styles.item}>
            <Action
              label={`${connection.displayName} · ${connection.status}${connection.hasCredentials ? ' · credentials protected' : ''}`}
              disabled={busy}
              active={connectionId === connection.connection.connectionId}
              onPress={() =>
                setConnectionId(connection.connection.connectionId)
              }
            />
            <Text style={styles.muted}>
              {connection.capabilities.join(' · ')}
            </Text>
            {connection.status !== 'revoked' ? (
              <ConfirmButton
                label="Revoke connection"
                variant="danger"
                confirmation={{
                  title: 'Revoke this provider connection?',
                  message:
                    'Processing jobs using this connection will no longer be able to use its credentials.',
                }}
                disabled={busy}
                onPress={() =>
                  void run(async (signal) => {
                    await apiRequest(
                      session,
                      `processing/connections/${connection.connection.connectionId}`,
                      { method: 'DELETE', signal },
                    );
                  })
                }
              />
            ) : null}
          </View>
        ))}
        <Text style={styles.label}>Add provider connection</Text>
        <View style={styles.options}>
          {connectors
            .filter(
              (connector) =>
                !connector.simulated &&
                connector.connectorId !== 'openai-subscription-oauth',
            )
            .map((connector) => (
              <Action
                key={connector.connectorId}
                label={connector.connectorId}
                active={provider === connector.connectorId}
                disabled={busy}
                onPress={() => {
                  setProvider(connector.connectorId);
                  setEndpoint(defaults[connector.connectorId] ?? '');
                  setSecret('');
                  setCapabilities(
                    connector.connectorId === 'openai-compatible'
                      ? ['text.structured']
                      : connector.capabilities,
                  );
                  setConfiguration(
                    connector.execution === 'local'
                      ? '{"allowPrivateNetwork":true}'
                      : '{}',
                  );
                }}
              />
            ))}
        </View>
        <Text style={styles.label}>
          Declare only capabilities supported by this endpoint
        </Text>
        <View style={styles.options}>
          {connectors
            .find((connector) => connector.connectorId === provider)
            ?.capabilities.map((capability) => (
              <Action
                key={capability}
                label={capability}
                active={capabilities.includes(capability)}
                disabled={busy}
                onPress={() =>
                  setCapabilities((current) =>
                    current.includes(capability)
                      ? current.filter((item) => item !== capability)
                      : [...current, capability],
                  )
                }
              />
            ))}
        </View>
        <Field label="Display name" value={name} onChangeText={setName} />
        <Field
          label="Provider endpoint"
          value={endpoint}
          onChangeText={setEndpoint}
        />
        <Field
          label="API key (stored encrypted)"
          value={secret}
          onChangeText={setSecret}
          secret
        />
        <Field
          label="Connection options (JSON)"
          value={configuration}
          onChangeText={setConfiguration}
          multiline
        />
        <Text style={styles.muted}>
          Azure synthesis requires ttsEndpoint in connection options. Local
          endpoints require allowPrivateNetwork: true. API-compatible providers
          may set protocol: "chat-completions".
        </Text>
        <Action
          label="Save connection"
          disabled={busy}
          onPress={() => void createConnection()}
        />
        <Text style={styles.label}>OpenAI subscription</Text>
        <Text style={styles.muted}>
          Link your own eligible account using the local subscription setup
          command. Import its protected registration through the authenticated
          server endpoint. Subscription access supports structured text only;
          speech requires a separate connection. Setup instructions are in the
          processing documentation.
        </Text>
      </Disclosure>
      {session.user.role === 'administrator' ? (
        <Disclosure title="Automatic RX transcription">
          <Text style={styles.muted}>
            Off until explicitly enabled for a radio and destination. Changing
            the endpoint, connection or profile revision requires new consent.
            User subscription connections cannot be used here.
          </Text>
          {consents.map((consent) => (
            <View key={consent.consentId} style={styles.item}>
              <Text style={styles.label}>
                Radio {consent.radioId} · profile revision{' '}
                {consent.profileRevision}
              </Text>
              <Text style={styles.muted}>
                {consent.endpoint} · service owner {consent.serviceOwnerUserId}
              </Text>
              <Action
                label="Disable automatic uploads"
                disabled={busy}
                onPress={() =>
                  void run(async (signal) => {
                    await apiRequest(
                      session,
                      `processing/background/${consent.radioId}`,
                      { method: 'DELETE', signal },
                    );
                    setStatus('Automatic uploads disabled for this radio.');
                  })
                }
              />
            </View>
          ))}
          <Text style={styles.label}>
            Selected radio: {radioId ?? 'Choose a radio first'}
          </Text>
          <Text style={styles.label}>
            Destination:{' '}
            {profileConnection?.endpoint ??
              'Select an instance-owned transcription profile'}
          </Text>
          <Text style={styles.muted}>
            Profile revision: {selectedProfile?.revision ?? 'none'}. Future
            received voice recordings on this radio will be sent to this exact
            provider endpoint.
          </Text>
          <Field
            label="Service-owner user ID"
            value={serviceOwnerUserId}
            onChangeText={setServiceOwnerUserId}
          />
          <SettingToggle
            label="I approve automatic uploads of this radio’s RX recordings to the displayed destination and profile revision."
            value={automaticConsent}
            onValueChange={setAutomaticConsent}
          />
          <Action
            label="Enable automatic uploads for this radio"
            disabled={
              busy ||
              !automaticConsent ||
              !radioId ||
              selectedProfile?.capability !== 'stt.batch' ||
              profileConnection?.connection.owner.kind !== 'instance'
            }
            onPress={() =>
              void run(async (signal) => {
                if (
                  !radioId ||
                  !selectedProfile ||
                  !profileConnection ||
                  !automaticConsent
                )
                  throw new Error(
                    'Select and explicitly approve a radio and transcription destination.',
                  );
                await apiRequest(session, 'processing/background/consent', {
                  method: 'PUT',
                  signal,
                  body: JSON.stringify({
                    radioId,
                    profileId: selectedProfile.profileId,
                    profileRevision: selectedProfile.revision,
                    endpoint: profileConnection.endpoint,
                    serviceOwnerUserId,
                    allowAutomaticUpload: true,
                  }),
                });
                signal.throwIfAborted();
                setAutomaticConsent(false);
                setStatus(
                  'Automatic RX uploads enabled for the displayed radio and destination.',
                );
              })
            }
          />
        </Disclosure>
      ) : null}
      <Disclosure title="Processing profiles">
        {profiles.map((profile) => (
          <Action
            key={profile.profileId}
            label={`${profile.task ?? profile.capability} · ${profile.model} · revision ${profile.revision}`}
            active={profileId === profile.profileId}
            disabled={busy}
            onPress={() => setProfileId(profile.profileId)}
          />
        ))}
        <Text style={styles.label}>New profile for selected connection</Text>
        <View style={styles.options}>
          {tasks
            .filter((task) =>
              selectedConnection?.capabilities.includes(task.capability),
            )
            .map((task) => (
              <Action
                key={`${task.taskId}:${task.version}`}
                label={task.taskId}
                active={taskId === task.taskId}
                disabled={busy}
                onPress={() => setTaskId(task.taskId)}
              />
            ))}
        </View>
        <Field
          label="Model or deployment name"
          value={model}
          onChangeText={setModel}
        />
        <Field
          label="Profile settings (JSON)"
          value={settings}
          onChangeText={setSettings}
          multiline
        />
        <Text style={styles.muted}>
          Speech synthesis requires voice. Azure also requires locale;
          transcription may set language. No credentials belong in these
          settings.
        </Text>
        <SettingToggle
          label="Allow cloud processing"
          value={allowCloud}
          onValueChange={setAllowCloud}
        />
        <Action
          label="Create profile"
          disabled={busy || !selectedConnection}
          onPress={() => void createProfile()}
        />
      </Disclosure>
    </ScrollView>
  );
}
function Field({
  label,
  value,
  onChangeText,
  secret = false,
  multiline = false,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  secret?: boolean;
  multiline?: boolean;
}) {
  const styles = useFeatureStyles('processing');
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        style={[styles.input, multiline && styles.multiline]}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secret}
        value={value}
        onChangeText={onChangeText}
        multiline={multiline}
      />
    </View>
  );
}

function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Options must be a JSON object.');
  return value as Record<string, unknown>;
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'The operation could not be completed.';
}
