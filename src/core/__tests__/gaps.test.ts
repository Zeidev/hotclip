import { describe, it, expect } from "vitest";
import { computeJumpCut, mergeShortCuts, splitLongSegments } from "../gaps";
import { buildJumpCutArgs } from "../cut";
import { quietRunAt, type PeakTrack } from "../audio-peaks";
import type { TranscriptWord } from "../../shared/api-types";

function w(text: string, startSec: number, endSec: number): TranscriptWord {
  return { text, startSec, endSec };
}

describe("computeJumpCut", () => {
  // speech 10-12s, 2s silence, speech 14-16s
  const words = [w("前", 10, 11), w("半", 11, 12), w("后", 14, 15), w("半", 15, 16)];

  it("cuts the silence into two kept segments with padding", () => {
    const plan = computeJumpCut(words, 10, 16.5);
    expect(plan.segments).toHaveLength(2);
    const [a, b] = plan.segments;
    expect(a.startSec).toBeCloseTo(10, 2); // clamped by clip start (10 - 0.15 lead-in)
    expect(a.endSec).toBeCloseTo(12.18, 2); // + pad after
    expect(b.startSec).toBeCloseTo(13.88, 2); // - pad before
    expect(b.endSec).toBeCloseTo(16.3, 2); // + tail
    expect(plan.removedSec).toBeCloseTo(6.5 - plan.durationSec, 5);
    expect(plan.removedSec).toBeGreaterThan(1.4);
  });

  it("beat grid pulls a kept segment back and keeps the word remap in sync", () => {
    const base = computeJumpCut(words, 10, 16.5);
    // Beats are output time, so junction 1 sits at the first piece's duration.
    const grid = [base.segments[0].endSec - base.segments[0].startSec - 0.08];
    const snapped = computeJumpCut(words, 10, 16.5, { beats: grid });
    expect(snapped.segments[0]).toEqual(base.segments[0]);
    expect(snapped.segments[1].startSec).toBeCloseTo(base.segments[1].startSec - 0.08, 3);
    expect(snapped.segments[1].endSec).toBeCloseTo(base.segments[1].endSec, 3);
    expect(snapped.durationSec).toBeCloseTo(base.durationSec + 0.08, 3);
    // Captions sit on the compressed timeline: the later segment starts 0.08 s
    // earlier in source, so its words land 0.08 s later in the output.
    expect(snapped.words[2].startSec).toBeCloseTo(base.words[2].startSec + 0.08, 3);
  });

  it("cross-fade shortens the output and shifts later words", () => {
    const base = computeJumpCut(words, 10, 16.5);
    const faded = computeJumpCut(words, 10, 16.5, { transitionSec: 0.1 });
    expect(faded.segments).toEqual(base.segments);
    expect(faded.durationSec).toBeCloseTo(base.durationSec - 0.1, 3);
    expect(faded.words[2].startSec).toBeCloseTo(base.words[2].startSec - 0.1, 3);
  });

  it("remaps words onto the compressed output timeline", () => {
    const plan = computeJumpCut(words.map((word) => ({ ...word, timingSource: "aligned" as const })), 10, 16.5);
    const [, , w3] = plan.words;
    // third word starts at seg2 start → output time = seg1 duration + pad-before offset
    const seg1Dur = plan.segments[0].endSec - plan.segments[0].startSec;
    expect(w3.startSec).toBeCloseTo(seg1Dur + (14 - plan.segments[1].startSec), 3);
    // monotonic and starting near zero
    expect(plan.words[0].startSec).toBeCloseTo(0, 2);
    for (let i = 1; i < plan.words.length; i++) {
      expect(plan.words[i].startSec).toBeGreaterThanOrEqual(plan.words[i - 1].startSec);
    }
    expect(plan.words.every((word) => word.timingSource === "aligned")).toBe(true);
  });

  it("no gaps → single segment trimmed to speech bounds", () => {
    const tight = [w("a", 10.5, 11), w("b", 11.1, 12)];
    const plan = computeJumpCut(tight, 10, 20);
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].startSec).toBeCloseTo(10.35, 2); // lead-in pad
    expect(plan.segments[0].endSec).toBeCloseTo(12.3, 2); // tail pad
  });

  it("no words → keeps the full clip", () => {
    const plan = computeJumpCut([], 5, 10);
    expect(plan.segments).toEqual([{ startSec: 5, endSec: 10 }]);
    expect(plan.durationSec).toBe(5);
  });

  // peaks: 30 blocks/s track covering 10-16.5s, quiet everywhere by default
  function trackWithBurst(burstFrom?: number, burstTo?: number): PeakTrack {
    const hopSec = 1 / 30;
    const values = new Float32Array(Math.ceil(6.5 / hopSec)).fill(0.01);
    if (burstFrom !== undefined && burstTo !== undefined) {
      for (let i = Math.floor((burstFrom - 10) / hopSec); i * hopSec + 10 < burstTo; i++) {
        values[i] = 0.4;
      }
    }
    return { values, startSec: 10, hopSec };
  }

  it("AND gate: quiet gap still gets cut when peaks are provided", () => {
    const plan = computeJumpCut(words, 10, 16.5, { peaks: trackWithBurst() });
    expect(plan.segments).toHaveLength(2);
  });

  it("AND gate: loud wordless gap (laughter/applause) survives the cut", () => {
    const plan = computeJumpCut(words, 10, 16.5, { peaks: trackWithBurst(12.5, 13.5) });
    expect(plan.segments).toHaveLength(1);
    expect(plan.removedSec).toBeLessThan(0.5);
  });

  it("VAD gate protects speech that ASR missed inside a quiet word gap", () => {
    const plan = computeJumpCut(words, 10, 16.5, {
      peaks: trackWithBurst(),
      speechSpans: [
        { startSec: 9.9, endSec: 12.1 },
        { startSec: 12.7, endSec: 13.3 },
        { startSec: 13.9, endSec: 16.1 },
      ],
    });
    expect(plan.segments).toHaveLength(1);
    expect(plan.speechProtectedGaps).toBe(1);
  });

  it("omitting VAD preserves the legacy result shape and cut", () => {
    const legacy = computeJumpCut(words, 10, 16.5, { peaks: trackWithBurst() });
    expect(legacy.segments).toHaveLength(2);
    expect(legacy).not.toHaveProperty("speechProtectedGaps");
  });

  it("keeps VAD-confirmed phoneme tails outside coarse ASR word edges", () => {
    const edgeWords = [w("开", 10.2, 10.6), w("尾", 11.5, 11.8)];
    const plan = computeJumpCut(edgeWords, 9.5, 12.5, {
      speechSpans: [{ startSec: 9.9, endSec: 10.65 }, { startSec: 11.45, endSec: 12.2 }],
    });
    expect(plan.segments[0].startSec).toBeCloseTo(9.82, 5);
    expect(plan.segments.at(-1)?.endSec).toBeCloseTo(12.32, 5);
  });
});

