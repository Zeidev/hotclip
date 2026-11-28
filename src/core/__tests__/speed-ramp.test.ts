import { describe, it, expect } from "vitest";
import {
  HOOK_RAMP_RATE,
  HOOK_RAMP_MIN_SEC,
  rampDuration,
  speedVideoStage,
  speedAudioStage,
  planHookRamp,
} from "../speed-ramp";
import { buildCutArgs, buildJumpCutArgs, buildVideoFilters } from "../cut";

describe("rampDuration(时长换算)", () => {
  it("1.4× 时 1.4s 变 1.0s;倍率非法按 1 算(不变速)", () => {
    expect(rampDuration(1.4, HOOK_RAMP_RATE)).toBe(1);
    expect(rampDuration(2, 1)).toBe(2);
    expect(rampDuration(2, 0)).toBe(2);
    expect(rampDuration(2, NaN)).toBe(2);
    expect(rampDuration(2, -1.4)).toBe(2);
  });
});

describe("speedVideoStage / speedAudioStage(滤镜串)", () => {
  it("画面 setpts、声音 atempo,都保留 4 位倍率", () => {
    expect(speedVideoStage(1.4)).toBe("setpts=(PTS-STARTPTS)/1.4000");
    expect(speedAudioStage(1.4)).toBe("atempo=1.4000");
  });

  it("倍率 1 / 缺省 / 非法 = 空串(链路逐字节不变)", () => {
    for (const r of [undefined, 1, 1.0000001, NaN, 0, -2]) {
      expect(speedVideoStage(r)).toBe("");
      expect(speedAudioStage(r)).toBe("");
    }
  });

  it("倍率被夹到 atempo 单实例范围 [0.5, 2]", () => {
    expect(speedAudioStage(4)).toBe("atempo=2.0000");
    expect(speedVideoStage(4)).toBe("setpts=(PTS-STARTPTS)/2.0000");
    expect(speedAudioStage(0.2)).toBe("atempo=0.5000");
  });
});

describe("planHookRamp(什么时候变速)", () => {
  it("只有爆点闪现变速,钩子句冷开场不动(语速被推快就是赶场)", () => {
    expect(planHookRamp({ sourceSec: 2.5, isFlash: false })).toBeNull();
    expect(planHookRamp({ sourceSec: 2.5, isFlash: true })).toEqual({ rate: HOOK_RAMP_RATE, outputSec: 1.786 });
  });

  it("太短的迷你片不变速(再快就成了一次闪)", () => {
    expect(planHookRamp({ sourceSec: HOOK_RAMP_MIN_SEC - 0.01, isFlash: true })).toBeNull();
    expect(planHookRamp({ sourceSec: HOOK_RAMP_MIN_SEC, isFlash: true })).not.toBeNull();
  });
});

describe("buildCutArgs 接线(变速)", () => {
  it("画面 setpts 在滤镜链最后(字幕烧完之后),声音 atempo 在音频链最后", () => {
    const args = buildCutArgs("in.mp4", "out.mp4", 5, 7.4, { speedRate: HOOK_RAMP_RATE, subtitlePath: "c.ass" });
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf.endsWith("setpts=(PTS-STARTPTS)/1.4000")).toBe(true);
    expect(vf.indexOf("subtitles=")).toBeLessThan(vf.indexOf("setpts="));
    const af = args[args.indexOf("-af") + 1];
    expect(af.endsWith("atempo=1.4000")).toBe(true);
    // 淡入淡出按源时间先做完(淡化时长不跟着被提前压缩)
    expect(af.indexOf("afade=")).toBeLessThan(af.indexOf("atempo="));
  });

  it("变速时 -t 挪到 -i 前面(量源时间;放输出侧会多吃 1.4 倍的源)", () => {
    const fast = buildCutArgs("in.mp4", "out.mp4", 5, 8, { speedRate: HOOK_RAMP_RATE });
    expect(fast.indexOf("-t")).toBeLessThan(fast.indexOf("-i"));
    expect(fast[fast.indexOf("-t") + 1]).toBe("00:00:03.000");
    const plain = buildCutArgs("in.mp4", "out.mp4", 5, 8, {});
    expect(plain.indexOf("-i")).toBeLessThan(plain.indexOf("-t"));
    expect(plain[plain.indexOf("-t") + 1]).toBe("00:00:03.000");
  });

  it("跳切不支持变速 → 当场报错(它的时间轴是自己拼的)", () => {
    expect(() =>
      buildJumpCutArgs("in.mp4", "out.mp4", 0, [{ startSec: 0, endSec: 1 }], { speedRate: 1.4 })
    ).toThrow(/not supported by jump cuts/);
  });

  it("没有倍率时链路里一个变速滤镜都没有(回归锁)", () => {
    const args = buildCutArgs("in.mp4", "out.mp4", 5, 7, {});
    expect(args.join(" ")).not.toContain("setpts=(PTS-STARTPTS)/");
    expect(args.join(" ")).not.toContain("atempo=");
  });

  it("变速强制重编码:即使调用方要求 copy 也升级到 accurate", () => {
    const args = buildCutArgs("in.mp4", "out.mp4", 0, 2, { mode: "copy", videoCopy: true, speedRate: 1.4 });
    expect(args).not.toContain("copy");
  });

  it("与环形收口同时出现 → 当场报错(收口按源时长倒放,两者不可能同时对)", () => {
    expect(() => buildCutArgs("in.mp4", "out.mp4", 0, 5, { speedRate: 1.4, loopCloseSec: 0.3 })).toThrow(
      /speedRate cannot be combined/
    );
  });

  it("buildVideoFilters:变速也吃竖屏裁切/运镜那条早退分支", () => {
    const f = buildVideoFilters({
      trackPlan: { cropXExpr: "100", cropW: 600, cropH: 1000, cropY: 40 },
      srcW: 1920,
      srcH: 1080,
      autoZoom: { durationSec: 2, fps: 30, punchTo: 1.08, outW: 1080, outH: 1920 },
      speedRate: 1.4,
    });
    expect(f[f.length - 1]).toBe("setpts=(PTS-STARTPTS)/1.4000");
  });
});