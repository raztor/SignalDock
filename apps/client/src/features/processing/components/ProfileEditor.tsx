import type { ClientSession } from '@signaldock/contracts';
import {
  Button,
  Chip,
  ChipGroup,
  Pressable,
  SettingToggle,
  Text,
  useToast,
  validateSchemaValue,
} from '@signaldock/ui';
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { createProfile } from '../processing-api';
import {
  activeConnections,
  cloudNotice,
  connectionExecution,
  EMPTY_PROFILE_DRAFT,
  latestTasks,
  modelSuggestions,
  profileDraftErrors,
  profileRequestBody,
  profileSettingsSchema,
  taskPresentation,
  tasksForConnection,
  type ProfileDraft,
} from '../processing-model';
import type { ProcessingController } from '../useProcessing';
import { Field, IconBox, Notice } from './common';
import { OptionsEditor } from './OptionsEditor';
import { useProcessingStyles } from './styles';

export function ProfileEditor({
  session,
  processing,
  onClose,
}: {
  session: ClientSession;
  processing: ProcessingController;
  onClose(): void;
}) {
  const styles = useProcessingStyles();
  const toast = useToast();
  const { connections, connectors, tasks, profiles } = processing.data;
  const usable = activeConnections(connections);
  const [draft, setDraft] = useState<ProfileDraft>(() => ({
    ...EMPTY_PROFILE_DRAFT,
    connectionId: usable[0]?.connection.connectionId,
  }));
  const [jsonError, setJsonError] = useState<string>();
  const onJsonError = useCallback(
    (error: string | undefined) => setJsonError(error),
    [],
  );
  const connection = usable.find(
    (item) => item.connection.connectionId === draft.connectionId,
  );
  const manifest = connectors.find(
    (item) => item.connectorId === connection?.connection.connectorId,
  );
  const available = latestTasks(tasksForConnection(tasks, connection));
  const task = available.find((item) => item.taskId === draft.taskId);
  const schema = useMemo(
    () => profileSettingsSchema(manifest, task?.capability),
    [manifest, task?.capability],
  );
  const settingErrors = useMemo(
    () => (schema ? validateSchemaValue(schema, draft.settings) : {}),
    [schema, draft.settings],
  );
  const models = modelSuggestions({
    manifest,
    capability: task?.capability,
    profiles,
    connections,
  });
  const execution = connectionExecution(connection, manifest);
  const notice = cloudNotice(execution, draft.allowCloud);
  const error =
    jsonError ?? profileDraftErrors(draft, connection, task, settingErrors);
  const update = (patch: Partial<ProfileDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  const save = async () => {
    if (error || !task) return;
    const body = profileRequestBody(draft, task);
    if (!body) return;
    const ok = await processing.run(async (signal) => {
      await createProfile(session, body, signal);
    });
    if (ok) {
      toast.show({ tone: 'success', message: 'Profile created.' });
      onClose();
    }
  };

  if (!usable.length)
    return (
      <Notice tone="warning">
        Add a provider connection before creating a profile.
      </Notice>
    );

  return (
    <View style={styles.panel}>
      <View style={styles.between}>
        <Text accessibilityRole="header" style={styles.heading}>
          New profile
        </Text>
        <Button
          variant="quiet"
          label="Cancel"
          disabled={processing.busy}
          onPress={onClose}
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Connection</Text>
        <ChipGroup accessibilityLabel="Connection">
          {usable.map((item) => (
            <Chip
              key={item.connection.connectionId}
              label={item.displayName}
              icon="server"
              selected={draft.connectionId === item.connection.connectionId}
              disabled={processing.busy}
              onPress={() =>
                update({
                  connectionId: item.connection.connectionId,
                  taskId: undefined,
                  settings: {},
                })
              }
            />
          ))}
        </ChipGroup>
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Task</Text>
        {available.length ? (
          <View
            style={styles.grid}
            accessibilityRole="radiogroup"
            accessibilityLabel="Task"
          >
            {available.map((item) => {
              const presentation = taskPresentation(item);
              const selected = draft.taskId === item.taskId;
              return (
                <Pressable
                  key={`${item.taskId}@${item.version}`}
                  accessibilityRole="radio"
                  accessibilityLabel={`${presentation.title}. ${presentation.description}`}
                  accessibilityState={{ checked: selected }}
                  disabled={processing.busy}
                  onPress={() =>
                    update({ taskId: item.taskId, settings: {}, model: '' })
                  }
                  style={[
                    styles.cardPressable,
                    styles.gridItem,
                    selected && styles.cardSelected,
                  ]}
                >
                  <View style={styles.titleRow}>
                    <IconBox name={presentation.icon} selected={selected} />
                    <Text style={[styles.label, styles.grow]}>
                      {presentation.title}
                    </Text>
                  </View>
                  <Text style={styles.caption}>{presentation.description}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Text style={styles.muted}>
            This connection supports no installed task.
          </Text>
        )}
      </View>

      {task ? (
        <>
          <View style={styles.field}>
            {models.length ? (
              <ChipGroup accessibilityLabel="Known models">
                {models.map((model) => (
                  <Chip
                    key={model}
                    label={model}
                    monospace
                    selected={draft.model.trim() === model}
                    disabled={processing.busy}
                    onPress={() => update({ model })}
                  />
                ))}
              </ChipGroup>
            ) : null}
            <Field
              label="Model or deployment name"
              value={draft.model}
              onChangeText={(model) => update({ model })}
              hint={
                models.length
                  ? 'Pick a known model or type another name.'
                  : 'The exact name the provider expects.'
              }
            />
          </View>

          <OptionsEditor
            key={`${draft.connectionId}:${task.taskId}`}
            label="Settings"
            schema={schema}
            value={draft.settings}
            onChange={(settings) => update({ settings })}
            errors={settingErrors}
            onJsonError={onJsonError}
            emptyText="This task needs no extra settings."
            disabled={processing.busy}
          />
          <Text style={styles.caption}>
            No credentials belong in these settings.
          </Text>

          <View style={styles.field}>
            <SettingToggle
              label="Allow cloud processing"
              value={draft.allowCloud}
              disabled={processing.busy}
              onValueChange={(allowCloud) => update({ allowCloud })}
            />
            <Text style={styles.caption}>
              When off, this profile only runs on local endpoints and cloud jobs
              are refused. When on, recordings or text may be sent to the
              provider’s cloud service.
            </Text>
            <Notice tone={notice.tone}>{notice.message}</Notice>
          </View>
        </>
      ) : null}

      {error && task ? (
        <Text accessibilityLiveRegion="polite" style={styles.errorCaption}>
          {error}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button
          variant="primary"
          label="Create profile"
          loading={processing.busy}
          disabled={Boolean(error)}
          onPress={() => void save()}
        />
      </View>
    </View>
  );
}
