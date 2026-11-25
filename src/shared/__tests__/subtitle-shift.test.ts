/**
 * 整轨平移:素材带片头/片尾时,创作者把全部字幕按同一个偏移量挪一次即可,
 * 不必逐句改时间码。钉住四件事:时间真的按偏移量走、越界边按既有裁剪/丢弃
 * 规则处理、零偏移不写回执、土耳其语原文一个字节都不动。
 */
import { describe, expect, it } from "vitest";
import type { Transcript } from "../api-types";
import {
  formatSubtitleOffset,
  parseSubtitleTranscript,
  shiftSubtitleCues,
  shiftSubtitleTranscript,
  subtitleRepairNotice,
  type ParsedCue,
} from "../subtitle-import";

const cue = (index: number, startSec: number, endSec: number, text = `line ${index}`): ParsedCue =>
  ({ index, startSec, endSec, text });
const srtCue = (index: number, start: string, end: string, body = `line ${index}`): string =>
  `${index}\n${start} --> ${end}\n${body}\n`;
/** The app's own import path: repaired, so the fixture matches what a creator sees. */
const imported = (body: string, durationSec = 30): Transcript =>
  parseSubtitleTranscript(body, "srt", durationSec, { repair: true });

describe("subtitle track shift", () => {
  it("moves every cue and every word by the offset, and nothing else", () => {
    const transcript = imported(
      srtCue(1, "00:00:01,000", "00:00:03,000", "bir iki") + "\n" + srtCue(2, "00:00:04,000", "00:00:06,000", "üç dört")
    );
    const shifted = shiftSubtitleTranscript(transcript, 0.5);
    expect(shifted.segments.map((s) => [s.id, s.startSec, s.endSec])).toEqual([[1, 1.5, 3.5], [2, 4.5, 6.5]]);
    expect(shifted.segments[0].words.map((w) => [w.text, w.startSec, w.endSec])).toEqual([
      ["bir", 1.5, 2.5],
      ["iki", 2.5, 3.5],
    ]);
    expect(shifted.segments.map((s) => s.text)).toEqual(["bir iki", "üç dört"]);
    expect(shifted.subtitleRepair).toEqual({
      cues: 2, repaired: 0, dropped: 0, reordered: false, shiftedSec: 0.5, shifted: 2, clipped: 0,
    });
  });

  it("drops a cue the offset pushes off the head, like any cue left with no time", () => {
    const transcript = imported(
      srtCue(1, "00:00:00,100", "00:00:00,200", "çok erken") + "\n" + srtCue(2, "00:00:01,000", "00:00:03,000", "sonra")
    );
    const shifted = shiftSubtitleTranscript(transcript, -0.3);
    expect(shifted.segments.map((s) => [s.id, s.startSec, s.endSec])).toEqual([[2, 0.7, 2.7]]);
    expect(shifted.subtitleRepair).toMatchObject({ cues: 2, shifted: 1, dropped: 1, clipped: 0, shiftedSec: -0.3 });
  });

  it("pins a cue that straddles the head to 0 and receipts the trim", () => {
    const transcript = imported(srtCue(1, "00:00:00,200", "00:00:01,200", "baştan taşan"), 30);
    const shifted = shiftSubtitleTranscript(transcript, -0.3);
    expect(shifted.segments).toHaveLength(1);
    expect(shifted.segments[0].startSec).toBe(0);
    expect(shifted.segments[0].endSec).toBeCloseTo(0.9, 6);
    expect(shifted.segments[0].text).toBe("baştan taşan");
    expect(shifted.segments[0].words.every((w) => w.startSec >= 0 && w.endSec <= 0.9)).toBe(true);
    expect(shifted.subtitleRepair).toMatchObject({ shifted: 1, clipped: 1, dropped: 0 });
  });

  it("clips a tail the offset pushes past the source and drops what falls off it", () => {
    const transcript = imported(
      srtCue(1, "00:00:08,000", "00:00:09,500", "kuyruk") + "\n" + srtCue(2, "00:00:09,500", "00:00:10,000", "en son"),
      10
    );
    const shifted = shiftSubtitleTranscript(transcript, 1);
    expect(shifted.segments.map((s) => [s.id, s.startSec, s.endSec])).toEqual([[1, 9, 10]]);
    expect(shifted.segments[0].words.at(-1)?.endSec).toBe(10);
    expect(shifted.subtitleRepair).toMatchObject({ cues: 2, shifted: 1, clipped: 1, dropped: 1 });
  });

  it("treats a zero or unusable offset as no shift at all: same object, no receipt", () => {
    const transcript = imported(srtCue(1, "00:00:01,000", "00:00:02,000", "değişmez"));
    expect(shiftSubtitleTranscript(transcript, 0)).toBe(transcript);
    expect(shiftSubtitleTranscript(transcript, Number.NaN)).toBe(transcript);
    expect(shiftSubtitleTranscript(transcript, Number.POSITIVE_INFINITY)).toBe(transcript);
    expect(transcript.subtitleRepair).toBeUndefined();
  });

  it("refuses a shift that would push every cue off the source", () => {
    const transcript = imported(srtCue(1, "00:00:01,000", "00:00:02,000", "tek satır"), 10);
    expect(shiftSubtitleTranscript(transcript, -5)).toBe(transcript);
    expect(shiftSubtitleTranscript(transcript, 30)).toBe(transcript);
    expect(transcript.subtitleRepair).toBeUndefined();
  });

  it("adds a second shift onto the receipt the import repair already wrote", () => {
    const transcript = imported(
      srtCue(1, "00:00:01,000", "00:00:05,000", "ilk") + "\n" + srtCue(2, "00:00:03,500", "00:00:07,000", "ikinci")
    );
    expect(transcript.subtitleRepair).toEqual({ cues: 2, repaired: 1, dropped: 0, reordered: false });
    const twice = shiftSubtitleTranscript(shiftSubtitleTranscript(transcript, 0.5), -0.2);
    expect(twice.segments.map((s) => s.startSec)).toHaveLength(2);
    expect(twice.segments[0].startSec).toBeCloseTo(1.3, 6);
    expect(twice.segments[1].startSec).toBeCloseTo(5.3, 6);
    expect(twice.subtitleRepair).toMatchObject({ cues: 2, repaired: 1, dropped: 0, reordered: false, shifted: 4, clipped: 0 });
    expect(twice.subtitleRepair?.shiftedSec).toBeCloseTo(0.3, 6);
  });

  it("keeps Turkish dotted and dotless letters byte-for-byte through a shift", () => {
    const lines = [srtCue(1, "00:00:01,000", "00:00:02,500", "İstanbul'da ışık hüzmesi"), srtCue(2, "00:00:03,000", "00:00:04,000", "şaşırtıcı güzel")];
    const transcript = imported(lines.join("\n"));
    const shifted = shiftSubtitleTranscript(transcript, -0.5);
    expect(shifted.segments.map((s) => s.text)).toEqual(["İstanbul'da ışık hüzmesi", "şaşırtıcı güzel"]);
    expect(Array.from(shifted.segments[0].text).map((ch) => ch.codePointAt(0))).toEqual(
      Array.from("İstanbul'da ışık hüzmesi").map((ch) => ch.codePointAt(0))
    );
    expect(shifted.segments[0].text.includes("ı") && shifted.segments[0].text.includes("İ")).toBe(true);
    expect(shifted.segments.flatMap((s) => s.words.map((w) => w.text))).toEqual(transcript.segments.flatMap((s) => s.words.map((w) => w.text)));
  });
});

