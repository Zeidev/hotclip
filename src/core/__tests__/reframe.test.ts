import { describe, it, expect } from "vitest";
import {
  LOST_HOLD_SEC,
  OneEuro,
  RECENTER_RAMP_SEC,
  cropXAtTime,
  downsampleKeyframes,
  evaluateCropCoverage,
  planCropComposition,
  planCropTrack,
  renderSendcmd,
  renderCropXExpr,
  smoothstep,
  speakerAnchors,
  type FaceSample,
} from "../reframe/track";
import { mapToOutputTime, remapCropKeyframes } from "../reframe";
import { decodeYunet, iou, matchCost, pickMainFace, YUNET_INPUT, type FaceBox } from "../reframe/yunet";

function samplesOf(cxs: Array<number | null>, fps = 3): FaceSample[] {
  return cxs.map((cx, i) => ({ t: i / fps, cx }));
}

describe("planCropTrack modes", () => {
  const W = 1920;
  const H = 1080; // cropW = 606 → even 606? 1080*9/16=607.5 → floor/2*2 = 606

  it("static shot → single keyframe at the median", () => {
    const kfs = planCropTrack(samplesOf([0.5, 0.51, 0.5, 0.49, 0.5, 0.5]), [], W, H);
    expect(kfs).toHaveLength(1);
    const cropW = Math.floor((H * 9) / 16 / 2) * 2;
    expect(kfs![0].x).toBe(Math.round(0.5 * W - cropW / 2));
  });

  it("locks a moving subject when its full shot envelope fits safely", () => {
    const samples = samplesOf([0.4, 0.43, 0.48, 0.53, 0.57]);
    const planned = planCropComposition(samples, [], W, H)!;
    expect(planned.keyframes).toHaveLength(1);
    expect(planned.stats).toMatchObject({ lockedShots: 1, trackedShots: 0 });
  });

  it("locks a group envelope and snaps a near-centred composition to centre", () => {
    const samples: FaceSample[] = [0, 1 / 3, 2 / 3, 1].map((t) => ({
      t,
      cx: 0.42,
      left: 0.36,
      right: 0.6,
      faceCount: 2,
    }));
    const planned = planCropComposition(samples, [], W, H)!;
    const cropW = Math.floor((H * 9) / 16 / 2) * 2;
    expect(planned.keyframes).toEqual([{ t: 0, x: Math.round(W / 2 - cropW / 2), hold: true }]);
    expect(planned.stats).toMatchObject({ lockedShots: 1, groupLockedShots: 1, clippedShots: 0 });
  });

  it("holds, then eases back to centre after a sustained detection loss", () => {
    const samples: FaceSample[] = [];
    for (let i = 0; i < 5; i++) samples.push({ t: i / 3, cx: 0.25 });
    for (let i = 5; i < 11; i++) samples.push({ t: i / 3, cx: null });
    const planned = planCropComposition(samples, [], W, H)!;
    const cropW = Math.floor((H * 9) / 16 / 2) * 2;
    expect(planned.stats.recoveryShots).toBe(1);
    expect(planned.keyframes.at(-1)!.x).toBe(Math.round(W / 2 - cropW / 2));
    const rampStart = planned.keyframes.at(-2)!;
    expect(rampStart.ease).toBe(true);
    // The framing holds right up to the ramp; the old planner jumped at the
    // hold deadline, which read as an unmotivated pan.
    const held = cropXAtTime(planned.keyframes, rampStart.t - 0.01);
    expect(held).toBe(rampStart.x);
    // The move leaves from rest, so a hundredth of a second in it has barely
    // budged (a linear ramp would already be ~3px along).
    expect(Math.abs(cropXAtTime(planned.keyframes, rampStart.t + 0.01) - rampStart.x)).toBeLessThan(1);
    // Halfway through the ramp the crop is moving but has not arrived.
    const mid = cropXAtTime(planned.keyframes, rampStart.t + RECENTER_RAMP_SEC / 2);
    expect(mid).toBeGreaterThan(rampStart.x);
    expect(mid).toBeLessThan(planned.keyframes.at(-1)!.x);
  });

  it("steady drift → one constant-velocity pan at the subject's own pace", () => {
    const kfs = planCropTrack(samplesOf([0.3, 0.34, 0.38, 0.42, 0.46, 0.5, 0.54, 0.58]), [], W, H)!;
    expect(kfs).toHaveLength(2);
    // Following a subject who walks at a steady pace: easing would lag them.
    expect(kfs[0].ease).toBeUndefined();
    expect(kfs[1].x).toBeGreaterThan(kfs[0].x);
    const at = (fraction: number): number => cropXAtTime(kfs, kfs[0].t + (kfs[1].t - kfs[0].t) * fraction);
    const linear = (fraction: number): number => kfs[0].x + (kfs[1].x - kfs[0].x) * fraction;
    expect(at(0.25)).toBeCloseTo(linear(0.25), 3);
    expect(at(0.5)).toBeCloseTo(linear(0.5), 3);
  });

  it("follows a curved drift instead of cutting the corner", () => {
    // Dwells left for 1.5 s, then sweeps right: the chord between endpoints
    // passes far from the subject, so panning on it would lose them.
    const kfs = planCropTrack(samplesOf([0.3, 0.3, 0.3, 0.3, 0.3, 0.55, 0.75]), [], W, H)!;
    expect(kfs.length).toBeGreaterThan(2);
    const mid = cropXAtTime(kfs, 1.0);
    expect(mid).toBeLessThan(Math.round(0.3 * W - Math.floor((H * 9) / 16 / 2) * 2 / 2) + 30);
  });

  it("does not creep across a stillness before the subject moves", () => {
    const samples = samplesOf([0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.4, 0.5, 0.6, 0.7]);
    const kfs = planCropTrack(samples, [], W, H)!;
    const still = Math.round(0.3 * W - Math.floor((H * 9) / 16 / 2) * 2 / 2);
    // Subject stands still until t=1.67; the crop must stand still with them.
    expect(cropXAtTime(kfs, 1.4)).toBe(still);
    expect(cropXAtTime(kfs, 3)).toBeGreaterThan(still + 100);
  });

  it("clamps a fast drift so the crop never whips", () => {
    const kfs = planCropTrack(samplesOf([0.3, 0.5, 0.8]), [], W, H)!;
    expect(kfs).toHaveLength(2);
    // 0.5 of the frame across 2/3 s would need a whip: the pan runs at the
    // velocity ceiling instead, so the crop trails the subject rather than
    // yanking across the frame.
    const commanded = (kfs[1].x - kfs[0].x) / W;
    expect(commanded).toBeCloseTo(0.3, 2);
    expect(kfs[0].ease).toBeUndefined();
  });

  it("holds through a long detection gap and pans when the subject returns", () => {
    const samples: FaceSample[] = [];
    for (let i = 0; i < 4; i++) samples.push({ t: i / 3, cx: 0.3, left: 0.2, right: 0.4 });
    for (let i = 4; i < 12; i++) samples.push({ t: i / 3, cx: null });
    for (let i = 12; i < 15; i++) samples.push({ t: i / 3, cx: 0.5, left: 0.4, right: 0.6 });
    const planned = planCropComposition(samples, [], W, H)!;
    const held = cropXAtTime(planned.keyframes, 1);
    // Still on the last framing well into the gap (the old planner drifted
    // toward centre the whole time).
    expect(cropXAtTime(planned.keyframes, 2.5)).toBe(held);
    expect(cropXAtTime(planned.keyframes, 4)).toBeGreaterThan(held + 100);
  });

  it("aims between co-present faces while panning", () => {
    const samples: FaceSample[] = [0, 1, 2, 3, 4].map((i) => {
      const shift = i * 0.05;
      return {
        t: i / 3,
        cx: 0.35 + shift,
        left: 0.3 + shift,
        right: 0.52 + shift,
        faceCount: 2,
        faces: [
          { left: 0.3 + shift, right: 0.4 + shift },
          { left: 0.42 + shift, right: 0.52 + shift },
        ],
      };
    });
    const kfs = planCropTrack(samples, [], W, H)!;
    // union centre of the first sample is 0.41, not the main face's 0.35
    expect(kfs[0].x).toBe(Math.round(0.41 * W - Math.floor((H * 9) / 16 / 2) * 2 / 2));
  });

  it("counts shots where the crop must clip a face", () => {
    const samples: FaceSample[] = [0, 1 / 3, 2 / 3].map((t) => ({
      t,
      cx: 0.3,
      left: 0.2,
      right: 0.7,
      faceCount: 2,
      faces: [
        { left: 0.2, right: 0.35 },
        { left: 0.55, right: 0.7 },
      ],
    }));
    const planned = planCropComposition(samples, [], W, H)!;
    expect(planned.stats.clippedShots).toBe(1);
    expect(planned.coverage).toHaveLength(3);
    expect(Math.min(...planned.coverage.map((c) => c.minVisibleFraction))).toBeLessThan(0.9);
  });

  it("low face coverage → null (center fallback)", () => {
    expect(planCropTrack(samplesOf([0.5, null, null, null, null, null]), [], W, H)).toBeNull();
  });

  it("source narrower than 9:16 → null", () => {
    expect(planCropTrack(samplesOf([0.5, 0.5, 0.5]), [], 500, 1080)).toBeNull();
  });

  it("scene cuts split segments (independent modes per shot)", () => {
    // shot A static at 0.3; cut at t=1.0; shot B static at 0.7
    const samples = [
      ...samplesOf([0.3, 0.3, 0.3]),
      { t: 1.0, cx: 0.7 },
      { t: 1.33, cx: 0.7 },
      { t: 1.67, cx: 0.7 },
    ];
    const kfs = planCropTrack(samples, [1.0], W, H)!;
    expect(kfs).toHaveLength(2);
    expect(kfs[1].x).toBeGreaterThan(kfs[0].x);
  });

  it("centres a sparse face-free shot instead of holding the previous crop", () => {
    const samples = [
      ...samplesOf([0.25, 0.25, 0.25]),
      { t: 1, cx: null },
      { t: 4 / 3, cx: null },
      { t: 5 / 3, cx: null },
    ];
    const planned = planCropComposition(samples, [1], W, H)!;
    const cropW = Math.floor((H * 9) / 16 / 2) * 2;
    expect(planned.keyframes.at(-1)).toEqual({ t: 1, x: Math.round(W / 2 - cropW / 2), hold: true });
    expect(planned.stats).toMatchObject({ totalShots: 2, centeredShots: 1 });
  });

  it("x is clamped inside the source", () => {
    const kfs = planCropTrack(samplesOf([0.01, 0.01, 0.99, 0.99, 0.99, 0.01]), [], W, H)!;
    const cropW = Math.floor((H * 9) / 16 / 2) * 2;
    for (const k of kfs) {
      expect(k.x).toBeGreaterThanOrEqual(0);
      expect(k.x).toBeLessThanOrEqual(W - cropW);
    }
  });
});

