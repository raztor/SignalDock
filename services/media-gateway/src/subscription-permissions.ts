import {
  FfiRequest,
  FfiResponse,
  ParticipantTrackPermission,
  SetTrackSubscriptionPermissionsRequest,
  livekitFfiRequest,
} from '@livekit/rtc-ffi-bindings';
import type { LocalParticipant } from '@livekit/rtc-node';
import { SignalDockError } from '@signaldock/contracts';

/** Pinned compatibility seam: rtc-node1.2.1 does not expose this native operation. */
export function setListenerPermissions(
  participant: LocalParticipant,
  identities: readonly string[],
): void {
  const handle = participant.ffi_handle?.handle;
  if (
    typeof handle !== 'bigint' ||
    handle <= 0n ||
    typeof livekitFfiRequest !== 'function'
  )
    throw new SignalDockError(
      'CAPABILITY_UNSUPPORTED',
      'The pinned media runtime cannot enforce listener permissions.',
    );
  const request = new FfiRequest({
    message: {
      case: 'setTrackSubscriptionPermissions',
      value: new SetTrackSubscriptionPermissionsRequest({
        localParticipantHandle: handle,
        allParticipantsAllowed: false,
        permissions: [...new Set(identities)].map(
          (participantIdentity) =>
            new ParticipantTrackPermission({
              participantIdentity,
              allowAll: true,
            }),
        ),
      }),
    },
  });
  const response = FfiResponse.fromBinary(
    livekitFfiRequest(request.toBinary()),
  );
  if (response.message.case !== 'setTrackSubscriptionPermissions')
    throw new SignalDockError(
      'CAPABILITY_UNSUPPORTED',
      'The media runtime rejected listener permissions.',
    );
}
