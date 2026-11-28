/**
 * 竖屏填边方式(见 core/fill.ts)的接线钉子。
 *
 * 之前这套能力只有引擎里有:值只能由 CutOptions/ExportRenderOptions 给,
 * 界面上没有开关,用户开不出来。这个测试盯住三件事:
 *  - 出厂默认仍是「居中裁剪」——升级不改任何人的成片;
 *  - 面板里选了「模糊」,ExportOptions.fillMode 真的变成 blur;
 *  - 这个值经主进程那一步(IPC unknown → FillMode)之后,真的换掉了画面滤镜链。
 *    最后一跳不能只看类型:开关死了(= 值到了但引擎不认)是这个项目踩过的坑。
 */
import { describe, expect, it } from "vitest";
import { buildVideoFilters } from "../../../../../core/cut";
import { normalizeFillMode } from "../../../../../shared/api-types";
import { BUILTIN_SCHEMES, SCHEME_KEYS, matchesScheme, snapshotOf } from "../../../stores/scheme-store";
import { RENDER_PREF_DEFAULTS, type RenderPrefs } from "../../../stores/render-prefs-store";
import { buildRenderToggles } from "../export-options";

/** 面板上的出片选项(与 Workbench 里手动出片/托管两条路径同一份)。 */
function toggles(patch: Partial<RenderPrefs> = {}): ReturnType<typeof buildRenderToggles> {
  return buildRenderToggles({
    prefs: { ...RENDER_PREF_DEFAULTS, ...patch },
    config: { baseUrl: "", apiKey: "", model: "" },
    brandState: { presets: [], activeId: "default" },
    diarize: false,
    transcript: null,
    atlasReady: false,
  });
}

/** 主进程那一步照做一遍:IPC 收上来的是 unknown,只认合法值。 */
function pictureFilters(patch: Partial<RenderPrefs> = {}): string[] {
  return buildVideoFilters({
    vertical: true,
    fillMode: normalizeFillMode(toggles(patch).fillMode),
    srcW: 1920,
    srcH: 1080,
  });
}

const hasBlurFill = (filters: string[]): boolean => filters.some((f) => f.startsWith("split=2[bg0][fg0];"));

describe("fillMode:面板选择 → 出片选项 → 画面滤镜", () => {
  it("出厂默认是 crop:老用户升级后画面一个像素都不变", () => {
    expect(RENDER_PREF_DEFAULTS.fillMode).toBe("crop");
    expect(toggles().fillMode).toBe("crop");
    expect(hasBlurFill(pictureFilters())).toBe(false);
  });

  it("选了「模糊」→ 值变成 blur,滤镜链换成模糊填边(居中裁剪那步消失)", () => {
    expect(toggles({ fillMode: "blur" }).fillMode).toBe("blur");
    const filters = pictureFilters({ fillMode: "blur" });
    expect(hasBlurFill(filters)).toBe(true);
    expect(filters.join(",")).toContain("gblur=");
  });

  it("横屏出口不受影响(开关只管竖屏那一路)", () => {
    const filters = buildVideoFilters({
      vertical: false,
      fillMode: normalizeFillMode(toggles({ fillMode: "blur" }).fillMode),
      srcW: 1920,
      srcH: 1080,
    });
    expect(hasBlurFill(filters)).toBe(false);
  });
});

describe("normalizeFillMode:IPC 上来的值只认两种", () => {
  it("缺省 / 乱值一律回落「没指定」(引擎按历史行为裁剪)", () => {
    for (const junk of [undefined, null, "", "blur ", "B LUR", 1, {}, []]) {
      expect(normalizeFillMode(junk)).toBeUndefined();
    }
  });
  it("合法值原样透传", () => {
    expect(normalizeFillMode("crop")).toBe("crop");
    expect(normalizeFillMode("blur")).toBe("blur");
  });
});

describe("方案快照带上这个开关", () => {
  it("存/认方案时 fillMode 进快照(否则切方案会把用户的选择抹掉)", () => {
    expect(SCHEME_KEYS).toContain("fillMode");
    expect(snapshotOf({ ...RENDER_PREF_DEFAULTS, fillMode: "blur" }).fillMode).toBe("blur");
    expect(matchesScheme({ ...RENDER_PREF_DEFAULTS, fillMode: "blur" }, BUILTIN_SCHEMES[0])).toBe(false);
    expect(matchesScheme({ ...RENDER_PREF_DEFAULTS, fillMode: "crop" }, BUILTIN_SCHEMES[0])).toBe(true);
  });
});
