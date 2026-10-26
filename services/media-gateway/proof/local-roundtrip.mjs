import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
  dispose,
} from '@livekit/rtc-node';
import {
  LiveKitCredentials,
  LiveKitRadioBridge,
  pcmBytes,
} from '@signaldock/media-gateway';

// Only a loopback, disposable SFU and synthetic audio. No radio connection.
const instanceId = crypto.randomUUID(),
  radioId = crypto.randomUUID(),
  sessionId = crypto.randomUUID();
const credentials = new LiveKitCredentials({
  serverUrl: process.env.LIVEKIT_URL ?? 'ws://127.0.0.1:7885',
  apiKey: process.env.LIVEKIT_API_KEY ?? 'devkey',
  apiSecret:
    process.env.LIVEKIT_API_SECRET ?? 'secret-for-local-synthetic-proof-only',
});
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(
    new URL(credentials.config.serverUrl).hostname,
  )
)
  throw new Error('This proof requires a loopback SFU.');
const listener = new Room(),
  publisher = new Room();
let rxFrames = 0,
  txFrames = 0,
  rxEnergy = 0,
  txEnergy = 0,
  archived = 0;
const listen = await credentials.issue({
  id: crypto.randomUUID(),
  instanceId,
  radioId,
  sessionId,
  mode: 'listen',
});
const transmit = await credentials.issue({
  id: crypto.randomUUID(),
  instanceId,
  radioId,
  sessionId,
  mode: 'transmit',
});
const grant = {
  txGrantId: crypto.randomUUID(),
  radioId,
  ownerId: crypto.randomUUID(),
  sessionId,
  controlGrant: crypto.randomUUID(),
  generation: crypto.randomUUID(),
  fencing: 1,
  tuningRevision: 1,
  expiresAt: Date.now() + 30000,
  maxUntil: Date.now() + 30000,
};
let active = true;
const readers = [];
const bridge = new LiveKitRadioBridge({
  instanceId,
  credentials,
  authorizeParticipant: (_radio, identity) =>
    active && identity === transmit.participantIdentity ? grant : undefined,
  sendTx: async (_id, frame) => {
    txFrames++;
    txEnergy += frame.data.reduce((sum, value) => sum + value, 0);
  },
  stopTx: async () => {
    active = false;
  },
  invalidateRadio: async () => undefined,
  onFrame: () => {
    archived++;
  },
  onError: (_id, error) => console.error('Bridge error:', error),
});
listener.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
  if (participant.identity !== `bridge-${instanceId}-${radioId}`) return;
  const reader = new AudioStream(track, {
    sampleRate: 32000,
    numChannels: 1,
    frameSizeMs: 20,
  }).getReader();
  readers.push(reader);
  void (async () => {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        rxFrames++;
        for (const sample of result.value.data) rxEnergy += Math.abs(sample);
      }
    } catch {}
  })();
});
const source = new AudioSource(32000, 1, 40);
const track = LocalAudioTrack.createAudioTrack('synthetic-microphone', source);
function samples(sequence) {
  const values = new Int16Array(640);
  for (let i = 0; i < 640; i++)
    values[i] = Math.round(
      8000 * Math.sin(((sequence * 640 + i) * 2 * Math.PI * 700) / 32000),
    );
  return values;
}
try {
  await listener.connect(credentials.config.serverUrl, listen.token, {
    autoSubscribe: true,
  });
  await bridge.attachRadio({
    radioId,
    generation: grant.generation,
    format: { encoding: 'pcm_s16le', sampleRateHz: 32000, channels: 1 },
    frames: async function* (signal) {
      let sequence = 0;
      while (!signal.aborted) {
        const data = pcmBytes(samples(sequence));
        yield {
          streamId: 'synthetic-rx',
          sequence,
          mediaTimeUs: sequence++ * 20000,
          format: { encoding: 'pcm_s16le', sampleRateHz: 32000, channels: 1 },
          data,
          tuningRevision: 1,
          attributionConfidence: 'confirmed',
          discontinuity: false,
        };
        await sleep(20);
      }
    },
  });
  await publisher.connect(credentials.config.serverUrl, transmit.token, {
    autoSubscribe: false,
  });
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  await publisher.localParticipant.publishTrack(track, options);
  for (let i = 0; i < 90; i++)
    await source.captureFrame(new AudioFrame(samples(i), 32000, 1, 640));
  await sleep(500);
  assert(rxFrames > 10 && rxEnergy > 0, 'RX must contain decoded PCM');
  assert(
    txFrames > 10 && txEnergy > 0,
    'TX must reach the authorized PCM bridge',
  );
  assert(
    archived >= rxFrames,
    'RX capture must run independently of WebRTC delivery',
  );
  console.log(
    JSON.stringify({
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      rxFrames,
      txFrames,
      rxEnergy,
      txEnergy,
      archived,
      syntheticOnly: true,
    }),
  );
} finally {
  active = false;
  await Promise.all(
    readers.map((reader) => reader.cancel().catch(() => undefined)),
  );
  await publisher.disconnect();
  await listener.disconnect();
  await bridge.close();
  await source.close();
  await track.close();
  await dispose();
}
