import {
  PCM_WEBSOCKET_PROTOCOL,
  decodePcmSocketFrame,
  encodePcmSocketFrame,
  type MediaSession,
} from '@signaldock/contracts';
import type { MediaConnection, Microphone } from './controller';

interface PcmMicrophone extends Microphone {
  track: { mediaStreamTrack: MediaStreamTrack };
  onStop?(listener: () => void): void;
}

// A silent Web Audio node captures only after the controller publishes an authorized microphone.
import { PCM_CAPTURE_MODULE } from './pcm-capture-worklet';

export async function connectPcmWebSocket(
  session: MediaSession,
  onInterrupted: () => void,
  signal: AbortSignal,
): Promise<MediaConnection> {
  const url = new URL(session.serverUrl);
  url.pathname =
    url.pathname.replace(/\/$/, '') + '/' + encodeURIComponent(session.id);
  const socket = new WebSocket(url, [
    PCM_WEBSOCKET_PROTOCOL,
    `ticket.${session.token}`,
  ]);
  socket.binaryType = 'arraybuffer';
  let closing = false;
  let interrupted = false;
  let completed = false;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let worklet: AudioWorkletNode | undefined;
  let capturing = false;
  let tuningRevision = 0;
  let sequence = 0;
  let samplesSent = 0;
  let lastRxSequence = -1;
  let nextPlayAt = 0;
  let level = 0;
  let lastAudioAt = 0;
  const playing = new Set<AudioBufferSourceNode>();
  const stopCapture = () => {
    capturing = false;
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.port.postMessage('stop');
      worklet.disconnect();
    }
    source?.disconnect();
    worklet = undefined;
    source = undefined;
  };
  const disconnect = async () => {
    if (closing) return;
    closing = true;
    signal.removeEventListener('abort', abort);
    stopCapture();
    for (const item of playing) {
      try {
        item.stop();
      } catch {}
      item.disconnect();
    }
    playing.clear();
    socket.close();
    if (context && context.state !== 'closed') await context.close();
  };
  const interrupt = () => {
    if (!closing && !completed && !interrupted && !signal.aborted) {
      interrupted = true;
      onInterrupted();
    }
    void disconnect().catch(() => undefined);
  };
  const abort = () => {
    void disconnect().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) {
    await disconnect();
    throw new Error('Audio connection cancelled.');
  }
  socket.addEventListener('close', interrupt);
  socket.addEventListener('error', interrupt);
  try {
    let resumed = Promise.resolve();
    if (session.mode === 'listen') {
      context = new AudioContext({
        sampleRate: 32000,
        latencyHint: 'interactive',
      });
      resumed = context.resume();
    }
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => done(new Error('Audio connection timed out.')),
        10000,
      );
      const cancelled = () => done(new Error('Audio connection cancelled.'));
      const failed = () => done(new Error('Audio connection failed.'));
      const ready = (event: MessageEvent) => {
        try {
          if (typeof event.data !== 'string')
            throw new Error('Invalid audio handshake.');
          const value = JSON.parse(event.data) as {
            type?: unknown;
            protocol?: unknown;
            format?: {
              encoding?: unknown;
              sampleRateHz?: unknown;
              channels?: unknown;
            };
            tuningRevision?: unknown;
          };
          if (
            value.type !== 'ready' ||
            value.protocol !== PCM_WEBSOCKET_PROTOCOL ||
            value.format?.encoding !== 'pcm_s16le' ||
            value.format.sampleRateHz !== 32000 ||
            value.format.channels !== 1
          )
            throw new Error('Unsupported audio format.');
          if (session.mode === 'transmit') {
            if (
              typeof value.tuningRevision !== 'number' ||
              !Number.isSafeInteger(value.tuningRevision) ||
              value.tuningRevision < 0
            )
              throw new Error('Missing TX revision.');
            tuningRevision = value.tuningRevision;
          }
          done();
        } catch (error) {
          done(error);
        }
      };
      const done = (error?: unknown) => {
        clearTimeout(timer);
        socket.removeEventListener('message', ready);
        socket.removeEventListener('close', failed);
        socket.removeEventListener('error', failed);
        signal.removeEventListener('abort', cancelled);
        if (error) reject(error);
        else resolve();
      };
      socket.addEventListener('message', ready);
      socket.addEventListener('close', failed);
      socket.addEventListener('error', failed);
      signal.addEventListener('abort', cancelled, { once: true });
      if (signal.aborted || closing) cancelled();
    });
    let setupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([readyPromise, resumed]),
        new Promise<never>((_resolve, reject) => {
          setupTimer = setTimeout(
            () => reject(new Error('Audio initialization timed out.')),
            10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(setupTimer);
    }
    if (signal.aborted || closing)
      throw new Error('Audio connection cancelled.');
    if (session.mode === 'listen')
      socket.addEventListener('message', (event: MessageEvent) => {
        if (closing || signal.aborted || !context) return;
        try {
          if (!(event.data instanceof ArrayBuffer))
            throw new Error('Invalid audio packet.');
          const frame = decodePcmSocketFrame(new Uint8Array(event.data));
          if (frame.sequence <= lastRxSequence)
            throw new Error('Audio packet sequence regressed.');
          lastRxSequence = frame.sequence;
          const samples = frame.data.length / 2;
          const buffer = context.createBuffer(1, samples, 32000);
          const output = buffer.getChannelData(0);
          const input = new DataView(
            frame.data.buffer,
            frame.data.byteOffset,
            frame.data.byteLength,
          );
          let energy = 0;
          for (let index = 0; index < samples; index++) {
            const value = input.getInt16(index * 2, true) / 32768;
            output[index] = value;
            energy += value * value;
          }
          const rms = Math.sqrt(energy / samples);
          level =
            rms > 0
              ? Math.min(1, Math.max(0, (20 * Math.log10(rms) + 60) / 60))
              : 0;
          lastAudioAt = performance.now();
          if (nextPlayAt - context.currentTime > 0.25)
            throw new Error('Audio playback fell behind.');
          nextPlayAt = Math.max(nextPlayAt, context.currentTime + 0.04);
          const node = context.createBufferSource();
          node.buffer = buffer;
          node.connect(context.destination);
          playing.add(node);
          node.onended = () => {
            playing.delete(node);
            node.disconnect();
          };
          node.start(nextPlayAt);
          nextPlayAt += samples / 32000;
        } catch {
          interrupt();
        }
      });
    return {
      disconnect,
      ...(session.mode === 'transmit'
        ? {
            finish: async () => {
              stopCapture();
              if (
                closing ||
                signal.aborted ||
                socket.readyState !== WebSocket.OPEN
              )
                throw new Error('Audio completion cancelled.');
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(
                  () => done(new Error('Audio completion timed out.')),
                  4000,
                );
                const ended = (event: MessageEvent) => {
                  if (typeof event.data !== 'string') return;
                  try {
                    if (JSON.parse(event.data).type === 'ended') {
                      completed = true;
                      done();
                    }
                  } catch {
                    done(new Error('Invalid audio completion.'));
                  }
                };
                const failed = () =>
                  done(new Error('Audio completion interrupted.'));
                const done = (error?: Error) => {
                  clearTimeout(timer);
                  socket.removeEventListener('message', ended);
                  socket.removeEventListener('close', failed);
                  socket.removeEventListener('error', failed);
                  signal.removeEventListener('abort', failed);
                  if (error) reject(error);
                  else resolve();
                };
                socket.addEventListener('message', ended);
                socket.addEventListener('close', failed);
                socket.addEventListener('error', failed);
                signal.addEventListener('abort', failed, { once: true });
                socket.send('{"type":"end"}');
              });
            },
          }
        : {}),
      ...(session.mode === 'listen'
        ? { level: () => (performance.now() - lastAudioAt < 200 ? level : 0) }
        : {}),
      publish: async (input) => {
        const microphone = input as PcmMicrophone;
        if (
          session.mode !== 'transmit' ||
          closing ||
          signal.aborted ||
          capturing ||
          microphone.track.mediaStreamTrack.readyState !== 'live'
        )
          throw new Error('Microphone publication is unavailable.');
        capturing = true;
        microphone.onStop?.(stopCapture);
        try {
          context = new AudioContext({
            sampleRate: 32000,
            latencyHint: 'interactive',
          });
          await context.resume();
          const moduleUrl = URL.createObjectURL(
            new Blob([PCM_CAPTURE_MODULE], { type: 'text/javascript' }),
          );
          try {
            await context.audioWorklet.addModule(moduleUrl);
          } finally {
            URL.revokeObjectURL(moduleUrl);
          }
          if (
            !capturing ||
            closing ||
            signal.aborted ||
            microphone.track.mediaStreamTrack.readyState !== 'live'
          )
            throw new Error('Microphone capture cancelled.');
          source = context.createMediaStreamSource(
            new MediaStream([microphone.track.mediaStreamTrack]),
          );
          worklet = new AudioWorkletNode(context, 'signaldock-pcm', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
          });
          worklet.port.onmessage = (event: MessageEvent) => {
            if (!capturing || closing || signal.aborted) return;
            try {
              if (
                !(event.data instanceof ArrayBuffer) ||
                event.data.byteLength !== 1280 ||
                socket.readyState !== WebSocket.OPEN ||
                socket.bufferedAmount > 3 * 1304
              )
                throw new Error('Microphone connection is too slow.');
              socket.send(
                encodePcmSocketFrame({
                  sequence: sequence++,
                  mediaTimeUs: Math.round((samplesSent * 1000000) / 32000),
                  tuningRevision,
                  data: new Uint8Array(event.data),
                }),
              );
              samplesSent += 640;
            } catch {
              stopCapture();
              interrupt();
            }
          };
          worklet.onprocessorerror = () => {
            stopCapture();
            interrupt();
          };
          source.connect(worklet);
          worklet.connect(context.destination);
        } catch (error) {
          stopCapture();
          await disconnect();
          throw error;
        }
      },
    };
  } catch (error) {
    await disconnect();
    throw error;
  }
}
