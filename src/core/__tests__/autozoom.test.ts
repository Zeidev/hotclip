import { describe, it, expect } from "vitest";
import {
  planZoomKeyframes,
  renderZoomExpr,
  buildZoomFilter,
  zoomSupersampleFactor,
  zoomSupersampleStage,
  ZOOM_BASE,
  ZOOM_BREATH,
  ZOOM_EMPHASIS,
  ZOOM_MIN_CLIP_SEC,
  ZOOM_PUNCH_END,
} from "../autozoom";

describe("planZoomKeyframes:punchTo(冷开场单向推近)", () => {
  it("整段从 1.0 推到 punchTo,短于 4 秒也生效", () => {
    expect(planZoomKeyframes(2.5, { punchTo: ZOOM_PUNCH_END })).toEqual([
      { t: 0, z: ZOOM_BASE },
      { t: 2.5, z: ZOOM_PUNCH_END },
    ]);
  });

  it("punchTo 不放宽普通路径:短片仍然不运镜", () => {
    expect(planZoomKeyframes(2.5)).toEqual([]);
  });

  it("只有起止两个关键帧(没有呼吸回落)", () => {
    const kfs = planZoomKeyframes(3, { punchTo: ZOOM_PUNCH_END });
    expect(kfs).toHaveLength(2);
    expect(kfs[1].z).toBeGreaterThan(kfs[0].z);
  });

  it("buildZoomFilter:punch 短片不返回 null,保留源帧率与目标尺寸", () => {
    const f = buildZoomFilter(2.5, 30, 1080, 1920, { punchTo: ZOOM_PUNCH_END })!;
    expect(f).toContain("s=1080x1920");
    expect(f).toContain("fps=30");
    // 无 punchTo 时仍是旧行为:太短不做运镜
    expect(buildZoomFilter(2.5, 30, 1080, 1920)).toBeNull();
  });
});

describe("planZoomKeyframes", () => {
  it("太短的切片不做运镜(推不到位只会显得晃)", () => {
    expect(planZoomKeyframes(ZOOM_MIN_CLIP_SEC - 0.1)).toEqual([]);
    expect(planZoomKeyframes(0)).toEqual([]);
  });

  it("呼吸节奏:从基准起步,在基准与推近之间来回,不会一路推到底", () => {
    const kfs = planZoomKeyframes(30);
    expect(kfs[0]).toEqual({ t: 0, z: ZOOM_BASE });
    const zooms = kfs.map((k) => k.z);
    expect(Math.max(...zooms)).toBeCloseTo(ZOOM_BREATH, 5);
    expect(Math.min(...zooms)).toBeCloseTo(ZOOM_BASE, 5);
    // 回落过:峰值之后一定还有一个基准值
    const firstPeak = zooms.findIndex((z) => z > ZOOM_BASE);
    expect(zooms.slice(firstPeak).some((z) => z === ZOOM_BASE)).toBe(true);
  });

  it("关键帧时间严格递增且不超片长", () => {
    const kfs = planZoomKeyframes(47, { emphasisAtSec: [5, 20, 33] });
    for (let i = 1; i < kfs.length; i++) expect(kfs[i].t).toBeGreaterThan(kfs[i - 1].t);
    expect(kfs[kfs.length - 1].t).toBeLessThanOrEqual(47);
    expect(kfs.every((k) => k.z >= ZOOM_BASE)).toBe(true);
  });

  it("强调时刻推到最近,并且是先动镜头后到内容", () => {
    const kfs = planZoomKeyframes(40, { emphasisAtSec: [20] });
    const peak = kfs.find((k) => k.z === ZOOM_EMPHASIS);
    expect(peak).toBeDefined();
    expect(peak!.t).toBeLessThanOrEqual(20);
    // 推近之前有一个基准帧(起推点),在强调点之前
    const lead = kfs.filter((k) => k.t < peak!.t && k.z === ZOOM_BASE).pop();
    expect(lead).toBeDefined();
  });

  it("breathZoom 压成基准 = 只做强调推近(节奏兜底那一层)", () => {
    const kfs = planZoomKeyframes(30, { emphasisAtSec: [8, 20], breathZoom: ZOOM_BASE, emphasisZoom: ZOOM_BREATH });
    const bumped = kfs.filter((k) => k.z > ZOOM_BASE);
    // 只有两处推近,幅度是呼吸峰值;中间那 12 秒不呼吸(全为基准)
    expect(bumped.every((k) => k.z === ZOOM_BREATH)).toBe(true);
    expect(kfs.filter((k) => k.t > 10 && k.t < 18).every((k) => k.z === ZOOM_BASE)).toBe(true);
  });

  it("挨得很近的多个强调并成一段长推近,不来回抽搐", () => {
    const kfs = planZoomKeyframes(40, { emphasisAtSec: [20, 20.5, 21] });
    // 只推近一次、只回落一次
    let rises = 0;
    let falls = 0;
    for (let i = 1; i < kfs.length; i++) {
      if (kfs[i].z === ZOOM_EMPHASIS && kfs[i - 1].z < ZOOM_EMPHASIS) rises++;
      if (kfs[i - 1].z === ZOOM_EMPHASIS && kfs[i].z < ZOOM_EMPHASIS) falls++;
    }
    expect(rises).toBe(1);
    expect(falls).toBe(1);
  });

  it("任何两个关键帧之间的变焦速度都在人眼可接受范围(不出现瞬间跳变)", () => {
    // 每秒变焦超过 0.3 倍就是抽搐——曾经的 bug:两个相邻强调合并时
    // 前一段的回落点没清掉,导致 0.1 秒内从 1.0 猛推到 1.1
    const cases = [
      [8, 8.5],
      [8, 8.5, 22],
      [5, 5.2, 5.4, 5.6],
      [10, 11, 12, 13, 14],
    ];
    for (const emphasisAtSec of cases) {
      const kfs = planZoomKeyframes(30, { emphasisAtSec });
      for (let i = 1; i < kfs.length; i++) {
        const dz = Math.abs(kfs[i].z - kfs[i - 1].z);
        const dt = kfs[i].t - kfs[i - 1].t;
        expect(dz / dt).toBeLessThanOrEqual(0.3);
      }
    }
  });

  it("越界的强调时刻被忽略", () => {
    const kfs = planZoomKeyframes(20, { emphasisAtSec: [-5, 100, NaN] });
    expect(kfs.every((k) => k.z <= ZOOM_BREATH)).toBe(true);
  });
});

