import type { PublicUser } from '@signaldock/contracts';
import { Chip, ChipGroup, Text } from '@signaldock/ui';
import { View } from 'react-native';
import { serviceOwnerCandidates } from '../processing-model';
import { Field } from './common';
import { useProcessingStyles } from './styles';

export type UserDirectory =
  | { status: 'loading' }
  | { status: 'ready'; users: PublicUser[] }
  | { status: 'unavailable'; message: string };

/**
 * Picks the background service owner from the user list. When the account
 * cannot list users, falls back to the previous user ID field.
 */
export function ServiceOwnerPicker({
  directory,
  radioId,
  currentUserId,
  value,
  onChange,
  disabled = false,
}: {
  directory: UserDirectory;
  radioId: string;
  currentUserId: string;
  value: string;
  onChange(userId: string): void;
  disabled?: boolean;
}) {
  const styles = useProcessingStyles();
  if (directory.status === 'unavailable')
    return (
      <Field
        label="Service-owner user ID"
        value={value}
        onChangeText={onChange}
        disabled={disabled}
        hint={`The user list is not available (${directory.message}). Enter the ID of an enabled administrator with history access to this radio.`}
      />
    );
  if (directory.status === 'loading')
    return <Text style={styles.caption}>Loading users…</Text>;
  const candidates = serviceOwnerCandidates(
    directory.users,
    radioId,
    currentUserId,
  );
  const selected = candidates.find((item) => item.userId === value);
  return (
    <View style={styles.field}>
      <Text style={styles.label}>Service owner</Text>
      <Text style={styles.caption}>
        Background jobs run with this user's permissions. It must be an enabled
        administrator with history access to this radio.
      </Text>
      <ChipGroup accessibilityLabel="Service owner">
        {candidates.map((candidate) => (
          <Chip
            key={candidate.userId}
            label={
              candidate.current
                ? `${candidate.username} (you)`
                : candidate.username
            }
            icon="user"
            selected={candidate.userId === value}
            disabled={disabled || !candidate.eligible}
            accessibilityLabel={
              candidate.eligible
                ? candidate.username
                : `${candidate.username}: ${candidate.reason ?? 'not eligible'}`
            }
            onPress={() => onChange(candidate.userId)}
          />
        ))}
      </ChipGroup>
      {candidates
        .filter((item) => !item.eligible)
        .slice(0, 5)
        .map((item) => (
          <Text key={item.userId} style={styles.caption}>
            {item.username}: {item.reason}
          </Text>
        ))}
      {!candidates.some((item) => item.eligible) ? (
        <Text style={styles.warning}>
          No user can own automatic transcription for this radio. Give an
          administrator history access to it in Users & access.
        </Text>
      ) : selected && !selected.eligible ? (
        <Text style={styles.warning}>{selected.reason}</Text>
      ) : !selected && value ? (
        <Text style={styles.warning}>Choose a service owner.</Text>
      ) : null}
    </View>
  );
}
