import { SignalDockError, type PcmAudioFrame } from '@signaldock/contracts';

/** Copy byte views explicitly: offsets and byte order must survive sliced buffers. */
export function pcmSamples(frame: PcmAudioFrame): Int16Array {
  if (
    frame.format.encoding !== 'pcm_s16le' ||
    frame.format.channels !== 1 ||
    frame.data.byteLength % 2 ||
    frame.data.byteLength > 9600
  ) {
    throw new SignalDockError(
      'INVALID_ARGUMENT',
      'A bounded mono PCM s16le frame is required.',
    );
  }
  const view = new DataView(
    frame.data.buffer,
    frame.data.byteOffset,
    frame.data.byteLength,
  );
  const samples = new Int16Array(frame.data.byteLength / 2);
  for (let i = 0; i < samples.length; i++)
    samples[i] = view.getInt16(i * 2, true);
  return samples;
}

export function pcmBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++)
    view.setInt16(i * 2, samples[i]!, true);
  return bytes;
}

/** Bounded handoff used by gRPC client-streaming TX; overflow fails closed. */
export class BoundedAudioQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: ((item: IteratorResult<T>) => void) | undefined;
  private finished = false;
  constructor(private readonly limit = 4) {}
  push(item: T): void {
    if (this.finished)
      throw new SignalDockError('DEADLINE_EXCEEDED', 'Audio input is closed.');
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value: item, done: false });
      return;
    }
    if (this.items.length >= this.limit)
      throw new SignalDockError(
        'TX_LIMIT_REACHED',
        'Audio queue exceeded its latency bound.',
      );
    this.items.push(item);
  }
  close(): void {
    this.finished = true;
    this.items.length = 0;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length)
          return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.finished)
          return Promise.resolve({ value: undefined, done: true });
        if (this.waiter)
          return Promise.reject(
            new Error('Only one audio consumer is supported.'),
          );
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}
