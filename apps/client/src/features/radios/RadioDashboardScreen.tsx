import { apiRequest } from '@signaldock/client-sdk';
import type {
  ControlLease,
  FeatureScreenProps,
  OperationContext,
  RadioConfiguration,
  RadioMemory,
  RadioSnapshot,
  RadioView,
} from '@signaldock/contracts';
import {
  Button,
  Disclosure,
  Icon,
  LoadingState,
  Pressable,
  ScrollView,
  SettingToggle,
  Text,
  TextInput,
  useFeatureStyles,
} from '@signaldock/ui';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { formatMegahertz, operationId, parseMegahertz } from './radio-input';

export function RadioDashboardScreen({
  session,
  radioId,
  onSelectRadio,
  audioPanel,
}: FeatureScreenProps & { audioPanel?: ReactNode }) {
  const styles = useFeatureStyles('radios');
  const [loaded, setLoaded] = useState(false);
  const [radios, setRadios] = useState<RadioView[]>([]);
  const [memories, setMemories] = useState<RadioMemory[]>([]);
  const [lease, setLease] = useState<ControlLease | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rx, setRx] = useState('');
  const [tx, setTx] = useState('');
  const [mode, setMode] = useState('FM');
  const leaseRef = useRef<ControlLease | null>(null);
  const epoch = useRef(0);
  const selected = radios.find((radio) => radio.radioId === radioId);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  function rememberLease(value: ControlLease | null) {
    leaseRef.current = value;
    setLease(value);
  }

  useEffect(() => {
    const version = ++epoch.current;
    const controller = new AbortController();
    setRadios([]);
    setLoaded(false);
    setMemories([]);
    setError('');
    setBusy(false);
    rememberLease(null);
    let loading = false;
    async function refresh() {
      if (loading) return;
      loading = true;
      try {
        const result = await apiRequest<RadioView[]>(session, 'radios', {
          signal: controller.signal,
        });
        if (epoch.current !== version) return;
        setRadios(result);
        setLoaded(true);
        const current = result.find((radio) => radio.radioId === radioId);
        const held = leaseRef.current;
        if (
          held &&
          (held.generation !== current?.snapshot?.generation ||
            current?.control?.grantId !== held.grantId)
        )
          rememberLease(null);
      } catch (failure) {
        if (!controller.signal.aborted && epoch.current === version)
          setError(message(failure));
      } finally {
        loading = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    const renewal = setInterval(() => {
      const held = leaseRef.current;
      if (!held || !radioId) return;
      void apiRequest<ControlLease>(
        session,
        `radios/${radioId}/control/renew`,
        {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({
            controlGrant: held.grantId,
            generation: held.generation,
          }),
        },
      )
        .then((value) => {
          if (
            epoch.current === version &&
            leaseRef.current?.grantId === held.grantId
          )
            rememberLease(value);
        })
        .catch((failure) => {
          if (!controller.signal.aborted && epoch.current === version) {
            rememberLease(null);
            setError(message(failure));
          }
        });
    }, 5000);
    return () => {
      ++epoch.current;
      controller.abort();
      clearInterval(timer);
      clearInterval(renewal);
      const held = leaseRef.current;
      leaseRef.current = null;
      if (held)
        void apiRequest(session, `radios/${held.radioId}/control`, {
          method: 'DELETE',
          body: JSON.stringify({
            controlGrant: held.grantId,
            generation: held.generation,
          }),
        }).catch(() => undefined);
    };
  }, [session.baseUrl, session.instanceId, session.accessToken, radioId]);

  useEffect(() => {
    const tuning = selected?.snapshot?.observedTuning;
    if (tuning) {
      setRx(formatMegahertz(tuning.rxHz));
      setTx(tuning.txHz === undefined ? '' : formatMegahertz(tuning.txHz));
      setMode(tuning.mode);
    } else {
      setRx('');
      setTx('');
      setMode('FM');
    }
  }, [radioId, selected?.snapshot?.generation, selected?.snapshot?.revision]);
  useEffect(() => {
    const controller = new AbortController();
    setMemories([]);
    if (radioId && selected?.descriptor?.capabilities.memories?.read)
      void apiRequest<RadioMemory[]>(session, `radios/${radioId}/memories`, {
        signal: controller.signal,
      })
        .then((items) => {
          if (!controller.signal.aborted) setMemories(items);
        })
        .catch((failure) => {
          if (!controller.signal.aborted) setError(message(failure));
        });
    return () => controller.abort();
  }, [
    session.baseUrl,
    session.instanceId,
    session.accessToken,
    radioId,
    selected?.snapshot?.generation,
    selected?.snapshot?.revision,
  ]);

  async function run(work: () => Promise<void>) {
    const version = epoch.current;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (failure) {
      if (epoch.current === version) setError(message(failure));
    } finally {
      if (epoch.current === version) setBusy(false);
    }
  }
  function context(): OperationContext {
    const current = selectedRef.current?.snapshot;
    const held = leaseRef.current;
    if (!current || !held || current.generation !== held.generation)
      throw new Error('Take control before changing the radio.');
    return {
      operationId: operationId(),
      radioId: current.radioId,
      generation: current.generation,
      expectedRevision: current.revision,
      controlGrant: held.grantId,
      fencing: held.fencing,
      deadline: new Date(Date.now() + 5000).toISOString(),
    };
  }
  function updateSnapshot(snapshot: RadioSnapshot) {
    setRadios((previous) =>
      previous.map((radio) =>
        radio.radioId === snapshot.radioId ? { ...radio, snapshot } : radio,
      ),
    );
  }
  const controlAllowed = session.user.radioPermissions.some(
    (entry) =>
      entry.radioId === radioId && entry.permissions.includes('radio.control'),
  );
  const editable = Boolean(
    lease &&
    selected?.snapshot?.connection === 'ready' &&
    selected.snapshot.txState === 'idle' &&
    !busy,
  );
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text accessibilityRole="header" style={styles.title}>
        Radios
      </Text>
      <Text style={styles.muted}>
        Select a radio to view its confirmed state. Selection never changes its
        frequency.
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      {!loaded && !error && <LoadingState label="Loading station radios…" />}
      {loaded && !error && !radios.length ? (
        <Text style={styles.muted}>
          No radios are assigned to this account. An administrator can configure
          a radio and assign its permissions.
        </Text>
      ) : null}
      <View style={styles.cards}>
        {radios.map((radio) => (
          <Pressable
            key={radio.radioId}
            accessibilityRole="button"
            accessibilityLabel={`Select ${radio.displayName}`}
            accessibilityState={{ selected: radio.radioId === radioId }}
            onPress={() => onSelectRadio?.(radio.radioId)}
            style={[styles.card, radio.radioId === radioId && styles.selected]}
          >
            <View style={styles.row}>
              <Icon name="radio" />
              <Text accessibilityRole="header" style={styles.heading}>
                {radio.displayName}
              </Text>
              <Text style={styles.small}>
                {radio.radioId === radioId ? 'Selected' : 'Select radio'}
              </Text>
            </View>
            <Text style={styles.frequency}>
              {radio.snapshot?.observedTuning
                ? `${formatMegahertz(radio.snapshot.observedTuning.rxHz)} MHz`
                : 'Frequency unavailable'}
            </Text>
            <Text style={styles.small}>
              {radio.health.state} · {radio.snapshot?.txState ?? 'unknown'} ·{' '}
              {radio.snapshot?.tuningConfidence ?? 'unknown'} ·{' '}
              {radio.descriptor?.capabilities.verification ?? 'Unverified'}
            </Text>
          </Pressable>
        ))}
      </View>
      {selected ? (
        <View style={styles.panel}>
          <Text accessibilityRole="header" style={styles.heading}>
            Operate {selected.displayName}
          </Text>
          <Text style={styles.muted}>
            {lease
              ? 'You control this radio.'
              : selected.control
                ? 'Another session controls this radio.'
                : 'Control is available.'}
          </Text>
          <Button
            title={lease ? 'Release control' : 'Take control'}
            variant={lease ? 'secondary' : 'primary'}
            disabled={
              busy ||
              !controlAllowed ||
              selected.snapshot?.connection !== 'ready'
            }
            onPress={() =>
              void run(async () => {
                const version = epoch.current;
                if (lease) {
                  await apiRequest(
                    session,
                    `radios/${selected.radioId}/control`,
                    {
                      method: 'DELETE',
                      body: JSON.stringify({
                        controlGrant: lease.grantId,
                        generation: lease.generation,
                      }),
                    },
                  );
                  if (epoch.current === version) rememberLease(null);
                } else {
                  const value = await apiRequest<ControlLease>(
                    session,
                    `radios/${selected.radioId}/control`,
                    { method: 'POST' },
                  );
                  if (epoch.current === version) rememberLease(value);
                  else
                    void apiRequest(
                      session,
                      `radios/${selected.radioId}/control`,
                      {
                        method: 'DELETE',
                        body: JSON.stringify({
                          controlGrant: value.grantId,
                          generation: value.generation,
                        }),
                      },
                    ).catch(() => undefined);
                }
              })
            }
          />
          <Text style={styles.label}>RX frequency (MHz)</Text>
          <TextInput
            style={styles.input}
            value={rx}
            onChangeText={setRx}
            editable={
              editable && selected.descriptor?.capabilities.tuning.writable
            }
            keyboardType="decimal-pad"
            accessibilityLabel="RX frequency in MHz"
          />
          {selected.descriptor?.capabilities.txAudio ? (
            <>
              <Text style={styles.label}>
                TX frequency (MHz, blank follows RX)
              </Text>
              <TextInput
                style={styles.input}
                value={tx}
                onChangeText={setTx}
                editable={
                  editable && selected.descriptor.capabilities.tuning.writable
                }
                keyboardType="decimal-pad"
                accessibilityLabel="TX frequency in MHz"
              />
            </>
          ) : null}
          <View style={styles.row}>
            {selected.descriptor?.capabilities.tuning.modes.map((item) => (
              <Button
                key={item}
                title={item === mode ? `${item} selected` : item}
                onPress={() => setMode(item)}
                disabled={!editable}
              />
            ))}
          </View>
          <Button
            title={busy ? 'Applying…' : 'Apply frequency'}
            disabled={
              !editable || !selected.descriptor?.capabilities.tuning.writable
            }
            onPress={() =>
              void run(async () => {
                const requestContext = context();
                const version = epoch.current;
                const snapshot = await apiRequest<RadioSnapshot>(
                  session,
                  `radios/${selected.radioId}/operations`,
                  {
                    method: 'POST',
                    body: JSON.stringify({
                      context: requestContext,
                      tuning: {
                        rxHz: parseMegahertz(rx),
                        ...(tx ? { txHz: parseMegahertz(tx) } : {}),
                        mode,
                      },
                    }),
                  },
                );
                if (epoch.current === version) updateSnapshot(snapshot);
              })
            }
          />
          {!selected.descriptor?.capabilities.tuning.writable ? (
            <Text style={styles.muted}>
              This driver does not advertise writable tuning.
            </Text>
          ) : null}
          <Disclosure title="Channel memories">
            {memories.map((memory) => (
              <View key={memory.memoryId} style={styles.memory}>
                <Text>
                  {memory.name} · {formatMegahertz(memory.tuning.rxHz)} MHz
                  {selected.snapshot?.selectedMemoryId === memory.memoryId
                    ? ' · Active'
                    : ''}
                </Text>
                <Button
                  title="Recall"
                  disabled={
                    !editable ||
                    !selected.descriptor?.capabilities.memories?.select
                  }
                  onPress={() =>
                    void run(async () => {
                      const version = epoch.current;
                      const snapshot = await apiRequest<RadioSnapshot>(
                        session,
                        `radios/${selected.radioId}/memories/${encodeURIComponent(memory.memoryId)}/select`,
                        { method: 'POST', body: JSON.stringify(context()) },
                      );
                      if (epoch.current === version) updateSnapshot(snapshot);
                    })
                  }
                />
                <Button
                  title="Store current inputs"
                  disabled={
                    !editable ||
                    !selected.descriptor?.capabilities.memories?.write
                  }
                  onPress={() =>
                    void run(async () => {
                      const version = epoch.current;
                      const saved = await apiRequest<RadioMemory>(
                        session,
                        `radios/${selected.radioId}/memories/${encodeURIComponent(memory.memoryId)}`,
                        {
                          method: 'PUT',
                          body: JSON.stringify({
                            context: context(),
                            memory: {
                              ...memory,
                              tuning: {
                                rxHz: parseMegahertz(rx),
                                ...(tx ? { txHz: parseMegahertz(tx) } : {}),
                                mode,
                              },
                            },
                          }),
                        },
                      );
                      const snapshot = await apiRequest<RadioSnapshot>(
                        session,
                        `radios/${selected.radioId}/state`,
                      );
                      if (epoch.current === version) {
                        setMemories((items) =>
                          items.map((item) =>
                            item.memoryId === saved.memoryId ? saved : item,
                          ),
                        );
                        updateSnapshot(snapshot);
                      }
                    })
                  }
                />
              </View>
            ))}
            {!memories.length ? (
              <Text style={styles.muted}>
                No readable memories are available.
              </Text>
            ) : null}
          </Disclosure>
        </View>
      ) : null}
      {audioPanel}
      {session.user.role === 'administrator' ? (
        <Disclosure title="Station radio configuration">
          <RadioConfigurationPanel session={session} />
        </Disclosure>
      ) : null}
    </ScrollView>
  );
}

