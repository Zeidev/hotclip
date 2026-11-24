import { describe, expect, it } from "vitest";
import {
  SUBTITLE_REPAIR_MIN_CUE_SEC,
  describeSubtitleRepairZh,
  parseSubtitleTranscript,
  repairSubtitleCues,
  subtitleRepairNotice,
  type ParsedCue,
} from "../subtitle-import";

const cue = (index: number, startSec: number, endSec: number, text = `line ${index}`): ParsedCue =>
  ({ index, startSec, endSec, text });

const srtCue = (index: number, start: string, end: string, body = `line ${index}`): string =>
  `${index}\n${start} --> ${end}\n${body}\n`;

describe("subtitle cue repair", () => {
  it("cuts an overlapping cue back to the previous cue's end", () => {
    const { cues, report } = repairSubtitleCues([cue(1, 1, 4), cue(2, 2, 5)], 30);
    expect(cues.map((c) => [c.startSec, c.endSec])).toEqual([[1, 4], [4, 5]]);
    expect(cues.every((c) => c.text === `line ${c.index}`)).toBe(true);
    expect(report).toEqual({ cues: 2, repaired: 1, dropped: 0, reordered: false });
  });

  it("swaps a backwards cue so its text keeps a window", () => {
    const { cues, report } = repairSubtitleCues([cue(1, 5, 3)], 30);
    expect(cues.map((c) => [c.startSec, c.endSec])).toEqual([[3, 5]]);
    expect(report).toEqual({ cues: 1, repaired: 1, dropped: 0, reordered: false });
  });

  it("gives a zero-length cue the minimum readable window, bounded by the next cue", () => {
    const { cues, report } = repairSubtitleCues([cue(1, 2, 2), cue(2, 2.4, 5)], 30);
    expect(cues.map((c) => [c.startSec, c.endSec])).toEqual([[2, 2.4], [2.4, 5]]);
    expect(cues[0].endSec - cues[0].startSec).toBeLessThan(SUBTITLE_REPAIR_MIN_CUE_SEC);
    expect(report.repaired).toBe(1);
    expect(report.dropped).toBe(0);
  });

  it("resolves a three-cue overlap chain into a chronological track", () => {
    const { cues, report } = repairSubtitleCues([cue(1, 1, 3), cue(2, 2, 4), cue(3, 3.5, 5)], 30);
    expect(cues.map((c) => [c.startSec, c.endSec])).toEqual([[1, 3], [3, 4], [4, 5]]);
    expect(report).toEqual({ cues: 3, repaired: 2, dropped: 0, reordered: false });
  });

  it("drops duplicate cues that share a window instead of inventing time for them", () => {
    const { cues, report } = repairSubtitleCues([cue(1, 1.25, 3.75, "kept"), cue(2, 1.25, 3.75, "duplicate"), cue(3, 1.25, 3.75, "duplicate 2")], 30);
    expect(cues.map((c) => c.text)).toEqual(["kept"]);
    expect(report).toEqual({ cues: 3, repaired: 0, dropped: 2, reordered: false });
  });

  it("re-sorts out-of-order cues by time and says so", () => {
    const { cues, report } = repairSubtitleCues([cue(1, 5, 6), cue(2, 1, 2)], 30);
    expect(cues.map((c) => c.index)).toEqual([2, 1]);
    expect(cues.map((c) => c.startSec)).toEqual([1, 5]);
    expect(report).toEqual({ cues: 2, repaired: 0, dropped: 0, reordered: true });
  });

  it("leaves a healthy track untouched", () => {
    const healthy = [cue(1, 1, 3), cue(2, 3, 5), cue(3, 6, 8)];
    const { cues, report } = repairSubtitleCues(healthy, 30);
    expect(cues).toEqual(healthy);
    expect(report).toEqual({ cues: 3, repaired: 0, dropped: 0, reordered: false });
  });
});

