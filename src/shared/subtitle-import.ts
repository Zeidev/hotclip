/** Plain-text subtitle interchange. No DOM, model, network or filesystem access. */
import type { SubtitleRepairReport, Transcript, TranscriptSegment, TranscriptWord } from "./api-types";
import { rebuildWords } from "./edit-transcript";

export type SubtitleFormat = "srt" | "vtt";
export const SUBTITLE_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_CUES = 20_000;
const MAX_WORDS = 100_000;
const MAX_CUE_CHARS = 8_000;

export const SUBTITLE_IMPORT_ERROR_CODES = [
  "format", "size", "encoding", "cue", "timestamps", "empty", "overlap", "range", "limit", "mapped",
] as const;
export type SubtitleImportErrorCode = typeof SUBTITLE_IMPORT_ERROR_CODES[number];

function fail(code: SubtitleImportErrorCode, cue = 0): never {
  throw new Error(`subtitle-import:${code}:${cue}`);
}

/** Works with both direct errors and Electron's IPC error wrapper. */
export function subtitleImportError(error: unknown): { code: SubtitleImportErrorCode; cue: number } | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /subtitle-import:([a-z]+):(\d+)/.exec(message);
  return match && SUBTITLE_IMPORT_ERROR_CODES.includes(match[1] as SubtitleImportErrorCode)
    ? { code: match[1] as SubtitleImportErrorCode, cue: Number(match[2]) }
    : null;
}

/** Headless clients get recovery advice as well as the stable machine code. */
export function describeSubtitleImportError(error: unknown): string {
  const issue = subtitleImportError(error);
  if (!issue) return error instanceof Error ? error.message : String(error);
  const advice: Record<SubtitleImportErrorCode, string> = {
    format: "Choose a UTF-8 .srt or .vtt file.",
    size: "The subtitle file exceeds 5 MB; export a smaller transcript.",
    encoding: "Save the subtitle file as UTF-8 and retry.",
    cue: "Check cue text, timestamp syntax and blank lines between cues.",
    timestamps: "This is a timestamped transcript, not SRT or WebVTT; export the track as SRT or WebVTT and import that.",
    empty: "The file has no subtitle cues.",
    overlap: "Export a single chronological transcript track without overlapping cues.",
    range: "Subtitle times exceed the source duration; choose subtitles aligned to this media file.",
    limit: "Import is limited to 20,000 cues, 100,000 words and 8,000 characters per cue.",
    mapped: "Export a standalone SRT/WebVTT aligned to this media, without a streaming timestamp map.",
  };
  return `subtitle-import:${issue.code}:${issue.cue} ${advice[issue.code]}${issue.cue ? ` Cue ${issue.cue}.` : ""}`;
}

export function validateSubtitleInput(text: unknown, format: unknown): asserts text is string {
  if (format !== "srt" && format !== "vtt") fail("format");
  if (typeof text !== "string") fail("format");
  if (text.length > SUBTITLE_IMPORT_MAX_BYTES || new TextEncoder().encode(text).length > SUBTITLE_IMPORT_MAX_BYTES) fail("size");
  if (text.includes("\u0000") || text.includes("\uFFFD")) fail("encoding");
}

/**
 * A timestamped transcript (`[00:41] Ay!` one line per fragment) is not a cue
 * track: there is no `-->`, so there is no end time to import and every
 * boundary would have to be invented. YouTube/GitHub transcript exports and
 * plain-text dumps from subtitle tools are shaped like this.
 *
 * Recognised only to name the real problem. Without it the creator gets the
 * generic malformed-cue message and hunts for a broken cue that does not
 * exist; the file is not an SRT at all. Needs a few list lines before we
 * claim that, so a stray timestamp in an otherwise broken SRT still reads as
 * a cue problem.
 */
const SUBTITLE_LIST_LINE = /^[\t ]*\[?\d{1,2}:\d{2}(?::\d{2})?\]?[\t ]/;
const SUBTITLE_LIST_MIN_LINES = 3;

function looksLikeTimestampedTranscript(source: string): boolean {
  let seen = 0;
  for (const line of source.split("\n")) {
    if (SUBTITLE_LIST_LINE.test(line) && ++seen >= SUBTITLE_LIST_MIN_LINES) return true;
  }
  return false;
}

