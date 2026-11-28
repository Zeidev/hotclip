import { describe, it, expect } from "vitest";
import { findPeakEvents, type PeakTrack } from "../audio-peaks";
import { computeJumpCut } from "../gaps";
import { genrePauseGapSec, genreMaxShotSec, DEFAULT_PAUSE_GAP_SEC, DEFAULT_MAX_SHOT_SEC } from "../genre";
import { maxVisualGapSec, pacingPunchPoints, assessClipQa, PACING_MAX_GAP_SEC } from "../qa";
import { buildCaptionAss, minimalText, VERTICAL_LAYOUT } from "../subtitle";
import type { TranscriptWord } from "../../shared/api-types";

function w(text: string, startSec: number, endSec: number): TranscriptWord {
  return { text, startSec, endSec };
}

/** 手搓峰值轨:values 每块 1/30s,从 startSec 起。 */
function track(values: number[], startSec = 0): PeakTrack {
  return { values: Float32Array.from(values), startSec, hopSec: 1 / 30 };
}

describe("findPeakEvents(峰值事件提取)", () => {
  it("高于响度水平 75% 的块聚成事件,按持续能量从高到低排", () => {
    // 30 块静音 + 6 块大响(t=1.0s 附近) + 30 块静音 + 3 块次响(t≈2.2s)
    const values = [...Array(30).fill(0.02), 0.7, 0.9, 0.8, 0.75, 0.72, 0.7, ...Array(30).fill(0.02), 0.71, 0.7, 0.69];
    const events = findPeakEvents(track(values));
    expect(events.length).toBe(2);
    expect(events[0].peak).toBeCloseTo(0.9, 5);
    expect(events[0].atSec).toBeCloseTo(31 / 30, 3);
    expect(events[1].peak).toBeCloseTo(0.71, 5);
    // 长的那段(0.2s)能量高过短的(0.1s),顺序与旧的峰值序一致
    expect(events[0].score).toBeGreaterThan(events[1].score);
  });

  it("全程近静音返回空(没有情绪高点可言)", () => {
    expect(findPeakEvents(track(Array(60).fill(0.03)))).toHaveLength(0);
  });

  it("33ms 的一下爆点不能压过 2.5 秒的大笑(旧实现按最高块设地板,整段爆发被埋掉)", () => {
    // 2.5s 持续 0.6 的爆发 + 单独一块 0.95 的尖峰(碰麦/口水)
    // 旧地板 = 0.75 × 0.95 = 0.7125 → 爆发整段低于地板,事件表里只剩那一下
    const values = [...Array(20).fill(0.02), ...Array(75).fill(0.6), ...Array(24).fill(0.02), 0.95];
    const events = findPeakEvents(track(values));
    expect(events).toHaveLength(2);
    expect(events[0].endSec - events[0].startSec).toBeCloseTo(75 / 30, 2); // 长爆发排第一
    expect(events[0].score).toBeGreaterThan(events[1].score * 10);
    // 中心取最响那一带的重心,不是随机的某一块
    expect(events[0].atSec).toBeCloseTo((20 + 94) / 2 / 30, 2);
  });
});

describe("computeJumpCut 情绪守卫(protectedSpans)", () => {
  // 说话 10-12s,3s 静音停顿,13-15... 实为 12-15 空隙,15-17 说话
  const words = [w("铺垫", 10, 12), w("包袱", 15, 17)];

  it("待删空隙撞上禁删区间时不剪(抖包袱前的憋要留)", () => {
    const base = computeJumpCut(words, 10, 17);
    expect(base.segments.length).toBe(2); // 无守卫:静音被剪
    const guarded = computeJumpCut(words, 10, 17, {
      protectedSpans: [{ startSec: 14.0, endSec: 16.0 }], // 包袱峰 ±1s
    });
    expect(guarded.segments.length).toBe(1); // 有守卫:整段保留
    expect(guarded.removedSec).toBe(0);
  });

  it("禁删区间不影响不相交的空隙", () => {
    const guarded = computeJumpCut(words, 10, 17, {
      protectedSpans: [{ startSec: 20, endSec: 22 }],
    });
    expect(guarded.segments.length).toBe(2);
  });
});

describe("genrePauseGapSec(品类停顿分档)", () => {
  it("解说快档、对谈慢档、未知回默认", () => {
    expect(genrePauseGapSec("esports")).toBeLessThan(DEFAULT_PAUSE_GAP_SEC);
    expect(genrePauseGapSec("interview")).toBeGreaterThan(DEFAULT_PAUSE_GAP_SEC);
    expect(genrePauseGapSec("auto")).toBe(DEFAULT_PAUSE_GAP_SEC);
    expect(genrePauseGapSec(undefined)).toBe(DEFAULT_PAUSE_GAP_SEC);
    // 旧 id 走同一套归一(live-sell → shopping)
    expect(genrePauseGapSec("live-sell")).toBe(genrePauseGapSec("shopping"));
  });
});

