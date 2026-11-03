import AsyncStorage from '@react-native-async-storage/async-storage';
import type { RadioView, Tuning } from '@signaldock/contracts';
import {
  Button,
  Heading,
  SegmentedControl,
  StatusIndicator,
  Text,
  space,
  type,
  useTheme,
  useToast,
  type SegmentedOption,
} from '@signaldock/ui';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import {
  confidencePresentation,
  formatTuning,
  offsetPresets,
  useStation,
  type TuningMode,
} from '../../station';
import { BandBar } from './BandBar';
import { FrequencyDial } from './FrequencyDial';
import { FrequencyReadout } from './RadioFaceplate';
import {
  STEP_STORAGE_KEY,
  TUNING_STEPS_HZ,
  applyState,
  confirmedTuning,
  draftSeed,
  parseStoredStep,
  pendingTuning,
  stepLabel,
  tuningBlockReason,
  type TuningDraft,
} from './tuning-model';

/**
 * Tuning controls for the selected radio: digit dial, step, mode, TX offset,
 * band bar, the pending request and Apply / Revert. Every control edits a
 * local draft; only Apply sends a command (through `useStation().tune`).
 */
export function TuningPanel() {
  const station = useStation();
  const radio = station.selected;
  if (!radio)
    return (
      <PanelFrame>
        <Muted>Select a radio to tune it.</Muted>
      </PanelFrame>
    );
  // Keyed by radio so the draft never carries over to another radio.
  return <TuningPanelBody key={radio.radioId} radio={radio} />;
}

const stepOptions: SegmentedOption<string>[] = TUNING_STEPS_HZ.map((hz) => ({
  value: String(hz),
  label: stepLabel(hz),
  accessibilityLabel: `Step ${stepLabel(hz)}`,
}));