describe("说话人取景(diarization 参与选脸)", () => {
  const W = 1920;
  const H = 1080;
  const cropW = Math.floor((H * 9) / 16 / 2) * 2;
  const xOf = (c: number): number => Math.round(c * W - cropW / 2);
  /** 单人帧:只有一张脸;双人帧:左右两张,主脸(最大的那张)在右边。 */
  const solo = (t: number, c: number): FaceSample => ({ t, cx: c, left: c - 0.03, right: c + 0.03, faceCount: 1, faces: [{ left: c - 0.03, right: c + 0.03 }] });
  const twoShot = (t: number): FaceSample => ({
    t,
    cx: 0.8,
    left: 0.14,
    right: 0.86,
    faceCount: 2,
    faces: [{ left: 0.14, right: 0.26 }, { left: 0.74, right: 0.86 }],
  });

  /** 前 6 帧各给一个说话人一段独处(建立锚点),后 6 帧两人同框。 */
  function scene(): { samples: FaceSample[]; speakers: Array<number | null> } {
    const samples: FaceSample[] = [];
    const speakers: Array<number | null> = [];
    for (let i = 0; i < 3; i++) {
      samples.push(solo(i / 3, 0.2));
      speakers.push(0);
    }
    for (let i = 3; i < 6; i++) {
      samples.push(solo(i / 3, 0.8));
      speakers.push(1);
    }
    for (let i = 6; i < 12; i++) {
      samples.push(twoShot(i / 3));
      speakers.push(0);
    }
    return { samples, speakers };
  }

  it("speakerAnchors:只在单人帧上学,样本太少不采信", () => {
    const { samples, speakers } = scene();
    const anchors = speakerAnchors(samples, speakers);
    expect(anchors.get(0)).toBeCloseTo(0.2, 3);
    expect(anchors.get(1)).toBeCloseTo(0.8, 3);
    // 只有两帧单人镜头 → 不建锚点
    expect(speakerAnchors(samples.slice(0, 2), [0, 0]).size).toBe(0);
  });

  it("两张脸挤不下时跟说话的人,而不是最大的那张", () => {
    const { samples, speakers } = scene();
    const planned = planCropComposition(samples, [], W, H, speakers)!;
    expect(planned.stats.speakerShots).toBe(1);
    // 末帧说话人是 0(左边那位):裁窗落在左脸那一侧,不是主脸 0.8。
    const last = cropXAtTime(planned.keyframes, samples[samples.length - 1].t);
    expect(Math.abs(last - xOf(0.2))).toBeLessThan(Math.abs(last - xOf(0.8)));
    // 不给说话人数据 → 老行为:跟主脸(右边那张)。
    const blind = planCropComposition(samples, [], W, H)!;
    expect(cropXAtTime(blind.keyframes, samples[samples.length - 1].t)).toBeGreaterThan(xOf(0.6));
    expect(blind.stats.speakerShots).toBe(0);
  });

  it("两个人都装得下时仍然锁全景,说话人不插手", () => {
    const samples: FaceSample[] = [];
    const speakers: Array<number | null> = [];
    for (let i = 0; i < 3; i++) {
      samples.push(solo(i / 3, 0.5));
      speakers.push(0);
    }
    for (let i = 3; i < 9; i++) {
      samples.push({
        t: i / 3,
        cx: 0.55,
        left: 0.44,
        right: 0.6,
        faceCount: 2,
        faces: [{ left: 0.44, right: 0.5 }, { left: 0.54, right: 0.6 }],
      });
      speakers.push(0);
    }
    const planned = planCropComposition(samples, [], W, H, speakers)!;
    expect(planned.stats.lockedShots).toBe(1);
    expect(planned.stats.speakerShots).toBe(0);
  });
});

