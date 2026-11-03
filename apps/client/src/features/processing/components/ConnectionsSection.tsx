import type {
  ClientSession,
  ProcessingConnectionView,
} from '@signaldock/contracts';
import {
  Badge,
  Button,
  Chip,
  ChipGroup,
  ConfirmButton,
  Icon,
  StatusIndicator,
  Text,
  useTheme,
  useToast,
} from '@signaldock/ui';
import { useState } from 'react';
import { View } from 'react-native';
import { revokeConnection } from '../processing-api';
import {
  capabilityPresentation,
  connectionExecution,
  connectionStatus,
  connectorTitle,
  hasSubscriptionConnector,
  SUBSCRIPTION_CONNECTOR_ID,
} from '../processing-model';
import type { ProcessingController } from '../useProcessing';
import { IconBox } from './common';
import { ConnectionWizard } from './ConnectionWizard';
import { useProcessingStyles } from './styles';

export function ConnectionsSection({
  session,
  processing,
}: {
  session: ClientSession;
  processing: ProcessingController;
}) {
  const styles = useProcessingStyles();
  const [adding, setAdding] = useState(false);
  const { connections, connectors } = processing.data;
  const administrator = session.user.role === 'administrator';
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text accessibilityRole="header" style={styles.heading}>
          Provider connections
        </Text>
        {administrator && !adding ? (
          <Button
            variant="primary"
            label="Add provider"
            disabled={processing.busy || !processing.loaded}
            onPress={() => setAdding(true)}
          />
        ) : null}
      </View>
      {!administrator ? (
        <Text style={styles.caption}>
          Only administrators can add provider connections.
        </Text>
      ) : null}
      {adding ? (
        <ConnectionWizard
          session={session}
          connectors={connectors}
          processing={processing}
          onClose={() => setAdding(false)}
        />
      ) : null}
      {connections.length ? (
        <View style={styles.grid}>
          {connections.map((connection) => (
            <ConnectionCard
              key={connection.connection.connectionId}
              connection={connection}
              session={session}
              processing={processing}
              execution={connectionExecution(
                connection,
                connectors.find(
                  (item) =>
                    item.connectorId === connection.connection.connectorId,
                ),
              )}
            />
          ))}
        </View>
      ) : processing.loaded ? (
        <Text style={styles.muted}>
          No provider connections yet. Processing is optional; radio operation
          and recording work without it.
        </Text>
      ) : null}
      {hasSubscriptionConnector(connectors) ? <SubscriptionCard /> : null}
    </View>
  );
}

function ConnectionCard({
  connection,
  execution,
  session,
  processing,
}: {
  connection: ProcessingConnectionView;
  execution: 'local' | 'cloud' | undefined;
  session: ClientSession;
  processing: ProcessingController;
}) {
  const styles = useProcessingStyles();
  const toast = useToast();
  const status = connectionStatus(connection.status);
  const revoked = connection.status === 'revoked';
  return (
    <View
      style={[styles.card, styles.gridItem, revoked && styles.cardDisabled]}
    >
      <View style={styles.titleRow}>
        <IconBox name={execution === 'local' ? 'server' : 'signal'} />
        <View style={styles.grow}>
          <Text numberOfLines={1} style={styles.label}>
            {connection.displayName}
          </Text>
          <Text numberOfLines={1} style={styles.caption}>
            {connectorTitle(connection.connection.connectorId)}
          </Text>
        </View>
      </View>
      <StatusIndicator tone={status.tone} label={status.label} size="compact" />
      <Text numberOfLines={1} style={styles.mono}>
        {connection.endpoint}
      </Text>
      <View style={styles.row}>
        {execution ? (
          <Badge
            label={execution === 'local' ? 'Local' : 'Cloud'}
            tone={execution === 'local' ? 'primary' : 'neutral'}
          />
        ) : null}
        {connection.connection.owner.kind === 'user' ? (
          <Badge label="Your account" icon="user" />
        ) : null}
        {connection.hasCredentials ? (
          <Badge label="Credentials protected" icon="lock" />
        ) : null}
      </View>
      <ChipGroup accessibilityLabel={`${connection.displayName} capabilities`}>
        {connection.capabilities.map((capability) => {
          const item = capabilityPresentation(capability);
          return <Chip key={capability} label={item.label} icon={item.icon} />;
        })}
      </ChipGroup>
      {!revoked ? (
        <ConfirmButton
          label="Revoke connection"
          variant="danger"
          confirmation={{
            title: 'Revoke this provider connection?',
            message:
              'Processing jobs using this connection will no longer be able to use its credentials.',
          }}
          disabled={processing.busy}
          onPress={() =>
            void processing
              .run((signal) =>
                revokeConnection(
                  session,
                  connection.connection.connectionId,
                  signal,
                ),
              )
              .then((ok) => {
                if (ok)
                  toast.show({
                    tone: 'success',
                    message: `${connection.displayName} was revoked.`,
                  });
              })
          }
        />
      ) : null}
    </View>
  );
}

/** The existing OpenAI subscription flow, presented as a card. */
function SubscriptionCard() {
  const styles = useProcessingStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <IconBox name="user" />
        <View style={styles.grow}>
          <Text style={styles.label}>
            {connectorTitle(SUBSCRIPTION_CONNECTOR_ID)}
          </Text>
          <Text style={styles.caption}>Personal account · text only</Text>
        </View>
        <Icon name="lock" size={16} color={colors.textSecondary} />
      </View>
      <View style={styles.row}>
        <Badge label="Cloud" />
        <Chip
          label={capabilityPresentation('text.structured').label}
          icon={capabilityPresentation('text.structured').icon}
        />
      </View>
      <Text style={styles.muted}>
        Link your own eligible account using the local subscription setup
        command. Import its protected registration through the authenticated
        server endpoint. Subscription access supports structured text only;
        speech requires a separate connection. Setup instructions are in the
        processing documentation.
      </Text>
    </View>
  );
}
