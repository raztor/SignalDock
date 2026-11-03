import type { ClientSession } from '@signaldock/contracts';
import {
  Button,
  Checkbox,
  Chip,
  ChipGroup,
  ConfirmDialog,
  SettingToggle,
  StatusIndicator,
  Text,
  useToast,
} from '@signaldock/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import {
  disableAutomaticRx,
  enableAutomaticRx,
  fetchUsers,
} from '../processing-api';
import {
  activeConsent,
  AUTOMATIC_RX_CONSENT,
  AUTOMATIC_RX_NOTICE,
  automationRadios,
  consentGate,
  consentHealth,
  consentRequestBody,
  defaultServiceOwner,
  errorMessage,
  profileLabel,
  serviceOwnerCandidates,
  transcriptionProfiles,
} from '../processing-model';
import type { ProcessingController } from '../useProcessing';
import { IconBox, Notice } from './common';
import { ServiceOwnerPicker, type UserDirectory } from './ServiceOwnerPicker';
import { useProcessingStyles } from './styles';

export interface AutomationRadio {
  radioId: string;
  displayName: string;
}

/** Automatic RX transcription: one card per radio, off until explicitly consented. */
export function AutomaticTranscription({
  session,
  processing,
  radios,
}: {
  session: ClientSession;
  processing: ProcessingController;
  radios: readonly AutomationRadio[];
}) {
  const styles = useProcessingStyles();
  const [directory, setDirectory] = useState<UserDirectory>({
    status: 'loading',
  });
  // Token refreshes replace the session object; only another account reloads.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const accountKey = `${session.baseUrl}\0${session.instanceId}\0${session.user.id}`;
  useEffect(() => {
    const controller = new AbortController();
    setDirectory({ status: 'loading' });
    void fetchUsers(sessionRef.current, controller.signal)
      .then((users) => {
        if (!controller.signal.aborted)
          setDirectory({ status: 'ready', users });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setDirectory({ status: 'unavailable', message: errorMessage(error) });
      });
    return () => controller.abort();
  }, [accountKey]);
  const cards = automationRadios(radios, processing.data.consents);
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.heading}>
        Automatic RX transcription
      </Text>
      <Notice icon="lock">{AUTOMATIC_RX_NOTICE}</Notice>
      {cards.length ? (
        cards.map((radio) => (
          <AutomaticRxCard
            key={radio.radioId}
            radioId={radio.radioId}
            name={radio.name}
            session={session}
            processing={processing}
            directory={directory}
          />
        ))
      ) : processing.loaded ? (
        <Text style={styles.muted}>No radios are configured yet.</Text>
      ) : null}
    </View>
  );
}