describe("mergeShortCuts", () => {
  it("fills back splices shorter than the minimum cut", () => {
    const merged = mergeShortCuts(
      [
        { startSec: 0, endSec: 2 },
        { startSec: 2.1, endSec: 4 }, // 0.1s cut — churn
        { startSec: 5, endSec: 6 }, // 1s cut — real
      ],
      0.2
    );
    expect(merged).toEqual([
      { startSec: 0, endSec: 4 },
      { startSec: 5, endSec: 6 },
    ]);
  });

  it("passes through when nothing is short", () => {
    const segs = [
      { startSec: 0, endSec: 2 },
      { startSec: 3, endSec: 4 },
    ];
    expect(mergeShortCuts(segs, 0.2)).toEqual(segs);
  });
});

describe("buildJumpCutArgs", () => {
  const segments = [
    { startSec: 10, endSec: 12.2 },
    { startSec: 13.9, endSec: 16.3 },
  ];

  it("seeks to clip start and trims with seek-relative times", () => {
    const args = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, segments);
    expect(args[args.indexOf("-ss") + 1]).toBe("00:00:10.000");
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("[0:v:0]trim=start=0.000:end=2.200");
    // 拼缝借的是被切掉的那段静音:前段声音多走 0.15s(L-cut),后段早进 0.15s
    // (J-cut),acrossfade 用 2×0.15 抵掉,总长仍等于画面总长。
    expect(fc).toContain("[0:a:0]atrim=start=0.000:end=2.350");
    expect(fc).toContain("[0:a:0]atrim=start=3.750:end=6.300");
    // 画面硬切;声音走 acrossfade(拼缝 1.7s 静音够长)。
    expect(fc).toContain("[v0][v1]concat=n=2:v=1:a=0");
    expect(fc).toContain("acrossfade=d=0.300:c1=qsin:c2=qsin[aout]");
    expect(args).toContain("[vout]");
    expect(args).toContain("[aout]");
  });

  it("首段被补静音拉到切片起点之前时,seek 跟着前移(否则补的那段被夹掉)", () => {
    const args = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, [{ startSec: 9.7, endSec: 12.2 }]);
    expect(args[args.indexOf("-ss") + 1]).toBe("00:00:09.700");
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("[0:v:0]trim=start=0.000:end=2.500");
  });
  it("chains reframe + subtitles after the concat", () => {
    const args = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, segments, {
      vertical: true,
      subtitlePath: "/tmp/a.ass",
    });
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toMatch(/\[vc\]crop=.*scale=1080:1920.*subtitles=filename='\/tmp\/a\.ass'\[vout\]/);
  });
});

