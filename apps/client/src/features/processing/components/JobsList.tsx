import type { ClientSession, ProcessingJobView } from '@signaldock/contracts';
import { Button, StatusIndicator, Text, useToast } from '@signaldock/ui';
import { useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import { cancelJob } from '../processing-api';
import {
  jobOutput,
  jobPresentation,
  jobTitle,
  sortJobs,
} from '../processing-model';
import type { ProcessingController } from '../useProcessing';
import { IconBox, ProgressBar } from './common';
import { PreviewAudio } from './PreviewAudio';
import { useProcessingStyles } from './styles';

const PAGE = 12;

export interface JobsListProps {
  session: ClientSession;
  processing: ProcessingController;
  preview: { jobId: string; url: string } | undefined;
  /** Job whose preview is shown by the speech flow instead of here. */
  flowJobId: string | undefined;
  onListen(jobId: string): void;
  onPreviewPlayed(jobId: string): void;
  /** Opens a speech preview in the Edit → Generate → Preview → Transmit flow. */
  onUseForSpeech?(jobId: string): void;
}

export function JobsList({
  session,
  processing,
  preview,
  flowJobId,
  onListen,
  onPreviewPlayed,
  onUseForSpeech,
}: JobsListProps) {
  const styles = useProcessingStyles();
  const [limit, setLimit] = useState(PAGE);
  const jobs = useMemo(
    () => sortJobs(processing.data.jobs),
    [processing.data.jobs],
  );
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text accessibilityRole="header" style={styles.heading}>
          Jobs
        </Text>
        <Button
          variant="quiet"
          label="Refresh jobs"
          disabled={processing.busy}
          onPress={processing.reload}
        />
      </View>
      {jobs.length ? (
        <View style={styles.section}>
          {jobs.slice(0, limit).map((job) => (
            <JobRow
              key={job.jobId}
              job={job}
              session={session}
              processing={processing}
              preview={
                preview?.jobId === job.jobId && job.jobId !== flowJobId
                  ? preview.url
                  : undefined
              }
              inFlow={job.jobId === flowJobId}
              onListen={onListen}
              onPreviewPlayed={onPreviewPlayed}
              onUseForSpeech={onUseForSpeech}
            />
          ))}
          {jobs.length > limit ? (
            <Button
              label={`Show ${Math.min(PAGE, jobs.length - limit)} more`}
              onPress={() => setLimit(limit + PAGE)}
            />
          ) : null}
        </View>
      ) : processing.loaded ? (
        <Text style={styles.muted}>No jobs yet.</Text>
      ) : null}
    </View>
  );
}

function JobRow({
  job,
  session,
  processing,
  preview,
  inFlow,
  onListen,
  onPreviewPlayed,
  onUseForSpeech,
}: {
  job: ProcessingJobView;
  session: ClientSession;
  processing: ProcessingController;
  preview: string | undefined;
  inFlow: boolean;
  onListen(jobId: string): void;
  onPreviewPlayed(jobId: string): void;
  onUseForSpeech?: ((jobId: string) => void) | undefined;
}) {
  const styles = useProcessingStyles();
  const toast = useToast();
  const presentation = jobPresentation(job.state);
  const output = jobOutput(job);
  const title = jobTitle(job, processing.data.tasks);
  const created = new Date(job.createdAt).toLocaleString();
  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <IconBox name={presentation.icon} />
        <View style={styles.grow}>
          <Text style={styles.label}>{title}</Text>
          <Text style={styles.caption}>{created}</Text>
        </View>
        <StatusIndicator
          tone={presentation.tone}
          label={presentation.label}
          pulse={presentation.pulse}
          size="compact"
        />
      </View>
      {presentation.active ? (
        <ProgressBar
          fraction={presentation.progress}
          tone={presentation.tone === 'warning' ? 'warning' : 'primary'}
          label={`${title}: ${presentation.label}`}
        />
      ) : null}
      {job.error ? <Text style={styles.errorCaption}>{job.error}</Text> : null}
      {output.kind === 'text' || output.kind === 'data' ? (
        <View style={styles.field}>
          <Text style={styles.caption}>{output.label}</Text>
          <Text selectable style={styles.body}>
            {output.text}
          </Text>
        </View>
      ) : null}
      {output.kind === 'audio' ? (
        <View style={styles.field}>
          <Text style={styles.caption}>
            {output.label}
            {output.detail ? ` · ${output.detail}` : ''}
            {inFlow ? ' · open in Prepared speech' : ''}
          </Text>
          {preview ? (
            <PreviewAudio
              url={preview}
              label={`${title} preview`}
              onPlay={() => onPreviewPlayed(job.jobId)}
            />
          ) : null}
        </View>
      ) : null}
      <View style={styles.actions}>
        {output.kind === 'audio' && !inFlow ? (
          <>
            {Platform.OS === 'web' && !preview ? (
              <Button
                label="Listen to preview"
                disabled={processing.busy}
                onPress={() => onListen(job.jobId)}
              />
            ) : null}
            {onUseForSpeech ? (
              <Button
                label="Use for transmission"
                disabled={processing.busy}
                onPress={() => onUseForSpeech(job.jobId)}
              />
            ) : null}
          </>
        ) : null}
        {presentation.cancellable ? (
          <Button
            variant="danger"
            label="Cancel job"
            disabled={processing.busy}
            onPress={() =>
              void processing
                .run((signal) => cancelJob(session, job.jobId, signal))
                .then((ok) => {
                  if (ok) toast.show({ message: 'Job cancelled.' });
                })
            }
          />
        ) : null}
      </View>
    </View>
  );
}