describe("subtitle import repair wiring", () => {
  const overlapping = srtCue(1, "00:00:01,000", "00:00:04,000") + "\n" + srtCue(2, "00:00:02,000", "00:00:05,000");

  it("stays strict unless repair is asked for", () => {
    expect(() => parseSubtitleTranscript(overlapping, "srt", 30)).toThrow("subtitle-import:overlap:2");
  });

  it("repairs on the import path and receipts what changed", () => {
    const transcript = parseSubtitleTranscript(overlapping, "srt", 30, { repair: true });
    expect(transcript.segments.map((s) => [s.startSec, s.endSec])).toEqual([[1, 4], [4, 5]]);
    expect(transcript.subtitleRepair).toEqual({ cues: 2, repaired: 1, dropped: 0, reordered: false });
    expect(transcript.segments.map((s) => s.id)).toEqual([1, 2]);
  });

  it("reports nothing for a healthy file, so the receipt never becomes noise", () => {
    const healthy = srtCue(1, "00:00:01,000", "00:00:03,000") + "\n" + srtCue(2, "00:00:03,000", "00:00:05,000");
    const repaired = parseSubtitleTranscript(healthy, "srt", 30, { repair: true });
    expect(repaired.subtitleRepair).toBeUndefined();
    expect(JSON.stringify(repaired)).toBe(JSON.stringify(parseSubtitleTranscript(healthy, "srt", 30)));
  });

  it("keeps cue ids pointing at their file order after a re-sort", () => {
    const outOfOrder = srtCue(1, "00:00:05,000", "00:00:06,000", "second spoken") + "\n" + srtCue(2, "00:00:01,000", "00:00:02,000", "first spoken");
    const transcript = parseSubtitleTranscript(outOfOrder, "srt", 30, { repair: true });
    expect(transcript.segments.map((s) => [s.id, s.text])).toEqual([[2, "first spoken"], [1, "second spoken"]]);
    expect(transcript.subtitleRepair).toEqual({ cues: 2, repaired: 0, dropped: 0, reordered: true });
  });

  it("still rejects the tracks repair cannot save", () => {
    const dropped = srtCue(1, "00:00:01,000", "00:00:03,000", "kept") + "\n" + srtCue(2, "00:00:01,000", "00:00:03,000", "duplicate");
    const transcript = parseSubtitleTranscript(dropped, "srt", 30, { repair: true });
    expect(transcript.segments.map((s) => s.text)).toEqual(["kept"]);
    expect(transcript.subtitleRepair).toEqual({ cues: 2, repaired: 0, dropped: 1, reordered: false });

    const onlyDuplicates = srtCue(1, "00:00:01,000", "00:00:03,000") + "\n" + srtCue(2, "00:00:01,000", "00:00:03,000");
    expect(() => parseSubtitleTranscript(onlyDuplicates + "\n" + srtCue(3, "00:00:01,000", "00:00:03,000"), "srt", 30, { repair: true }))
      .not.toThrow(); // one cue survives
    expect(() => parseSubtitleTranscript(srtCue(1, "00:00:05,000", "00:00:01,000"), "srt", 30, { repair: true }))
      .not.toThrow(); // backwards cue, repaired by swapping
    expect(() => parseSubtitleTranscript(srtCue(1, "00:00:0x,000", "00:00:03,000"), "srt", 30, { repair: true }))
      .toThrow("subtitle-import:cue:1"); // syntax errors are not repairable
    expect(() => parseSubtitleTranscript(srtCue(1, "00:00:01,000", "00:00:09,000"), "srt", 8, { repair: true }))
      .toThrow("subtitle-import:range:1"); // times outside the source stay an error
  });
});

