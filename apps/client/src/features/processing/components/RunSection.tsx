import type { ClientSession } from '@signaldock/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { fetchPreviewAudio } from '../processing-api';
import type { GeneratedSpeech } from '../processing-model';
import type { ProcessingController } from '../useProcessing';
import { JobRunner } from './JobRunner';
import { JobsList } from './JobsList';
import { SpeechFlow, type TransmitSpeech } from './SpeechFlow';
import { useProcessingStyles } from './styles';

interface Preview {
  jobId: string;
  url: string;
}

/** Speech flow, job runner and jobs list, sharing one preview player state. */
export function RunSection({
  visible = true,
  session,
  processing,
  radioId,
  radioName,
  onTransmitSpeech,
  radioBlockedReason,
}: {
  /** False while another Processing section is shown (kept mounted, hidden). */
  visible?: boolean;
  session: ClientSession;
  processing: ProcessingController;
  radioId: string | undefined;
  radioName: string | undefined;
  onTransmitSpeech?: TransmitSpeech | undefined;
  radioBlockedReason?: string | undefined;
}) {
  const styles = useProcessingStyles();
  const [preview, setPreview] = useState<Preview>();
  const [previewed, setPreviewed] = useState<ReadonlySet<string>>(new Set());
  const [generated, setGenerated] = useState<GeneratedSpeech>();
  const [text, setText] = useState('');
  const latest = useRef<Preview | undefined>(undefined);

  // Object URLs are revoked on replacement and unmount.
  useEffect(() => {
    const previous = latest.current;
    latest.current = preview;
    if (previous && previous !== preview && Platform.OS === 'web')
      URL.revokeObjectURL(previous.url);
  }, [preview]);
  useEffect(
    () => () => {
      if (latest.current && Platform.OS === 'web')
        URL.revokeObjectURL(latest.current.url);
    },
    [],
  );

  // A new session or radio starts from a clean, private state.
  useEffect(() => {
    setPreview(undefined);
    setPreviewed(new Set());
    setGenerated(undefined);
    setText('');
  }, [session, radioId]);

  const listen = useCallback(
    (jobId: string) => {
      void processing.run(
        async (signal) => {
          if (Platform.OS !== 'web')
            throw new Error(
              'Audio preview is currently available in the browser.',
            );
          const blob = await fetchPreviewAudio(session, jobId, signal);
          signal.throwIfAborted();
          setPreview({ jobId, url: URL.createObjectURL(blob) });
        },
        { reload: false },
      );
    },
    [processing, session],
  );

  const played = useCallback((jobId: string) => {
    setPreviewed((current) =>
      current.has(jobId) ? current : new Set([...current, jobId]),
    );
  }, []);

  const openInSpeechFlow = useCallback((jobId: string) => {
    setGenerated({ jobId });
    setText('');
  }, []);

  return (
    <View style={styles.section}>
      <SpeechFlow
        visible={visible}
        session={session}
        processing={processing}
        radioId={radioId}
        radioName={radioName}
        onTransmitSpeech={onTransmitSpeech}
        radioBlockedReason={radioBlockedReason}
        generated={generated}
        onGenerated={setGenerated}
        text={text}
        onText={setText}
        preview={preview}
        previewed={generated ? previewed.has(generated.jobId) : false}
        onListen={listen}
        onPreviewPlayed={played}
      />
      <JobRunner session={session} processing={processing} radioId={radioId} />
      <JobsList
        session={session}
        processing={processing}
        preview={preview}
        flowJobId={generated?.jobId}
        onListen={listen}
        onPreviewPlayed={played}
        // Without an audio preview (native) a listed job cannot be reviewed,
        // so it is never offered for transmission.
        onUseForSpeech={
          onTransmitSpeech && Platform.OS === 'web'
            ? openInSpeechFlow
            : undefined
        }
      />
    </View>
  );
}