function TuningPanelBody({ radio }: { radio: RadioView }) {
  const { colors } = useTheme();
  const station = useStation();
  const toast = useToast();
  const snapshot = radio.snapshot;
  const capabilities = radio.descriptor?.capabilities;
  const ranges = useMemo(
    () => capabilities?.tuning.ranges ?? [],
    [capabilities?.tuning.ranges],
  );
  const modes = useMemo<readonly TuningMode[]>(
    () => capabilities?.tuning.modes ?? [],
    [capabilities?.tuning.modes],
  );
  const writable = capabilities?.tuning.writable === true;
  const txAudio = capabilities?.txAudio === true;

  const [stepHz, setStepHz] = useState<number>(parseStoredStep(undefined));
  useEffect(() => {
    let current = true;
    void AsyncStorage.getItem(STEP_STORAGE_KEY)
      .then((value) => {
        if (current && value !== null) setStepHz(parseStoredStep(value));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, []);
  function chooseStep(value: string) {
    const step = parseStoredStep(value);
    setStepHz(step);
    void AsyncStorage.setItem(STEP_STORAGE_KEY, String(step)).catch(() => {});
  }

  const [draft, setDraft] = useState<TuningDraft | undefined>(() =>
    draftSeed(snapshot, ranges, modes),
  );
  const [edited, setEdited] = useState(false);
  const [inFlight, setInFlight] = useState<Tuning | undefined>();
  const editedRef = useRef(edited);
  editedRef.current = edited;
  const seedInputs = useRef({ snapshot, ranges, modes });
  seedInputs.current = { snapshot, ranges, modes };

  // Follow the radio while the operator has not touched the draft.
  const generation = snapshot?.generation;
  const revision = snapshot?.revision;
  useEffect(() => {
    if (editedRef.current) return;
    const inputs = seedInputs.current;
    setDraft(draftSeed(inputs.snapshot, inputs.ranges, inputs.modes));
  }, [generation, revision, ranges, modes]);
  // A radio restart (new generation) always discards an edited draft.
  const lastGeneration = useRef(generation);
  useEffect(() => {
    if (lastGeneration.current === generation) return;
    lastGeneration.current = generation;
    const inputs = seedInputs.current;
    setEdited(false);
    setDraft(draftSeed(inputs.snapshot, inputs.ranges, inputs.modes));
  }, [generation]);

  function edit(next: Partial<TuningDraft>) {
    setDraft((current) => (current ? { ...current, ...next } : current));
    setEdited(true);
  }
  function revert() {
    setEdited(false);
    setDraft(draftSeed(snapshot, ranges, modes));
  }

  const confirmed = confirmedTuning(snapshot);
  const pending = pendingTuning(snapshot);
  const blockReason = tuningBlockReason({
    writable,
    canControl: station.canControl,
    controlState: station.controlState,
    leaseCurrent: Boolean(
      station.lease && station.lease.generation === snapshot?.generation,
    ),
    connection: snapshot?.connection,
    txState: snapshot?.txState,
    busy: station.busy,
  });
  const apply = applyState({
    draft,
    snapshot,
    ranges,
    modes,
    txAudio,
    blockReason:
      blockReason ??
      (station.editable ? undefined : 'Tuning is not available right now.'),
  });

  async function send() {
    const tuning = apply.tuning;
    if (!apply.enabled || !tuning) return;
    setInFlight(tuning);
    try {
      const result = await station.tune(tuning);
      if (result.ok) {
        setEdited(false);
        toast.show({
          message: result.message,
          tone: result.message.startsWith('Radio confirmed')
            ? 'success'
            : 'neutral',
        });
      } else toast.show({ message: result.error, tone: 'error' });
    } finally {
      setInFlight(undefined);
    }
  }

  if (!capabilities)
    return (
      <PanelFrame>
        <Muted>This radio has not reported its capabilities yet.</Muted>
      </PanelFrame>
    );

  if (!writable)
    return (
      <PanelFrame>
        <FrequencyReadout
          hz={confirmed?.rxHz}
          mode={confirmed?.mode}
          fontSize={32}
          confidence={
            confirmed
              ? confidencePresentation(snapshot?.tuningConfidence).style
              : 'none'
          }
        />
        <Muted>
          This driver does not support free tuning — use channel memories.
        </Muted>
      </PanelFrame>
    );

  // Listener-only accounts never get enabled write controls.
  const inputsDisabled = !station.canControl;
  const requested = pending ?? inFlight;
  const offsetOptions = draft
    ? offsetPresets(draft.rxHz, draft.offsetHz).map((preset) => ({
        value: preset.key,
        label:
          preset.kind === 'custom' ? `${preset.label} (custom)` : preset.label,
        accessibilityLabel:
          preset.kind === 'simplex'
            ? 'TX simplex'
            : `TX offset ${preset.label}`,
      }))
    : [];
  const note = apply.changed ? apply.reason : blockReason;

  return (
    <PanelFrame>
      {draft ? (
        <FrequencyDial
          valueHz={draft.rxHz}
          onChange={(rxHz) => edit({ rxHz })}
          ranges={ranges}
          stepHz={stepHz}
          disabled={inputsDisabled}
          onSubmit={() => void send()}
          onRevert={revert}
          accessibilityLabel="Draft RX frequency"
        />
      ) : (
        <Muted>No tuning information yet.</Muted>
      )}

      {/* Live regions stay mounted so new text is announced. */}
      <View
        accessibilityLiveRegion="polite"
        style={
          requested
            ? { flexDirection: 'row', alignItems: 'center' }
            : emptyLiveRegion
        }
      >
        {requested ? (
          <StatusIndicator
            tone="pending"
            pulse
            size="compact"
            label={
              pending
                ? `Requested ${formatTuning(pending)} · waiting for radio confirmation`
                : `Sending ${formatTuning(requested)}…`
            }
          />
        ) : null}
      </View>

      <ControlRow label="Step">
        <SegmentedControl
          size="compact"
          accessibilityLabel="Tuning step"
          options={stepOptions}
          value={String(stepHz)}
          onChange={chooseStep}
          disabled={inputsDisabled}
        />
      </ControlRow>
      <ControlRow label="Mode">
        <SegmentedControl<TuningMode>
          size="compact"
          accessibilityLabel="Mode"
          options={modes.map((mode) => ({ value: mode, label: mode }))}
          value={draft?.mode}
          onChange={(mode) => edit({ mode })}
          disabled={inputsDisabled || !draft}
        />
      </ControlRow>
      {txAudio && (
        <ControlRow label="TX offset">
          <SegmentedControl
            size="compact"
            accessibilityLabel="TX offset"
            options={offsetOptions}
            value={draft ? String(draft.offsetHz) : undefined}
            onChange={(key) => {
              const preset = offsetPresets(
                draft?.rxHz ?? 0,
                draft?.offsetHz ?? 0,
              ).find((item) => item.key === key);
              if (preset) edit({ offsetHz: preset.offsetHz });
            }}
            disabled={inputsDisabled || !draft}
          />
        </ControlRow>
      )}

      <BandBar
        ranges={ranges}
        {...(confirmed ? { confirmedHz: confirmed.rxHz } : {})}
        {...(pending ? { desiredHz: pending.rxHz } : {})}
        {...(draft ? { draftHz: draft.rxHz } : {})}
        stepHz={stepHz}
        onSelectHz={(rxHz) => edit({ rxHz })}
        disabled={inputsDisabled || !draft}
      />

      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: space.sm,
        }}
      >
        <Button
          variant="primary"
          label={apply.tuning ? `Apply ${formatTuning(apply.tuning)}` : 'Apply'}
          onPress={() => void send()}
          disabled={!apply.enabled}
          loading={inFlight !== undefined}
        />
        <Button
          variant="quiet"
          label="Revert"
          onPress={revert}
          disabled={!edited || inFlight !== undefined}
        />
      </View>
      <View
        accessibilityLiveRegion="polite"
        style={note ? undefined : emptyLiveRegion}
      >
        {note ? (
          <Text
            style={[
              type.caption,
              {
                color:
                  apply.changed && apply.reason
                    ? colors.warning
                    : colors.textSecondary,
              },
            ]}
          >
            {note}
          </Text>
        ) : null}
      </View>
    </PanelFrame>
  );
}

/** An empty, always-mounted live region that takes no space in the gap layout. */
const emptyLiveRegion = { position: 'absolute', width: 0, height: 0 } as const;

function PanelFrame({ children }: { children: ReactNode }) {
  return (
    <View style={{ gap: space.lg, minWidth: 0 }}>
      <Heading>Tuning</Heading>
      {children}
    </View>
  );
}

function ControlRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: space.md,
      }}
    >
      <Text
        style={[
          type.caption,
          { color: colors.textSecondary, minWidth: 72, fontWeight: '600' },
        ]}
      >
        {label}
      </Text>
      {children}
    </View>
  );
}

function Muted({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <Text style={{ color: colors.textSecondary }}>{children}</Text>;
}