describe("shiftSubtitleCues", () => {
  it("shifts at cue level, clips at the source, and never touches text", () => {
    const { cues, report } = shiftSubtitleCues([cue(1, 1, 3, "ölçü"), cue(2, 4, 9.8)], 1, 10);
    expect(cues.map((c) => [c.index, c.startSec, c.endSec])).toEqual([[1, 2, 4], [2, 5, 10]]);
    expect(cues.map((c) => c.text)).toEqual(["ölçü", "line 2"]);
    expect(report).toEqual({
      cues: 2, repaired: 0, dropped: 0, reordered: false, shiftedSec: 1, shifted: 2, clipped: 1,
    });
  });

  it("is plain repair when the offset is zero", () => {
    const { cues, report } = shiftSubtitleCues([cue(1, 2, 2), cue(2, 5, 6)], 0, 10);
    expect(cues.map((c) => [c.startSec, c.endSec])).toEqual([[2, 2.7], [5, 6]]);
    expect(report).toEqual({ cues: 2, repaired: 1, dropped: 0, reordered: false });
  });
});

describe("shift receipt text", () => {
  const t = (key: string, params?: Record<string, string | number>): string => {
    if (key === "subtitleShiftedBy") return `shifted ${params?.sec}`;
    if (key === "subtitleShiftedCues") return `moved ${params?.n}`;
    if (key === "subtitleShiftClipped") return `clipped ${params?.n}`;
    return `repaired ${params?.n}`;
  };

  it("reads the shift first and the import repair after it", () => {
    expect(subtitleRepairNotice({ cues: 2, repaired: 0, dropped: 0, reordered: false, shiftedSec: -0.3, shifted: 2, clipped: 1 }, t))
      .toBe("shifted -0.30s moved 2 clipped 1");
    expect(subtitleRepairNotice({ cues: 2, repaired: 1, dropped: 0, reordered: false }, t)).toBe("repaired 1");
  });

  it("formats the offset with a signed, fixed-point number", () => {
    expect(formatSubtitleOffset(0.5)).toBe("+0.50s");
    expect(formatSubtitleOffset(-0.3)).toBe("-0.30s");
    expect(formatSubtitleOffset(0)).toBe("+0.00s");
  });
});
