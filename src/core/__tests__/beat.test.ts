import { describe, it, expect } from "vitest";
import { detectOnsets, estimateBeatSec, planBeatSnap } from "../beat";

const SR = 16000;

/** Click track: a short 1 kHz burst every beat. */
function metronome(bpm: number, durationSec: number, clickSec = 0.02): Float32Array {
  const samples = new Float32Array(Math.round(durationSec * SR));
  const period = 60 / bpm;
  for (let t = 0; t < durationSec; t += period) {
    const start = Math.round(t * SR);
    const length = Math.round(clickSec * SR);
    for (let i = 0; i < length && start + i < samples.length; i++) {
      samples[start + i] = 0.8 * Math.sin((2 * Math.PI * 1000 * i) / SR);
    }
  }
  return samples;
}

describe("beat detection", () => {
  it("finds metronome attacks and derives the tempo", () => {
    const onsets = detectOnsets(metronome(120, 4), SR);
    expect(onsets.length).toBeGreaterThanOrEqual(7);
    expect(estimateBeatSec(onsets)).toBeCloseTo(0.5, 2);
    for (let i = 1; i < Math.min(onsets.length, 5); i++) {
      expect(onsets[i] - onsets[i - 1]).toBeCloseTo(0.5, 1);
    }
  });

  it("returns nothing for silence or too little input", () => {
    expect(detectOnsets(new Float32Array(SR), SR)).toEqual([]);
    expect(detectOnsets(new Float32Array(16), SR)).toEqual([]);
    expect(estimateBeatSec([0, 1])).toBeNull();
  });
});

describe("beat snap", () => {
  it("pulls a start back onto the beat and leaves the rest alone", () => {
    const segments = [{ startSec: 0, endSec: 2 }, { startSec: 5.04, endSec: 7 }, { startSec: 9.5, endSec: 11 }];
    const result = planBeatSnap(segments, [0, 0.5, 1, 2, 4, 5, 7, 8, 9, 9.5], 0.12);
    expect(result.snapped).toBe(1);
    expect(result.segments[0]).toEqual({ startSec: 0, endSec: 2 });
    expect(result.segments[1]).toEqual({ startSec: 5, endSec: 7 });
    // Already on the grid: unchanged and not counted.
    expect(result.segments[2]).toEqual({ startSec: 9.5, endSec: 11 });
  });

  it("never shifts forward, into the previous piece, or past the tolerance", () => {
    expect(planBeatSnap([{ startSec: 0, endSec: 2 }, { startSec: 5, endSec: 7 }], [5.05], 0.12).snapped).toBe(0);
    expect(planBeatSnap([{ startSec: 0, endSec: 5 }, { startSec: 5.04, endSec: 7 }], [5], 0.12).snapped).toBe(0);
    expect(planBeatSnap([{ startSec: 0, endSec: 2 }, { startSec: 5.5, endSec: 7 }], [5], 0.12).snapped).toBe(0);
    // Shifting must not collapse the piece either.
    expect(planBeatSnap([{ startSec: 0, endSec: 2 }, { startSec: 5.05, endSec: 5.2 }], [5], 0.12).snapped).toBe(0);
  });
});