describe("genreMaxShotSec(品类节奏目标)", () => {
  it("画面品类设上限,「把一件事说完」的品类不限", () => {
    expect(genreMaxShotSec("game")).toBeLessThanOrEqual(6);
    expect(genreMaxShotSec("pet")).toBeLessThan(genreMaxShotSec("talk")!);
    // 知识/访谈/手工的看点是信息自足,补刀会把信息切碎
    expect(genreMaxShotSec("knowledge")).toBe(Infinity);
    expect(genreMaxShotSec("interview")).toBe(Infinity);
    expect(genreMaxShotSec("craft")).toBe(Infinity);
    expect(genreMaxShotSec("auto")).toBe(Infinity);
    expect(genreMaxShotSec(undefined)).toBe(Infinity);
    expect(genreMaxShotSec("live-sell")).toBe(genreMaxShotSec("shopping"));
    expect(DEFAULT_MAX_SHOT_SEC).toBe(Infinity);
  });
});

describe("qa 节奏信号", () => {
  it("maxVisualGapSec:事件之间的最长间隔(含片头片尾)", () => {
    expect(maxVisualGapSec([], 30)).toBe(30);
    expect(maxVisualGapSec([10, 20], 30)).toBe(10);
    expect(maxVisualGapSec([3], 30)).toBe(27);
  });

  it("超过 5s 硬顶出节奏告警;不评估(null)不告警", () => {
    const base = {
      durationSec: 30,
      expectedDurationSec: 30,
      blackSpans: [],
      silenceSpans: [],
      loudness: null,
      loudnessNormalized: false,
      midWordCuts: null,
    };
    const warn = assessClipQa({ ...base, pacingGapSec: PACING_MAX_GAP_SEC + 3 });
    expect(warn.status).toBe("warn");
    expect(warn.issues.some((i) => i.includes("无视觉变化"))).toBe(true);
    expect(warn.pacingGapSec).toBe(PACING_MAX_GAP_SEC + 3);
    const pass = assessClipQa({ ...base, pacingGapSec: null });
    expect(pass.status).toBe("pass");
    expect(pass.pacingGapSec).toBeNull();
  });

  it("pacingPunchPoints:只给超长窗补点,补完每个窗都不超上限", () => {
    expect(pacingPunchPoints([], 3)).toEqual([]); // 本来就不超
    expect(pacingPunchPoints([], 5)).toEqual([]); // 恰好压线不补(判据是 > 上限)
    expect(pacingPunchPoints([], 6)).toEqual([3]); // 6 切两半
    expect(pacingPunchPoints([], 20)).toEqual([4, 8, 12, 16]); // 20 切五段,每段 4 ≤ 5
    // 只有超长的那两段被补:3→30 切六段(4.5 一段)、30→40 切三段
    expect(pacingPunchPoints([3, 30], 40)).toEqual([7.5, 12, 16.5, 21, 25.5, 33.33, 36.67]);
    // 病态输入不炸
    expect(pacingPunchPoints([], 0)).toEqual([]);
    expect(pacingPunchPoints([NaN, -3], 8)).toEqual([4]);
  });

  it("pacingPunchPoints:补完的点真的把最长静止窗压到线下", () => {
    for (const dur of [6, 12, 23.5, 60]) {
      const punched = pacingPunchPoints([], dur);
      expect(maxVisualGapSec(punched, dur)).toBeLessThanOrEqual(PACING_MAX_GAP_SEC);
    }
  });
});

describe("动态极简字幕(minimal)", () => {
  const words = [w("这个", 0, 0.4), w("方法", 0.4, 0.8), w("省", 0.8, 1.0), w("300块", 1.0, 1.5)];

  it("每块至多 1 处高亮:关键词优先,其次数字", () => {
    // 关键词命中:「方法」上色,数字不再上色
    const kw = minimalText(words, ["方法"], "#00FF00");
    expect(kw.indexOf("\\c&H00FF00&")).toBeGreaterThanOrEqual(0);
    expect(kw.split("\\c&H00FF00&").length).toBe(2); // 只出现一次高亮开启
    // 无关键词:数字 token「300块」兜底上色
    const digit = minimalText(words, [], undefined);
    expect(digit).toContain("300块");
    expect(digit.split("\\fscx108").length).toBe(2);
  });

  it("buildCaptionAss 走短块分块且不做全大写", () => {
    const latin = [w("Save", 0, 0.4), w("Money", 0.4, 0.8)];
    const ass = buildCaptionAss(latin, 0, VERTICAL_LAYOUT, "minimal", {});
    expect(ass).toContain("\\fscx96"); // 轻顶入
    expect(ass).toContain("Save"); // 不像 hormozi 那样 SAVE 全大写
    expect(ass).not.toContain("SAVE");
  });

  it("minimal 风格描边更细、带软阴影(样式行)", () => {
    const ass = buildCaptionAss(words, 0, VERTICAL_LAYOUT, "minimal", {});
    const styleLine = ass.split("\n").find((l) => l.startsWith("Style: Caption"))!;
    const cols = styleLine.split(",");
    // Outline 列 = 2(VERTICAL_LAYOUT.outline 4 - 2),Shadow 列 = 1
    expect(Number(cols[16])).toBe(2);
    expect(Number(cols[17])).toBe(1);
  });
});