function RadioConfigurationPanel({
  session,
}: Pick<FeatureScreenProps, 'session'>) {
  const styles = useFeatureStyles('radios');
  const [configurations, setConfigurations] = useState<RadioConfiguration[]>(
    [],
  );
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [driver, setDriver] = useState('simulator.tunable');
  const [endpoint, setEndpoint] = useState('');
  const [groups, setGroups] = useState('');
  const [config, setConfig] = useState('{}');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const version = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    ++version.current;
    setConfigurations([]);
    setId('');
    setName('');
    setDriver('simulator.tunable');
    setGroups('');
    setEnabled(true);
    setSaving(false);
    setEndpoint('');
    setConfig('{}');
    setError('');
    void apiRequest<RadioConfiguration[]>(session, 'radios/configurations', {
      signal: controller.signal,
    })
      .then((items) => {
        if (!controller.signal.aborted) setConfigurations(items);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(message(failure));
      });
    return () => {
      ++version.current;
      controller.abort();
    };
  }, [session.baseUrl, session.instanceId, session.accessToken]);
  return (
    <View style={styles.panel}>
      <Text accessibilityRole="header" style={styles.title}>
        Radio configuration
      </Text>
      <Text style={styles.muted}>
        Install a driver connector before configuring it. Configuring a radio
        does not grant operational access.
      </Text>
      {configurations.map((item) => (
        <Button
          key={item.radioId}
          title={`Edit ${item.displayName}`}
          onPress={() => {
            setId(item.radioId);
            setName(item.displayName);
            setDriver(item.driverId);
            setEndpoint(item.endpoint ?? '');
            setGroups(item.resourceGroupIds.join(', '));
            setConfig(JSON.stringify(item.config, null, 2));
            setEnabled(item.enabled);
          }}
        />
      ))}
      <Text style={styles.label}>Radio ID (blank creates a new radio)</Text>
      <TextInput
        style={styles.input}
        value={id}
        onChangeText={setId}
        autoCapitalize="none"
        accessibilityLabel="Radio ID"
      />
      <Text style={styles.label}>Display name</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        accessibilityLabel="Radio display name"
      />
      <Text style={styles.label}>Driver ID</Text>
      <TextInput
        style={styles.input}
        value={driver}
        onChangeText={setDriver}
        autoCapitalize="none"
        accessibilityLabel="Driver ID"
      />
      <Text style={styles.label}>Private driver endpoint</Text>
      <TextInput
        style={styles.input}
        value={endpoint}
        onChangeText={setEndpoint}
        autoCapitalize="none"
        accessibilityLabel="Private driver endpoint"
      />
      <Text style={styles.label}>Shared resource groups (comma separated)</Text>
      <TextInput
        style={styles.input}
        value={groups}
        onChangeText={setGroups}
        autoCapitalize="none"
        accessibilityLabel="Resource groups"
      />
      <Text style={styles.label}>
        Connector configuration (JSON, credential references only)
      </Text>
      <TextInput
        style={styles.input}
        value={config}
        onChangeText={setConfig}
        multiline
        autoCapitalize="none"
        accessibilityLabel="Connector configuration"
      />
      <SettingToggle
        label="Radio enabled"
        value={enabled}
        onValueChange={setEnabled}
      />
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <Button
        title={saving ? 'Saving…' : 'Save configuration'}
        disabled={saving || !name.trim() || !driver.trim()}
        onPress={() =>
          void (async () => {
            const current = version.current;
            setSaving(true);
            setError('');
            try {
              const saved = await apiRequest<RadioConfiguration>(
                session,
                'radios',
                {
                  method: 'POST',
                  body: JSON.stringify({
                    radioId: id.trim() || operationId(),
                    displayName: name.trim(),
                    driverId: driver.trim(),
                    ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}),
                    resourceGroupIds: groups
                      .split(',')
                      .map((value) => value.trim())
                      .filter(Boolean),
                    enabled,
                    config: JSON.parse(config),
                  }),
                },
              );
              if (version.current === current) {
                setId(saved.radioId);
                const items = await apiRequest<RadioConfiguration[]>(
                  session,
                  'radios/configurations',
                );
                if (version.current === current) setConfigurations(items);
              }
            } catch (failure) {
              if (version.current === current) setError(message(failure));
            } finally {
              if (version.current === current) setSaving(false);
            }
          })()
        }
      />
    </View>
  );
}
function message(failure: unknown): string {
  return failure instanceof Error
    ? failure.message
    : 'The radio request failed.';
}

export default RadioDashboardScreen;
