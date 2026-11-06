import type { TranscriptSegment } from "./api-types";
import type { TranscriptSearchHit } from "./transcript-search";
import type { VisualEvidenceHit } from "./evidence-search";

export type EvidenceSource = "all" | "transcript" | "visual";
export type EvidenceResult =
  | { kind: "transcript"; id: string; startSec: number; endSec: number; hit: TranscriptSearchHit }
  | { kind: "visual"; id: string; startSec: number; endSec: number; hit: VisualEvidenceHit };

/** 统一时间序用于鼠标与键盘导航，过滤源素材范围之外的旧证据。 */
export function evidenceResults(
  transcript: readonly TranscriptSearchHit[], visual: readonly VisualEvidenceHit[],
  durationSec: number, source: EvidenceSource = "all",
): EvidenceResult[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const results: EvidenceResult[] = [];
  if (source !== "visual") transcript.forEach((hit, i) => results.push({ kind: "transcript", id: `text:${i}`, startSec: hit.startSec, endSec: hit.endSec, hit }));
  if (source !== "transcript") visual.forEach((hit) => results.push({ kind: "visual", id: `visual:${hit.id}`, startSec: hit.t, endSec: hit.t, hit }));
  return results.filter((r) => Number.isFinite(r.startSec) && Number.isFinite(r.endSec) &&
    r.startSec >= 0 && r.startSec < durationSec && r.endSec >= r.startSec && r.endSec <= durationSec)
    .sort((a, b) => a.startSec - b.startSec);
}

/** 首次 Enter 定位首项，之后才前进；反向首次从末项开始。 */
export function nextEvidenceIndex(current: number, length: number, delta: 1 | -1): number {
  if (length <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : length - 1;
  return (Math.min(current, length - 1) + delta + length) % length;
}

/** 试听有短上下文且不超过 30 秒；选段保留完整句子，最终由用户确认。 */
export function evidenceContext(result: EvidenceResult, segments: readonly TranscriptSegment[], durationSec: number): {
  startSec: number; endSec: number; segmentIds: number[];
} {
  const startSec = Math.max(0, result.startSec - 2);
  const endSec = Math.min(durationSec, result.endSec + 2, startSec + 30);
  const matched = result.kind === "transcript" ? new Set(result.hit.segmentIds) : null;
  return {
    startSec, endSec,
    segmentIds: segments.filter((segment) => matched ? matched.has(segment.id)
      : segment.endSec > startSec && segment.startSec < endSec).map((segment) => segment.id),
  };
}
