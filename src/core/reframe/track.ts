/**
 * Face-track → crop-window planning (pure, unit-testable).
 *
 * Doctrine (AutoFlip-style, per 2026 research): "don't move unless you must".
 * Per shot segment, pick one of three modes:
 *  - locked: all visible faces fit one safe crop → one constant crop
 *  - pan: steady drift → linear interpolation between endpoints
 *  - track: real movement → One Euro filtered keyframes with a dead zone
 *  - recover: a sustained detection loss eases the crop back toward centre
 * Falls back to center crop (null) when faces are too sparse to trust.
 */

export interface FaceSample {
  /** Clip-relative seconds. */
  t: number;
  /** Face-center x normalized to [0,1] of source width; null = no detection. */
  cx: number | null;
  /** Horizontal envelope of every visible face, normalized to source width. */
  left?: number | null;
  right?: number | null;
  /** Number of visible faces represented by the envelope. */
  faceCount?: number;
  /** Individual visible-face intervals for crop-coverage QA. */
  faces?: Array<{ left: number; right: number }>;
}

export interface CropKeyframe {
  t: number;
  /** Crop left edge in source pixels. */
  x: number;
  /** Hold this crop until the next keyframe (used at shot boundaries). */
  hold?: boolean;
  /**
   * Ease the move that LEAVES this keyframe with a cubic smoothstep instead of
   * a constant-velocity ramp. Used for deliberate moves (recovery, reacquire
   * after a long loss), never for data-following points.
   */
  ease?: boolean;
}

export interface CropCoverageSample {
  t: number;
  faceCount: number;
  /** Least-visible detected face in this sampled frame, from 0 to 1. */
  minVisibleFraction: number;
}

export interface CropPlanningStats {
  totalShots: number;
  lockedShots: number;
  groupLockedShots: number;
  trackedShots: number;
  recoveryShots: number;
  centeredShots: number;
  /** Shots where the planned crop leaves some face below 90% visible. */
  clippedShots: number;
  /** Shots that followed the speaker instead of the biggest face. */
  speakerShots?: number;
}

export interface CropPlanningResult {
  keyframes: CropKeyframe[];
  stats: CropPlanningStats;
  /** Face visibility measured against the compiled trajectory. */
  coverage: CropCoverageSample[];
}

/** Standard One Euro filter (1D). */
export class OneEuro {
  private prevT: number | null = null;
  private prevX = 0;
  private prevDx = 0;

  constructor(
    private minCutoff = 0.3,
    private beta = 0.007,
    private dCutoff = 1.0
  ) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x: number, t: number): number {
    if (this.prevT === null) {
      this.prevT = t;
      this.prevX = x;
      return x;
    }
    const dt = Math.max(1e-3, t - this.prevT);
    const dx = (x - this.prevX) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.prevDx;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.prevX;
    this.prevT = t;
    this.prevX = xHat;
    this.prevDx = dxHat;
    return xHat;
  }
}

/** Hold the last framing through detector flicker this long before acting. */
export const LOST_HOLD_SEC = 1.25;
/** Seconds an eased reposition takes once a hold expires. */
export const RECENTER_RAMP_SEC = 1.4;
/**
 * Ceiling on the velocity of a blind, endpoints-only pan, as a fraction of
 * source width per second. Such a pan commits to a single speed before the
 * renderer knows whether the subject keeps up, so a sprint has to be trailed
 * rather than chased. The point-by-point tracking path is not capped: it emits
 * the positions the subject was actually seen at, so its speed can never exceed
 * the subject's own.
 */
export const MAX_PAN_FRAC_PER_SEC = 0.45;
/** Keyframes emitted per tracking run (the expression supports 32 in total). */
const MAX_TRACK_KEYFRAMES = 20;
/** How far (source px) a kept keyframe may sit from the filtered curve. */
const TRACK_SIMPLIFY_PX = 8;
/**
 * How far (as a fraction of the move's own length) the observed subject path
 * may stray from the straight chord between its endpoints and still be followed
 * with one constant-velocity pan. Measured on real clips: a hand-held subject
 * walk stays under 10%, while a dwell-then-sweep strays past 25% — panning on
 * the chord there loses the subject instead of following it.
 */
