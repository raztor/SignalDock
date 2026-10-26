import { describe, expect, it } from 'vitest';
import { RadioViewSchema, type PublicUser } from '@signaldock/contracts';
import { mediaAccess } from './media-access';

function fixture() {
  const radioId = crypto.randomUUID(),
    userId = crypto.randomUUID(),
    generation = crypto.randomUUID();
  const user: PublicUser = {
    id: userId,
    username: 'operator',
    role: 'operator',
    enabled: true,
    radioPermissions: [
      {
        radioId,
        permissions: ['radio.listen', 'radio.control', 'radio.transmit'],
      },
    ],
  };
  const radio = RadioViewSchema.parse({
    radioId,
    displayName: 'Fixture',
    driverId: 'simulation',
    resourceGroupIds: [],
    enabled: true,
    descriptor: {
      radioId,
      displayName: 'Fixture',
      driverId: 'simulation',
      resourceGroupIds: [],
      capabilities: {
        tuning: {
          writable: true,
          ranges: [{ minHz: 144000000, maxHz: 148000000 }],
          modes: ['FM'],
        },
        rxAudio: true,
        txAudio: true,
        ptt: 'audio_coupled',
        physicalTxObservation: true,
        independentlyReceivableChannels: 1,
        verification: 'simulated',
      },
    },
    snapshot: {
      radioId,
      generation,
      revision: 1,
      connection: 'ready',
      observedTuning: { rxHz: 147540000, mode: 'FM' },
      tuningConfidence: 'confirmed',
      txState: 'idle',
    },
    control: null,
    health: { state: 'connected' },
  });
  return { radio, user, radioId, mediaAvailable: true };
}
describe('media feature availability', () => {
  it('disables live audio when the server has no media service', () => {
    const f = fixture();
    const access = mediaAccess({ ...f, mediaAvailable: false });
    expect(access.canListen).toBe(false);
    expect(access.canTransmit).toBe(false);
    expect(access.listenReason).toContain('not configured');
  });
  it('disables unsupported simulator audio even for an authorized operator', () => {
    const f = fixture();
    f.radio.descriptor!.capabilities.rxAudio = false;
    f.radio.descriptor!.capabilities.txAudio = false;
    f.radio.descriptor!.capabilities.ptt = 'unsupported';
    const access = mediaAccess(f);
    expect(access.canListen).toBe(false);
    expect(access.canTransmit).toBe(false);
    expect(access.transmitReason).toContain('does not support');
  });
  it('requires explicit listening, control and transmit permissions', () => {
    const f = fixture();
    f.user.radioPermissions[0]!.permissions = ['radio.listen'];
    expect(mediaAccess(f)).toMatchObject({
      canListen: true,
      canTransmit: false,
    });
    f.user.radioPermissions[0]!.permissions = [
      'radio.control',
      'radio.transmit',
    ];
    expect(mediaAccess(f)).toMatchObject({
      canListen: false,
      canTransmit: false,
    });
  });
  it('keeps listening available while another operator owns control', () => {
    const f = fixture();
    f.radio.control = {
      radioId: f.radioId,
      grantId: crypto.randomUUID(),
      generation: f.radio.snapshot!.generation,
      ownerId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      fencing: 1,
      expiresAt: Date.now() + 10000,
    };
    expect(mediaAccess(f)).toMatchObject({
      canListen: true,
      canTransmit: false,
    });
    f.radio.control.ownerId = f.user.id;
    expect(mediaAccess(f).canTransmit).toBe(true);
    f.radio.control.ownerId = crypto.randomUUID();
    f.radio.control.expiresAt = 1;
    expect(mediaAccess(f).canTransmit).toBe(true);
  });
  it('requires confirmed tuning and carrier state without interrupting normal active PTT', () => {
    const f = fixture();
    f.radio.snapshot!.tuningConfidence = 'unknown';
    expect(mediaAccess(f)).toMatchObject({
      canListen: true,
      canTransmit: false,
    });
    f.radio.snapshot!.tuningConfidence = 'confirmed';
    f.radio.snapshot!.txState = 'transmitting';
    expect(mediaAccess(f).canTransmit).toBe(false);
    expect(mediaAccess({ ...f, activeTx: true }).canTransmit).toBe(true);
    f.radio.snapshot!.txState = 'stop_unconfirmed';
    expect(mediaAccess({ ...f, activeTx: true }).canTransmit).toBe(false);
  });
  it('explains unavailable details and disconnected radios', () => {
    const f = fixture();
    expect(mediaAccess({ ...f, radio: null }).listenReason).toContain(
      'Loading',
    );
    expect(
      mediaAccess({ ...f, radio: null, radioError: 'failed' }).listenReason,
    ).toContain('unavailable');
    f.radio.snapshot!.connection = 'disconnected';
    expect(mediaAccess(f)).toMatchObject({
      canListen: false,
      canTransmit: false,
    });
  });
});
