import type { MediaSession } from '@signaldock/contracts';
import type { LiveKitCredentials, LiveKitRadioBridge } from './livekit.js';

export type MediaCredentials = Pick<LiveKitCredentials, 'issue' | 'revoke'>;
export type MediaBridgeOptions = Omit<
  ConstructorParameters<typeof LiveKitRadioBridge>[0],
  'credentials'
>;
export interface MediaSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
  onMessage(listener: (data: Uint8Array, binary: boolean) => void): () => void;
  onClose(listener: () => void): void;
  onError(listener: () => void): void;
  ping?(): void;
  onPong?(listener: () => void): void;
}
export interface MediaBridgePort {
  attachRadio: LiveKitRadioBridge['attachRadio'];
  updateListeners: LiveKitRadioBridge['updateListeners'];
  close: LiveKitRadioBridge['close'];
  openSocket?(session: MediaSession, socket: MediaSocket): void;
  disconnectParticipant?(identity: string): void;
}