describe("crop trajectory / subject coverage", () => {
  it("holds a locked shot until the next cut instead of drifting across it", () => {
    const keyframes = [
      { t: 0, x: 100, hold: true },
      { t: 2, x: 500, hold: true },
    ];
    expect(cropXAtTime(keyframes, 1.9)).toBe(100);
    expect(cropXAtTime(keyframes, 2)).toBe(500);
    expect(renderCropXExpr(keyframes)).toContain("if(lt(t,2.000),100,500)");
  });

  it("compiles an eased segment as a cubic smoothstep", () => {
    const keyframes = [
      { t: 0, x: 100, ease: true },
      { t: 2, x: 500, hold: true },
    ];
    expect(renderCropXExpr(keyframes)).toContain("*(3-2*");
    expect(cropXAtTime(keyframes, 0.5)).toBeCloseTo(100 + 400 * smoothstep(0.25), 6);
  });

  it("keeps linear motion inside a tracking shot then holds its tail", () => {
    const keyframes = [
      { t: 0, x: 100 },
      { t: 1, x: 300, hold: true },
      { t: 3, x: 700, hold: true },
    ];
    expect(cropXAtTime(keyframes, 0.5)).toBe(200);
    expect(cropXAtTime(keyframes, 2.5)).toBe(300);
  });

  it("reports the least-visible face per sampled frame", () => {
    const samples: FaceSample[] = [
      { t: 0, cx: 0.3, faces: [{ left: 0.25, right: 0.35 }] },
      { t: 1, cx: 0.5, faces: [{ left: 0.45, right: 0.6 }] },
    ];
    const coverage = evaluateCropCoverage(samples, [{ t: 0, x: 200, hold: true }], 1000, 300);
    expect(coverage[0].minVisibleFraction).toBe(1);
    expect(coverage[1].minVisibleFraction).toBeCloseTo(1 / 3, 3);
  });

  it("keeps every shot boundary even when it exceeds the soft keyframe limit", () => {
    const keyframes = Array.from({ length: 40 }, (_, i) => ({ t: i, x: i * 10, hold: true }));
    expect(downsampleKeyframes(keyframes, 8)).toEqual(keyframes);
  });

  it("does not interpolate crop motion through a removed jump-cut gap", () => {
    const source = [
      { t: 0, x: 0 },
      { t: 10, x: 1000, hold: true },
    ];
    const mapped = remapCropKeyframes(source, [
      { startSec: 100, endSec: 102 },
      { startSec: 108, endSec: 110 },
    ], 100);
    expect(cropXAtTime(mapped, 1)).toBeCloseTo(100, 3);
    expect(cropXAtTime(mapped, 2)).toBeCloseTo(800, 3);
    expect(cropXAtTime(mapped, 3)).toBeCloseTo(900, 3);
  });

  it("switches framing at the cross-fade, not at the source end", () => {
    const source = [
      { t: 0, x: 0 },
      { t: 10, x: 1000, hold: true },
    ];
    const mapped = remapCropKeyframes(source, [
      { startSec: 100, endSec: 102 },
      { startSec: 108, endSec: 110 },
    ], 100, 0.4);
    // The blend starts 0.4 s before the piece ends, so the second piece's
    // framing is already on screen at 1.6 s, not at the raw 2 s source end.
    expect(cropXAtTime(mapped, 1.6)).toBeCloseTo(800, 1);
    // 0.3 s into the second piece it has moved on from 800, never back near 190.
    expect(cropXAtTime(mapped, 1.9)).toBeCloseTo(830, 1);
    // The whole output is 0.4 s shorter than the summed pieces.
    expect(cropXAtTime(mapped, 3.6)).toBeCloseTo(1000, 1);
  });

  it("clamps a cross-fade longer than half the piece", () => {
    const source = [
      { t: 0, x: 0 },
      { t: 10, x: 1000, hold: true },
    ];
    const mapped = remapCropKeyframes(source, [
      { startSec: 100, endSec: 101 },
      { startSec: 108, endSec: 110 },
    ], 100, 5);
    // A 5 s blend over a 1 s piece would erase it; clamped to 0.5 s.
    expect(cropXAtTime(mapped, 0.5)).toBeCloseTo(800, 1);
  });
});

