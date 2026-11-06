/**
 * Forced alignment through whisper.cpp — the transcript is already known
 * (imported subtitles, hand-edited cues), so nothing is transcribed: the cue
 * audio is decoded once and only the returned token timings are used.
 * `refineWordTimings` (character-level LCS) maps those timings onto the
 * existing words and keeps the text untouched.
 *
 * Why batched: whisper.cpp pays a large fixed startup cost per process (about
 * 25 s on a Pascal CUDA build, ~2 s on CPU). Aligning cue-by-cue would pay it
 * once per sentence. Instead every selected cue is cut out, concatenated into
 * one 16 kHz WAV, decoded in a single run, and the token times are mapped back
 * through the segment offsets — one process for the whole calibration batch.
 *
 * Returns null per cue when whisper.cpp is not wired up or the LCS match is too
 * weak; callers keep the original words in that case.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { resolveFfmpegPath } from "./binaries";
import { joinWords } from "./transcribe/segment";
import { resolveWhisperCpp, runWhisperCpp, whisperCppWords, type WhisperCppConfig } from "./transcribe/whisper-cpp";
import { refineWordTimings, type ClipAlignmentResult } from "./align";
import { summarizeTimingQuality } from "../shared/transcript-quality";
import type { TranscriptWord } from "../shared/api-types";

const execFileAsync = promisify(execFile);
/** Decode margin on both sides so boundary words are complete. */
const ALIGN_PAD_SEC = 0.4;
/**
 * LCS match floor for accepting an aligned cue. Lower than the Paraformer/Qwen
 * aligners on purpose: whisper.cpp re-spells hard words ("Eczacı" → "Ecacı"),
 * and a 0.5 floor rejected half of an otherwise perfectly timed Turkish cue
 * batch. 0.35 still refuses cues the decoder missed entirely.
 */
export const WHISPER_CPP_MIN_MATCH_FRAC = 0.35;

export interface AlignTarget {
  id: number;
  startSec: number;
  endSec: number;
  words: TranscriptWord[];
}

export type WhisperCppAligner = (
  filePath: string,
  targets: AlignTarget[]
) => Promise<Map<number, ClipAlignmentResult | null>>;

export function createWhisperCppAligner(
  signal?: AbortSignal,
  config: WhisperCppConfig | null = resolveWhisperCpp()
): WhisperCppAligner | null {
  if (!config) return null;

  return async (filePath, targets) => {
    signal?.throwIfAborted();
    const result = new Map<number, ClipAlignmentResult | null>();
    const usable = targets.filter((target) => target.words.length > 0);
    for (const target of targets) if (!target.words.length) result.set(target.id, null);
    if (usable.length === 0) return result;

    const temp = await mkdtemp(join(tmpdir(), "hotclip-align-wcpp-"));
    try {
      interface Part { id: number; path: string; concatSec: number; durationSec: number; coreSec: number; coreDurationSec: number; fromSec: number; target: AlignTarget }
      const parts: Part[] = [];
      let concatSec = 0;
      for (const target of usable) {
        signal?.throwIfAborted();
        const from = Math.max(0, target.startSec - ALIGN_PAD_SEC);
        const durationSec = Math.max(0.2, target.endSec + ALIGN_PAD_SEC - from);
        const path = join(temp, `cue-${target.id}.wav`);
        await execFileAsync(
          resolveFfmpegPath(),
          [
            "-hide_banner", "-y",
            "-ss", from.toFixed(3),
            "-i", filePath,
            "-t", durationSec.toFixed(3),
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
            path,
          ],
          { maxBuffer: 32 * 1024 * 1024, signal }
        );
        // The cue's own span inside the concatenated WAV, without the decode
        // padding. Token assignment uses these core spans: padded windows of
        // neighbouring cues overlap, and a strict overlap lets a boundary token
        // land in the wrong cue.
        parts.push({
          id: target.id,
          path,
          concatSec,
          durationSec,
          coreSec: concatSec + (target.startSec - from),
          coreDurationSec: Math.max(0.1, target.endSec - target.startSec),
          fromSec: from,
          target,
        });
        concatSec += durationSec;
      }
      if (parts.length === 0) return result;

      // One continuous WAV: concat demuxer with a re-encode keeps headers valid.
      const listPath = join(temp, "list.txt");
      await writeFile(listPath, parts.map((part) => `file '${part.path.replace(/\\/g, "/")}'`).join("\n"), "utf8");
      const wav = join(temp, "all.wav");
      await execFileAsync(
        resolveFfmpegPath(),
        ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
        { maxBuffer: 32 * 1024 * 1024, signal }
      );

      // Prompt = the known text. It only steers the decoder; the emitted words
      // are never used, only their timings.
      const prompt = usable.map((target) => joinWords(target.words)).join(" ").slice(0, 800);
      const payload = await runWhisperCpp(config, wav, join(temp, "out"), { prompt, signal, maxContext: 0 });
      const { words: refs } = whisperCppWords(payload, concatSec);
      if (refs.length === 0) return result;

      // Assign every token to the cue window it belongs to. Distance-based
      // rather than strict range containment: an imported subtitle can be a
      // second or two off, and a strict filter would drop every token of that
      // cue and call it "no match".
      const assigned = new Map<number, TranscriptWord[]>();
      for (const part of parts) assigned.set(part.id, []);
      for (const ref of refs) {
        let best: Part | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const part of parts) {
          const start = part.coreSec;
          const end = part.coreSec + part.coreDurationSec;
          const distance = ref.startSec < start ? start - ref.startSec : ref.startSec > end ? ref.startSec - end : 0;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = part;
          }
        }
        if (best) assigned.get(best.id)?.push(ref);
      }

      for (const part of parts) {
        const inPart = assigned.get(part.id) ?? [];
        if (inPart.length === 0) {
          result.set(part.id, null);
          continue;
        }
        const shifted: TranscriptWord[] = inPart.map((ref) => ({
          ...ref,
          startSec: Math.max(0, ref.startSec - part.concatSec + part.fromSec),
          endSec: Math.max(0, ref.endSec - part.concatSec + part.fromSec),
        }));
        const refined = refineWordTimings(part.target.words, shifted);
        if (refined.matchedFrac < WHISPER_CPP_MIN_MATCH_FRAC) {
          result.set(part.id, null);
          continue;
        }
        const timing = summarizeTimingQuality(refined.words);
        result.set(part.id, {
          words: refined.words,
          report: {
            matchedFrac: refined.matchedFrac,
            alignedWords: timing.sourceCounts.aligned ?? 0,
            interpolatedWords: timing.sourceCounts.interpolated ?? 0,
            uncertainSpans: timing.uncertainSpans,
          },
        });
      }
      return result;
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => {});
    }
  };
}