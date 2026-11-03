import type { ClientSession } from '@signaldock/contracts';
import {
  Badge,
  Button,
  Chip,
  ChipGroup,
  Icon,
  Pressable,
  Text,
  useTheme,
  useToast,
} from '@signaldock/ui';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { submitJob } from '../processing-api';
import {
  buildJobRequest,
  communicationSummary,
  idempotencyKey,
  profileLabel,
  profilesFor,
  taskFor,
} from '../processing-model';
import type { ProcessingController } from '../useProcessing';
import { Field, Notice } from './common';
import { useProcessingStyles } from './styles';

const VISIBLE_SOURCES = 8;

/** Runs a transcription or text-analysis profile on a recorded communication. */
export function JobRunner({
  session,
  processing,
  radioId,
}: {
  session: ClientSession;
  processing: ProcessingController;
  radioId: string | undefined;
}) {
  const styles = useProcessingStyles();
  const { colors } = useTheme();
  const toast = useToast();
  const { profiles, tasks, connections, communications } = processing.data;
  const runnable = profilesFor(profiles, ['stt.batch', 'text.structured']);
  const [profileId, setProfileId] = useState<string>();
  const [communicationId, setCommunicationId] = useState<string>();
  const [text, setText] = useState('');
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    setCommunicationId(undefined);
    setText('');
    setShowAll(false);
  }, [radioId, session]);

  const profile = runnable.find((item) => item.profileId === profileId);
  const task = taskFor(tasks, profile?.task);
  const audio = task?.capability === 'stt.batch';
  const communication = communications.find(
    (item) => item.id === communicationId,
  );
  const request = buildJobRequest({
    profile,
    tasks,
    communication,
    text,
    radioId,
    now: 0,
    idempotencyKey: 'preview',
  });
  const sources = showAll
    ? communications
    : communications.slice(0, VISIBLE_SOURCES);

  const runJob = async () => {
    const built = buildJobRequest({
      profile,
      tasks,
      communication,
      text,
      radioId,
      now: Date.now(),
      idempotencyKey: idempotencyKey(Date.now(), Math.random),
    });
    if (!built.ok) return;
    const ok = await processing.run(async (signal) => {
      await submitJob(session, built.body, signal);
    });
    if (ok)
      toast.show({
        tone: 'success',
        message: 'Processing queued. Results appear in Jobs.',
      });
  };

  return (
    <View style={styles.panel}>
      <View style={styles.titleRow}>
        <Icon name="wave" size={20} color={colors.primary} />
        <Text accessibilityRole="header" style={[styles.heading, styles.grow]}>
          Transcribe or analyze
        </Text>
      </View>
      {runnable.length ? (
        <View style={styles.field}>
          <Text style={styles.label}>Profile</Text>
          <ChipGroup accessibilityLabel="Profile to run">
            {runnable.map((item) => (
              <Chip
                key={item.profileId}
                label={profileLabel(item, tasks, connections)}
                icon={item.capability === 'stt.batch' ? 'wave' : 'note'}
                selected={profileId === item.profileId}
                disabled={processing.busy}
                onPress={() => setProfileId(item.profileId)}
              />
            ))}
          </ChipGroup>
        </View>
      ) : (
        <Notice>
          Add a provider connection and a transcription or analysis profile to
          run jobs.
        </Notice>
      )}

      <View style={styles.field}>
        <Text style={styles.label}>Source</Text>
        <Text style={styles.caption}>
          {radioId
            ? 'Select a communication as the source for transcription or analysis.'
            : 'Select a radio from the dashboard to load recordings.'}
        </Text>
        {sources.map((item) => {
          const summary = communicationSummary(item);
          const selected = item.id === communicationId;
          const unusable = audio && !summary.hasRecording;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="radio"
              accessibilityLabel={`${summary.title}, ${summary.detail}${unusable ? ', no available recording' : ''}`}
              accessibilityState={{ checked: selected }}
              disabled={processing.busy}
              onPress={() => setCommunicationId(selected ? undefined : item.id)}
              style={[
                styles.cardPressable,
                selected && styles.cardSelected,
                unusable && styles.cardDisabled,
              ]}
            >
              <View style={styles.titleRow}>
                <Icon
                  name={summary.icon}
                  size={18}
                  color={selected ? colors.primary : colors.textSecondary}
                />
                <View style={styles.grow}>
                  <Text style={styles.label}>{summary.title}</Text>
                  <Text style={styles.caption}>{summary.detail}</Text>
                </View>
                {summary.hasRecording ? (
                  <Badge label="Recording" icon="play" />
                ) : null}
                {selected ? (
                  <Icon name="check" size={18} color={colors.primary} />
                ) : null}
              </View>
            </Pressable>
          );
        })}
        {communications.length > VISIBLE_SOURCES && !showAll ? (
          <Button
            variant="quiet"
            label={`Show all ${communications.length}`}
            onPress={() => setShowAll(true)}
          />
        ) : null}
      </View>

      {task?.capability === 'text.structured' &&
      !communication?.transcripts.length ? (
        <Field
          label="Text to analyze"
          value={text}
          onChangeText={setText}
          multiline
          hint="Used when the selected communication has no transcript."
        />
      ) : null}

      {!request.ok && profile ? (
        <Text style={styles.caption}>{request.error}</Text>
      ) : null}
      <View style={styles.actions}>
        <Button
          variant="primary"
          label="Run selected profile"
          loading={processing.busy}
          disabled={!request.ok}
          onPress={() => void runJob()}
        />
      </View>
    </View>
  );
}