describe("renderZoomExpr", () => {
  it("空关键帧 = 不缩放", () => {
    expect(renderZoomExpr([])).toBe("1");
  });

  it("单关键帧 = 常量倍率", () => {
    expect(renderZoomExpr([{ t: 0, z: 1.05 }])).toBe("1.0500");
  });

  it("分段线性插值,自变量是 in_time(不是输出帧号)", () => {
    const expr = renderZoomExpr([
      { t: 0, z: 1 },
      { t: 5, z: 1.1 },
    ]);
    expect(expr).toContain("in_time");
    expect(expr).toContain("lt(in_time,5.000)");
    expect(expr).not.toContain("NaN");
  });

  it("关键帧过多时降采样,嵌套深度受控", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ t: i, z: 1 + (i % 2) * 0.05 }));
    const expr = renderZoomExpr(many, 8);
    expect((expr.match(/if\(/g) ?? []).length).toBeLessThanOrEqual(8);
    expect(expr).not.toContain("NaN");
  });

  it("同一时刻的重复关键帧不产生除零", () => {
    const expr = renderZoomExpr([
      { t: 1, z: 1 },
      { t: 1, z: 1.1 },
      { t: 3, z: 1 },
    ]);
    expect(expr).not.toContain("Infinity");
    expect(expr).not.toContain("NaN");
    expect(expr).not.toContain("/0.0000");
  });
});

describe("buildZoomFilter", () => {
  it("生成 zoompan 串:居中缩放、输出目标尺寸、显式带上源帧率", () => {
    const f = buildZoomFilter(30, 30, 1080, 1920)!;
    expect(f).toContain("zoompan=");
    expect(f).toContain("s=1080x1920");
    expect(f).toContain("fps=30"); // 不显式给 fps 会被重采样到 25
    expect(f).toContain("d=1");
    expect(f).toContain("iw/2-(iw/zoom/2)");
  });

  it("帧率未知时拒绝生成(宁可不运镜也不能改帧率)", () => {
    expect(buildZoomFilter(30, 0, 1080, 1920)).toBeNull();
    expect(buildZoomFilter(30, NaN, 1080, 1920)).toBeNull();
  });

  it("太短的切片返回 null,调用方退回普通 scale", () => {
    expect(buildZoomFilter(2, 30, 1080, 1920)).toBeNull();
  });
});
describe("zoomSupersampleFactor / zoomSupersampleStage(运镜抖动的量化网格)", () => {
  it("1080p 的两条出口都吃得下 SS=2", () => {
    expect(zoomSupersampleFactor(608, 1080)).toBe(2); // 竖屏裁窗
    expect(zoomSupersampleFactor(606, 1080)).toBe(2);
    expect(zoomSupersampleFactor(1920, 1080)).toBe(2); // 横屏整帧
  });
  it("工作帧超过 12MP 就退回 1(4K/1440p)", () => {
    expect(zoomSupersampleFactor(3840, 2160)).toBe(1);
    expect(zoomSupersampleFactor(2560, 1440)).toBe(1);
  });
  it("尺寸缺失或非法一律不放大——宁可有抖动,也不能把显存吃穿", () => {
    expect(zoomSupersampleFactor(0, 1080)).toBe(1);
    expect(zoomSupersampleFactor(1920, 0)).toBe(1);
    expect(zoomSupersampleFactor(NaN, NaN)).toBe(1);
    expect(zoomSupersampleFactor(-1920, 1080)).toBe(1);
  });
  it("阶段串:SS<2 为空串,SS=2 是 lanczos 放大 + yuv444p(消掉色度网格)", () => {
    expect(zoomSupersampleStage(1)).toBe("");
    expect(zoomSupersampleStage(0)).toBe("");
    expect(zoomSupersampleStage(2)).toBe("scale=iw*2:ih*2:flags=lanczos,format=yuv444p");
  });
});
