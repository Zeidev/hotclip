import { describe, it, expect } from "vitest";
import {
  frameChangeFraction,
  createFrameDiffMeter,
  cutFrameChanges,
  shotIntervals,
  shotRhythm,
  longestStaticSec,
  computeEditMetrics,
  FRAME_PIXEL_DELTA,
  INVISIBLE_CUT_FRACTION,
  METRONOME_CV,
} from "../edit-metrics";
import { assessClipQa } from "../qa";

/** 造一帧:value 填充。 */
function frame(n: number, value: number): Uint8Array {
  return new Uint8Array(n).fill(value);
}

describe("frameChangeFraction(相邻帧变化像素占比)", () => {
  it("完全一样 = 0;全体 +50 = 1;一半 = 0.5", () => {
    const a = frame(100, 100);
    expect(frameChangeFraction(a, frame(100, 100))).toBe(0);
    expect(frameChangeFraction(a, frame(100, 150))).toBe(1);
    const half = frame(100, 100);
    half.fill(150, 0, 50);
    expect(frameChangeFraction(a, half)).toBe(0.5);
  });

  it("阈值本身算「没变」:差 8 = 0,差 9 = 1(静止画面的颗粒噪声不该算剪切)", () => {
    const a = frame(10, 40);
    expect(frameChangeFraction(a, frame(10, 40 + FRAME_PIXEL_DELTA))).toBe(0);
    expect(frameChangeFraction(a, frame(10, 40 + FRAME_PIXEL_DELTA + 1))).toBe(1);
  });

  it("尺寸不一致按短的算,空的返回 0(病态输入不炸)", () => {
    expect(frameChangeFraction(new Uint8Array(0), new Uint8Array(0))).toBe(0);
    expect(frameChangeFraction(frame(10, 0), frame(5, 0))).toBe(0);
  });
});

describe("createFrameDiffMeter(管道块 → 逐帧差分)", () => {
  const FB = 4; // 每帧 4 字节,便于手算
  const f0 = new Uint8Array([0, 0, 0, 0]);
  const f1 = new Uint8Array([255, 0, 0, 0]); // 1/4 像素变了
  const f2 = new Uint8Array([255, 255, 0, 0]);

  it("一次喂三帧 → 两处差分", () => {
    const m = createFrameDiffMeter(FB);
    const merged = new Uint8Array([...f0, ...f1, ...f2]);
    expect(m.push(merged)).toEqual([0.25, 0.25]);
  });

  it("切块边界怎么切,结果都一样(半帧跨块也接得上)", () => {
    const ref = createFrameDiffMeter(FB).push(new Uint8Array([...f0, ...f1, ...f2]));
    const merged = new Uint8Array([...f0, ...f1, ...f2]);
    // 逐字节喂(最坏的切法:每帧都跨 3 个块)
    const byte = createFrameDiffMeter(FB);
    const byteOut: number[] = [];
    for (const b of merged) byteOut.push(...byte.push(new Uint8Array([b])));
    expect(byteOut).toEqual(ref);
    // 三块不整齐的切法
    const chunked = createFrameDiffMeter(FB);
    const chunkedOut: number[] = [];
    for (const [from, to] of [
      [0, 3],
      [3, 9],
      [9, 12],
    ])
      chunkedOut.push(...chunked.push(merged.slice(from, to)));
    expect(chunkedOut).toEqual(ref);
  });

  it("帧没凑齐不吐差分,补齐后照常吐", () => {
    const m = createFrameDiffMeter(FB);
    expect(m.push(new Uint8Array([...f0, 10, 20]))).toEqual([]); // 第二帧只到一半
    expect(m.push(new Uint8Array([30, 40]))).toEqual([1]); // 补齐 = [10,20,30,40],四个像素都变了
  });
});

describe("cutFrameChanges(切点画面变化)", () => {
  it("按帧网格取相邻两处差分里的较大者", () => {
    const diffs = Array(120).fill(0.01);
    diffs[60] = 0.3; // 切在 2.0s → k=60
    const out = cutFrameChanges(diffs, 30, [2]);
    expect(out).toEqual([{ atSec: 2, change: 0.3 }]);
    // 计划时刻偏半帧:落在 k=61 上,仍取到相邻的 0.3
    expect(cutFrameChanges(diffs, 30, [2.02])[0].change).toBe(0.3);
  });

  it("同一帧网格上的重复切点只算一次;0/负数/NaN 与越界的丢掉", () => {
    const diffs = Array(60).fill(0.01);
    diffs[30] = 0.5;
    expect(cutFrameChanges(diffs, 30, [1, 1.001, 0, -2, NaN, 99])).toEqual([{ atSec: 1, change: 0.5 }]);
  });

  it("帧率为 0 或没有帧流 → 空", () => {
    expect(cutFrameChanges([0.1], 0, [0.5])).toEqual([]);
    expect(cutFrameChanges([], 30, [1])).toEqual([]);
  });
});

