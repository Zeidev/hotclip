/**
 * Beat synchronisation for the background music bed.
 *
 * Two pieces, both deterministic and side-effect free:
 *  - `detectOnsets` finds note/percussion attacks from the short-term RMS
 *    envelope (energy jumps), which is what a music bed needs; no model, no
 *    extra dependency.
 *  - `planBeatSnap` moves a jump-cut boundary BACKWARD onto the nearest beat,
 *    never forward: backward always lands in the silence the jump cut is about
 *    to remove, so a snapped cut can never eat a word or a breath that the
 *    original boundary protected.
 *
 * 时间轴口径(踩过一次的坑):beat 来自 BGM 文件本身,而 BGM 是从成片 0 秒
 * 铺满的(sound-design `-stream_loop -1` + `atrim` + `asetpts`),所以 **beat 的
 * 单位是成片时间**;而 segment.startSec 是**源片时间**(VOD 里动辄 3000 秒开外)。
 * 两者直接相减永远差一个「这条片在源里的位置」,于是 snap 一次都不生效。
 * 判据因此先算出每个接缝在成片上的位置(逐段时长累加,再减掉交叉淡化),
 * 在那里找 beat,再把源片上的切点按同样的量往前挪。
 */
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { extractPcmF32le16k, readF32leSamples } from "./models";
import { resolveFfmpegPath } from "./binaries";

export interface OnsetOptions {
  /** Analysis frame in seconds (default 20 ms). */
  frameSec?: number;
  /** Minimum spacing between accepted onsets (default 0.12 s). */
  minGapSec?: number;
  /** Accept a jump when it clears this fraction of the strongest jump (0.35). */
  thresholdRatio?: number;
}

/** Short-term RMS envelope onsets (seconds), monotonically increasing. */
export function detectOnsets(samples: Float32Array, sampleRate: number, options: OnsetOptions = {}): number[] {
  const frameSec = options.frameSec ?? 0.02;
  const minGapSec = options.minGapSec ?? 0.12;
  const thresholdRatio = options.thresholdRatio ?? 0.35;
  const frame = Math.max(1, Math.round(frameSec * sampleRate));
  const frames = Math.floor(samples.length / frame);
  if (frames < 3) return [];

  const energy = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    const start = i * frame;
    for (let j = 0; j < frame; j++) {
      const v = samples[start + j];
      sum += v * v;
    }
    energy[i] = Math.sqrt(sum / frame);
  }
  // Positive energy flux: attacks only, not the decay of the previous note.
  const flux = new Float64Array(frames);
  let peak = 0;
  for (let i = 1; i < frames; i++) {
    const jump = energy[i] - energy[i - 1];
    flux[i] = jump > 0 ? jump : 0;
    if (flux[i] > peak) peak = flux[i];
  }
  if (peak <= 0) return [];
  const threshold = peak * thresholdRatio;

  const onsets: number[] = [];
  for (let i = 1; i < frames - 1; i++) {
    if (flux[i] < threshold) continue;
    // Local maximum only, so one attack yields one beat.
    if (flux[i] < flux[i - 1] || flux[i] < flux[i + 1]) continue;
    const at = i * frameSec;
    if (onsets.length > 0 && at - onsets[onsets.length - 1] < minGapSec) continue;
    onsets.push(Number(at.toFixed(3)));
  }
  return onsets;
}

/** Median inter-onset interval — a robust tempo estimate in seconds. */
export function estimateBeatSec(onsets: number[]): number | null {
  if (onsets.length < 3) return null;
  const gaps = onsets.slice(1).map((onset, i) => onset - onsets[i]).filter((gap) => gap > 0.05);
  if (gaps.length === 0) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return Number(median.toFixed(3));
}

export interface BeatSnapResult {
  segments: Array<{ startSec: number; endSec: number }>;
  /** How many splices moved onto a beat. */
  snapped: number;
}

export interface BeatSnapOptions {
  /** Furthest a splice may travel to reach a beat (default 0.12 s). */
  maxShiftSec?: number;
  /**
   * Cross-fade length between kept segments. Each one shortens the output
   * timeline, so the splice it belongs to sits that much earlier.
   */
  transitionSec?: number;
}