const LINEAR_PATH_TOL = 0.15;
/** Minimum face-detection coverage to trust tracking at all. */
const MIN_COVERAGE = 0.4;
/** Std below this fraction of width = "static" shot. */
const STATIC_STD = 0.04;
/** Breathing room outside the union of visible face boxes. */
const FACE_ENVELOPE_MARGIN = 0.025;
/** Preserve intentional source centering when the ideal crop is already near it. */
const CENTER_SNAP_DISTANCE = 0.035;

/** Cubic smoothstep on [0,1]: zero velocity at both ends. */
export function smoothstep(u: number): number {
  const c = u <= 0 ? 0 : u >= 1 ? 1 : u;
  return c * c * (3 - 2 * c);
}

/**
 * Per-sample subject target. When every visible face at this instant fits the
 * crop, aim at the middle of them (co-present faces stay in frame); otherwise
 * follow the main face — two far-apart people cannot share one 9:16 window,
 * and splitting the difference would clip both. `want` (normalized x a speaker
 * is expected at) overrides the main face when two people are too far apart to
 * share the crop: the one who is talking stays in frame, the other may not.
 */
function subjectTarget(s: FaceSample & { cx: number }, cropFrac: number, want: number | null = null): number {
  if (want !== null && s.faces && s.faces.length > 1) return nearestFaceCenter(s.faces, want);
  const left = Math.min(s.left ?? s.cx, s.cx);
  const right = Math.max(s.right ?? s.cx, s.cx);
  return right - left <= cropFrac ? (left + right) / 2 : s.cx;
}

/** Center of the visible face closest to `want`. */
function nearestFaceCenter(faces: Array<{ left: number; right: number }>, want: number): number {
  let best = (faces[0].left + faces[0].right) / 2;
  for (const f of faces) {
    const c = (f.left + f.right) / 2;
    if (Math.abs(c - want) < Math.abs(best - want)) best = c;
  }
  return best;
}

/** Single-face samples needed before a speaker's position is trusted. */
const SPEAKER_ANCHOR_MIN_SAMPLES = 3;

/**
 * Where each speaker sits in the source frame, learned from the frames where
 * only ONE face is visible: during that speaker's turn the lone face has to be
 * theirs. Median, so one stray detection can't drag the anchor.
 */
export function speakerAnchors(
  samples: FaceSample[],
  activeSpeakers: Array<number | null>
): Map<number, number> {
  const seen = new Map<number, number[]>();
  samples.forEach((s, i) => {
    const speaker = activeSpeakers[i];
    if (speaker === null || speaker === undefined) return;
    const faces = s.faces;
    if (!faces || faces.length !== 1) return;
    const list = seen.get(speaker) ?? [];
    list.push((faces[0].left + faces[0].right) / 2);
    seen.set(speaker, list);
  });
  const anchors = new Map<number, number>();
  for (const [speaker, centers] of seen) {
    if (centers.length < SPEAKER_ANCHOR_MIN_SAMPLES) continue;
    const sorted = [...centers].sort((a, b) => a - b);
    anchors.set(speaker, sorted[Math.floor(sorted.length / 2)]);
  }
  return anchors;
}

function hasSustainedLoss(samples: FaceSample[]): boolean {
  let lastValidT: number | null = null;
  const firstValid = samples.find((s) => s.cx !== null);
  for (const sample of samples) {
    if (sample.cx !== null) {
      lastValidT = sample.t;
      continue;
    }
    const distance = lastValidT === null
      ? (firstValid ? firstValid.t - sample.t : Number.POSITIVE_INFINITY)
      : sample.t - lastValidT;
    if (distance > LOST_HOLD_SEC) return true;
  }
  return false;
}

/**
 * Reduce a filtered tracking curve to as few keyframes as it can without any
 * kept segment drifting more than TRACK_SIMPLIFY_PX from the curve: dense where
 * the subject moves fast, two points where they stand still. A fixed time grid
 * instead lags on a fast sweep and still spends points on a stillness.
 */
