import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PCM_CAPTURE_MODULE } from '../../apps/client/src/features/media/pcm-capture-worklet.ts';

test('PCM worklet captures exact samples, keeps playback silent and stops immediately', () => {
  const frames = [];
  class Processor {
    port = {
      postMessage: (buffer) => frames.push(new Uint8Array(buffer).slice()),
      onmessage: undefined,
    };
  }
  let Capture;
  runInNewContext(PCM_CAPTURE_MODULE, {
    AudioWorkletProcessor: Processor,
    registerProcessor: (_name, constructor) => {
      Capture = constructor;
    },
  });
  const processor = new Capture(),
    input = new Float32Array(128).fill(0.5),
    output = new Float32Array(128).fill(1);
  input[0] = -1;
  for (let index = 0; index < 5; index++)
    processor.process([[input]], [[output]]);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, 1280);
  assert.deepEqual([...frames[0].slice(0, 4)], [0, 128, 0, 64]);
  assert(output.every((sample) => sample === 0));
  processor.port.onmessage();
  assert.equal(processor.process([[input]], [[output]]), false);
  assert.equal(frames.length, 1);
});
