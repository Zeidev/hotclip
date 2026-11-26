import { describe, expect, it } from "vitest";
import {
  describeSubtitleImportError,
  parseSubtitleTranscript,
  SUBTITLE_IMPORT_MAX_BYTES,
  subtitleImportError,
} from "../subtitle-import";
import { summarizeTimingQuality } from "../transcript-quality";
import { editSegmentText, tokenizeForWords } from "../edit-transcript";

const srt = (body = "Hello world", start = "00:00:01,250", end = "00:00:03,750") => `1\n${start} --> ${end}\n${body}\n`;

/**
 * 实测(2026-11-26,用户 Downloads 目录):两份导出文件都叫 `.srt`、扩展名与
 * 「选一个 SRT/VTT」的提示都对,内容却是行首时间码的文稿:
 *
 *     [00:20] Ah
 *     [01:39] >> Ay!
 *     [01:00:02] Pinage kimdir?
 *
 * 整份文件一个 `-->` 都没有(1,984 行、0 个箭头、0 个空行)。旧行为是在第一块
 * 上抛 `cue:1`,界面显示「字幕段落为空或格式有误……第 1 段」——用户去找一个
 * 根本不存在的坏段落,而真正的问题是「这不是字幕轨」。现在这类文件单独报
 * `timestamps`,并且**不带段号**(cue 0),因为没有任何一段是坏的。
 */
describe("timestamped transcript lists are named, not blamed on a cue", () => {
  const list = [
    "[00:20] Ah",
    "[00:39] >>",
    "[00:50] >> Ah.",
    "[01:02] Ah.",
    "[01:00:02] Pinage kimdir?",
  ].join("\n");

  it("rejects a real-world [MM:SS] transcript export with its own code and no cue number", () => {
    expect(() => parseSubtitleTranscript(list, "srt", 600)).toThrow("subtitle-import:timestamps:0");
    // 同一条路径在导入入口(repair 打开)上也是同一个错误:修复不是「整份文件不是字幕」的解药
    expect(() => parseSubtitleTranscript(list, "srt", 600, { repair: true })).toThrow("subtitle-import:timestamps:0");
    expect(subtitleImportError(new Error("subtitle-import:timestamps:0"))).toEqual({ code: "timestamps", cue: 0 });
    // cue 0 时界面不追加「第 1 段」——没有哪一段是坏的
    expect(describeSubtitleImportError(new Error("subtitle-import:timestamps:0"))).not.toContain("Cue");
  });

  it("detects it with or without blank lines between entries", () => {
    const spaced = list.split("\n").join("\n\n");
    expect(() => parseSubtitleTranscript(spaced, "srt", 600)).toThrow("timestamps");
    // 方括号可省:有的导出直接写「00:20 metin」
    expect(() => parseSubtitleTranscript(list.replace(/[\[\]]/g, ""), "srt", 600)).toThrow("timestamps");
  });

  it("still reports a malformed cue as a cue, and a header-less VTT as a format problem", () => {
    // 箭头在、cue 行不是段号 → 仍然是坏的段落,不是文稿
    expect(() => parseSubtitleTranscript("x\n00:00:01,000 --> 00:00:02,000\nhi", "srt", 8)).toThrow("cue:1");
    // 只有一两行时间码的残文件不足以断言「这是文稿」,按原有口径报坏段落
    expect(() => parseSubtitleTranscript("[00:20] Ah\n[00:39] >>", "srt", 600)).toThrow("cue:1");
    // VTT 先查头:没有 WEBVTT 就是格式问题,不该被当成文稿
    expect(() => parseSubtitleTranscript(list, "vtt", 600)).toThrow("format:0");
    // 真正的 SRT 一个字都不受影响
    expect(parseSubtitleTranscript(srt(), "srt", 8).segments).toHaveLength(1);
  });
});

