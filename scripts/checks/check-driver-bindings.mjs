import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { AudioFrameSchema } from '@signaldock/radio-driver-sdk/wire';

const frame = create(AudioFrameSchema, {
  streamId: 'cross-language-fixture',
  sequence: 7n,
  mediaTimeUs: 9007199254740993n,
  payload: new Uint8Array([0, 128, 255]),
  format: { sampleRateHz: 32000, channels: 1, encoding: 'pcm_s16le' },
  tuningRevision: 9n,
  attributionConfidence: 'unknown',
  discontinuity: true,
});
const encoded = Buffer.from(toBinary(AudioFrameSchema, frame)).toString('hex');
const python = `
import sys
from signaldock.driver.v1 import driver_pb2, driver_pb2_grpc
frame = driver_pb2.AudioFrame.FromString(bytes.fromhex(sys.argv[1]))
assert frame.stream_id == 'cross-language-fixture'
assert frame.payload == bytes([0, 128, 255])
assert frame.media_time_us == 9007199254740993
assert frame.format.sample_rate_hz == 32000
assert frame.discontinuity
assert driver_pb2_grpc.RadioDriverServiceStub
frame.sequence = 8
print(frame.SerializeToString().hex())
`;
const returned = execFileSync(
  resolve('.venv-codegen/bin/python'),
  ['-c', python, encoded],
  {
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONPATH: resolve('packages/radio-driver-sdk/generated/python'),
    },
  },
).trim();
const decoded = fromBinary(AudioFrameSchema, Buffer.from(returned, 'hex'));
if (decoded.sequence !== 8n || decoded.mediaTimeUs !== frame.mediaTimeUs)
  throw new Error('Driver binding interoperability failed.');
console.log('TypeScript → Python → TypeScript driver bindings passed.');
