/**
 * Piece-to-piece colour matching for jump cuts: two pieces recorded minutes
 * apart (or from a different camera/light) can sit 10-20 luma apart and read as
 * an accidental flash. The first kept piece is the reference; later pieces get
 * a small, hard-capped `eq` correction derived from `signalstats` means.
 *
 * Deliberately conservative: ordinary footage (already close) gets no filter,
 * monochrome stays monochrome, and every adjustment is capped far below what
 * would look like a grade.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfmpegPath } from "./binaries";
import { parseVisualSignalSamples } from "./visual-enhance";

const execFileAsync = promisify(execFile);

export interface PieceColorStats {
  luma: number;
  saturation: number;
}

export interface PieceColorGrade {
  brightness: number;
  saturation: number;
}

/** Only correct when the pieces are visibly apart; closer than this reads fine. */
export const MIN_LUMA_DELTA = 6;
export const MIN_SAT_RATIO = 0.15;
export const MAX_BRIGHTNESS = 0.03;
export const MAX_SATURATION = 0.06;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
const round = (value: number, digits: number): number => Number(value.toFixed(digits));

/**
 * Measure one kept range with the same `signalstats` fields the Tier-0 probe
 * prints. Two samples/second is plenty for a mean and keeps the pass cheap.
 */
export async function measurePieceColor(
  filePath: string,
  range: { startSec: number; endSec: number },
  signal?: AbortSignal
): Promise<PieceColorStats | null> {
  const start = Math.max(0, range.startSec);
  const duration = Math.max(0.2, range.endSec - start);
  try {
    const { stdout } = await execFileAsync(
      resolveFfmpegPath(),
      [
        "-hide_banner", "-nostats",
        "-ss", start.toFixed(3),
        "-t", duration.toFixed(3),
        "-i", filePath,
        "-vf", "fps=2,signalstats,metadata=print:file=-",
        "-an", "-f", "null", "-",
      ],
      { maxBuffer: 8 * 1024 * 1024, signal }
    );
    const samples = parseVisualSignalSamples(String(stdout));
    if (samples.length === 0) return null;
    const luma = samples.reduce((sum, sample) => sum + sample.yAvg, 0) / samples.length;
    const saturation = samples.reduce((sum, sample) => sum + sample.satAvg, 0) / samples.length;
    if (!Number.isFinite(luma) || !Number.isFinite(saturation)) return null;
    return { luma, saturation };
  } catch {
    return null;
  }
}

/** Measure every kept piece; a failed piece stays null and is left untouched. */
export async function measurePieceColors(
  filePath: string,
  ranges: Array<{ startSec: number; endSec: number }>,
  signal?: AbortSignal
): Promise<Array<PieceColorStats | null>> {
  const measured: Array<PieceColorStats | null> = [];
  for (const range of ranges) {
    signal?.throwIfAborted();
    measured.push(await measurePieceColor(filePath, range, signal));
  }
  return measured;
}

/**
 * First measured piece is the reference. Corrections are relative, capped and
 * skipped entirely when the pieces are already close or monochrome.
 */
export function planPieceColorGrades(pieces: Array<PieceColorStats | null>): Array<PieceColorGrade | null> {
  const reference = pieces.find((piece): piece is PieceColorStats => piece !== null);
  if (!reference) return pieces.map(() => null);
  return pieces.map((piece) => {
    if (!piece) return null;
    // SATAVG near zero is intentional monochrome: never "fix" it.
    if (reference.saturation < 8 || piece.saturation < 8) return null;
    const lumaDelta = piece.luma - reference.luma;
    const brightness = Math.abs(lumaDelta) >= MIN_LUMA_DELTA
      ? round(clamp(-lumaDelta / 255 * 0.6, -MAX_BRIGHTNESS, MAX_BRIGHTNESS), 3)
      : 0;
    const satRatio = reference.saturation / Math.max(1, piece.saturation);
    const saturation = Math.abs(1 - satRatio) >= MIN_SAT_RATIO
      ? round(clamp(satRatio, 1 - MAX_SATURATION, 1 + MAX_SATURATION), 3)
      : 1;
    if (Math.abs(brightness) < 0.003 && saturation === 1) return null;
    return { brightness, saturation };
  });
}

/** Compile one piece's correction into FFmpeg's per-frame `eq` (null = no filter). */
export function pieceColorFilter(grade?: PieceColorGrade | null): string | null {
  if (!grade) return null;
  if (Math.abs(grade.brightness) < 0.003 && grade.saturation === 1) return null;
  return `eq=brightness=${grade.brightness.toFixed(3)}:saturation=${grade.saturation.toFixed(3)}`;
}