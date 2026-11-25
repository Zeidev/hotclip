/**
 * Türkçe/拉丁文断行与阅读速度校准:行尾不落在连词/介词上、土耳其特殊字符
 * 不被破坏、CJK 路径逐字不变、CPS 预算按语言取(纯函数,零 FFmpeg)。
 */
import { describe, expect, it } from "vitest";
import type { TranscriptWord } from "../../shared/api-types";
import {
  captionReadingCps,
  groupWordsIntoLines,
  planReadableCaptions,
  VERTICAL_LAYOUT,
} from "../subtitle";
import { lintSubtitleTimeline, subtitleMaxCps } from "../subtitle-quality";

/** 词表:逐词均分时间轴(词序 = 语序)。 */
function words(texts: readonly string[], perWordSec = 0.3): TranscriptWord[] {
  return texts.map((text, i) => ({
    text,
    startSec: i * perWordSec,
    endSec: (i + 1) * perWordSec,
  }));
}

const linesOf = (grouped: TranscriptWord[][]): string[] => grouped.map((line) => line.map((w) => w.text).join(" "));
const lastWords = (grouped: TranscriptWord[][]): string[] => grouped.map((line) => line[line.length - 1].text);
const unbroken = (grouped: TranscriptWord[][]): string[] => grouped.flat().map((w) => w.text);

const TR_SENTENCE = ["bu", "akşam", "sinemaya", "gidiyoruz", "ve", "yarın", "sabah", "erken", "kalkacağız"];

describe("groupWordsIntoLines 拉丁文行尾规则", () => {
  it("TR 长句断行不让行尾落在连词上,默认路径逐字不变", () => {
    const tr = words(TR_SENTENCE);
    const grouped = groupWordsIntoLines(tr, 12, [], "tr");
    expect(linesOf(grouped)).toEqual(["bu akşam", "sinemaya", "gidiyoruz", "ve yarın sabah", "erken", "kalkacağız"]);
    expect(lastWords(grouped)).not.toContain("ve");
    // 词序不动、词不拆:拼回去就是原句
    expect(unbroken(grouped)).toEqual(TR_SENTENCE);
    // 同一句不给语言 = 老口径(仍会断在「ve」)——证明默认路径没被改动
    const plain = groupWordsIntoLines(tr, 12);
    expect(lastWords(plain)).toContain("ve");
    expect(groupWordsIntoLines(tr, 12, [], "zh")).toEqual(plain);
  });

  it("大写/点标变体也算禁忌词(İLE → ile),带点字符原样保留", () => {
    const tr = words(["kahveyi", "İLE", "arkadaş", "içtik"]);
    const grouped = groupWordsIntoLines(tr, 12, [], "tr");
    expect(lastWords(grouped)).not.toContain("İLE");
    expect(unbroken(grouped)).toContain("İLE"); // 只在断行位置移动,文本零改写
    expect(unbroken(grouped)).toEqual(["kahveyi", "İLE", "arkadaş", "içtik"]);
  });

  it("退行会把连词单独晾成一行时不退(退回宽度切)", () => {
    // 进来的词比一行还宽:退掉 ve 只会让它独占一行,不如留在行尾
    const tr = words(["kahveyi", "ve", "arkadaşlarımızla"]);
    const grouped = groupWordsIntoLines(tr, 10, [], "tr");
    expect(linesOf(grouped)[0]).toBe("kahveyi ve");
    expect(unbroken(grouped)).toEqual(["kahveyi", "ve", "arkadaşlarımızla"]);
  });

  it("en 行尾同样避开冠词/介词", () => {
    const en = words(["I", "recorded", "the", "whole", "session", "yesterday"]);
    const grouped = groupWordsIntoLines(en, 14, [], "en");
    expect(lastWords(grouped)).not.toContain("the");
    expect(unbroken(grouped)).toEqual(["I", "recorded", "the", "whole", "session", "yesterday"]);
  });

  it("土耳其特殊字符在断行后逐字不变", () => {
    const tr = words(["ığüşöç", "İĞÜŞÖÇ", "çalışıyoruz", "güzel", "değil", "mi", "acaba"]);
    const grouped = groupWordsIntoLines(tr, 14, [], "tr");
    expect(unbroken(grouped)).toEqual(["ığüşöç", "İĞÜŞÖÇ", "çalışıyoruz", "güzel", "değil", "mi", "acaba"]);
    for (const line of grouped) {
      const text = line.map((w) => w.text).join("");
      expect(text.replace(/[\s]/g, "")).toMatch(/^[ıİğĞüÜşŞöÖçÇa-zA-Z]+$/);
    }
  });

  it("CJK 输出与语言参数无关(zh/缺省/tr 全等)", () => {
    const cjk = Array.from("你好世界再说了吧").map((ch, i) => ({ text: ch, startSec: i * 0.3, endSec: (i + 1) * 0.3 }));
    const plain = groupWordsIntoLines(cjk, 4);
    expect(groupWordsIntoLines(cjk, 4, [], "zh")).toEqual(plain);
    expect(groupWordsIntoLines(cjk, 4, [], "en")).toEqual(plain);
    expect(groupWordsIntoLines(cjk, 4, [], "tr")).toEqual(plain);
    expect(plain.map((line) => line.map((w) => w.text).join(""))).toEqual(["你好", "世界", "再说", "了吧"]);
  });

  it("行内混入汉字时仍用中文粒子回退", () => {
    const mixed = words(["喝茶", "的", "好处", "很多", "ve", "bu"]);
    expect(groupWordsIntoLines(mixed, 6, [], "tr")).toEqual(groupWordsIntoLines(mixed, 6));
  });
});

