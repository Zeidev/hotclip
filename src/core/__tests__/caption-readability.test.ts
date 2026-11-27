import { describe, expect, it } from "vitest";
import {
  buildCaptionAss,
  captionReadableChars,
  captionReadingCps,
  groupWordsIntoLines,
  lineWidthUnits,
  planReadableCaptions,
  VERTICAL_LAYOUT,
  widthUnits,
} from "../subtitle";
import { buildOverlayPayload } from "../caption-overlay/payload";
import { srtLinesFromWords } from "../srt";
import { lintSubtitleTimeline } from "../subtitle-quality";

describe("language-aware caption display", () => {
  it("uses graphemes and script-specific reading defaults", () => {
    expect(captionReadableChars("cafe\u0301")).toBe(4);
    expect(captionReadingCps("你好")).toBe(9);
    expect(captionReadingCps("こんにちは")).toBe(7);
    expect(captionReadingCps("안녕")).toBe(12);
    expect(captionReadingCps("hello")).toBe(20);
  });
  it("extends short display only into available space; original word timings stay unchanged", () => {
    const words = [{ text: "你好", startSec: 0, endSec: 0.2, timingSource: "native" as const }];
    const before = JSON.stringify(words);
    const plan = planReadableCaptions(words, 22, [], 0.9);
    expect(plan[0].endSec).toBeCloseTo(0.7);
    expect(JSON.stringify(words)).toBe(before);
    expect(planReadableCaptions(words, 22, [0.4], 0.9)[0].endSec).toBe(0.4);
    expect(planReadableCaptions(words, 22, [], 0.3)[0].endSec).toBe(0.3);
  });
  it("merges readable short lines but respects splices and speaker changes", () => {
    const words = [{ text: "好！", startSec: 0, endSec: 0.2, speaker: 0 }, { text: "走吧。", startSec: 0.25, endSec: 0.6, speaker: 0 }];
    expect(planReadableCaptions(words, 22, [], 1)).toHaveLength(1);
    expect(planReadableCaptions(words, 22, [0.23], 1)).toHaveLength(2);
    expect(planReadableCaptions([words[0], { ...words[1], speaker: 1 }], 22, [], 1)).toHaveLength(2);
  });
  it("ASS, overlay, SRT and quality checks share the effective display duration", () => {
    const words = [{ text: "Hello", startSec: 0, endSec: 0.1, timingSource: "native" as const }];
    const options = { readability: true, endSec: 1 };
    const ass = buildCaptionAss(words, 0, VERTICAL_LAYOUT, "karaoke", options);
    expect(ass).toContain("0:00:00.70");
    expect(ass).toContain("\\k10");
    expect(buildOverlayPayload(words, VERTICAL_LAYOUT, options).lines[0].endMs).toBe(700);
    expect(srtLinesFromWords(words, [], [], options)[0].endSec).toBeCloseTo(0.7);
    expect(lintSubtitleTimeline(words, VERTICAL_LAYOUT, "karaoke", [], [], options).status).toBe("pass");
  });
});

/**
 * 断行口径(踩过的坑):渲染出来的一行 = 词宽 + 词间空格 + 关键词高亮的 108% 放大。
 * 只数词宽,拉丁行少算近 20%,行尾顶出画面;关键词放大又再加 8%。
 */
describe("caption line width accounting", () => {
  const w = (text: string, startSec: number, endSec: number) => ({ text, startSec, endSec });

  it("counts the spaces the renderer inserts between latin words", () => {
    const line = [w("Merhaba", 0, 0.2), w("dünya", 0.25, 0.5)];
    const raw = line.reduce((sum, word) => sum + widthUnits(word.text), 0);
    expect(raw).toBe(12);
    expect(lineWidthUnits(line)).toBe(13);
    // CJK gets no inserted space, so the accounting is unchanged there.
    expect(lineWidthUnits([w("你好", 0, 0.2), w("世界", 0.25, 0.5)])).toBe(8);
  });

  it("breaks a latin line that only overflows once its spaces are counted", () => {
    const words = [w("aaaaaaa", 0, 0.2), w("bbbbbbb", 0.25, 0.4), w("ccccccc", 0.45, 0.6)];
    // Raw word widths: 7 + 7 + 7 = 21, which fits 22 on paper.
    expect(groupWordsIntoLines(words, 22, [], "en")).toHaveLength(2);
    // 7 + space + 7 + space + 7 = 23 is what the renderer actually draws, so it
    // only stays one line when the cap is that wide.
    expect(groupWordsIntoLines(words, 23, [], "en")).toHaveLength(1);
  });

  it("counts a keyword-highlighted word at its rendered 108% size", () => {
    const words = [w("aaaaaaa", 0, 0.2), w("ccccccc", 0.25, 0.5)];
    expect(lineWidthUnits(words)).toBe(15);
    expect(lineWidthUnits(words, ["ccccccc"])).toBeCloseTo(15.56, 2);
    // What fits by raw width no longer fits once the highlight grows the glyphs.
    expect(groupWordsIntoLines(words, 15, [], "en")).toHaveLength(1);
    expect(groupWordsIntoLines(words, 15, [], "en", ["ccccccc"])).toHaveLength(2);
  });

  it("keeps the merge step honest about both", () => {
    const words = [w("aaaaaaa", 0, 0.2), w("ccccccc", 0.25, 0.5)];
    // Two short neighboring lines merge back into one when 7+1+7 fits the cap.
    expect(planReadableCaptions(words, 15, [], Infinity, "en")).toHaveLength(1);
    // Highlighted, the merged line renders at 15.56 and stays two lines.
    expect(planReadableCaptions(words, 15, [], Infinity, "en", ["ccccccc"])).toHaveLength(2);
  });
});
