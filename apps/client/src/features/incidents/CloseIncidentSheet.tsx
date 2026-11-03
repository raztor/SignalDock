import type { IncidentRecord } from '@signaldock/contracts';
import {
  Button,
  Chip,
  ChipGroup,
  Heading,
  Overlay,
  Text,
  TextInput,
  space,
  type,
  useTheme,
} from '@signaldock/ui';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import {
  DECISION_NOTE_MAX,
  closeReasonsFor,
  composeCloseNote,
  type CloseReason,
  type CloseState,
} from './incident-model';

export interface CloseIncidentSheetProps {
  /** Incident being closed; null hides the sheet. */
  incident: IncidentRecord | null;
  target: CloseState;
  busy: boolean;
  /** Error from the last attempt, shown next to the confirm button. */
  error?: string;
  onCancel: () => void;
  /** Receives the composed decision note (`"<reason>: <note>"`). */
  onConfirm: (note: string) => void;
}

/**
 * Resolve / dismiss: a reason chip plus an optional note. The reason alone is
 * a valid decision note, so the API's required-note rule is always met.
 */
export function CloseIncidentSheet({
  incident,
  target,
  busy,
  error,
  onCancel,
  onConfirm,
}: CloseIncidentSheetProps) {
  const { colors } = useTheme();
  const [reason, setReason] = useState<CloseReason>();
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const incidentId = incident?.id;
  useEffect(() => {
    setReason(undefined);
    setNote('');
    setTouched(false);
  }, [incidentId, target]);
  const result = composeCloseNote(reason, note);
  const verb = target === 'resolved' ? 'Resolve' : 'Dismiss';
  return (
    <Overlay
      visible={incident !== null}
      onClose={() => {
        if (!busy) onCancel();
      }}
      accessibilityLabel={`${verb} incident`}
      scroll
    >
      <Heading>{verb} incident</Heading>
      {incident && (
        <Text numberOfLines={2} style={{ color: colors.textSecondary }}>
          {incident.title}
        </Text>
      )}
      <View style={{ gap: space.sm }}>
        <Text style={[type.label, { color: colors.textPrimary }]}>Reason</Text>
        <ChipGroup accessibilityLabel="Reason">
          {closeReasonsFor(target).map((entry) => (
            <Chip
              key={entry.key}
              label={entry.label}
              selected={reason === entry.key}
              disabled={busy}
              onPress={() => {
                setTouched(true);
                setReason(reason === entry.key ? undefined : entry.key);
              }}
            />
          ))}
        </ChipGroup>
      </View>
      <View style={{ gap: space.xs }}>
        <Text style={[type.label, { color: colors.textPrimary }]}>
          Note{reason === 'other' ? '' : ' (optional)'}
        </Text>
        <TextInput
          accessibilityLabel={
            reason === 'other' ? 'Decision note' : 'Decision note (optional)'
          }
          value={note}
          onChangeText={setNote}
          editable={!busy}
          multiline
          maxLength={DECISION_NOTE_MAX}
          placeholder="What happened?"
          style={{ minHeight: 88 }}
        />
      </View>
      {result.ok ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[type.caption, { color: colors.textSecondary }]}
        >
          Saved as: “{result.note}”
        </Text>
      ) : touched || reason ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[type.caption, { color: colors.warning }]}
        >
          {result.error}
        </Text>
      ) : null}
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          {error}
        </Text>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
        <Button
          label="Cancel"
          variant="quiet"
          disabled={busy}
          onPress={onCancel}
        />
        <Button
          label={verb}
          variant={target === 'dismissed' ? 'danger' : 'primary'}
          disabled={!result.ok}
          loading={busy}
          onPress={() => {
            if (result.ok) onConfirm(result.note);
          }}
        />
      </View>
    </Overlay>
  );
}
