import type { PublicUser, RadioView } from '@signaldock/contracts';

export interface MediaAccess {
  canListen: boolean;
  canTransmit: boolean;
  listenReason: string;
  transmitReason: string;
}
/** Display availability only. The backend still validates each request. */
export function mediaAccess(input: {
  mediaAvailable: boolean;
  radio: RadioView | null;
  user: PublicUser;
  radioId: string;
  activeTx?: boolean;
  now?: number;
  radioError?: string | undefined;
}): MediaAccess {
  const { radio, user, radioId } = input;
  const permissions = user.radioPermissions
    .filter((grant) => grant.radioId === radioId)
    .flatMap((grant) => grant.permissions);
  const common = !input.mediaAvailable
    ? 'Live audio is not configured on this server.'
    : !radio
      ? input.radioError
        ? 'Radio details are unavailable.'
        : 'Loading radio audio capabilities.'
      : !radio.enabled
        ? 'This radio is disabled.'
        : radio.health.state === 'failed'
          ? 'The radio connection is unavailable.'
          : !radio.descriptor
            ? 'Radio capabilities are unavailable.'
            : radio.snapshot?.connection !== 'ready'
              ? 'The radio must be connected before using live audio.'
              : !user.enabled
                ? 'This account is disabled.'
                : '';
  const listenReason =
    common ||
    (!radio?.descriptor?.capabilities.rxAudio
      ? 'This radio does not support live reception.'
      : !permissions.includes('radio.listen')
        ? 'You do not have listening permission for this radio.'
        : '');
  const capabilities = radio?.descriptor?.capabilities;
  const held =
    radio?.control && radio.control.expiresAt > (input.now ?? Date.now())
      ? radio.control
      : null;
  const txState = radio?.snapshot?.txState;
  const transmitReason =
    common ||
    (!capabilities?.txAudio || capabilities.ptt === 'unsupported'
      ? 'This radio does not support live transmission.'
      : !permissions.includes('radio.listen') ||
          !permissions.includes('radio.transmit') ||
          !permissions.includes('radio.control')
        ? 'Listening, control and transmit permissions are required for PTT.'
        : held && held.ownerId !== user.id
          ? 'Another user controls this radio.'
          : held && held.generation !== radio?.snapshot?.generation
            ? 'Radio control state is changing.'
            : radio?.snapshot?.tuningConfidence !== 'confirmed' ||
                !radio.snapshot.observedTuning
              ? 'Confirm the radio frequency before transmitting.'
              : txState !== 'idle' &&
                  !(
                    input.activeTx &&
                    ['preparing', 'tx_unconfirmed', 'transmitting'].includes(
                      txState ?? '',
                    )
                  )
                ? 'The radio is transmitting or its carrier state is uncertain.'
                : '');
  return {
    canListen: !listenReason,
    canTransmit: !transmitReason,
    listenReason,
    transmitReason,
  };
}
