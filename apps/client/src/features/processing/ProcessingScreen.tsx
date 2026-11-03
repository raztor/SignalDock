import type { FeatureScreenProps } from '@signaldock/contracts';
import {
  Button,
  LoadingState,
  ScrollView,
  SegmentedControl,
  Text,
  useFeatureStyles,
  useScreenActive,
  type SegmentedOption,
} from '@signaldock/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { mediaAccess } from '../media/media-access';
import { useStation } from '../station';
import { AutomaticTranscription } from './components/AutomaticTranscription';
import { ConnectionsSection } from './components/ConnectionsSection';
import { ProfilesSection } from './components/ProfilesSection';
import { RunSection } from './components/RunSection';
import type { TransmitSpeech } from './components/SpeechFlow';
import { useProcessingStyles } from './components/styles';
import { useProcessing } from './useProcessing';

export interface ProcessingScreenProps extends FeatureScreenProps {
  /** Explicit prepared-speech transmission (owned by the radio/media shell). */
  onTransmitSpeech?: TransmitSpeech;
}

type Section = 'run' | 'providers' | 'profiles' | 'automation';

/**
 * Processing: speech and jobs, provider connections (wizard), profiles and
 * automatic RX transcription. Must be rendered inside StationProvider.
 */
export function ProcessingScreen({
  session,
  radioId,
  onTransmitSpeech,
}: ProcessingScreenProps) {
  const page = useFeatureStyles('processing');
  const styles = useProcessingStyles();
  const active = useScreenActive();
  const station = useStation();
  const administrator = session.user.role === 'administrator';
  const processing = useProcessing(session, radioId, administrator, active);
  const [section, setSection] = useState<Section>('run');
  const [visited, setVisited] = useState<ReadonlySet<Section>>(
    () => new Set<Section>(['run']),
  );
  const select = (next: Section) => {
    setSection(next);
    setVisited((current) =>
      current.has(next) ? current : new Set([...current, next]),
    );
  };
  const radio = station.radios.find((item) => item.radioId === radioId);
  const radioName = radio?.displayName;
  // Same display rules as live PTT (receive-only, permissions, unconfirmed
  // tuning, busy transmitter). Prepared speech is still validated server-side.
  const radioBlockedReason = radioId
    ? mediaAccess({
        mediaAvailable: true,
        radio: radio ?? null,
        user: session.user,
        radioId,
      }).transmitReason.replace(' for PTT', '') || undefined
    : undefined;

  useEffect(() => {
    if (!administrator && section === 'automation') setSection('run');
  }, [administrator, section]);

  const { connections, profiles } = processing.data;
  const options = useMemo<SegmentedOption<Section>[]>(
    () => [
      { value: 'run', label: 'Speech & jobs' },
      {
        value: 'providers',
        label: connections.length
          ? `Providers (${connections.length})`
          : 'Providers',
      },
      {
        value: 'profiles',
        label: profiles.length ? `Profiles (${profiles.length})` : 'Profiles',
      },
      ...(administrator
        ? [{ value: 'automation' as const, label: 'Automatic RX' }]
        : []),
    ],
    [administrator, connections.length, profiles.length],
  );

  return (
    <ScrollView contentContainerStyle={page.page}>
      <Text accessibilityRole="header" style={page.title}>
        Processing
      </Text>
      <Text style={page.muted}>
        Choose where recordings and messages are processed. Cloud access
        requires an enabled profile.
      </Text>
      <SegmentedControl
        accessibilityLabel="Processing section"
        options={options}
        value={section}
        onChange={select}
      />
      {processing.status ? (
        <View style={styles.between}>
          <Text accessibilityRole="alert" style={[styles.error, styles.grow]}>
            {processing.status}
          </Text>
          <Button
            variant="quiet"
            label="Dismiss"
            onPress={processing.clearStatus}
          />
        </View>
      ) : null}
      {!processing.loaded && !processing.status ? (
        <LoadingState label="Loading processing settings…" />
      ) : null}
      <SectionView visible={section === 'run'}>
        <RunSection
          visible={section === 'run'}
          session={session}
          processing={processing}
          radioId={radioId}
          radioName={radioName}
          onTransmitSpeech={onTransmitSpeech}
          radioBlockedReason={radioBlockedReason}
        />
      </SectionView>
      {visited.has('providers') ? (
        <SectionView visible={section === 'providers'}>
          <ConnectionsSection session={session} processing={processing} />
        </SectionView>
      ) : null}
      {visited.has('profiles') ? (
        <SectionView visible={section === 'profiles'}>
          <ProfilesSection session={session} processing={processing} />
        </SectionView>
      ) : null}
      {administrator && visited.has('automation') ? (
        <SectionView visible={section === 'automation'}>
          <AutomaticTranscription
            session={session}
            processing={processing}
            radios={station.radios}
          />
        </SectionView>
      ) : null}
    </ScrollView>
  );
}

/** Keeps visited sections mounted (drafts survive switching) but hidden. */
function SectionView({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  return <View style={{ display: visible ? 'flex' : 'none' }}>{children}</View>;
}
