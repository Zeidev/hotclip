/**
 * Face-aware vertical reframing orchestrator: sample frames in the clip →
 * YuNet detection → shot-aware crop planning. Returns null whenever tracking
 * can't be trusted (no faces, tiny source, model unavailable) — callers fall
 * back to the plain center crop, so this can never make output WORSE.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfmpegPath } from "../binaries";
import { ffmpegVideoStreamSpecifier, probeMedia, type MediaInfo } from "../probe";
import { planColorRender } from "../color";
import { analysisVideoFilter, type AnalysisVideoOptions } from "../analysis-video";
import { ensureModel, YUNET_MODEL } from "../models";
import { parseShowinfoTimes } from "../signals";
import type { SpeakerTurn } from "../diarize";
import { YunetDetector, YUNET_INPUT, pickMainFace, type FaceBox } from "./yunet";
import { compileCropKeyframes, cropHoldAtTime, cropXAtTime, planCropComposition, renderSendcmd, renderCropXExpr, type CropCoverageSample, type FaceSample, type CropKeyframe, type CropPlanningStats } from "./track";

const execFileAsync = promisify(execFile);

/** Detection sampling rate inside the clip. */
const SAMPLE_FPS = 3;

export interface CropPlan {
  /** sendcmd keyframes (clip-relative time, crop-left-edge px). */
  keyframes: CropKeyframe[];
  cropW: number;
  cropH: number;
  cropY: number;
  /** First keyframe x — the crop's initial position. */
  x0: number;
  /** Machine-readable composition receipt for this source range. */
  composition: CropPlanningStats;
  /** Sampled face visibility against the exact planned crop trajectory. */
  coverageSamples: CropCoverageSample[];
}

export { renderSendcmd, renderCropXExpr };

/** Keep identity through this many consecutive face-free frames (≈2 s @ 3 fps). */
const TRACK_MEMORY_FRAMES = 6;

export interface FaceScan {
  samples: FaceSample[];
  info: MediaInfo;
  analysis: AnalysisVideoOptions;
}

/**
 * Decode the clip at SAMPLE_FPS and track the main face per frame. Exported so
 * the pure planner can be exercised on recorded samples without re-decoding the
 * source (the renderer never calls this directly).
 */
export async function scanFaceSamples(
  inputPath: string,
  clipStartSec: number,
  clipEndSec: number,
  modelsRoot: string,
  providedAnalysis?: AnalysisVideoOptions
): Promise<FaceScan | null> {
  const info = await probeMedia(inputPath);
  if (!info.hasVideo || info.width <= 0 || info.height <= 0) return null;
  const analysis = providedAnalysis ?? {
    videoStreamIndex: info.videoStreamIndex,
    color: planColorRender(info),
  };

  await ensureModel(modelsRoot, YUNET_MODEL);
  const detector = new YunetDetector(modelsRoot);
  await detector.init();

  const dur = clipEndSec - clipStartSec;
  const ffmpeg = resolveFfmpegPath();

  // Letterboxed 640×640 frames — anisotropic stretching skews YuNet's box
  // centers toward the frame middle (verified on a 3x-squeezed synthetic),
  // so keep the aspect ratio and undo the padding when mapping back.
  const s = Math.min(YUNET_INPUT / info.width, YUNET_INPUT / info.height);
  const scaledW = Math.round(info.width * s);
  const padX = Math.floor((YUNET_INPUT - scaledW) / 2);
  const { stdout } = await execFileAsync(
    ffmpeg,
    [
      "-hide_banner", "-v", "error",
      "-ss", String(clipStartSec), "-i", inputPath, "-t", String(dur),
      "-vf",
      analysisVideoFilter(
        `fps=${SAMPLE_FPS},scale=${YUNET_INPUT}:${YUNET_INPUT}:force_original_aspect_ratio=decrease,pad=${YUNET_INPUT}:${YUNET_INPUT}:(ow-iw)/2:(oh-ih)/2:black`,
        analysis.color
      ),
      "-map", ffmpegVideoStreamSpecifier(analysis.videoStreamIndex),
      "-f", "rawvideo", "-pix_fmt", "bgr24", "-",
    ],
    { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 }
  );
  const frameBytes = YUNET_INPUT * YUNET_INPUT * 3;
  const samples: FaceSample[] = [];
  let prevMain: FaceBox | null = null;
  let missed = 0;
  for (let off = 0, idx = 0; off + frameBytes <= stdout.length; off += frameBytes, idx++) {
    const faces = await detector.detect(new Uint8Array(stdout.subarray(off, off + frameBytes)));
    const main = pickMainFace(faces, prevMain);
    if (main) {
      prevMain = main;
      missed = 0;
    } else if (++missed > TRACK_MEMORY_FRAMES) {
      // Clearing on the first empty frame threw identity away on a single
      // detector hiccup; hold it through short dropouts instead.
      prevMain = null;
    }
    const visible = faces
      .filter((face) => face.x + face.w > padX && face.x < padX + scaledW)
      .map((face) => ({
        left: Math.min(1, Math.max(0, (face.x - padX) / scaledW)),
        right: Math.min(1, Math.max(0, (face.x + face.w - padX) / scaledW)),
      }))
      .filter((face) => face.right > face.left);
    samples.push({
      t: idx / SAMPLE_FPS,
      cx: main ? Math.min(1, Math.max(0, (main.x + main.w / 2 - padX) / scaledW)) : null,
      left: visible.length > 0 ? Math.min(...visible.map((face) => face.left)) : null,
      right: visible.length > 0 ? Math.max(...visible.map((face) => face.right)) : null,
      faceCount: visible.length,
      faces: visible,
    });
  }
  return { samples, info, analysis };
}