function timestamp(value: string, format: SubtitleFormat): number | null {
  const pattern = format === "srt"
    ? /^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/
    : /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/;
  const match = pattern.exec(value);
  if (!match) return null;
  const ms = (Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 + Number(match[4]);
  return Number.isSafeInteger(ms) ? ms / 1000 : null;
}

/** Strip presentation only, then decode entities once so escaped text stays text. */
function cueText(payload: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "", rlm: "" };
  return payload
    .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[a-z][^>]*>|<\d{2,}:[\d:.]+>/gi, "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|lrm|rlm);/gi, (entity, name: string) => {
      if (!name.startsWith("#")) return entities[name.toLowerCase()] ?? entity;
      const n = /^#x/i.test(name) ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** A cue as written in the file, before any repair. */
export interface ParsedCue {
  /** Cue number as written in the file; becomes the transcript segment id. */
  index: number;
  startSec: number;
  endSec: number;
  text: string;
}

export interface SubtitleImportOptions {
  /**
   * Repair a track that is overlapping, out of order, backwards or zero-length
   * instead of rejecting it, and report on the transcript what changed.
   * The app's import path (core/subtitle-import.ts) turns this on: a creator
   * importing their own SRT should get usable captions plus a visible receipt,
   * not an error. Left off, this parser stays strict, which is what callers that
   * validate a track they produced themselves expect.
   */
  repair?: boolean;
}

/**
 * Smallest window handed to a cue that arrived zero-length. Matches the caption
 * readability floor (`planReadableCaptions` never shows a line for less than
 * 0.7s), so a repaired cue is never shorter than what we would render anyway.
 */
export const SUBTITLE_REPAIR_MIN_CUE_SEC = 0.7;

/**
 * Deterministic local repair of a malformed subtitle track: no model, no key,
 * no guessing at text. Only the broken times move, and only as far as needed:
 *
 *  - out-of-order cues are re-sorted by start time (stable for ties);
 *  - a backwards cue (its end written before its start) is swapped back;
 *  - an overlapping cue's START is pushed to the previous cue's END, so the
 *    later line keeps its own text window and never eats the earlier line;
 *  - a cue left with no time at all (a duplicate sharing its neighbour's
 *    window, or a zero-length cue with no room to grow) is dropped, because
 *    inventing a window for it would rewrite the creator's file;
 *  - text is never touched, so a healthy file passes through byte-for-byte.
 */
export function repairSubtitleCues(
  cues: readonly ParsedCue[],
  durationSec: number
): { cues: ParsedCue[]; report: SubtitleRepairReport } {
  const ordered = cues
    .map((cue, fileOrder) => ({ cue, fileOrder }))
    .sort((a, b) => a.cue.startSec - b.cue.startSec || a.cue.endSec - b.cue.endSec || a.fileOrder - b.fileOrder);
  const reordered = ordered.some((entry, i) => entry.fileOrder !== i);
  const kept: ParsedCue[] = [];
  let repaired = 0;
  let dropped = 0;
  for (let i = 0; i < ordered.length; i++) {
    const cue = ordered[i].cue;
    let { startSec, endSec } = cue;
    let touched = false;
    if (endSec < startSec) {
      // Timestamps written the wrong way round: swapping keeps the text window.
      [startSec, endSec] = [endSec, startSec];
      touched = true;
    } else if (endSec === startSec) {
      // Zero-length cue: give it the minimum readable window, bounded by the
      // next cue's start and by the source so it can never overlap or overrun.
      const next = ordered[i + 1]?.cue;
      endSec = Math.min(startSec + SUBTITLE_REPAIR_MIN_CUE_SEC, next ? next.startSec : Infinity, durationSec);
      touched = true;
    }
    const previous = kept[kept.length - 1];
    if (previous && startSec < previous.endSec) {
      startSec = previous.endSec;
      touched = true;
    }
    if (endSec <= startSec) {
      dropped++;
      continue;
    }
    if (touched) repaired++;
    kept.push({ index: cue.index, startSec, endSec, text: cue.text });
  }
  return { cues: kept, report: { cues: cues.length, repaired, dropped, reordered } };
}

/**
 * Signed fixed-point offset for receipts and notices, e.g. "+0.50s" / "-0.30s".
 * ASCII sign and dot on purpose: it is read by people and pasted into files.
 */
export function formatSubtitleOffset(offsetSec: number): string {
  return `${offsetSec >= 0 ? "+" : "-"}${Math.abs(offsetSec).toFixed(2)}s`;
}

/**
 * Move a whole track in time, text untouched: an intro or jingle at the head of
 * the source otherwise forces the creator to re-time every line by hand. Only
 * times move, and the edges follow the rules the import path already applies:
 *
 *  - a cue the offset pushes off the head (its end lands at or before 0) is
 *    dropped, exactly as repair drops a cue with no time to keep;
 *  - a cue the offset pushes past the source (its start reaches the source
 *    duration) is dropped for the same reason;
 *  - a surviving cue is clamped into [0, source duration] — the same trimming
 *    the import path already does to a tail — and the clamp is receipted;
 *  - clamping can land a later cue on an earlier one, so the shifted track runs
 *    through `repairSubtitleCues`: overlap/zero-length/order rules are never
 *    re-implemented here.
 *
 * A zero (or unusable) offset is not a shift: it returns the plain repair
 * result and no shift fields, so no receipt claims work that never happened.
 */
export function shiftSubtitleCues(
  cues: readonly ParsedCue[],
  offsetSec: number,
  durationSec: number
): { cues: ParsedCue[]; report: SubtitleRepairReport } {
  if (!Number.isFinite(offsetSec) || offsetSec === 0) return repairSubtitleCues(cues, durationSec);
  const bounded = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : Infinity;
  const moved: ParsedCue[] = [];
  let dropped = 0;
  let clipped = 0;
  for (const cue of cues) {
    const startSec = cue.startSec + offsetSec;
    const endSec = cue.endSec + offsetSec;
    if (endSec <= 0 || startSec >= bounded) {
      dropped++;
      continue;
    }
    const start = Math.max(0, startSec);
    const end = Math.min(endSec, bounded);
    if (start !== startSec || end !== endSec) clipped++;
    moved.push({ index: cue.index, startSec: start, endSec: end, text: cue.text });
  }
  const repairedTrack = repairSubtitleCues(moved, bounded);
  return {
    cues: repairedTrack.cues,
    report: {
      cues: cues.length,
      repaired: repairedTrack.report.repaired,
      dropped: dropped + repairedTrack.report.dropped,
      reordered: repairedTrack.report.reordered,
      shiftedSec: offsetSec,
      shifted: moved.length,
      clipped,
    },
  };
}

/**
 * Shift every word of a cue by the same offset and clamp each one into the
 * cue's own window. Text is never re-read, so a creator's own line survives
 * byte-for-byte; a cue whose words all fell outside the window (a cue trimmed
 * to a sliver) falls back to the estimate the import path uses.
 */
function shiftWordTimes(
  words: readonly TranscriptWord[],
  text: string,
  offsetSec: number,
  startSec: number,
  endSec: number
): TranscriptWord[] {
  const moved = words
    .map((word) => ({
      ...word,
      startSec: Math.max(startSec, word.startSec + offsetSec),
      endSec: Math.min(endSec, word.endSec + offsetSec),
    }))
    .filter((word) => word.endSec > word.startSec);
  if (moved.length > 0 || !text) return moved;
  return rebuildWords(text, startSec, endSec).map((word) => ({ ...word, timingSource: "estimated" as const }));
}

/** Fold a shift receipt onto the receipt the track already carried (if any). */
function mergeSubtitleRepair(
  previous: SubtitleRepairReport | undefined,
  shift: SubtitleRepairReport
): SubtitleRepairReport {
  return {
    cues: previous?.cues ?? shift.cues,
    repaired: (previous?.repaired ?? 0) + shift.repaired,
    dropped: (previous?.dropped ?? 0) + shift.dropped,
    reordered: (previous?.reordered ?? false) || shift.reordered,
    shiftedSec: (previous?.shiftedSec ?? 0) + (shift.shiftedSec ?? 0),
    shifted: (previous?.shifted ?? 0) + (shift.shifted ?? 0),
    clipped: (previous?.clipped ?? 0) + (shift.clipped ?? 0),
  };
}

/**
 * Apply a manual offset to an imported subtitle transcript — cue times, word
 * times and the receipt — and return the shifted track. A zero or unusable
 * offset returns the very same object, so "apply 0" adds no receipt and no
 * render. A shift that would push every cue off the source is refused the same
 * way: an offset corrects alignment, it is not a way to delete a transcript.
 */
export function shiftSubtitleTranscript(transcript: Transcript, offsetSec: number): Transcript {
  if (!Number.isFinite(offsetSec) || offsetSec === 0) return transcript;
  const shifted = shiftSubtitleCues(
    transcript.segments.map((segment) => ({
      index: segment.id,
      startSec: segment.startSec,
      endSec: segment.endSec,
      text: segment.text,
    })),
    offsetSec,
    transcript.durationSec
  );
  const source = new Map(transcript.segments.map((segment) => [segment.id, segment]));
  const segments: TranscriptSegment[] = [];
  for (const cue of shifted.cues) {
    const segment = source.get(cue.index);
    if (!segment) continue;
    segments.push({
      ...segment,
      startSec: cue.startSec,
      endSec: cue.endSec,
      words: shiftWordTimes(segment.words, segment.text, offsetSec, cue.startSec, cue.endSec),
    });
  }
  if (segments.length === 0) return transcript;
  return {
    ...transcript,
    segments,
    subtitleRepair: mergeSubtitleRepair(transcript.subtitleRepair, shifted.report),
  };
}

/**
 * Same receipt for the locale-free console surfaces. CLI and MCP emit Chinese
 * only (they pass no locale), so this mirrors the phrasing of their existing
 * import note instead of resolving a UI language.
 */
export function describeSubtitleRepairZh(report: SubtitleRepairReport): string {
  const parts: string[] = [];
  if (report.shiftedSec !== undefined) parts.push(`整体平移 ${formatSubtitleOffset(report.shiftedSec)}`);
  if (report.shifted !== undefined && report.shifted > 0) parts.push(`移动 ${report.shifted} 段`);
  if (report.clipped) parts.push(`按片长裁剪 ${report.clipped} 段`);
  if (report.repaired > 0) parts.push(`修复 ${report.repaired} 处字幕时间`);
  if (report.dropped > 0) parts.push(`丢弃 ${report.dropped} 段无可保留时间的字幕`);
  if (report.reordered) parts.push("按时间重新排序");
  return parts.join(";");
}

/**
 * Human-readable receipt for a repaired or hand-shifted track, so every surface
 * (import panel, transcript panel, CLI, MCP) reports the same facts. `t` is the
 * caller's translator for the "transcribe" namespace; a receipt that changed
 * nothing yields "" and callers show nothing.
 */
export function subtitleRepairNotice(
  report: SubtitleRepairReport,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  const parts: string[] = [];
  // The manual shift happened last, so it reads first; the import repair facts
  // the track still carries follow it.
  if (report.shiftedSec !== undefined) parts.push(t("subtitleShiftedBy", { sec: formatSubtitleOffset(report.shiftedSec) }));
  if (report.shifted !== undefined && report.shifted > 0) parts.push(t("subtitleShiftedCues", { n: report.shifted }));
  if (report.clipped) parts.push(t("subtitleShiftClipped", { n: report.clipped }));
  if (report.repaired > 0) parts.push(t("subtitleRepairedCues", { n: report.repaired }));
  if (report.dropped > 0) parts.push(t("subtitleRepairedDropped", { n: report.dropped }));
  if (report.reordered) parts.push(t("subtitleRepairedReordered"));
  return parts.join(" ");
}

/**
 * Import a single transcript track bound to the probed source duration. Cue
 * boundaries are preserved; all within-cue word times are explicitly estimated.
 * Malformed tracks (unreadable encoding, stray timestamps, mapped WebVTT,
 * times outside the source) are still rejected instead of silently losing
 * dialogue; a file that is a timestamped transcript list rather than a cue
 * track is rejected as `timestamps` so the message names what is wrong; with
 * `repair` on, overlapping/backwards/zero-length/out-of-order cues inside an
 * otherwise readable track are repaired and receipted instead.
 */
export function parseSubtitleTranscript(
  text: string,
  format: SubtitleFormat,
  durationSec: number,
  options: SubtitleImportOptions = {}
): Transcript {
  validateSubtitleInput(text, format);
  if (!Number.isFinite(durationSec) || durationSec <= 0) fail("range");
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!source) fail("empty");
  const blocks = source.split(/\n[\t ]*\n+/);
  if (format === "vtt") {
    if (!/^WEBVTT(?:[\t ]|$)/.test(blocks[0].split("\n")[0])) fail("format");
    // HLS clock mappings require the matching media timeline; standalone media
    // cannot establish that relationship, including when LOCAL happens to be 0.
    if (/^X-TIMESTAMP-MAP[=:]/m.test(source)) fail("mapped");
    if (blocks[0].includes("-->")) fail("cue", 1);
    blocks.shift();
  }

  // Checked before the cue loop, so the first block is not blamed as a
  // malformed cue when the whole file is a timestamped transcript list.
  if (!source.includes("-->") && looksLikeTimestampedTranscript(source)) fail("timestamps");

  const parsed: ParsedCue[] = [];
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (format === "vtt" && /^(NOTE(?:[\t ]|$)|STYLE$|REGION$)/.test(lines[0])) continue;
    const cue = parsed.length + 1;
    if (cue > MAX_CUES) fail("limit", cue);
    const timingIndex = lines[0].includes("-->") ? 0 : 1;
    if (timingIndex === 1 && format === "srt" && !/^\d+$/.test(lines[0])) fail("cue", cue);
    const timing = /^(\S+)\s+-->\s+(\S+)(?:[\t ]+(.*))?$/.exec(lines[timingIndex]?.trim() ?? "");
    if (!timing || (format === "srt" && timing[3])) fail("cue", cue);
    const startSec = timestamp(timing[1], format);
    const endSec = timestamp(timing[2], format);
    if (startSec === null || endSec === null) fail("cue", cue);
    if (endSec <= startSec && !options.repair) fail("cue", cue);
    if (startSec >= durationSec || endSec > durationSec + 0.001) fail("range", cue);
    if (!options.repair && parsed.length && startSec < parsed[parsed.length - 1].endSec) fail("overlap", cue);
    const payload = lines.slice(timingIndex + 1).join("\n");
    if (payload.length > MAX_CUE_CHARS) fail("limit", cue);
    // Missing block separators must never turn a following timestamp into speech.
    if (payload.includes("-->")) fail("cue", cue);
    const clean = cueText(payload);
    if (!clean) fail("cue", cue);
    parsed.push({ index: cue, startSec, endSec, text: clean });
  }
  if (!parsed.length) fail("empty");

  const repairedTrack = options.repair ? repairSubtitleCues(parsed, durationSec) : null;
  const cues = repairedTrack ? repairedTrack.cues : parsed;
  if (!cues.length) fail("empty");

  const segments: TranscriptSegment[] = [];
  let totalWords = 0;
  for (const cue of cues) {
    const endSec = Math.min(cue.endSec, durationSec);
    const words = rebuildWords(cue.text, cue.startSec, endSec)
      .map((word) => ({ ...word, timingSource: "estimated" as const }));
    totalWords += words.length;
    if (totalWords > MAX_WORDS) fail("limit", cue.index);
    segments.push({ id: cue.index, startSec: cue.startSec, endSec, text: cue.text, words });
  }
  const report = repairedTrack?.report;
  const changed = report !== undefined && (report.repaired > 0 || report.dropped > 0 || report.reordered);
  // SRT/VTT have no reliable language declaration. Downstream text-based
  // language inference already handles "auto" without inventing an ASR result.
  return { language: "auto", engine: `subtitle-${format}`, durationSec, segments, ...(changed ? { subtitleRepair: report } : {}) };
}