describe("首尾补进真静音(成片开头/结尾的词不能被切半)", () => {
  const hopSec = 1 / 30;
  /** [from, to, peak] 铺出来的峰值轨;未覆盖的块 = 0.01(静音)。 */
  function track(spans: Array<[number, number, number]>, startSec = 9.5, endSec = 13.6): PeakTrack {
    const values = new Float32Array(Math.ceil((endSec - startSec) / hopSec)).fill(0.01);
    for (const [from, to, peak] of spans) {
      const first = Math.max(0, Math.floor((from - startSec) / hopSec));
      for (let i = first; i < values.length && startSec + i * hopSec < to - 1e-9; i++) values[i] = peak;
    }
    return { values, startSec, hopSec };
  }

  it("尾部被 clipEndSec 夹掉、落在真人声里 → 往后补进静音", () => {
    const words = [w("a", 10.2, 10.6), w("b", 10.7, 11.2), w("c", 11.3, 12.95)];
    // 真人声一直到 13.25:切片在 13 结束,末尾词正被切在发声里;静音 13.25 之后
    const peaks = track([[10.2, 13.25, 0.4]]);
    const plan = computeJumpCut(words, 10, 13, { peaks });
    expect(plan.segments).toHaveLength(1);
    const tail = plan.segments[0].endSec;
    expect(tail).toBeGreaterThan(13.05);
    expect(quietRunAt(peaks, tail)).toBe(true);
    // 补静音让成片比原切片略长:净删除量取 0,不能出现负回执
    expect(plan.removedSec).toBe(0);
    expect(plan.durationSec).toBeCloseTo(tail - plan.segments[0].startSec, 6);
  });

  it("首端落在真人声里(估词时间偏后)→ 往前补进静音,词一个不丢", () => {
    const words = [w("a", 10.2, 10.6), w("b", 10.7, 11.5)];
    // 真语音从 9.86 就开始,切片起点 10 落在句中;静音在 9.86 之前
    const peaks = track([[9.86, 11.6, 0.4]]);
    const plan = computeJumpCut(words, 10, 12, { peaks });
    expect(plan.segments).toHaveLength(1);
    const head = plan.segments[0].startSec;
    expect(head).toBeLessThan(10);
    expect(quietRunAt(peaks, head)).toBe(true);
    expect(plan.words).toHaveLength(2);
    // 字幕时间基跟着新的起点:首词在成片里 = 源时间 − 新起点
    expect(plan.words[0].startSec).toBeCloseTo(10.2 - head, 3);
  });

  it("两端本来就在静音里 → 一个字节都不动", () => {
    const words = [w("a", 10.2, 10.6), w("b", 10.7, 11.5)];
    const peaks = track([[10.2, 11.6, 0.4]]);
    const plan = computeJumpCut(words, 10, 12, { peaks });
    expect(plan.segments[0].startSec).toBeCloseTo(10.05, 3); // 10.2 − 0.15 前导
    expect(plan.segments[0].endSec).toBeCloseTo(11.8, 3); // 11.5 + 0.3 尾巴
  });
});