/** Shot-cut times inside the clip, clip-relative. Empty when detection fails. */
async function detectShotCuts(
  inputPath: string,
  clipStartSec: number,
  dur: number,
  analysis: AnalysisVideoOptions
): Promise<number[]> {
  const sceneErr = await execFileAsync(
    resolveFfmpegPath(),
    [
      "-hide_banner",
      "-ss", String(clipStartSec), "-i", inputPath, "-t", String(dur), "-an",
      "-vf", analysisVideoFilter("fps=6,scale=160:-2,select='gt(scene,0.3)',showinfo", analysis.color),
      "-map", ffmpegVideoStreamSpecifier(analysis.videoStreamIndex),
      "-f", "null", "-",
    ],
    { maxBuffer: 64 * 1024 * 1024 }
  ).then((r) => r.stderr, () => "");
  return parseShowinfoTimes(sceneErr);
}

/**
 * Build a face-tracking crop plan for one clip. `uiCrop` fractions (when the
 * screen-UI trim is active) are folded into the SAME crop so the whole
 * reframe stays one filter instance driven by sendcmd.
 */
export async function generateCropPlan(
  inputPath: string,
  clipStartSec: number,
  clipEndSec: number,
  modelsRoot: string,
  uiCrop?: { topFrac: number; bottomFrac: number },
  providedAnalysis?: AnalysisVideoOptions,
  /**
   * Diarization turns (absolute source seconds). When two people are too far
   * apart for one 9:16 crop, the planner then keeps whoever is talking instead
   * of the biggest face. Absent turns = the old behaviour, exactly.
   */
  speakerTurns?: SpeakerTurn[]
): Promise<CropPlan | null> {
  const scan = await scanFaceSamples(inputPath, clipStartSec, clipEndSec, modelsRoot, providedAnalysis);
  if (!scan) return null;
  const { samples, info, analysis } = scan;

  const top = uiCrop?.topFrac ?? 0;
  const bottom = uiCrop?.bottomFrac ?? 0;
  const cropY = Math.floor((info.height * top) / 2) * 2;
  const cropH = Math.floor((info.height * Math.max(0.2, 1 - top - bottom)) / 2) * 2;
  const cropW = Math.floor((cropH * 9) / 16 / 2) * 2;
  if (cropW >= info.width) return null; // already narrower than 9:16

  const cuts = await detectShotCuts(inputPath, clipStartSec, clipEndSec - clipStartSec, analysis);
  const planned = planCropComposition(samples, cuts, info.width, cropH, activeSpeakersFor(samples, clipStartSec, speakerTurns));
  if (!planned) return null;
  return {
    keyframes: planned.keyframes,
    cropW,
    cropH,
    cropY,
    x0: planned.keyframes[0].x,
    composition: planned.stats,
    // Planner-measured against the compiled trajectory — one source of truth
    // for both the receipt and the QA pass.
    coverageSamples: planned.coverage,
  };
}