function simplifyTrack(
  run: Array<{ t: number; x: number }>,
  srcW: number
): Array<{ t: number; x: number }> {
  if (run.length <= 2) return run;
  const keep = new Set<number>([0, run.length - 1]);
  for (;;) {
    const idx = [...keep].sort((a, b) => a - b);
    let bestIdx = -1;
    let bestDev = 0;
    for (let s = 0; s < idx.length - 1; s++) {
      const a = run[idx[s]];
      const b = run[idx[s + 1]];
      const span = Math.max(1e-6, b.t - a.t);
      for (let i = idx[s] + 1; i < idx[s + 1]; i++) {
        const u = (run[i].t - a.t) / span;
        const dev = Math.abs(run[i].x - (a.x + (b.x - a.x) * u));
        if (dev > bestDev) {
          bestDev = dev;
          bestIdx = i;
        }
      }
    }
    if (bestIdx < 0 || keep.size >= MAX_TRACK_KEYFRAMES || bestDev * srcW <= TRACK_SIMPLIFY_PX) break;
    keep.add(bestIdx);
  }
  return [...keep].sort((a, b) => a - b).map((i) => run[i]);
}

export function planCropComposition(
  samples: FaceSample[],
  cuts: number[],
  srcW: number,
  srcH: number,
  activeSpeakers?: Array<number | null>
): CropPlanningResult | null {
  const cropW = Math.floor((srcH * 9) / 16 / 2) * 2;
  if (cropW >= srcW || samples.length === 0) return null;
  const coverage = samples.filter((s) => s.cx !== null).length / samples.length;
  if (coverage < MIN_COVERAGE) return null;
  // 说话人锚点:整片只在「画面里只有一张脸」的时刻学,学不到就整条路照旧。
  const anchors =
    activeSpeakers && activeSpeakers.length === samples.length ? speakerAnchors(samples, activeSpeakers) : new Map<number, number>();
  const wantOf = new Map<FaceSample, number | null>();
  if (anchors.size > 0) {
    samples.forEach((s, i) => {
      const speaker = activeSpeakers?.[i];
      const anchor = speaker === null || speaker === undefined ? undefined : anchors.get(speaker);
      wantOf.set(s, anchor ?? null);
    });
  }

  const cropFrac = cropW / srcW;
  // 留 1 像素边距:运镜的超采样链要在窗口左右各借 1 像素(见 cut.ts 的
  // floor(X)-1 与 autozoom.ts 的 ZOOM_SS),贴边时 crop 会把自己裁窄、窗口
  // 宽度就不是常量了。代价是构图最多挪 1 像素,远小于色度网格本来就会
  // 造成的 2 像素抖动。
  const edge = srcW - cropW >= 2 ? 1 : 0;
  const clampX = (cxNorm: number): number =>
    Math.round(Math.min(Math.max(cxNorm * srcW - cropW / 2, edge), srcW - cropW - edge));

  // split samples into shot segments at the cut times
  const bounds = [...cuts].sort((a, b) => a - b);
  const segments: FaceSample[][] = [];
  let seg: FaceSample[] = [];
  let bi = 0;
  for (const s of samples) {
    while (bi < bounds.length && s.t >= bounds[bi]) {
      if (seg.length > 0) segments.push(seg);
      seg = [];
      bi++;
    }
    seg.push(s);
  }
  if (seg.length > 0) segments.push(seg);

  const stats: CropPlanningStats = {
    totalShots: 0,
    lockedShots: 0,
    groupLockedShots: 0,
    trackedShots: 0,
    recoveryShots: 0,
    centeredShots: 0,
    clippedShots: 0,
    speakerShots: 0,
  };
  const keyframes: CropKeyframe[] = [];
  for (const segment of segments) {
    stats.totalShots++;
    const visible = segment.filter((s): s is FaceSample & { cx: number } => s.cx !== null);
    if (visible.length / segment.length < MIN_COVERAGE) {
      keyframes.push({ t: segment[0].t, x: clampX(0.5), hold: true });
      stats.centeredShots++;
      continue;
    }
    const hasRecovery = hasSustainedLoss(segment);
    if (hasRecovery) stats.recoveryShots++;
    // A loss that runs to the end of the shot gets an explicit hold + eased
    // recovery. Losses inside the shot are bridged by interpolation below.
    const tailLost = hasRecovery && segment[segment.length - 1].cx === null;
    const lastVisible = visible[visible.length - 1];

    const envelopeLeft = Math.min(...visible.map((s) => Math.min(s.left ?? s.cx, s.cx)));
    const envelopeRight = Math.max(...visible.map((s) => Math.max(s.right ?? s.cx, s.cx)));
    const envelopeWidth = envelopeRight - envelopeLeft + FACE_ENVELOPE_MARGIN * 2;
    const hasGroup = visible.some((s) => (s.faceCount ?? 1) > 1);

    // Comfort-first composition: if every observed face position fits in one
    // crop, lock the virtual camera for the entire shot. This prevents small
    // body movement and multi-person turn-taking from creating artificial pan.
    // A brief detection loss does not disable the lock.
    if (envelopeWidth <= cropFrac) {
      let center = (envelopeLeft + envelopeRight) / 2;
      if (Math.abs(center - 0.5) <= CENTER_SNAP_DISTANCE) center = 0.5;
      keyframes.push({ t: visible[0].t, x: clampX(center), hold: true });
      stats.lockedShots++;
      if (hasGroup) stats.groupLockedShots++;
      if (tailLost) planRecovery(keyframes, lastVisible, 0.5, clampX);
      continue;
    }

    const xs = visible.map((s) => subjectTarget(s, cropFrac, wantOf.get(s) ?? null));
    if (wantOf.size > 0 && visible.some((s) => wantOf.get(s) != null && (s.faces?.length ?? 0) > 1)) stats.speakerShots = (stats.speakerShots ?? 0) + 1;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    const median = [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const firstT = visible[0].t;
    const lastT = lastVisible.t;
    const shotDur = Math.max(1 / 3, lastT - firstT);

    if (std < STATIC_STD) {
      keyframes.push({ t: firstT, x: clampX(median), hold: true });
      stats.lockedShots++;
    } else {
      stats.trackedShots++;
      const drift = xs[xs.length - 1] - xs[0];
      // How far the observed path strays from the straight chord between its
      // ends, relative to the move itself.
      let stray = 0;
      for (let i = 0; i < xs.length; i++) {
        const u = (visible[i].t - firstT) / shotDur;
        stray = Math.max(stray, Math.abs(xs[i] - (xs[0] + drift * u)));
      }
      const straightPath = Math.abs(drift) > 1e-6 && stray <= LINEAR_PATH_TOL * Math.abs(drift);
      // An endpoints-only move assumes the drift was observed throughout. With a
      // sustained loss it wasn't, and panning blind across the gap is exactly
      // what the hold-then-pan path below exists to prevent. A path that bends
      // away from its chord is followed point by point instead: a straight pan
      // would cut the corner and leave the subject behind.
      if (!hasRecovery && Math.abs(drift) > 2 * std && straightPath) {
        // Data-following pan: the subject walks at a steady pace, so matching
        // that pace keeps them centred (easing here would lag behind them). The
        // pace is capped, so a sprint is followed as well as it can be without
        // the camera whipping.
        const travel = Math.sign(drift) * Math.min(Math.abs(drift), MAX_PAN_FRAC_PER_SEC * shotDur);
        keyframes.push({ t: firstT, x: clampX(xs[0]) });
        keyframes.push({ t: lastT, x: clampX(xs[0] + travel), hold: true });
      } else {
        // Real movement, filtered, then simplified down to the keyframes the
        // expression can hold. Simplify by tolerance, never on a time grid: a
        // grid drops the second end of a stillness (so the crop creeps across
        // it) and spends the same keyframes on a quiet stretch as on a sweep.
        const euro = new OneEuro();
        const curve = visible.map((s) => ({
          t: s.t,
          x: euro.filter(subjectTarget(s, cropFrac, wantOf.get(s) ?? null), s.t),
        }));
        const emit = (run: Array<{ t: number; x: number }>): void => {
          for (const point of simplifyTrack(run, srcW)) {
            keyframes.push({ t: point.t, x: clampX(point.x) });
          }
        };
        let run: Array<{ t: number; x: number }> = [];
        for (const point of curve) {
          const prev = run.length > 0 ? run[run.length - 1] : null;
          if (prev && point.t - prev.t > LOST_HOLD_SEC) {
            // Long detection gap: hold the last framing, then time the move to
            // land as the subject reappears — never chase a face we cannot see.
            emit(run);
            const prevKf = keyframes[keyframes.length - 1];
            if (prevKf) prevKf.hold = true;
            const moveFrom = Math.max(prev.t, point.t - Math.min(RECENTER_RAMP_SEC, (point.t - prev.t) / 2));
            keyframes.push({ t: moveFrom, x: clampX(prev.x), ease: true });
            keyframes.push({ t: point.t, x: clampX(point.x) });
            run = [point];
          } else {
            run.push(point);
          }
        }
        emit(run);
        const tail = keyframes[keyframes.length - 1];
        if (tail) tail.hold = true;
      }
    }
    if (tailLost) planRecovery(keyframes, lastVisible, 0.5, clampX);
  }
  if (keyframes.length === 0) return null;
  keyframes.sort((a, b) => a.t - b.t);
  const out: CropKeyframe[] = [];
  for (const k of keyframes) {
    const last = out[out.length - 1];
    if (last && k.x === last.x) {
      // A plateau (the subject stood still) keeps BOTH ends: keeping only the
      // first makes the next move interpolate across the stillness, so the crop
      // creeps while nobody moves. Anything deeper in the plateau is dropped.
      if (out.length >= 2 && out[out.length - 2].x === k.x) {
        out[out.length - 1] = { ...k, hold: k.hold };
        continue;
      }
    }
    out.push(k);
  }
  // Measure the trajectory that will actually run, so the receipt and the QA
  // pass consume the same numbers the renderer does.
  const compiled = compileCropKeyframes(out);
  const measured = evaluateCropCoverage(samples, compiled, srcW, cropW);
  const clipped = new Set<number>();
  let segIndex = 0;
  for (const sample of measured) {
    while (segIndex < bounds.length && sample.t >= bounds[segIndex]) segIndex++;
    if (sample.minVisibleFraction < 0.9) clipped.add(segIndex);
  }
  stats.clippedShots = clipped.size;
  return { keyframes: compiled, stats, coverage: measured };
}

/**
 * Tail-loss recovery: hold the current framing for LOST_HOLD_SEC, then ease to
 * `centre`. The pre-2026 planner jumped to centre the moment the hold expired,
 * an unmotivated pan with no subject on screen to justify it.
 */
function planRecovery(
  keyframes: CropKeyframe[],
  lastVisible: FaceSample & { cx: number },
  centre: number,
  clampX: (cxNorm: number) => number
): void {
  const anchor = keyframes.length > 0 ? keyframes[keyframes.length - 1].x : clampX(lastVisible.cx);
  const target = clampX(centre);
  if (anchor === target) return;
  const prev = keyframes[keyframes.length - 1];
  if (prev) prev.hold = true;
  const holdUntil = lastVisible.t + LOST_HOLD_SEC;
  keyframes.push({ t: holdUntil, x: anchor, ease: true });
  keyframes.push({ t: holdUntil + RECENTER_RAMP_SEC, x: target });
}

export function planCropTrack(
  samples: FaceSample[],
  cuts: number[],
  srcW: number,
  srcH: number
): CropKeyframe[] | null {
  return planCropComposition(samples, cuts, srcW, srcH)?.keyframes ?? null;
}

/** Render keyframes as an ffmpeg sendcmd file targeting `crop@track`. */
export function renderSendcmd(keyframes: CropKeyframe[]): string {
  return keyframes.map((k) => `${Math.max(0, k.t).toFixed(3)} crop@track x ${k.x};`).join("\n") + "\n";
}

/** Even keyframe downsampling (keeps first & last). */
export function downsampleKeyframes(kfs: CropKeyframe[], max: number): CropKeyframe[] {
  if (kfs.length <= max) return kfs;
  const mandatory = new Set<number>([0, kfs.length - 1]);
  for (let i = 0; i < kfs.length; i++) {
    // Hold boundaries and the start of an eased move both change the shape of
    // the trajectory; dropping either makes the crop drift or snap.
    if (!kfs[i].hold && !kfs[i].ease) continue;
    mandatory.add(i);
    if (i + 1 < kfs.length) mandatory.add(i + 1);
  }
  const selected = new Set<number>();
  const must = [...mandatory].sort((a, b) => a - b);
  if (must.length >= max) {
    // `max` is a soft expression-size target. Dropping a hold boundary makes
    // the crop drift across a shot cut, which is worse than a longer filter.
    return must.map((i) => kfs[i]);
  } else {
    for (const i of must) selected.add(i);
    for (let i = 0; selected.size < max && i < max * 3; i++) {
      selected.add(Math.round((i * (kfs.length - 1)) / Math.max(1, max * 3 - 1)));
    }
  }
  return [...selected].sort((a, b) => a - b).slice(0, max).map((i) => kfs[i]);
}

/** The exact reduced trajectory used by the FFmpeg crop expression. */
export function compileCropKeyframes(keyframes: CropKeyframe[], maxKeyframes = 32): CropKeyframe[] {
  return downsampleKeyframes(keyframes, maxKeyframes).filter(
    (k, i, arr) => i === 0 || k.t > arr[i - 1].t + 1e-4
  );
}

/** Evaluate the same hold/linear trajectory that is compiled for FFmpeg. */
export function cropXAtTime(keyframes: CropKeyframe[], t: number): number {
  if (keyframes.length === 0) return 0;
  if (t <= keyframes[0].t) return keyframes[0].x;
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    if (t >= b.t) continue;
    if (a.hold || b.t <= a.t) return a.x;
    const p = Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
    return a.x + (b.x - a.x) * (a.ease ? smoothstep(p) : p);
  }
  return keyframes[keyframes.length - 1].x;
}

