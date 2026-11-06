import { describe, expect, it } from "vitest";
import { evidenceContext, evidenceResults, nextEvidenceIndex } from "../evidence-navigation";
import { indexTranscript, searchTranscript } from "../transcript-search";
import { searchVisualEvidence } from "../evidence-search";

const segments = [
  { id: 1, text: "Hello", startSec: 0, endSec: 4, words: [] },
  { id: 2, text: "world", startSec: 10, endSec: 15, words: [] },
  { id: 3, text: "Hello again", startSec: 50, endSec: 55, words: [] },
];
const transcript = searchTranscript(indexTranscript(segments), "hello");
const visual = searchVisualEvidence([
  { t: 11, energy: 3, note: "Hello title" }, { t: 58, energy: 2, note: "Hello outro" },
], "hello");

describe("evidence navigation", () => {
  it("merges speech and frame matches in chronological order, with source filters", () => {
    expect(evidenceResults(transcript, visual, 60).map((r) => [r.kind, r.startSec])).toEqual([
      ["transcript", 0], ["visual", 11], ["transcript", 50], ["visual", 58],
    ]);
    expect(evidenceResults(transcript, visual, 60, "transcript")).toHaveLength(2);
    expect(evidenceResults(transcript, visual, 60, "visual")).toHaveLength(2);
  });
  it("excludes stale evidence outside the current source duration", () => {
    expect(evidenceResults(transcript, visual, 20).map((r) => r.startSec)).toEqual([0, 11]);
    expect(evidenceResults(transcript, visual, NaN)).toEqual([]);
    expect(evidenceResults([{ ...transcript[0], startSec: NaN }], [], 60)).toEqual([]);
  });
  it("first forward navigation selects the first match and reverse wraps", () => {
    expect(nextEvidenceIndex(-1, 4, 1)).toBe(0);
    expect(nextEvidenceIndex(0, 4, 1)).toBe(1);
    expect(nextEvidenceIndex(3, 4, 1)).toBe(0);
    expect(nextEvidenceIndex(-1, 4, -1)).toBe(3);
    expect(nextEvidenceIndex(0, 4, -1)).toBe(3);
    expect(nextEvidenceIndex(8, 2, 1)).toBe(0);
    expect(nextEvidenceIndex(0, 0, 1)).toBe(-1);
  });
  it("preselects only complete matched sentences, even for cross-cue phrases", () => {
    const result = evidenceResults(searchTranscript(indexTranscript(segments), "hello world"), [], 60)[0];
    expect(evidenceContext(result, segments, 60)).toEqual({ startSec: 0, endSec: 17, segmentIds: [1, 2] });
  });
  it("preselects nearby speech for a frame, never invents a sentence in silence", () => {
    const results = evidenceResults([], visual, 60);
    expect(evidenceContext(results[0], segments, 60)).toEqual({ startSec: 9, endSec: 13, segmentIds: [2] });
    expect(evidenceContext(results[1], segments, 60)).toEqual({ startSec: 56, endSec: 60, segmentIds: [] });
  });
  it("caps a long cross-cue audition without changing selected sentence bounds", () => {
    const result = evidenceResults([{ ...transcript[0], startSec: 4, endSec: 59 }], [], 60)[0];
    expect(evidenceContext(result, segments, 60)).toEqual({ startSec: 2, endSec: 32, segmentIds: [1] });
  });
});
