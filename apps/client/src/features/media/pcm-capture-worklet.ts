export const PCM_CAPTURE_MODULE = `
class SignalDockPcm extends AudioWorkletProcessor {
  constructor() {
    super(); this.active = true; this.used = 0; this.buffer = new ArrayBuffer(1280); this.view = new DataView(this.buffer);
    this.port.onmessage = () => { this.active = false; };
  }
  process(inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0);
    if (!this.active) return false;
    const channels = inputs[0];
    if (!channels || !channels[0]) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      sample = Math.max(-1, Math.min(1, sample));
      this.view.setInt16(this.used * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      if (++this.used === 640) {
        this.port.postMessage(this.buffer, [this.buffer]); this.used = 0;
        this.buffer = new ArrayBuffer(1280); this.view = new DataView(this.buffer);
      }
    }
    return true;
  }
}
registerProcessor('signaldock-pcm', SignalDockPcm);
`;
