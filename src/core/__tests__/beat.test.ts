import { describe, it, expect } from "vitest";
import { detectOnsets, estimateBeatSec, planBeatSnap, repeatBeatGrid } from "../beat";

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

/** Half-second grid, long enough for the fixtures below. */
const GRID = Array.from({ length: 40 }, (_, i) => i * 0.5);

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
  // Beats are output time; segment starts are absolute source seconds. The two
  // fixtures below use deliberately different source offsets to prove the
  // decision is made on the output timeline only.
  it("judges the splice in output time, not by the source timestamp", () => {
    // Source 100 → output 0. Junction 1 sits at output 2.0 s, which is a beat:
    // the source-numbered 105.04 must not pull the cut anywhere.
    const segments = [{ startSec: 100, endSec: 102 }, { startSec: 105.04, endSec: 107 }];
    const result = planBeatSnap(segments, [0, 0.5, 1, 2, 4, 5, 7, 8, 9, 9.5]);
    expect(result.snapped).toBe(0);
    expect(result.segments).toEqual(segments);
  });

  it("pulls a start back onto the beat under the splice", () => {
    // Junction at output 2.05 s, nearest beat back is 2.0 → the source cut moves
    // back by the same 0.05 s, into the silence the cut is about to remove.
    const result = planBeatSnap([{ startSec: 0, endSec: 2.05 }, { startSec: 5.05, endSec: 7 }], GRID);
    expect(result.snapped).toBe(1);
    expect(result.segments[0]).toEqual({ startSec: 0, endSec: 2.05 });
    expect(result.segments[1]).toEqual({ startSec: 5, endSec: 7 });
  });

  it("snaps even when the source timestamp already sits on a beat number", () => {
    // Source 5.0 looks like a beat, but the splice lands at output 2.05 s, so
    // the source cut has to go to 4.95 for the beat to fall on the splice.
    const result = planBeatSnap([{ startSec: 0, endSec: 2.05 }, { startSec: 5, endSec: 7 }], GRID);
    expect(result.snapped).toBe(1);
    expect(result.segments[1]).toEqual({ startSec: 4.95, endSec: 7 });
  });

  it("accumulates the snapped lengths, so a later splice sees its true position", () => {
    // The first snap starts piece 2 0.15 s earlier in the source while its end
    // stays put — the piece is now 0.15 s longer, so splice 2 actually sits at
    // output 4.05 s (a beat). The old code summed the original 2.15+1.75 =
    // 3.90 s, found no beat within reach, and left the third cut unsnapped.
    const result = planBeatSnap(
      [
        { startSec: 0, endSec: 2.15 },
        { startSec: 5.15, endSec: 6.9 },
        { startSec: 10, endSec: 12 },
      ],
      GRID,
      { maxShiftSec: 0.2 }
    );
    expect(result.snapped).toBe(2);
    expect(result.segments[1]).toEqual({ startSec: 5, endSec: 6.9 });
    expect(result.segments[2]).toEqual({ startSec: 9.95, endSec: 12 });
  });

  it("counts a cross-fade when locating the splice", () => {
    // With no cross-fade the junction sits at output 2.0 s (a beat, no snap);
    // a 0.4 s cross-fade moves it to 1.6 s, which pulls toward 1.5.
    const segments = [{ startSec: 0, endSec: 2 }, { startSec: 5.05, endSec: 7 }];
    expect(planBeatSnap(segments, GRID).snapped).toBe(0);
    const faded = planBeatSnap(segments, GRID, { transitionSec: 0.4 });
    expect(faded.snapped).toBe(1);
    expect(faded.segments[1]).toEqual({ startSec: 4.95, endSec: 7 });
  });

  it("never shifts forward, into the previous piece, or past the tolerance", () => {
    // A beat after the splice is out of reach: shifting forward would eat speech.
    const forward = planBeatSnap([{ startSec: 0, endSec: 2 }, { startSec: 5, endSec: 7 }], [2.05]);
    expect(forward.snapped).toBe(0);
    expect(forward.segments[1]).toEqual({ startSec: 5, endSec: 7 });
    // The shift would swallow the previous piece.
    expect(planBeatSnap([{ startSec: 0, endSec: 5.02 }, { startSec: 5.04, endSec: 7 }], GRID).snapped).toBe(0);
    // The shift would collapse this piece.
    expect(planBeatSnap([{ startSec: 0, endSec: 5.02 }, { startSec: 5.05, endSec: 5.2 }], GRID).snapped).toBe(0);
    // Nearest beat back is further than maxShiftSec.
    expect(planBeatSnap([{ startSec: 0, endSec: 2.3 }, { startSec: 5.5, endSec: 7 }], GRID).snapped).toBe(0);
    // No beats at all, or a single piece: nothing to align.
    expect(planBeatSnap([{ startSec: 0, endSec: 2.05 }, { startSec: 5.05, endSec: 7 }], []).snapped).toBe(0);
    expect(planBeatSnap([{ startSec: 5.05, endSec: 7 }], GRID).snapped).toBe(0);
  });
});

describe("repeatBeatGrid", () => {
  it("repeats a looping bed's grid out to the clip length", () => {
    // 2 s loop, 5 s clip → the grid plays three times.
    expect(repeatBeatGrid([0, 0.5, 1, 1.5], 2, 5)).toEqual([
      0, 0.5, 1, 1.5,
      2, 2.5, 3, 3.5,
      4, 4.5, 5,
    ]);
  });

  it("leaves a grid that already covers the clip alone", () => {
    expect(repeatBeatGrid([0, 1, 2], 2, 2)).toEqual([0, 1, 2]);
    expect(repeatBeatGrid([], 2, 10)).toEqual([]);
    expect(repeatBeatGrid([0, 1], 0, 10)).toEqual([0, 1]);
  });
});