describe("OneEuro / smoothstep", () => {
  it("smooths jitter but follows real movement", () => {
    const euro = new OneEuro();
    let out = 0;
    // jittery around 0.5
    for (let i = 0; i < 20; i++) out = euro.filter(0.5 + (i % 2 === 0 ? 0.01 : -0.01), i / 3);
    expect(Math.abs(out - 0.5)).toBeLessThan(0.01);
  });

  it("smoothstep eases both ends and is symmetric", () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBe(0.5);
    expect(smoothstep(0.25)).toBeCloseTo(0.15625, 6);
    expect(smoothstep(0.75)).toBeCloseTo(0.84375, 6);
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(2)).toBe(1);
  });
});

describe("renderSendcmd", () => {
  it("targets crop@track and clamps negative times", () => {
    const cmd = renderSendcmd([
      { t: -0.01, x: 100 },
      { t: 1.5, x: 240 },
    ]);
    expect(cmd).toBe("0.000 crop@track x 100;\n1.500 crop@track x 240;\n");
  });
});

describe("mapToOutputTime", () => {
  const segments = [
    { startSec: 10, endSec: 12 },
    { startSec: 14, endSec: 16 },
  ];

  it("maps kept times and drops spliced-out ones", () => {
    expect(mapToOutputTime(0.5, segments, 10)).toBeCloseTo(0.5, 5); // 10.5 abs
    expect(mapToOutputTime(3, segments, 10)).toBeNull(); // 13 abs — cut out
    expect(mapToOutputTime(5, segments, 10)).toBeCloseTo(3, 5); // 15 abs → 2 + 1
  });

  it("subtracts each cross-fade crossed from later output times", () => {
    expect(mapToOutputTime(0.5, segments, 10, 0.4)).toBeCloseTo(0.5, 5); // before seam
    expect(mapToOutputTime(5, segments, 10, 0.4)).toBeCloseTo(2.6, 5); // 15 abs → 1.6 + 1
    expect(mapToOutputTime(6, segments, 10, 0.4)).toBeCloseTo(3.6, 5); // output end
  });
});