function AutomaticRxCard({
  radioId,
  name,
  session,
  processing,
  directory,
}: {
  radioId: string;
  name: string;
  session: ClientSession;
  processing: ProcessingController;
  directory: UserDirectory;
}) {
  const styles = useProcessingStyles();
  const toast = useToast();
  const { consents, profiles, connections, tasks } = processing.data;
  const consent = activeConsent(consents, radioId);
  const health = consentHealth(consent, profiles, connections);
  const options = useMemo(
    () => transcriptionProfiles(profiles, connections),
    [profiles, connections],
  );
  const [setupOpen, setSetupOpen] = useState(false);
  const [profileId, setProfileId] = useState<string>();
  const [owner, setOwner] = useState(session.user.id);
  const [approved, setApproved] = useState(false);
  const [confirm, setConfirm] = useState<'enable' | 'disable'>();

  const option =
    options.find((item) => item.profile.profileId === profileId) ??
    (options.filter((item) => item.eligible).length === 1
      ? options.find((item) => item.eligible)
      : undefined);

  // Any change of destination or profile list requires a fresh approval.
  useEffect(() => {
    setApproved(false);
  }, [option?.profile.profileId, option?.profile.revision, radioId, profiles]);

  // Default the owner to an eligible account once users are known.
  useEffect(() => {
    if (directory.status !== 'ready') return;
    const candidates = serviceOwnerCandidates(
      directory.users,
      radioId,
      session.user.id,
    );
    setOwner(
      (current) =>
        (candidates.some((item) => item.userId === current && item.eligible)
          ? current
          : defaultServiceOwner(candidates, session.user.id)) ?? current,
    );
  }, [directory, radioId, session.user.id]);

  const draft = {
    radioId,
    option,
    serviceOwnerUserId: owner,
    approved,
  };
  const gate = consentGate(draft, processing.busy);
  const ownerName =
    directory.status === 'ready'
      ? directory.users.find((user) => user.id === consent?.serviceOwnerUserId)
          ?.username
      : undefined;
  const status =
    health.state === 'on'
      ? { tone: 'ok' as const, label: 'On · new RX recordings are transcribed' }
      : health.state === 'stale'
        ? {
            tone: 'warning' as const,
            label: 'Paused · consent must be renewed',
          }
        : { tone: 'off' as const, label: 'Off' };

  const enable = async () => {
    setConfirm(undefined);
    const body = consentRequestBody(draft);
    if (!body) return;
    const ok = await processing.run((signal) =>
      enableAutomaticRx(session, body, signal),
    );
    setApproved(false);
    if (ok) {
      setSetupOpen(false);
      toast.show({
        tone: 'success',
        message: `Automatic RX uploads enabled for ${name} and the displayed destination.`,
      });
    }
  };

  const disable = async () => {
    setConfirm(undefined);
    const ok = await processing.run((signal) =>
      disableAutomaticRx(session, radioId, signal),
    );
    if (ok)
      toast.show({
        message: `Automatic uploads disabled for ${name}.`,
      });
  };

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <IconBox name="rx" selected={health.state === 'on'} />
        <View style={styles.grow}>
          <Text style={styles.label}>{name}</Text>
          <StatusIndicator
            tone={status.tone}
            label={status.label}
            size="compact"
          />
        </View>
      </View>
      <SettingToggle
        label={`Automatic transcription for ${name}`}
        value={Boolean(consent) || setupOpen}
        disabled={processing.busy}
        onValueChange={(next) => {
          if (next) setSetupOpen(true);
          else if (consent) setConfirm('disable');
          else setSetupOpen(false);
        }}
      />

      {consent ? (
        <View>
          <Detail label="Destination" value={consent.endpoint} mono />
          <Detail
            label="Profile"
            value={(() => {
              const profile = profiles.find(
                (item) => item.profileId === consent.profileId,
              );
              return profile
                ? `${profileLabel(profile, tasks, connections)} (consented revision ${consent.profileRevision})`
                : `Revision ${consent.profileRevision}`;
            })()}
          />
          <Detail
            label="Service owner"
            value={ownerName ?? consent.serviceOwnerUserId}
          />
          <Detail
            label="Since"
            value={new Date(consent.consentedAt).toLocaleString()}
          />
          {health.state === 'stale' ? (
            <Notice tone="warning">{health.reason}</Notice>
          ) : null}
          {health.state === 'stale' && !setupOpen ? (
            <Button
              label="Renew consent"
              disabled={processing.busy}
              onPress={() => setSetupOpen(true)}
            />
          ) : null}
        </View>
      ) : null}

      {setupOpen ? (
        <View style={styles.section}>
          <View style={styles.divider} />
          <View style={styles.field}>
            <Text style={styles.label}>Transcription profile</Text>
            {options.length ? (
              <ChipGroup
                accessibilityLabel={`Transcription profile for ${name}`}
              >
                {options.map((item) => (
                  <Chip
                    key={item.profile.profileId}
                    label={profileLabel(item.profile, tasks, connections)}
                    icon="wave"
                    selected={
                      option?.profile.profileId === item.profile.profileId
                    }
                    disabled={processing.busy || !item.eligible}
                    accessibilityLabel={
                      item.eligible
                        ? undefined
                        : `${profileLabel(item.profile, tasks, connections)}: ${item.reason ?? ''}`
                    }
                    onPress={() => setProfileId(item.profile.profileId)}
                  />
                ))}
              </ChipGroup>
            ) : (
              <Text style={styles.muted}>
                Create an instance-owned transcription profile first.
              </Text>
            )}
            {options
              .filter((item) => !item.eligible)
              .slice(0, 3)
              .map((item) => (
                <Text key={item.profile.profileId} style={styles.caption}>
                  {profileLabel(item.profile, tasks, connections)}:{' '}
                  {item.reason}
                </Text>
              ))}
          </View>
          <Detail
            label="Destination"
            value={
              option?.connection?.endpoint ??
              'Select an instance-owned transcription profile'
            }
            mono={Boolean(option?.connection)}
          />
          <Text style={styles.caption}>
            Profile revision: {option?.profile.revision ?? 'none'}. Future
            received voice recordings on this radio will be sent to this exact
            provider endpoint.
          </Text>
          <ServiceOwnerPicker
            directory={directory}
            radioId={radioId}
            currentUserId={session.user.id}
            value={owner}
            onChange={setOwner}
            disabled={processing.busy}
          />
          <Checkbox
            label={AUTOMATIC_RX_CONSENT}
            value={approved}
            disabled={processing.busy || !option?.eligible}
            onValueChange={setApproved}
          />
          {!gate.enabled ? (
            <Text style={styles.caption}>{gate.reason}</Text>
          ) : null}
          <View style={styles.actions}>
            <Button
              variant="primary"
              label="Enable automatic uploads for this radio"
              disabled={!gate.enabled}
              onPress={() => setConfirm('enable')}
            />
            <Button
              variant="quiet"
              label="Cancel"
              disabled={processing.busy}
              onPress={() => {
                setSetupOpen(false);
                setApproved(false);
              }}
            />
          </View>
        </View>
      ) : null}

      <ConfirmDialog
        visible={confirm === 'enable'}
        title={`Enable automatic transcription for ${name}?`}
        message={`Future received voice recordings on ${name} will be uploaded to ${option?.connection?.endpoint ?? 'the selected provider'} using profile revision ${option?.profile.revision ?? '—'}. Changing the endpoint or profile requires new consent.`}
        confirmLabel="Enable uploads"
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => void enable()}
      />
      <ConfirmDialog
        visible={confirm === 'disable'}
        title={`Disable automatic transcription for ${name}?`}
        message="New received recordings on this radio will no longer be uploaded. Recordings and existing transcripts are kept."
        confirmLabel="Disable automatic uploads"
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => void disable()}
      />
    </View>
  );
}

function Detail({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  const styles = useProcessingStyles();
  return (
    <View style={styles.reviewRow}>
      <Text style={styles.reviewLabel}>{label}</Text>
      <Text style={[styles.reviewValue, mono && styles.mono]}>{value}</Text>
    </View>
  );
}
