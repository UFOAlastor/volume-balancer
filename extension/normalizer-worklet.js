import { BalanceDSP } from './dsp.js';

class BalanceNormalizer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.dsp = new BalanceDSP(sampleRate, options.processorOptions);
    // Carry the upstream controller's attenuation across pause/replay and
    // playlist replacement. Silence must not restart loudness learning.
    const previous = options.processorOptions?.levelerState;
    if (previous && ['energy', 'fastEnergy', 'gain', 'hold'].every(key => Number.isFinite(previous[key])) &&
        previous.energy >= 0 && previous.fastEnergy >= 0 && previous.gain >= .05 && previous.gain <= 5 && previous.hold >= 0) {
      Object.assign(this.dsp.leveler, previous, { initialized: previous.initialized === true });
      this.dsp.gain = previous.gain;
    }
    this.frames = 0;
    this.requiresHeartbeat = options.processorOptions?.requiresHeartbeat === true;
    this.withoutHeartbeat = 0;
    this.disposed = false;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'dispose') this.disposed = true;
      else if (data?.type === 'heartbeat') this.withoutHeartbeat = 0;
      else if (!this.disposed) this.dsp.configure(data);
    };
  }

  process(inputs, outputs) {
    this.withoutHeartbeat += outputs[0][0]?.length || 0;
    if (this.requiresHeartbeat && this.withoutHeartbeat > sampleRate * .8) this.disposed = true;
    if (this.disposed) {
      for (const channel of outputs[0] || []) channel.fill(0);
      return false;
    }
    this.dsp.process(inputs[0] || [], outputs[0]);
    this.frames += outputs[0][0]?.length || 0;
    if (this.frames >= sampleRate / 5) {
      const { energy, fastEnergy, gain, hold, initialized } = this.dsp.leveler;
      this.port.postMessage({ ...this.dsp.metrics, levelerState: { energy, fastEnergy, gain, hold, initialized } });
      this.frames = 0;
    }
    return true;
  }
}

registerProcessor('balance-normalizer', BalanceNormalizer);
