import { describe, expect, it } from "vitest";
import { peaksFromPcm, peakInRange, mapPeakEvents, type PeakTrack } from "../audio-peaks";
import { mapToOutputTime } from "../reframe";

describe("peaksFromPcm", () => {
  it("folds each block to its max |sample| normalised to 0..1", () => {
    const pcm = new Int16Array([0, 100, -3277, 50, 0, 0, 16384, -20, 0, 0]);
    const peaks = peaksFromPcm(pcm, 5);
    expect(peaks.length).toBe(2);
    expect(peaks[0]).toBeCloseTo(3277 / 32768, 5);
    expect(peaks[1]).toBeCloseTo(16384 / 32768, 5);
  });

  it("keeps fractional block boundaries aligned via error accumulation", () => {
    // 16000 Hz at 30 blocks/s -> 533.33 samples per block; over 3s the block
    // count must be exact (90), not drift to 89 or 91.
    const pcm = new Int16Array(16000 * 3);
    const peaks = peaksFromPcm(pcm, 16000 / 30);
    expect(peaks.length).toBe(90);
  });

  it("handles empty input", () => {
    expect(peaksFromPcm(new Int16Array(0), 5).length).toBe(0);
  });
});

describe("peakInRange", () => {
  const track: PeakTrack = {
    values: Float32Array.from([0.01, 0.02, 0.5, 0.02, 0.01]),
    startSec: 10,
    hopSec: 1,
  };

  it("returns the max peak inside the window", () => {
    expect(peakInRange(track, 11.5, 13.5)).toBeCloseTo(0.5);
  });

  it("stays quiet when the window avoids the burst", () => {
    expect(peakInRange(track, 10, 10.9)).toBeLessThan(0.05);
  });

  it("returns 0 (no evidence) for windows fully outside the track", () => {
    expect(peakInRange(track, 0, 5)).toBe(0);
    expect(peakInRange(track, 100, 200)).toBe(0);
  });

  it("clamps partially overlapping windows to the track bounds", () => {
    expect(peakInRange(track, 8, 10.5)).toBeCloseTo(0.02, 4); // start clamp; ceil reaches block 1
    expect(peakInRange(track, 14.5, 100)).toBeCloseTo(0.01, 4); // end clamp
  });
});

describe("mapPeakEvents", () => {
  // 跳剪片:保留 [100,104] + [108,112],106 前后那段被剪掉
  const segments = [
    { startSec: 100, endSec: 104 },
    { startSec: 108, endSec: 112 },
  ];
  // 峰值轨是绝对源时间:第一块就在 100s(切片起点),hop 0.5s
  const values = new Float32Array(24);
  values[4] = 0.8; // 102s — 段内,切片开头 2s
  values[12] = 0.7; // 106s — 落在被剪掉的空隙里
  values[20] = 0.65; // 110s — 第二段内(输出 6s)
  const track: PeakTrack = { values, startSec: 100, hopSec: 0.5 };

  it("源时间(绝对)按保留段映射成输出时间,空隙里的峰被丢掉", () => {
    expect(mapPeakEvents(track, segments, 100, 8)).toEqual([
      { srcSec: 102, outSec: 2 },
      { srcSec: 110, outSec: 6 },
    ]);
  });

  it("没有跳剪(plan 为空)时输出时间就是切片相对时间", () => {
    expect(mapPeakEvents(track, null, 100, 12)).toEqual([
      { srcSec: 102, outSec: 2 },
      { srcSec: 106, outSec: 6 },
      { srcSec: 110, outSec: 10 },
    ]);
  });

  it("回归:切片开头的峰不能被多余的偏移吃掉(旧实现恒返回空表)", () => {
    // 旧写法把绝对 e.atSec 直接喂给 mapToOutputTime(它期望的是切片相对时间),
    // 偏移叠了一次,每个事件都落到所有保留段之外 → 空表 → 闪现从不触发
    expect(mapToOutputTime(102, segments, 100)).toBeNull();
    expect(mapPeakEvents(track, segments, 100, 8).length).toBe(2);
  });

  it("接缝有交叉淡化时,xfade 把后面的事件整体提前", () => {
    // 第一处接缝交叠 0.5s → 成片短 0.5s,第二段的峰从 6s 挪到 5.5s
    expect(mapPeakEvents(track, segments, 100, 8, 0.5)).toEqual([
      { srcSec: 102, outSec: 2 },
      { srcSec: 110, outSec: 5.5 },
    ]);
  });

  it("输出时间超出切片时长的峰被丢掉", () => {
    expect(mapPeakEvents(track, null, 100, 5).map((p) => p.outSec)).toEqual([2]);
  });

  it("近静音素材没有峰事件", () => {
    const quiet: PeakTrack = { values: Float32Array.from([0.01, 0.02, 0.01]), startSec: 100, hopSec: 0.5 };
    expect(mapPeakEvents(quiet, segments, 100, 8)).toEqual([]);
  });
});
