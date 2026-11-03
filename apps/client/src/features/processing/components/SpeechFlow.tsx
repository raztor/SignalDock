import type { ClientSession, ProcessingJobView } from '@signaldock/contracts';
import {
  Button,
  Chip,
  ChipGroup,
  ConfirmDialog,
  Icon,
  StatusIndicator,
  Stepper,
  Text,
  useScreenActive,
  useTheme,
  useToast,
  type StatusTone,
} from '@signaldock/ui';
import { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { submitJob } from '../processing-api';
import {
  buildJobRequest,
  idempotencyKey,
  profileLabel,
  profilesFor,
  SPEECH_STEPS,
  speechFlowState,
  type GeneratedSpeech,
} from '../processing-model';
import type { ProcessingController } from '../useProcessing';
import { Field, Notice } from './common';
import { PreviewAudio } from './PreviewAudio';
import { useProcessingStyles } from './styles';

export type TransmitSpeech = (
  jobId: string,
  radioId: string,
  signal: AbortSignal,
) => Promise<void>;

export interface SpeechFlowProps {
  /**
   * False while the Speech & jobs section is hidden behind another Processing
   * section. A hidden flow cannot show its ON-AIR banner or Stop button, so a
   * transmission in progress is aborted.
   */
  visible?: boolean | undefined;
  session: ClientSession;
  processing: ProcessingController;
  radioId: string | undefined;
  radioName: string | undefined;
  onTransmitSpeech?: TransmitSpeech | undefined;
  /** Display-only radio gate (permissions, capabilities, state); the server decides. */
  radioBlockedReason?: string | undefined;
  generated: GeneratedSpeech | undefined;
  onGenerated(next: GeneratedSpeech | undefined): void;
  text: string;
  onText(text: string): void;
  preview: { jobId: string; url: string } | undefined;
  previewed: boolean;
  onListen(jobId: string): void;
  onPreviewPlayed(jobId: string): void;
}

const previewSupported = Platform.OS === 'web';

/**
 * Edit → Generate → Preview → Transmit. Nothing is transmitted until the
 * operator presses Transmit and confirms; leaving the screen or the Speech &
 * jobs section, changing radio or session, or pressing Stop aborts a
 * transmission in progress.
 */
export function SpeechFlow({
  visible = true,
  session,
  processing,
  radioId,
  radioName,
  onTransmitSpeech,
  radioBlockedReason,
  generated,
  onGenerated,
  text,
  onText,
  preview,
  previewed,
  onListen,
  onPreviewPlayed,
}: SpeechFlowProps) {
  const styles = useProcessingStyles();
  const { colors } = useTheme();
  const toast = useToast();
  const active = useScreenActive();
  const { profiles, tasks, connections, jobs } = processing.data;
  const speechProfiles = profilesFor(profiles, ['tts.synthesize']);
  const [profileId, setProfileId] = useState<string>();
  const [acknowledged, setAcknowledged] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [transmitting, setTransmitting] = useState(false);
  const [transmitted, setTransmitted] = useState<string>();
  const [submitted, setSubmitted] = useState<ProcessingJobView>();
  const transmission = useRef<AbortController | null>(null);

  const profile =
    speechProfiles.find((item) => item.profileId === profileId) ??
    (speechProfiles.length === 1 ? speechProfiles[0] : undefined);
  const job =
    jobs.find((item) => item.jobId === generated?.jobId) ??
    (submitted?.jobId === generated?.jobId ? submitted : undefined);
  const jobId = generated?.jobId;
  const state = speechFlowState({
    text,
    profile,
    generated,
    job,
    previewed:
      jobId !== undefined &&
      (previewSupported ? previewed : acknowledged === jobId),
    previewSupported,
    radioId,
    radioName,
    canTransmit: Boolean(onTransmitSpeech),
    radioBlockedReason,
    transmitting,
    transmitted: jobId !== undefined && transmitted === jobId,
    busy: processing.busy,
  });

  // Prepared speech is transmission: stop it when the screen is left.
  useEffect(() => {
    if (!active)
      transmission.current?.abort(
        new Error('Transmission stopped because you left Processing.'),
      );
    else if (!visible)
      transmission.current?.abort(
        new Error('Transmission stopped because you left Speech & jobs.'),
      );
  }, [active, visible]);
  useEffect(
    () => () => transmission.current?.abort(new Error('Transmission stopped.')),
    [],
  );
  // A different radio or session never inherits a pending confirmation.
  useEffect(() => {
    setConfirming(false);
    setTransmitted(undefined);
  }, [radioId, session]);

  const generate = async () => {
    const value = text.trim();
    const request = buildJobRequest({
      profile,
      tasks,
      communication: undefined,
      text: value,
      radioId,
      now: Date.now(),
      idempotencyKey: idempotencyKey(Date.now(), Math.random),
    });
    if (!request.ok) {
      toast.show({ tone: 'error', message: request.error });
      return;
    }
    let view: ProcessingJobView | undefined;
    const ok = await processing.run(async (signal) => {
      view = await submitJob(session, request.body, signal);
      signal.throwIfAborted();
    });
    if (ok && view) {
      setSubmitted(view);
      onGenerated({ jobId: view.jobId, text: value });
      toast.show({ message: 'Generating a private speech preview.' });
    }
  };

  const transmit = async () => {
    setConfirming(false);
    if (!state.transmit.enabled || !jobId || !radioId || !onTransmitSpeech)
      return;
    const controller = new AbortController();
    transmission.current = controller;
    setTransmitting(true);
    const ok = await processing.run(
      (signal) => onTransmitSpeech(jobId, radioId, signal),
      { signal: controller.signal, reload: false },
    );
    if (transmission.current === controller) transmission.current = null;
    setTransmitting(false);
    if (ok) {
      setTransmitted(jobId);
      toast.show({
        tone: 'success',
        message: `Prepared speech transmitted${radioName ? ` on ${radioName}` : ''}.`,
      });
    } else if (controller.signal.aborted) {
      toast.show({ tone: 'warning', message: 'Transmission stopped.' });
    }
  };

  const tone: StatusTone = state.stale
    ? 'warning'
    : transmitting
      ? 'error'
      : state.step >= 2
        ? 'ok'
        : generated
          ? 'pending'
          : 'off';

  return (
    <View style={styles.panel}>
      <View style={styles.titleRow}>
        <Icon name="mic" size={20} color={colors.primary} />
        <Text accessibilityRole="header" style={[styles.heading, styles.grow]}>
          Prepared speech
        </Text>
      </View>
      <Stepper steps={SPEECH_STEPS} current={state.step} />

      {speechProfiles.length ? (
        speechProfiles.length > 1 ? (
          <View style={styles.field}>
            <Text style={styles.label}>Speech profile</Text>
            <ChipGroup accessibilityLabel="Speech profile">
              {speechProfiles.map((item) => (
                <Chip
                  key={item.profileId}
                  label={profileLabel(item, tasks, connections)}
                  icon="mic"
                  selected={profile?.profileId === item.profileId}
                  disabled={processing.busy || transmitting}
                  onPress={() => setProfileId(item.profileId)}
                />
              ))}
            </ChipGroup>
          </View>
        ) : profile ? (
          <Text style={styles.caption}>
            Profile: {profileLabel(profile, tasks, connections)}
          </Text>
        ) : null
      ) : (
        <Notice tone="warning">
          Create a speech synthesis profile in Profiles to prepare speech.
        </Notice>
      )}

      <Field
        label="Speech text"
        value={text}
        onChangeText={onText}
        multiline
        disabled={transmitting}
        placeholder="Write the message to speak on the radio."
      />

      <StatusIndicator
        tone={tone}
        label={state.status}
        pulse={transmitting || (state.step === 1 && !state.stale)}
      />

      {preview && preview.jobId === jobId && !state.stale ? (
        <PreviewAudio
          url={preview.url}
          label="Speech preview"
          onPlay={() => onPreviewPlayed(preview.jobId)}
        />
      ) : null}

      {transmitting ? (
        <View style={styles.onAir} accessibilityLiveRegion="assertive">
          <Icon name="tx" size={20} color={colors.error} />
          <Text style={[styles.label, styles.grow, { color: colors.error }]}>
            On air · {radioName ?? 'radio'}
          </Text>
          <Button
            variant="danger"
            label="Stop"
            onPress={() =>
              transmission.current?.abort(new Error('Transmission stopped.'))
            }
          />
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button
          variant={state.step === 0 ? 'primary' : 'secondary'}
          label={
            generated && !state.stale ? 'Generate again' : 'Generate preview'
          }
          disabled={!state.generate.enabled || transmitting}
          onPress={() => void generate()}
        />
        {previewSupported ? (
          <Button
            variant={state.step === 2 ? 'primary' : 'secondary'}
            label="Listen to preview"
            disabled={
              !state.preview.enabled ||
              transmitting ||
              (preview?.jobId === jobId && preview !== undefined)
            }
            onPress={() => jobId && onListen(jobId)}
          />
        ) : (
          <Button
            variant={state.step === 2 ? 'primary' : 'secondary'}
            label={
              acknowledged === jobId && jobId
                ? 'Text reviewed'
                : 'I reviewed the text'
            }
            active={acknowledged === jobId && jobId !== undefined}
            disabled={!state.preview.enabled || transmitting}
            onPress={() => setAcknowledged(jobId)}
          />
        )}
        {onTransmitSpeech ? (
          <Button
            variant="danger"
            label={radioName ? `Transmit on ${radioName}` : 'Transmit'}
            disabled={!state.transmit.enabled}
            onPress={() => setConfirming(true)}
          />
        ) : null}
      </View>
      {!state.transmit.enabled && state.step >= 2 && !transmitting ? (
        <Text style={styles.caption}>{state.transmit.reason}</Text>
      ) : null}
      {!previewSupported ? (
        <Text style={styles.caption}>
          Audio preview is currently available in the browser.
        </Text>
      ) : null}
      <Text style={styles.caption}>
        Synthesis produces a private preview. Transmitting it requires the
        radio's authorized PTT workflow and your confirmation.
      </Text>

      <ConfirmDialog
        visible={confirming}
        title="Transmit prepared speech?"
        message={`SignalDock will take control of ${radioName ?? 'the selected radio'} and key the transmitter to play this preview. Transmission stops if you leave this screen or press Stop.`}
        confirmLabel="Transmit"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void transmit()}
      />
    </View>
  );
}
