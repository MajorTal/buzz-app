const DEFAULT_FRAME_SAMPLES = 960;

class BuzzLiveCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requested = options.processorOptions?.frameSamples;
    this.frameSamples =
      Number.isInteger(requested) && requested > 0
        ? requested
        : DEFAULT_FRAME_SAMPLES;
    this.frame = new Float32Array(this.frameSamples);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    let sourceOffset = 0;
    while (sourceOffset < input.length) {
      const count = Math.min(
        input.length - sourceOffset,
        this.frameSamples - this.offset,
      );
      this.frame.set(
        input.subarray(sourceOffset, sourceOffset + count),
        this.offset,
      );
      this.offset += count;
      sourceOffset += count;
      if (this.offset !== this.frameSamples) continue;

      let sumSquares = 0;
      for (const sample of this.frame) sumSquares += sample * sample;
      const complete = this.frame;
      this.port.postMessage(
        {
          samples: complete,
          rms: Math.sqrt(sumSquares / this.frameSamples),
        },
        [complete.buffer],
      );
      this.frame = new Float32Array(this.frameSamples);
      this.offset = 0;
    }
    return true;
  }
}

registerProcessor("buzz-live-capture", BuzzLiveCapture);