describe("语言化 CPS 预算", () => {
  it("拉丁文 17 CPS,缺省与 zh 保持 20", () => {
    expect(captionReadingCps("hello")).toBe(20);
    expect(captionReadingCps("hello", "zh")).toBe(20);
    expect(captionReadingCps("hello", "tr")).toBe(17);
    expect(captionReadingCps("hello", "en")).toBe(17);
    // 脚本优先:TR 项目里的中文行仍用中文预算
    expect(captionReadingCps("你好", "tr")).toBe(9);
    expect(subtitleMaxCps()).toBe(20);
    expect(subtitleMaxCps("zh")).toBe(20);
    expect(subtitleMaxCps("tr")).toBe(17);
  });

  it("readability 计划的每行预算跟着语言走", () => {
    const tr = words(Array.from({ length: 9 }, () => "sözcük"), 1 / 3);
    expect(planReadableCaptions(tr, 200, [], Infinity)[0].maxCps).toBe(20);
    expect(planReadableCaptions(tr, 200, [], Infinity, "tr")[0].maxCps).toBe(17);
  });

  it("18 CPS 的 TR 行:TR 预算报警,默认预算不报", () => {
    const wide = { ...VERTICAL_LAYOUT, maxLineUnits: 200 };
    const tr = words(Array.from({ length: 9 }, () => "sözcük"), 1 / 3); // 54 字 / 3s = 18 CPS
    const trReport = lintSubtitleTimeline(tr, wide, "karaoke", [], [], { lang: "tr" });
    expect(trReport.maxCps).toBe(18);
    expect(trReport.issues.some((issue) => issue.code === "reading-speed")).toBe(true);
    const defaultReport = lintSubtitleTimeline(tr, wide, "karaoke", [], [], {});
    expect(defaultReport.issues.some((issue) => issue.code === "reading-speed")).toBe(false);
    // 中文口径不变:同一句当作 zh 也不报
    const zhReport = lintSubtitleTimeline(tr, wide, "karaoke", [], [], { lang: "zh" });
    expect(zhReport.issues.some((issue) => issue.code === "reading-speed")).toBe(false);
  });
});