/** Whether the active source trajectory is holding at this instant. */
export function cropHoldAtTime(keyframes: CropKeyframe[], t: number): boolean {
  if (keyframes.length === 0) return true;
  if (t < keyframes[0].t) return true;
  for (let i = keyframes.length - 1; i >= 0; i--) {
    if (t >= keyframes[i].t) return keyframes[i].hold === true || i === keyframes.length - 1;
  }
  return true;
}

/** Reuse detection samples to prove how much of every face the crop retains. */
export function evaluateCropCoverage(
  samples: FaceSample[],
  keyframes: CropKeyframe[],
  srcW: number,
  cropW: number
): CropCoverageSample[] {
  if (srcW <= 0 || cropW <= 0 || keyframes.length === 0) return [];
  const out: CropCoverageSample[] = [];
  for (const sample of samples) {
    const faces = sample.faces?.length
      ? sample.faces
      : sample.left !== null && sample.left !== undefined && sample.right !== null && sample.right !== undefined
        ? [{ left: sample.left, right: sample.right }]
        : [];
    if (faces.length === 0) continue;
    const cropLeft = cropXAtTime(keyframes, sample.t);
    const cropRight = cropLeft + cropW;
    let minVisible = 1;
    for (const face of faces) {
      const left = Math.min(1, Math.max(0, face.left)) * srcW;
      const right = Math.min(1, Math.max(0, face.right)) * srcW;
      const width = right - left;
      if (width <= 0) continue;
      const visible = Math.max(0, Math.min(right, cropRight) - Math.max(left, cropLeft)) / width;
      minVisible = Math.min(minVisible, visible);
    }
    out.push({
      t: sample.t,
      faceCount: faces.length,
      minVisibleFraction: Number(minVisible.toFixed(4)),
    });
  }
  return out;
}

