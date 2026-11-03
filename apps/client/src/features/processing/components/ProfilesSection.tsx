import type { ClientSession } from '@signaldock/contracts';
import { Badge, Button, Text } from '@signaldock/ui';
import { useState } from 'react';
import { View } from 'react-native';
import {
  connectorTitle,
  taskFor,
  taskPresentation,
  capabilityPresentation,
} from '../processing-model';
import type { ProcessingController } from '../useProcessing';
import { IconBox } from './common';
import { ProfileEditor } from './ProfileEditor';
import { useProcessingStyles } from './styles';

export function ProfilesSection({
  session,
  processing,
}: {
  session: ClientSession;
  processing: ProcessingController;
}) {
  const styles = useProcessingStyles();
  const [creating, setCreating] = useState(false);
  const { profiles, connections, tasks } = processing.data;
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text accessibilityRole="header" style={styles.heading}>
          Processing profiles
        </Text>
        {!creating ? (
          <Button
            variant="primary"
            label="New profile"
            disabled={processing.busy || !processing.loaded}
            onPress={() => setCreating(true)}
          />
        ) : null}
      </View>
      <Text style={styles.caption}>
        A profile pairs a connection with a task, model and settings. Creating a
        profile does not run anything.
      </Text>
      {creating ? (
        <ProfileEditor
          session={session}
          processing={processing}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {profiles.length ? (
        <View style={styles.grid}>
          {profiles.map((profile) => {
            const task = profile.task
              ? (taskFor(tasks, profile.task) ?? {
                  taskId: profile.task,
                  capability: profile.capability,
                })
              : undefined;
            const presentation = task
              ? taskPresentation(task)
              : {
                  title: capabilityPresentation(profile.capability).label,
                  icon: capabilityPresentation(profile.capability).icon,
                };
            const connection = connections.find(
              (item) => item.connection.connectionId === profile.connectionId,
            );
            return (
              <View
                key={profile.profileId}
                style={[styles.card, styles.gridItem]}
                accessible
                accessibilityLabel={`${presentation.title}, model ${profile.model}, revision ${profile.revision}, ${profile.allowCloud ? 'cloud allowed' : 'local only'}`}
              >
                <View style={styles.titleRow}>
                  <IconBox name={presentation.icon} />
                  <Text style={[styles.label, styles.grow]}>
                    {presentation.title}
                  </Text>
                </View>
                <Text numberOfLines={1} style={styles.mono}>
                  {profile.model}
                </Text>
                <Text numberOfLines={1} style={styles.caption}>
                  {connection
                    ? `${connection.displayName} · ${connectorTitle(connection.connection.connectorId)}`
                    : 'Connection unavailable'}
                </Text>
                <View style={styles.row}>
                  <Badge label={`Revision ${profile.revision}`} />
                  <Badge
                    label={profile.allowCloud ? 'Cloud allowed' : 'Local only'}
                    tone={profile.allowCloud ? 'warning' : 'primary'}
                    icon={profile.allowCloud ? 'signal' : 'lock'}
                  />
                  {connection?.status === 'revoked' ? (
                    <Badge label="Connection revoked" tone="error" />
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      ) : processing.loaded && !creating ? (
        <Text style={styles.muted}>
          No profiles yet. Add a provider connection, then create a profile for
          each task you want to run.
        </Text>
      ) : null}
    </View>
  );
}