describe("subtitle transcript interchange", () => {
  it("preserves BOM/CRLF cue boundaries and marks every word as estimated", () => {
    const transcript = parseSubtitleTranscript(`\uFEFF${srt("你好，world!").replace(/\n/g, "\r\n")}`, "srt", 8);
    expect(transcript).toMatchObject({ engine: "subtitle-srt", language: "auto", durationSec: 8 });
    const segment = transcript.segments[0];
    expect(segment).toMatchObject({ id: 1, startSec: 1.25, endSec: 3.75, text: "你好，world!" });
    expect(segment.words.map((word) => word.text)).toEqual(["你", "好，", "world!"]);
    expect(segment.words[0].startSec).toBe(1.25);
    expect(segment.words.at(-1)?.endSec).toBe(3.75);
    expect(summarizeTimingQuality(segment.words).uncertainWords).toBe(3);
    expect(segment.words.every((word) => word.timingSource === "estimated")).toBe(true);
  });

  it("imports long-hour SRT, optional indices and multiline payloads", () => {
    const transcript = parseSubtitleTranscript("26:00:01.000 --> 26:00:02.500\nFirst line\nsecond line", "srt", 100_000);
    expect(transcript.segments[0]).toMatchObject({ startSec: 93601, endSec: 93602.5, text: "First line second line" });
  });

  it("handles VTT headers, cue identifiers, settings, comments, regions and presentation tags", () => {
    const text = `WEBVTT - interview\nKind: captions\n\nNOTE an annotation\nnot spoken\n\nSTYLE\n::cue { color: lime; }\n\nREGION\nid:foo\n\nfirst\n00:01.000 --> 00:03.000 align:start position:10%\n<v Guest><c.green>Hello</c> <00:02.000><i>world</i></v>\n\n00:00:04.000 --> 00:00:06.000\n<ruby>字<rt>zi</rt></ruby> &amp; &#x1F408; &lt;tag&gt;`;
    const transcript = parseSubtitleTranscript(text, "vtt", 8);
    expect(transcript.segments.map((segment) => segment.text)).toEqual(["Hello world", "字 & 🐈 <tag>"]);
    expect(transcript.segments[0].speaker).toBeUndefined(); // names are not diarization evidence
    expect(transcript.engine).toBe("subtitle-vtt");
    expect(transcript.segments.flatMap((segment) => segment.words).every((word) => word.timingSource === "estimated")).toBe(true);
  });

  it("keeps encoded tags as plain text and strips SRT styling without executing markup", () => {
    const transcript = parseSubtitleTranscript(srt('{\\an8}<font color="red">2 &lt; 3</font><br>Tom &amp; Jerry &#39;yes&#39;'), "srt", 8);
    expect(transcript.segments[0].text).toBe("2 < 3 Tom & Jerry 'yes'");
  });

  it("preserves multilingual word units and combining marks during import and correction", () => {
    const text = "café mañana déjà nai\u0308ve Привет مرحبا";
    expect(tokenizeForWords(text)).toEqual(text.split(" "));
    const transcript = parseSubtitleTranscript(srt(text), "srt", 8);
    expect(transcript.segments[0].words.map((word) => word.text)).toEqual(text.split(" "));
    const edited = editSegmentText(transcript, 1, "café завтра");
    expect(edited.segments[0].words.map((word) => word.text)).toEqual(["café", "завтра"]);
    expect(edited.segments[0].words.every((word) => word.timingSource === "edited")).toBe(true);
    expect(transcript.segments[0].text).toBe(text);
  });

  it.each([
    ["", "empty"],
    ["not a subtitle", "cue"],
    [srt("", "00:00:01,000", "00:00:02,000"), "cue"],
    [srt("<b></b>"), "cue"],
    [srt("test", "00:60:00,000"), "cue"],
    [srt("test", "-00:00:01,000"), "cue"],
    [srt("test", "00:00:03,750"), "cue"],
    [srt("test", "00:00:04,000"), "cue"],
    [srt("test", "00:00:01,250", "00:00:09,000"), "range"],
    [srt("test\u0000"), "encoding"],
    [srt("test\uFFFD"), "encoding"],
    [srt("x") + srt("y"), "cue"],
    [srt("x") + "\n" + srt("y"), "overlap"],
    [srt("字".repeat(8001)), "limit"],
    ["x".repeat(SUBTITLE_IMPORT_MAX_BYTES + 1), "size"],
    ["字".repeat(Math.ceil(SUBTITLE_IMPORT_MAX_BYTES / 3)), "size"],
  ])("rejects invalid SRT input (%#) without a partial transcript", (text, code) => {
    expect(() => parseSubtitleTranscript(text, "srt", 8)).toThrow(`subtitle-import:${code}:`);
  });

  it("rejects backwards ordering and permits exactly touching cues", () => {
    expect(() => parseSubtitleTranscript(srt() + "\n" + srt("back", "00:00:00,000", "00:00:01,000"), "srt", 8)).toThrow("overlap:2");
    const t = parseSubtitleTranscript(srt() + "\n" + srt("next", "00:00:03,750", "00:00:08,000"), "srt", 8);
    expect(t.segments).toHaveLength(2);
    expect(t.segments[1].endSec).toBe(8);
  });

  it("rejects VTT clock mappings and a missing header", () => {
    expect(() => parseSubtitleTranscript("00:01.000 --> 00:02.000\nhi", "vtt", 8)).toThrow("format");
    expect(() => parseSubtitleTranscript("WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:900000\n\n00:01.000 --> 00:02.000\nhi", "vtt", 8)).toThrow("mapped");
    expect(() => parseSubtitleTranscript("WEBVTT\n00:01.000 --> 00:02.000\nhi", "vtt", 8)).toThrow("cue");
    expect(() => parseSubtitleTranscript("WEBVTT\n\nNOTE no captions", "vtt", 8)).toThrow("empty");
  });

  it("requires a finite positive source duration", () => {
    for (const duration of [0, -1, NaN, Infinity]) {
      expect(() => parseSubtitleTranscript(srt(), "srt", duration)).toThrow("range");
    }
  });

  it("recovers actionable cue errors through IPC wrappers", () => {
    expect(subtitleImportError(new Error("Error invoking remote method: Error: subtitle-import:overlap:12"))).toEqual({ code: "overlap", cue: 12 });
    expect(subtitleImportError(new Error("unrelated"))).toBeNull();
  });
});