/**
 * Render keyframes as a piecewise-linear crop-x expression in `t`.
 * The bundled ffmpeg's crop filter ignores runtime commands (verified), but
 * its x option re-evaluates per frame — so we compile the whole track into
 * one expression. Nested ifs stay shallow via keyframe downsampling.
 */
export function renderCropXExpr(keyframes: CropKeyframe[], maxKeyframes = 32): string {
  const kfs = compileCropKeyframes(keyframes, maxKeyframes);
  if (kfs.length === 0) return "0";
  if (kfs.length === 1) return String(kfs[0].x);
  let expr = String(kfs[kfs.length - 1].x);
  for (let i = kfs.length - 2; i >= 0; i--) {
    const a = kfs[i];
    const b = kfs[i + 1];
    const dt = (b.t - a.t).toFixed(4);
    const u = `((t-${a.t.toFixed(3)})/${dt})`;
    const seg = a.hold
      ? String(a.x)
      : a.ease
        // cubic smoothstep: u*u*(3-2u) — matches cropXAtTime exactly
        ? `(${a.x}+(${b.x - a.x})*${u}*${u}*(3-2*${u}))`
        : `(${a.x}+(${b.x - a.x})*${u})`;
    expr = `if(lt(t,${b.t.toFixed(3)}),${seg},${expr})`;
  }
  return `if(lt(t,${kfs[0].t.toFixed(3)}),${kfs[0].x},${expr})`;
}