describe("splitLongSegments(节奏目标:长镜头补刀)", () => {
  const hopSec = 1 / 30;
  /** [from, to, peak] 铺出来的峰值轨;未覆盖的块 = 0.01(静音)。 */
  function track(spans: Array<[number, number, number]>, startSec = 0, endSec = 24): PeakTrack {
    const values = new Float32Array(Math.ceil((endSec - startSec) / hopSec)).fill(0.01);
    for (const [from, to, peak] of spans) {
      const first = Math.max(0, Math.floor((from - startSec) / hopSec));
      for (let i = first; i < values.length && startSec + i * hopSec < to - 1e-9; i++) values[i] = peak;
    }
    return { values, startSec, hopSec };
  }
  /** 每 step 秒一个词、词长 len 秒;gap 处正确留白。 */
  function words(from: number, to: number, step = 0.5, len = 0.4): TranscriptWord[] {
    const out: TranscriptWord[] = [];
    for (let t = from; t + len <= to; t += step) out.push(w("字", t, t + len));
    return out;
  }

  it("切口取目标附近最宽的词间缝的中点——绝不在词里下刀", () => {
    const seq = [...words(0, 4.5), w("长", 4.6, 5.0), w("后", 6.0, 6.5), ...words(6.5, 12)];
    const out = splitLongSegments([{ startSec: 0, endSec: 12 }], 6, seq);
    expect(out[0]).toEqual({ startSec: 0, endSec: 5.5 }); // 1.0s 宽的缝 → 取中线
    for (const seg of out) expect(seg.endSec - seg.startSec).toBeLessThanOrEqual(6);
    expect(out[out.length - 1].endSec).toBe(12);
    // 段段首尾相接、缺口为零 → 音频取自同一段源,一个样本都不变
    for (let i = 1; i < out.length; i++) expect(out[i].startSec).toBe(out[i - 1].endSec);
  });

  it("全是连续语流(词间没有缝)就不切,宁可不达标", () => {
    const out = splitLongSegments([{ startSec: 0, endSec: 12 }], 6, [w("一口气说完", 0, 12)]);
    expect(out).toEqual([{ startSec: 0, endSec: 12 }]);
  });

  it("缝里其实是响声(笑声/掌声)时不下刀——峰值说了才算静音", () => {
    const seq = words(0, 12);
    const loud = track([[0, 12, 0.4]]); // 全程有声:词间缝是笑声,不是静音
    expect(splitLongSegments([{ startSec: 0, endSec: 12 }], 6, seq, loud)).toEqual([
      { startSec: 0, endSec: 12 },
    ]);
    const quiet = track([[0, 4.7, 0.4], [6.2, 12, 0.4]]); // 5.1-6.2 真静音
    const split = splitLongSegments([{ startSec: 0, endSec: 12 }], 6, seq, quiet);
    expect(split).toHaveLength(2);
    expect(split[0].endSec).toBeGreaterThan(5.0);
    expect(split[0].endSec).toBeLessThan(6.2);
  });

  it("短过一个镜头的不动;补出来的每一段都够长(不造碎镜头)", () => {
    expect(splitLongSegments([{ startSec: 0, endSec: 5 }], 6, words(0, 5))).toEqual([
      { startSec: 0, endSec: 5 },
    ]);
    const tight = splitLongSegments([{ startSec: 0, endSec: 3 }], 1.5, words(0, 3));
    expect(tight.length).toBeGreaterThan(1);
    for (const seg of tight) expect(seg.endSec - seg.startSec).toBeGreaterThanOrEqual(0.8);
    expect(tight[0].startSec).toBe(0);
    expect(tight[tight.length - 1].endSec).toBe(3);
  });

  it("不设上限(∞/0)时一个字节都不动", () => {
    const segs = [{ startSec: 0, endSec: 12 }];
    expect(splitLongSegments(segs, Infinity, words(0, 12))).toEqual(segs);
    expect(splitLongSegments(segs, 0, words(0, 12))).toEqual(segs);
  });
});

