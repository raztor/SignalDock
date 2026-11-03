import type {
  ClientSession,
  ProcessingConnectionView,
} from '@signaldock/contracts';
import {
  Badge,
  Button,
  Chip,
  ChipGroup,
  Stepper,
  Text,
  useToast,
  validateSchemaValue,
} from '@signaldock/ui';
import { useCallback, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import {
  useFocusOnChange,
  type FocusTarget,
} from '../../../shared/accessibility';
import { useRadioGroupKeyboard } from '../../../shared/radio-group';
import { createConnection } from '../processing-api';
import {
  apiKeyRequirement,
  capabilityPresentation,
  CONNECTION_STEPS,
  connectionOptionSchema,
  connectionRequestBody,
  connectionReview,
  connectionStepErrors,
  connectorCards,
  connectorTitle,
  endpointFixed,
  endpointPolicy,
  firstError,
  initialConnectionDraft,
  toggleCapability,
  type ConnectionDraft,
  type ConnectionStep,
  type ConnectorManifestView,
} from '../processing-model';
import type { ProcessingController } from '../useProcessing';
import { Field, Notice } from './common';
import { ConnectorCard } from './ConnectorCard';
import { OptionsEditor } from './OptionsEditor';
import { useProcessingStyles } from './styles';

export interface ConnectionWizardProps {
  session: ClientSession;
  connectors: readonly ConnectorManifestView[];
  processing: ProcessingController;
  onClose(): void;
  onSaved?(connection: ProcessingConnectionView): void;
}

/** Provider → Credentials → Options → Review & save. */
export function ConnectionWizard({
  session,
  connectors,
  processing,
  onClose,
  onSaved,
}: ConnectionWizardProps) {
  const styles = useProcessingStyles();
  const toast = useToast();
  const [step, setStep] = useState<ConnectionStep>(0);
  const [draft, setDraft] = useState<ConnectionDraft>();
  const [jsonError, setJsonError] = useState<string>();
  const cards = useMemo(() => connectorCards(connectors), [connectors]);
  const manifest = connectors.find(
    (item) => item.connectorId === draft?.connectorId,
  );
  const schema = useMemo(
    () => connectionOptionSchema(manifest, draft?.capabilities ?? []),
    [manifest, draft?.capabilities],
  );
  const optionErrors = useMemo(
    () => (schema && draft ? validateSchemaValue(schema, draft.options) : {}),
    [schema, draft],
  );
  const errors = connectionStepErrors(step, draft, manifest, optionErrors);
  const blocking = (step >= 2 ? jsonError : undefined) ?? firstError(errors);
  const update = (patch: Partial<ConnectionDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));
  const onJsonError = useCallback(
    (error: string | undefined) => setJsonError(error),
    [],
  );
  // Each step change moves focus to the title, which names the step.
  const titleRef = useFocusOnChange(step);
  const choose = (connectorId: string) => {
    const next = connectors.find((item) => item.connectorId === connectorId);
    if (next && next.connectorId !== draft?.connectorId) {
      setDraft(initialConnectionDraft(next));
      setJsonError(undefined);
    }
  };
  const providerKeys = useRadioGroupKeyboard({
    enabled: cards.map((card) => card.selectable && !processing.busy),
    checkedIndex: cards.findIndex(
      (card) => card.connectorId === draft?.connectorId,
    ),
    onSelect: (index) => {
      const card = cards[index];
      if (card) choose(card.connectorId);
    },
  });

  const save = async () => {
    if (!draft || blocking) return;
    let saved: ProcessingConnectionView | undefined;
    const ok = await processing.run(async (signal) => {
      try {
        saved = await createConnection(
          session,
          connectionRequestBody(draft),
          signal,
        );
        signal.throwIfAborted();
      } finally {
        // The key is write-only: clear it after every attempt.
        if (!signal.aborted) update({ apiKey: '' });
      }
    });
    if (ok && saved) {
      toast.show({
        tone: 'success',
        message:
          'Connection configured. A successful job confirms provider access.',
      });
      onSaved?.(saved);
      onClose();
    }
  };

  const requirement = draft ? apiKeyRequirement(draft.connectorId) : 'none';
  const policy = draft
    ? endpointPolicy(draft.endpoint, draft.options, draft.connectorId)
    : undefined;

  return (
    <View
      style={styles.panel}
      accessibilityLabel="Add provider connection"
      accessible={false}
    >
      <View style={styles.between}>
        <Text
          ref={(node) => {
            titleRef.current = node as FocusTarget;
          }}
          accessibilityRole="header"
          accessibilityLabel={`Add provider connection · Step ${step + 1} of ${
            CONNECTION_STEPS.length
          }: ${CONNECTION_STEPS[step] ?? ''}`}
          {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})}
          style={styles.heading}
        >
          Add provider connection
        </Text>
        <Button
          variant="quiet"
          label="Cancel"
          disabled={processing.busy}
          onPress={() => {
            update({ apiKey: '' });
            onClose();
          }}
        />
      </View>
      <Stepper steps={CONNECTION_STEPS} current={step} />

      {step === 0 ? (
        <View style={styles.section}>
          <Text style={styles.muted}>
            Choose the provider that will process recordings and messages.
          </Text>
          {cards.length ? (
            <View
              style={styles.grid}
              accessibilityRole="radiogroup"
              accessibilityLabel="Provider"
              {...providerKeys.group}
            >
              {cards.map((card, index) => (
                <ConnectorCard
                  key={card.connectorId}
                  card={card}
                  selected={draft?.connectorId === card.connectorId}
                  disabled={processing.busy}
                  focusProps={providerKeys.item(index)}
                  onSelect={() => choose(card.connectorId)}
                />
              ))}
            </View>
          ) : (
            <Text style={styles.muted}>
              No processing connectors are installed on this server.
            </Text>
          )}
        </View>
      ) : null}

      {step === 1 && draft && manifest ? (
        <View style={styles.section}>
          <Field
            label="Display name"
            value={draft.displayName}
            onChangeText={(displayName) => update({ displayName })}
            placeholder={connectorTitle(draft.connectorId)}
            hint="Shown in profiles. Leave empty to use the provider name."
            error={errors.displayName}
          />
          <Field
            label="Provider endpoint"
            icon="server"
            value={draft.endpoint}
            onChangeText={(endpoint) => update({ endpoint })}
            readOnly={endpointFixed(draft.connectorId)}
            placeholder="https://provider.example/v1"
            hint={
              endpointFixed(draft.connectorId)
                ? 'This connector always uses the public OpenAI API.'
                : policy?.local
                  ? 'Local endpoint · requires "Allow private network" in Options.'
                  : 'Use https://. Plain http:// works only for local endpoints.'
            }
            error={errors.endpoint}
          />
          <View style={styles.field}>
            <Text style={styles.label}>Capabilities</Text>
            <Text style={styles.caption}>
              Declare only capabilities this endpoint supports.
            </Text>
            <ChipGroup accessibilityLabel="Capabilities">
              {manifest.capabilities.map((capability) => {
                const item = capabilityPresentation(capability);
                return (
                  <Chip
                    key={capability}
                    label={item.label}
                    icon={item.icon}
                    selected={draft.capabilities.includes(capability)}
                    disabled={processing.busy}
                    onPress={() =>
                      update({
                        capabilities: toggleCapability(
                          draft.capabilities,
                          capability,
                        ),
                      })
                    }
                  />
                );
              })}
            </ChipGroup>
            {errors.capabilities ? (
              <Text style={styles.errorCaption}>{errors.capabilities}</Text>
            ) : null}
          </View>
          {requirement !== 'none' ? (
            <Field
              label={
                requirement === 'required'
                  ? 'API key (stored encrypted)'
                  : 'API key (optional, stored encrypted)'
              }
              icon="lock"
              secret
              value={draft.apiKey}
              onChangeText={(apiKey) => update({ apiKey })}
              hint="Encrypted on the server and never shown again. It is cleared from this form after saving."
              error={errors.apiKey}
            />
          ) : (
            <Notice icon="lock">This provider does not use an API key.</Notice>
          )}
        </View>
      ) : null}

      {step === 2 && draft ? (
        <View style={styles.section}>
          <OptionsEditor
            label="Connection options"
            schema={schema}
            value={draft.options}
            onChange={(options) => update({ options })}
            errors={optionErrors}
            onJsonError={onJsonError}
            emptyText="This provider needs no extra options."
            disabled={processing.busy}
          />
          {errors.endpoint ? (
            <Notice tone="warning">{errors.endpoint}</Notice>
          ) : null}
        </View>
      ) : null}

      {step === 3 && draft ? (
        <View style={styles.section}>
          <View accessibilityLabel="Connection summary">
            {connectionReview(draft).map((row) => (
              <View key={row.label} style={styles.reviewRow}>
                <Text style={styles.reviewLabel}>{row.label}</Text>
                <Text style={styles.reviewValue}>{row.value}</Text>
              </View>
            ))}
          </View>
          <View style={styles.row}>
            <Badge
              label={blocking ? 'Check failed' : 'Local checks passed'}
              tone={blocking ? 'error' : 'primary'}
              icon={blocking ? 'alert' : 'check'}
            />
          </View>
          <Text style={styles.caption}>
            Saving does not contact the provider. The status stays “Configured”
            until a job succeeds.
          </Text>
        </View>
      ) : null}

      {blocking && step > 0 ? (
        <Text accessibilityLiveRegion="polite" style={styles.errorCaption}>
          {blocking}
        </Text>
      ) : null}

      <View style={styles.actions}>
        {/* Kept mounted (disabled on the first step) so focus is not lost. */}
        <Button
          label="Back"
          disabled={processing.busy || step === 0}
          onPress={() => setStep(Math.max(0, step - 1) as ConnectionStep)}
        />
        <View style={styles.spacer} />
        {step < 3 ? (
          <Button
            variant="primary"
            label="Next"
            disabled={processing.busy || Boolean(blocking)}
            onPress={() => setStep((step + 1) as ConnectionStep)}
          />
        ) : (
          <Button
            variant="primary"
            label="Save connection"
            loading={processing.busy}
            disabled={Boolean(blocking)}
            onPress={() => void save()}
          />
        )}
      </View>
    </View>
  );
}
