import { describe, it, expect } from "vitest";
import { BLUR_FILL_DIM, BLUR_FILL_SIGMA, blurFillStage, planFill } from "../fill";
import { buildVideoFilters } from "../cut";

describe("blurFillStage(滤镜串)", () => {
  it("split 起两路:背景放大裁满 + 模糊 + 压暗,上层整帧缩到框内,居中叠加", () => {
    const s = blurFillStage(1080, 1920);
    expect(s.startsWith("split=2[bg0][fg0];")).toBe(true);
    expect(s).toContain(
      `[bg0]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=${BLUR_FILL_SIGMA},eq=brightness=${BLUR_FILL_DIM}[bg]`
    );
    expect(s).toContain("[fg0]scale=1080:1920:force_original_aspect_ratio=decrease[fg]");
    // 最后一条链不带标签 → 后面的滤镜(字幕/变速)能接着逗号连下去
    expect(s.endsWith("[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1")).toBe(true);
  });

  it("尺寸取偶数(crop 与编码器都按偶数走)", () => {
    expect(blurFillStage(1079, 1919)).toContain("scale=1078:1918");
  });
});

describe("planFill(什么时候用模糊填边)", () => {
  const base = { mode: "blur" as const, vertical: true, hasTrack: false, hasZoom: false, srcW: 1920, srcH: 1080, outW: 1080, outH: 1920 };

  it("横屏源进竖屏画幅 + 没有跟拍/运镜 → blur", () => {
    expect(planFill(base)).toBe("blur");
  });

  it("缺省(不传)永远是 crop —— 历史行为不变", () => {
    expect(planFill({ ...base, mode: undefined })).toBe("crop");
    expect(planFill({ ...base, mode: "crop" })).toBe("crop");
  });

  it("有跟拍目标 / 有运镜 → crop(构图已经有人主张,不叠第二套)", () => {
    expect(planFill({ ...base, hasTrack: true })).toBe("crop");
    expect(planFill({ ...base, hasZoom: true })).toBe("crop");
  });

  it("不是竖屏出口 → crop(横屏出口就是源画幅,没有边要填)", () => {
    expect(planFill({ ...base, vertical: false })).toBe("crop");
  });

  it("源画幅已经等于目标画幅 → crop(省一次放大+模糊,画面本来就没有边)", () => {
    expect(planFill({ ...base, srcW: 1080, srcH: 1920 })).toBe("crop");
    expect(planFill({ ...base, srcW: 608, srcH: 1080 })).toBe("crop");
  });

  it("尺寸未知就按调用方的要求办(不看画幅)", () => {
    expect(planFill({ ...base, srcW: 0, srcH: 0 })).toBe("blur");
    expect(planFill({ ...base, srcW: undefined, srcH: undefined })).toBe("blur");
  });
});

describe("buildVideoFilters 接线(模糊填边)", () => {
  it("竖屏 + fillMode:blur → 换成模糊填边链,居中裁剪那一步消失", () => {
    const f = buildVideoFilters({ vertical: true, fillMode: "blur", srcW: 1920, srcH: 1080 });
    expect(f.some((x) => x.startsWith("split=2[bg0][fg0];"))).toBe(true);
    expect(f.join(",")).not.toContain("crop=w='min(iw,ih*9/16)'");
  });

  it("缺省 / 有跟拍 / 有运镜 → 照旧居中裁剪(回归锁)", () => {
    for (const opts of [
      { vertical: true, srcW: 1920, srcH: 1080 },
      { vertical: true, fillMode: "blur" as const, srcW: 1920, srcH: 1080, trackPlan: { cropXExpr: "100", cropW: 600, cropH: 1000, cropY: 40 } },
      { vertical: true, fillMode: "blur" as const, srcW: 1920, srcH: 1080, autoZoom: { durationSec: 2, fps: 30, punchTo: 1.08, outW: 1080, outH: 1920 } },
    ]) {
      const f = buildVideoFilters(opts);
      expect(f.some((x) => x.includes("split=2[bg0]"))).toBe(false);
    }
  });

  it("模糊填边后面接的字幕与变速仍在同一条链上(逗号连下去)", () => {
    const f = buildVideoFilters({
      vertical: true,
      fillMode: "blur",
      srcW: 1920,
      srcH: 1080,
      subtitlePath: "c.ass",
      speedRate: 1.4,
    });
    const i = f.findIndex((x) => x.startsWith("split=2[bg0][fg0];"));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(f[i + 1]).toContain("subtitles=");
    expect(f[i + 2]).toBe("setpts=(PTS-STARTPTS)/1.4000");
  });
});