describe("decodeYunet", () => {
  it("decodes a synthetic single-anchor hit with sqrt scoring and exp size", () => {
    const fw = YUNET_INPUT / 32;
    const n = fw * fw;
    const cls = new Float32Array(n);
    const obj = new Float32Array(n);
    const bbox = new Float32Array(n * 4);
    const idx = 5 * fw + 8; // row 5, col 8
    cls[idx] = 0.81;
    obj[idx] = 1.0;
    bbox[idx * 4] = 0.5; // dx
    bbox[idx * 4 + 1] = 0.5;
    bbox[idx * 4 + 2] = Math.log(4); // w = 4*32
    bbox[idx * 4 + 3] = Math.log(4);
    const empty8 = { data: new Float32Array(0) };
    const boxes = decodeYunet({
      cls_8: empty8, obj_8: empty8, bbox_8: empty8,
      cls_16: empty8, obj_16: empty8, bbox_16: empty8,
      cls_32: { data: cls }, obj_32: { data: obj }, bbox_32: { data: bbox },
    });
    expect(boxes).toHaveLength(1);
    expect(boxes[0].score).toBeCloseTo(0.9, 5);
    expect(boxes[0].w).toBeCloseTo(128, 3);
    expect(boxes[0].x).toBeCloseTo((8 + 0.5) * 32 - 64, 3);
  });
});