describe("shotIntervals / shotRhythm(镜头节奏)", () => {
  it("切点划段,片头片尾算天然切点;乱序输入也排好", () => {
    expect(shotIntervals([1.5, 0.5], 3)).toEqual([0.5, 1, 1.5]);
    expect(shotIntervals([], 4)).toEqual([4]);
    expect(shotIntervals([0, 4, 9], 4)).toEqual([4]); // 越界的（0/片尾/超出）不算
    expect(shotIntervals([1], 0)).toEqual([]);
  });

  it("一样长 = cv 0(节拍器);长短交替 = cv 大", () => {
    expect(shotRhythm([2, 2, 2, 2]).cv).toBe(0);
    expect(shotRhythm([2, 2, 2, 2]).longestShotSec).toBe(2);
    const varied = shotRhythm([1, 4, 1, 4]);
    expect(varied.cv).toBeGreaterThan(METRONOME_CV);
    expect(varied.longestShotSec).toBe(4);
  });

  it("镜头少于 3 段不谈节奏(cv = null),最长镜头照样给", () => {
    expect(shotRhythm([3]).cv).toBeNull();
    expect(shotRhythm([1, 5]).cv).toBeNull();
    expect(shotRhythm([1, 5]).longestShotSec).toBe(5);
    expect(shotRhythm([])).toEqual({ longestShotSec: 0, cv: null });
  });
});

describe("longestStaticSec(最长近静止画面)", () => {
  it("连续 k 个低变化帧间 = 跨 k+1 帧", () => {
    const diffs = [...Array(10).fill(0.1), ...Array(90).fill(0.001), ...Array(10).fill(0.1)];
    expect(longestStaticSec(diffs, 30)).toBeCloseTo(91 / 30, 2);
  });

  it("没有静止段 → 0;帧率缺失 → 0", () => {
    expect(longestStaticSec(Array(50).fill(0.5), 30)).toBe(0);
    expect(longestStaticSec(Array(50).fill(0.001), 0)).toBe(0);
  });
});

describe("computeEditMetrics(组装)", () => {
  const fps = 30;
  const durationSec = 10;
  const diffs = Array(Math.round(durationSec * fps) - 1).fill(0.02);
  for (const t of [2, 4, 6]) diffs[Math.round(t * fps)] = 0.3;

  it("真实剪切看得见:minCutChange 取最弱的一刀,没有隐形的", () => {
    const m = computeEditMetrics({ frameDiffs: diffs, fps, cutTimesSec: [2, 4, 6], durationSec });
    expect(m.cuts).toBe(3);
    expect(m.minCutChange).toBeCloseTo(0.3, 5);
    expect(m.invisibleCuts).toBe(0);
    expect(m.minCutChange!).toBeGreaterThan(INVISIBLE_CUT_FRACTION);
  });

  it("画面没变的切点记进 invisibleCuts(剪了等于没剪)", () => {
    const muted = [...diffs];
    // 4s 那刀的画面没动:取窗口内三处接缝都要低(切点时刻有 ±1 帧误差)
    for (const k of [Math.round(4 * fps) - 1, Math.round(4 * fps), Math.round(4 * fps) + 1]) muted[k] = 0.001;
    const m = computeEditMetrics({ frameDiffs: muted, fps, cutTimesSec: [2, 4, 6], durationSec });
    expect(m.invisibleCuts).toBe(1);
    expect(m.minCutChange).toBeCloseTo(0.001, 5);
  });

  it("没有切点也照样给最长静止窗与镜头时长;帧率为 0 时画面那半边留空", () => {
    const m = computeEditMetrics({ frameDiffs: Array(299).fill(0.001), fps, cutTimesSec: [], durationSec });
    expect(m.cuts).toBe(0);
    expect(m.minCutChange).toBeNull();
    expect(m.longestShotSec).toBe(durationSec);
    expect(m.longestStaticSec).toBeCloseTo(durationSec, 1);
    const noFps = computeEditMetrics({ frameDiffs: diffs, fps: 0, cutTimesSec: [2, 4, 6], durationSec });
    expect(noFps.cuts).toBe(0);
    expect(noFps.longestStaticSec).toBe(0);
    expect(noFps.longestShotSec).toBe(4); // 2/4/6 划段:2,2,2,4 —— 镜头节奏不依赖帧流
  });
});

describe("assessClipQa × 剪辑度量", () => {
  const base = {
    durationSec: 10,
    expectedDurationSec: 10,
    blackSpans: [],
    silenceSpans: [],
    loudness: null,
    loudnessNormalized: false,
    midWordCuts: null,
  };

  it("隐形切点与节拍器节奏进告警;干净报告不告警", () => {
    const warn = assessClipQa({
      ...base,
      editMetrics: {
        cuts: 6,
        minCutChange: 0.002,
        invisibleCuts: 2,
        longestShotSec: 2,
        cv: 0.02,
        longestStaticSec: 1,
      },
    });
    expect(warn.status).toBe("warn");
    expect(warn.issues[0]).toContain("几乎没变");
    expect(warn.issues[1]).toContain("节拍器");
    expect(warn.edit?.invisibleCuts).toBe(2);
    const pass = assessClipQa({
      ...base,
      editMetrics: { cuts: 6, minCutChange: 0.2, invisibleCuts: 0, longestShotSec: 3, cv: 0.4, longestStaticSec: 1 },
    });
    expect(pass.status).toBe("pass");
  });

  it("告警句式跟随界面语言(en/tr 各自的措辞,不互抄)", () => {
    const editMetrics = {
      cuts: 3,
      minCutChange: 0.001,
      invisibleCuts: 1,
      longestShotSec: 5,
      cv: null,
      longestStaticSec: 2,
    };
    expect(assessClipQa({ ...base, editMetrics, lang: "en" }).issues[0]).toContain("barely changes");
    // 土耳其语百分比用逗号小数(0,1)
    expect(assessClipQa({ ...base, editMetrics, lang: "tr" }).issues[0]).toContain("%0,1");
  });

  it("没量(editMetrics 缺省)→ 不告警,报告里为 null(老回执逐字节不变)", () => {
    const r = assessClipQa(base);
    expect(r.issues).toEqual([]);
    expect(r.edit).toBeNull();
  });
});