/**
 * Who is talking at each sampled frame, as diarization speaker ids (null =
 * nobody/unknown). Samples are clip-relative; turns are absolute source time.
 */
function activeSpeakersFor(
  samples: FaceSample[],
  clipStartSec: number,
  turns?: SpeakerTurn[]
): Array<number | null> | undefined {
  if (!turns || turns.length === 0) return undefined;
  return samples.map((s) => {
    const t = s.t + clipStartSec;
    const turn = turns.find((turn) => t >= turn.startSec && t <= turn.endSec);
    return turn ? turn.speaker : null;
  });
}

/**
 * Map a clip-relative source time onto the jump-cut output timeline (null =
 * spliced out). `transitionSec` is the cross-fade length at each splice: an
 * xfade shortens the output by its own duration, so every splice already
 * crossed pulls all later output times earlier. Leaving it out makes SFX,
 * autozoom cues and crop keyframes drift `transitionSec` later per splice.
 */
export function mapToOutputTime(
  tClipRel: number,
  segments: Array<{ startSec: number; endSec: number }>,
  clipStartSec: number,
  transitionSec = 0
): number | null {
  const tAbs = tClipRel + clipStartSec;
  const xfade = Math.max(0, transitionSec);
  let out = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (tAbs < seg.startSec) return null;
    if (tAbs <= seg.endSec) return out + (tAbs - seg.startSec);
    out += seg.endSec - seg.startSec - (i < segments.length - 1 ? xfade : 0);
  }
  return null;
}

/**
 * Preserve the source crop trajectory across removed jump-cut intervals.
 * A 1ms pre-cut endpoint prevents interpolation through the discarded gap,
 * while the next segment starts at the exact output splice time.
 */
export function remapCropKeyframes(
  keyframes: CropKeyframe[],
  segments: Array<{ startSec: number; endSec: number }>,
  clipStartSec: number,
  transitionSec = 0
): CropKeyframe[] {
  if (keyframes.length === 0) return [];
  const out: CropKeyframe[] = [];
  let outOffset = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const duration = seg.endSec - seg.startSec;
    if (duration <= 0) continue;
    const sourceStart = seg.startSec - clipStartSec;
    const sourceEnd = seg.endSec - clipStartSec;
    out.push({
      t: outOffset,
      x: cropXAtTime(keyframes, sourceStart),
      hold: cropHoldAtTime(keyframes, sourceStart),
    });
    for (const keyframe of keyframes) {
      if (keyframe.t <= sourceStart + 1e-4 || keyframe.t >= sourceEnd - 1e-4) continue;
      out.push({ ...keyframe, t: outOffset + keyframe.t - sourceStart });
    }
    const hasFollowingSegment = i < segments.length - 1;
    // An xfade starts blending the next piece in `xfade` seconds before this
    // piece's source range ends, so the splice — and the framing switch — sits
    // there on the stitched output, and every later piece starts that much
    // earlier. The crop filter runs on the blended frame, so the switch is timed
    // to the blend, not to the raw source end.
    const xfade = hasFollowingSegment ? Math.max(0, Math.min(transitionSec, duration / 2)) : 0;
    const seamInset = hasFollowingSegment ? Math.min(0.001, duration / 2) : 0;
    out.push({
      t: outOffset + duration - xfade - seamInset,
      x: cropXAtTime(keyframes, sourceEnd - seamInset),
      hold: true,
    });
    outOffset += duration - xfade;
  }
  return compileCropKeyframes(out);
}