describe("pickMainFace continuity", () => {
  const box = (x: number, size: number): FaceBox => ({ x, y: 100, w: size, h: size, score: 0.9 });

  it("sticks with the tracked face even when a bigger one appears", () => {
    const prev = box(100, 100);
    const picked = pickMainFace([box(105, 100), box(400, 130)], prev);
    expect(picked!.x).toBe(105); // continuity beats area
  });

  it("switches to the biggest face when the track is lost", () => {
    const prev = box(100, 100);
    const picked = pickMainFace([box(400, 130), box(600, 90)], prev);
    expect(picked!.x).toBe(400);
  });

  it("keeps identity through motion that clears its own box between frames", () => {
    const prev = box(100, 100); // centre x = 150
    // The subject moved 2.05 face-widths — zero IoU with `prev` — while a
    // differently-sized person sits further right.
    const moved = box(300, 110);
    expect(iou(moved, prev)).toBe(0);
    const picked = pickMainFace([moved, box(500, 140)], prev);
    expect(picked!.x).toBe(300);
  });

  it("rejects a face at a different depth even when it overlaps", () => {
    const prev = box(100, 100);
    expect(matchCost(box(100, 400), prev)).toBeNull(); // 4x the size
    expect(matchCost(box(100, 100), prev)).toBeCloseTo(0, 6);
  });

  it("no previous → biggest face; empty → null", () => {
    expect(pickMainFace([box(50, 80), box(300, 120)], null)!.x).toBe(300);
    expect(pickMainFace([], null)).toBeNull();
  });
});

describe("裁窗边距(运镜超采样要借 1 像素)", () => {
  const W = 1920;
  const H = 1080;
  const cropW = Math.floor((H * 9) / 16 / 2) * 2;

  it("贴左缘的主体:裁窗不贴到 0,留 1 像素给 floor(X)-1", () => {
    const kfs = planCropTrack(samplesOf([0, 0.01, 0.02, 0.03, 0.04]), [], W, H)!;
    expect(Math.min(...kfs.map((k) => k.x))).toBeGreaterThanOrEqual(1);
  });

  it("贴右缘的主体:裁窗右边也留 1 像素(放大帧上还要多裁 2 列)", () => {
    const kfs = planCropTrack(samplesOf([1, 0.99, 0.98, 0.97, 0.96]), [], W, H)!;
    expect(Math.max(...kfs.map((k) => k.x))).toBeLessThanOrEqual(W - cropW - 1);
  });

  it("余量不足 2 像素时不借位,裁窗仍完整落在画面里", () => {
    const srcH = 1080;
    const srcW = cropW + 1; // 只剩 1 像素余量:借不动
    const kfs = planCropTrack(samplesOf([0, 0.5, 1]), [], srcW, srcH)!;
    expect(kfs.length).toBeGreaterThan(0);
    for (const k of kfs) {
      expect(k.x).toBeGreaterThanOrEqual(0);
      expect(k.x).toBeLessThanOrEqual(srcW - cropW);
    }
  });
});