/**
 * Move each splice onto the closest beat at or before it, within
 * `maxShiftSec`. `beats` are output-time seconds (see the file header);
 * segments carry absolute source seconds.
 *
 * A splice already on a beat, the first segment (whose start is output 0, and
 * moving it would drop the clip's opening), and shifts that would swallow the
 * previous segment or collapse this one are all left alone.
 */
export function planBeatSnap(
  segments: Array<{ startSec: number; endSec: number }>,
  beats: number[],
  options: BeatSnapOptions = {}
): BeatSnapResult {
  const maxShiftSec = options.maxShiftSec ?? 0.12;
  const transitionSec = options.transitionSec ?? 0;
  if (segments.length < 2 || beats.length === 0) return { segments: [...segments], snapped: 0 };
  const ordered = [...beats].sort((a, b) => a - b);
  let snapped = 0;
  let keptSec = 0;
  const next = segments.map((segment, index) => {
    // Output-time position of this splice: everything kept before it, minus one
    // cross-fade per splice already crossed (xfade/concat semantics in cut.ts).
    const atSec = keptSec - transitionSec * index;
    keptSec += Math.max(0, segment.endSec - segment.startSec);
    if (index === 0) return { ...segment };
    let best: number | null = null;
    for (const beat of ordered) {
      if (beat > atSec) break;
      if (atSec - beat <= maxShiftSec) best = beat;
    }
    if (best === null) return { ...segment };
    // Already on the grid: nothing to do, and don't count it as a snap.
    if (atSec - best < 1e-3) return { ...segment };
    // Same amount, measured on the source timeline: the cut moves back into the
    // silence this splice is about to remove, so the beat lands on the splice.
    const shifted = segment.startSec - (atSec - best);
    // Never let a shift swallow the previous segment or collapse this one.
    // (epsilon: 5.2 - 5 evaluates to 0.20000000000000018)
    if (shifted <= segments[index - 1].endSec + 1e-6 || segment.endSec - shifted <= 0.2 + 1e-6) return { ...segment };
    snapped++;
    return { startSec: Number(shifted.toFixed(3)), endSec: segment.endSec };
  });
  return { segments: next, snapped };
}

/**
 * Repeat a bed's onset grid across the whole output. The mixer loops the bed
 * (`-stream_loop -1`, sound-design.ts), so a bed shorter than the clip replays
 * its grid every bed length; a grid that already covers `untilSec` is returned
 * as is.
 */
export function repeatBeatGrid(onsets: number[], periodSec: number, untilSec: number): number[] {
  const sorted = [...onsets].sort((a, b) => a - b);
  if (sorted.length === 0 || !(periodSec > 0) || untilSec <= periodSec) return sorted;
  const out = [...sorted];
  for (let shift = periodSec; shift <= untilSec; shift += periodSec) {
    for (const onset of sorted) {
      const at = Number((onset + shift).toFixed(3));
      if (at > untilSec) break;
      out.push(at);
    }
  }
  return out;
}

/** Decode a bounded prefix of a music bed and return its onsets. */
export async function detectFileOnsets(
  filePath: string,
  options: { maxSeconds?: number; signal?: AbortSignal } = {}
): Promise<{ onsets: number[]; beatSec: number | null; analyzedSec: number }> {
  const temp = await mkdtemp(join(tmpdir(), "hotclip-beat-"));
  const pcm = join(temp, "bed.f32le");
  try {
    await extractPcmF32le16k(
      resolveFfmpegPath(),
      filePath,
      pcm,
      options.maxSeconds ? { startSec: 0, durationSec: options.maxSeconds } : undefined,
      undefined,
      options.signal
    );
    const samples = await readF32leSamples(pcm);
    const decodedSec = samples.length / 16000;
    // Shorter than the request means the bed ran out: this is the whole file,
    // which is also its loop period.
    const analyzedSec = Number(Math.min(decodedSec, options.maxSeconds ?? decodedSec).toFixed(3));
    const onsets = detectOnsets(samples, 16000);
    return { onsets, beatSec: estimateBeatSec(onsets), analyzedSec };
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