describe("computeJumpCut 的节奏目标(maxShotSec)", () => {
  // 一段 12 秒不停口的话:词间只有 0.1s 缝,静音剪一个都剪不掉
  const words = Array.from({ length: 24 }, (_, i) => w("话", 10 + i * 0.5, 10.4 + i * 0.5));

  it("长镜头被切成几刀,成片总长和字幕时间轴都不变", () => {
    const base = computeJumpCut(words, 10, 22);
    expect(base.segments).toHaveLength(1);
    expect(base.durationSec).toBeCloseTo(12, 3);
    const split = computeJumpCut(words, 10, 22, { maxShotSec: 5 });
    expect(split.longShotsSplit).toBe(split.segments.length - 1);
    expect(split.longShotsSplit).toBeGreaterThanOrEqual(2);
    for (const seg of split.segments) expect(seg.endSec - seg.startSec).toBeLessThanOrEqual(5);
    // 总时长一模一样:补刀只挪画面切点,音频是从同一段源连续取的
    expect(split.durationSec).toBeCloseTo(base.durationSec, 3);
    // 每个新镜头都是一个换行点(字幕得跟着画面走)
    expect(split.breaks).toHaveLength(split.segments.length - 1);
    // 字幕时间轴不变:词还落在成片里同一个位置
    expect(split.words.map((x) => x.startSec)).toEqual(base.words.map((x) => x.startSec));
  });

  it("密度曲线:开场与收口比中段切得密,中段仍听品类档", () => {
    const long = Array.from({ length: 60 }, (_, i) => w("话", i * 0.5, 0.4 + i * 0.5)); // 30 秒不停口
    const split = computeJumpCut(long, 0, 30, { maxShotSec: 10 });
    // 开场 3 秒内已经换过画面
    expect(split.segments[0].endSec - split.segments[0].startSec).toBeLessThanOrEqual(3.05);
    for (const seg of split.segments) expect(seg.endSec - seg.startSec).toBeLessThanOrEqual(10);
    // 输出时间轴上累出每段起点,数一数收口 5 秒里有几刀
    let u = 0;
    const starts: number[] = [];
    for (const seg of split.segments) {
      starts.push(u);
      u += seg.endSec - seg.startSec;
    }
    expect(u).toBeCloseTo(30, 3);
    expect(starts.filter((s) => s >= u - 5)).toHaveLength(2); // 收口 5 秒 = 3 段(≤4 秒一镜)
    expect(split.breaks).toHaveLength(split.segments.length - 1);
  });

  it("刀落在周围词最稀的那条缝里(词/秒 ≈ 信息密度)", () => {
    /** 每 0.5 秒一个 0.4 秒的词:连续语流,词间一律 0.1 秒缝。 */
    const dense = (from: number, to: number) =>
      Array.from({ length: Math.max(0, Math.round((to - from) / 0.5)) }, (_, i) =>
        w("密", from + i * 0.5, from + i * 0.5 + 0.4)
      );
    const seq = [
      ...dense(0, 5),
      w("静", 5.0, 7.2), w("静", 7.3, 9.6), // 慢速长词:7.2→7.3 同样是 0.1 秒缝
      ...dense(9.7, 20),
    ];
    const out = splitLongSegments([{ startSec: 0, endSec: 20 }], 10, seq);
    // 目标 10 秒、搜索窗 [7,10]:7.25 那条缝周围只有两个长词,信息最稀 → 刀落那儿;
    // 9.65 那条离目标更近,但夹在密语流里,不该抢
    expect(out[0].endSec).toBeCloseTo(7.25, 2);
  });

  it("不限(∞/缺省)时与历史成片逐字节一致", () => {
    const base = computeJumpCut(words, 10, 22);
    expect(computeJumpCut(words, 10, 22, { maxShotSec: Infinity }).segments).toEqual(base.segments);
    expect(computeJumpCut(words, 10, 22, {}).longShotsSplit).toBeUndefined();
  });
});