describe("subtitle repair receipts across locales", () => {
  it("composes a per-language receipt for every surface", () => {
    const report = { cues: 10, repaired: 3, dropped: 1, reordered: true };
    expect(subtitleRepairNotice(report, (key, params) => `${key}:${params?.n ?? ""}`))
      .toBe("subtitleRepairedCues:3 subtitleRepairedDropped:1 subtitleRepairedReordered:");
    expect(subtitleRepairNotice({ cues: 4, repaired: 0, dropped: 0, reordered: false }, (key) => key)).toBe("");
    expect(describeSubtitleRepairZh(report)).toBe("修复 3 处字幕时间;丢弃 1 段无可保留时间的字幕;按时间重新排序");
    expect(describeSubtitleRepairZh({ cues: 4, repaired: 0, dropped: 0, reordered: false })).toBe("");
  });
});

describe("Turkish subtitle repair", () => {
  const turkish =
    srtCue(1, "00:00:01,000", "00:00:05,000", "İstanbul'da ışık hüzmesi") +
    "\n" +
    srtCue(2, "00:00:03,500", "00:00:07,000", "şaşırtıcı derecede güzel") +
    "\n" +
    srtCue(3, "00:00:08,000", "00:00:08,000", "ığüşöç");

  it("repairs overlapping Turkish cues without touching a single character", () => {
    const transcript = parseSubtitleTranscript(turkish, "srt", 30, { repair: true });
    expect(transcript.segments.map((s) => s.text)).toEqual(["İstanbul'da ışık hüzmesi", "şaşırtıcı derecede güzel", "ığüşöç"]);
    expect(transcript.segments.map((s) => [s.startSec, s.endSec])).toEqual([[1, 5], [5, 7], [8, 8.7]]);
    expect(transcript.subtitleRepair).toEqual({ cues: 3, repaired: 2, dropped: 0, reordered: false });
    expect(transcript.segments[0].words.map((w) => w.text)).toEqual(["İstanbul'da", "ışık", "hüzmesi"]);
  });

  it("drops a Turkish cue whose window is already covered, rather than moving its text", () => {
    const covered =
      srtCue(1, "00:00:01,000", "00:00:05,000", "İstanbul'da ışık hüzmesi") +
      "\n" +
      srtCue(2, "00:00:03,500", "00:00:07,000", "şaşırtıcı derecede güzel") +
      "\n" +
      srtCue(3, "00:00:04,000", "00:00:04,000", "ığüşöç");
    const transcript = parseSubtitleTranscript(covered, "srt", 30, { repair: true });
    expect(transcript.segments.map((s) => s.text)).toEqual(["İstanbul'da ışık hüzmesi", "şaşırtıcı derecede güzel"]);
    expect(transcript.subtitleRepair).toEqual({ cues: 3, repaired: 1, dropped: 1, reordered: false });
  });

  it("keeps Turkish dotted and dotless i distinct through the repair", () => {
    const transcript = parseSubtitleTranscript(srtCue(1, "00:00:01,000", "00:00:02,000", "İki ışık"), "srt", 30, { repair: true });
    const codes = Array.from(transcript.segments[0].text).map((ch) => ch.codePointAt(0));
    // İ k i ␠ ı ş ı k — U+0130 and U+0131 survive, nothing folds to ASCII i
    expect(codes).toEqual([0x130, 0x6b, 0x69, 0x20, 0x131, 0x15f, 0x131, 0x6b]);
  });
});

describe("subtitle timestamp separators", () => {
  it("accepts comma and dot decimals, including both in one file", () => {
    const mixed =
      srtCue(1, "00:00:01,250", "00:00:03.750", "comma then dot") +
      "\n" +
      srtCue(2, "00:00:03.500", "00:00:05,000", "dot then comma");
    const transcript = parseSubtitleTranscript(mixed, "srt", 30, { repair: true });
    expect(transcript.segments.map((s) => [s.startSec, s.endSec])).toEqual([[1.25, 3.75], [3.75, 5]]);
    expect(transcript.subtitleRepair).toEqual({ cues: 2, repaired: 1, dropped: 0, reordered: false });
  });
});
