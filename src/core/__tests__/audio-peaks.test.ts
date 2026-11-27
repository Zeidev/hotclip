import { describe, expect, it } from "vitest";
import {
  EDGE_QUIET_PEAK,
  EDGE_QUIET_RUN_SEC,
  isSpeechEdge,
  peakAt,
  peakInRange,
  peaksFromPcm,
  mapPeakEvents,
  quietRunAt,
  relativeQuietPeak,
  snapEdgeToQuiet,
  snapSpansToQuiet,
  type PeakTrack,
} from "../audio-peaks";
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

describe("切点真音频吸附(snapEdgeToQuiet / snapSpansToQuiet)", () => {
  const hopSec = 1 / 30;
  /** [from, to, peak] 铺出来的轨道;未覆盖的块 = 0.01(静音)。 */
  function trackFrom(spans: Array<[number, number, number]>, startSec = 10, endSec = 14): PeakTrack {
    const values = new Float32Array(Math.ceil((endSec - startSec) / hopSec)).fill(0.01);
    for (const [from, to, peak] of spans) {
      const first = Math.max(0, Math.floor((from - startSec) / hopSec));
      for (let i = first; i < values.length && startSec + i * hopSec < to - 1e-9; i++) values[i] = peak;
    }
    return { values, startSec, hopSec };
  }

  it("peakAt 取该时刻所在块;轨道外 = 0(没证据)", () => {
    const track: PeakTrack = { values: Float32Array.from([0.01, 0.5, 0.01]), startSec: 10, hopSec: 1 };
    expect(peakAt(track, 11.5)).toBeCloseTo(0.5);
    expect(peakAt(track, 9.5)).toBe(0);
    expect(peakAt(track, 13)).toBe(0);
  });

  it("quietRunAt 要求整段被覆盖且低于阈值:没覆盖不算静音", () => {
    const track = trackFrom([[10, 10.5, 0.5]], 10, 12);
    expect(quietRunAt(track, 11, EDGE_QUIET_PEAK, EDGE_QUIET_RUN_SEC)).toBe(true);
    expect(quietRunAt(track, 10.0, EDGE_QUIET_PEAK, EDGE_QUIET_RUN_SEC)).toBe(false);
    // 轨道只到 12s:12 之前一点点起跑的窗口越界 → 不算静音(不能凭「没有数据」下结论)
    expect(quietRunAt(track, 11.99, EDGE_QUIET_PEAK, EDGE_QUIET_RUN_SEC)).toBe(false);
  });

  it("已经在静音里的切点一个都不动", () => {
    const track = trackFrom([[12, 14, 0.5]]);
    expect(snapEdgeToQuiet(track, 11, { bias: "head" })).toEqual({ sec: 11, movedSec: 0 });
  });

  it("切点在真人声里 → 往前挪进静音(head)或往后(tail)", () => {
    // 真人声 11.85-12.6,切点 12 正落在这段发声中间(估词时间与真语音错位);
    // 静音只在前面 0.21s 处 → head 往前挪
    const track = trackFrom([[11.85, 12.6, 0.5]]);
    const head = snapEdgeToQuiet(track, 12, { bias: "head" });
    expect(head.movedSec).toBeLessThan(0);
    expect(quietRunAt(track, head.sec)).toBe(true);
    expect(head.sec).toBeCloseTo(11.78, 1); // 只挪到最近的静音,不越过

    // 镜像:真人声 11.4-12.15,静音只在后面 0.15s 处 → tail 往后挪
    const tray = trackFrom([[11.4, 12.15, 0.5]]);
    const tail = snapEdgeToQuiet(tray, 12, { bias: "tail" });
    expect(tail.movedSec).toBeGreaterThan(0);
    expect(quietRunAt(tray, tail.sec)).toBe(true);
    expect(tail.sec).toBeCloseTo(12.17, 1);
  });

  it("oneWay 只许一个方向:反向没有静音就原样返回", () => {
    // 响的 11.5-12.2:往回要挪 0.56s(超过 0.4s 上限),往后 0.2s 就有静音
    const track = trackFrom([[11.5, 12.2, 0.5]]);
    expect(snapEdgeToQuiet(track, 12, { bias: "head", oneWay: "earlier" })).toEqual({ sec: 12, movedSec: 0 });
    const later = snapEdgeToQuiet(track, 12, { bias: "tail", oneWay: "later" });
    expect(later.movedSec).toBeGreaterThan(0);
  });

  it("没静音可挪(附近全在响)→ 原样返回,不猜", () => {
    const track = trackFrom([[10, 14, 0.5]]);
    expect(snapEdgeToQuiet(track, 12, { bias: "head" })).toEqual({ sec: 12, movedSec: 0 });
  });

  it("relativeQuietPeak:越吵的段落门槛越高,但有上下限", () => {
    const loud = trackFrom([[10, 14, 0.5]]);
    expect(relativeQuietPeak(loud, 12)).toBeCloseTo(0.11, 3);
    const quiet = trackFrom([]);
    expect(relativeQuietPeak(quiet, 12)).toBe(EDGE_QUIET_PEAK);
    const screaming = trackFrom([[10, 14, 1]]);
    expect(relativeQuietPeak(screaming, 12)).toBeLessThanOrEqual(0.2); // ceiling
  });

  it("已经是干净的发声交界(词头)→ skipIfOnset 一个字节都不动", () => {
    // 静音到 10.5,10.5 起发声:词头就切在 10.5
    const track = trackFrom([[10.5, 12, 0.4]], 10, 13);
    expect(isSpeechEdge(track, 10.5, "head")).toBe(true);
    expect(snapEdgeToQuiet(track, 10.5, { bias: "head", oneWay: "earlier", skipIfOnset: true })).toEqual({ sec: 10.5, movedSec: 0 });
    // 不传它时旧行为:退进停顿 0.07s(开场多一截死气)
    expect(snapEdgeToQuiet(track, 10.5, { bias: "head", oneWay: "earlier" }).movedSec).toBeLessThan(0);
    // 词尾镜像
    expect(isSpeechEdge(track, 12, "tail")).toBe(true);
    expect(isSpeechEdge(track, 11.5, "tail")).toBe(false);
  });

  it("切点落在长停顿深处(估词时间偏早)→ speech-edge 贴着发声留 ~0.06s 引子", () => {
    // 12s 前全是静音:切点 11.5 在停顿中间,不滑就是开场先静 0.5s
    const track = trackFrom([[12, 13, 0.4]], 10, 14);
    const start = snapEdgeToQuiet(track, 11.5, { bias: "head", oneWay: "earlier", landing: "speech-edge" });
    expect(start.sec).toBeGreaterThan(11.85);
    expect(start.sec).toBeLessThanOrEqual(12);
    expect(quietRunAt(track, start.sec)).toBe(true);
    // 缺省 quiet-start:原样(已在静音里)
    expect(snapEdgeToQuiet(track, 11.5, { bias: "head", oneWay: "earlier" })).toEqual({ sec: 11.5, movedSec: 0 });
  });

  it("snapSpansToQuiet:强制剪除区间两端挪到附近谷底,空区间被丢掉", () => {
    // 密集口语:11.6 处一段 0.08s 的谷底(0.02,门槛 0.05 之下),其余都在响。
    // 语气词区间按估词时间标成 11.5-11.8,但真人声 11.3-12.0 都在响;
    const track = trackFrom([[10, 11.6, 0.4], [11.6, 11.75, 0.02], [11.75, 12.5, 0.4]]);
    const [span] = snapSpansToQuiet(track, [{ startSec: 11.5, endSec: 12.4 }], { ceiling: 0.05 });
    expect(span.startSec).toBeCloseTo(11.6, 2);
    expect(span.endSec).toBeCloseTo(12.5, 2);

    const empty = snapSpansToQuiet(track, [{ startSec: 11.7, endSec: 11.7 }], { ceiling: 0.05 });
    expect(empty).toEqual([]);
  });
});
