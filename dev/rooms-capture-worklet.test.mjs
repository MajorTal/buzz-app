import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

async function loadProcessor() {
  const messages = [];
  let Processor;
  class AudioWorkletProcessor {
    port = {
      postMessage: (value, transfer) => messages.push({ value, transfer }),
    };
  }
  const source = await readFile(
    new URL("../public/rooms-capture-worklet.js", import.meta.url),
    "utf8",
  );
  vm.runInNewContext(source, {
    AudioWorkletProcessor,
    Float32Array,
    Math,
    Number,
    registerProcessor: (name, implementation) => {
      expect(name).toBe("buzz-live-capture");
      Processor = implementation;
    },
  });
  return { processor: new Processor({ processorOptions: {} }), messages };
}

describe("Live room capture worklet", () => {
  it("accumulates render quanta into exact 960-sample frames with RMS", async () => {
    const { processor, messages } = await loadProcessor();
    const quantum = new Float32Array(128).fill(0.25);

    for (let index = 0; index < 8; index++) processor.process([[quantum]]);
    expect(messages).toHaveLength(1);
    expect(messages[0].value.samples).toHaveLength(960);
    expect(messages[0].value.rms).toBeCloseTo(0.25);
    expect(messages[0].transfer).toEqual([messages[0].value.samples.buffer]);

    for (let index = 0; index < 7; index++) processor.process([[quantum]]);
    expect(messages).toHaveLength(2);
    expect(messages[1].value.samples).toHaveLength(960);
  });
});
