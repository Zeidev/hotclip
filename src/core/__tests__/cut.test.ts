import { describe, it, expect } from "vitest";
import {
  buildCutArgs,
  buildJumpCutArgs,
  buildVideoFilters,
  buildColdSeamArgs,
  coldSeamXfadeName,
  pickColdSeamTransition,
  COLD_SEAM_TRANSITIONS,
  COLD_SEAM_XFADE_SEC,
  escapeFilterPath,
  metadataArgs,
  parseFfmpegProgress,
  edgeFadeFilters,
  LOUDNORM_FILTER,
  LOUDNORM_OUT_RATE,
  DENOISE_FILTER,
  EDGE_FADE_SEC,
  SEAM_LEAD_SEC,
  seamCrossfades,
  loopCloseSec,
  LOOP_CLOSE_SEC,
  type ColdSeamTransition,
} from "../cut";
import type { ColorRenderPlan } from "../color";
import type { VisualEnhancePlan } from "../visual-enhance";

function colorPlan(detected: "pq" | "hlg" | "sdr"): ColorRenderPlan {
  const hdr = detected !== "sdr";
  return {
    source: {
      pixelFormat: hdr ? "yuv420p10le" : "yuv420p",
      bitDepth: hdr ? 10 : 8,
      primaries: hdr ? "bt2020" : "bt709",
      transfer: detected === "pq" ? "smpte2084" : detected === "hlg" ? "arib-std-b67" : "bt709",
      space: hdr ? "bt2020nc" : "bt709",
      range: "tv",
      peakNits: hdr ? 0 : 100,
    },
    detected,
    action: hdr ? "tonemap-bt709" : "passthrough",
    output: hdr
      ? {
          pixelFormat: "yuv420p",
          bitDepth: 8,
          primaries: "bt709",
          transfer: "bt709",
          space: "bt709",
          range: "tv",
          peakNits: 100,
        }
      : null,
    reason: hdr ? `hdr-${detected}-tone-map-bt709` : "sdr-transfer-passthrough",
  };
}

describe("buildCutArgs", () => {
  it("accurate mode: fast seek before -i, re-encode, faststart", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 61.5, 91.5);
    const ss = args.indexOf("-ss");
    const i = args.indexOf("-i");
    expect(ss).toBeGreaterThan(-1);
    expect(ss).toBeLessThan(i); // fast seek must precede the input
    expect(args[ss + 1]).toBe("00:01:01.500");
    expect(args).toContain("-t");
    expect(args[args.indexOf("-t") + 1]).toBe("00:00:30.000");
    expect(args).toContain("libx264");
    expect(args).toContain("+faststart");
    expect(args[args.length - 1]).toBe("/v/out.mp4");
  });

  it("maps the probed global video/audio streams in continuous and jump-cut paths", () => {
    const selected = { videoStreamIndex: 1, audioStreamIndex: 2 };
    const continuous = buildCutArgs("/v/in.mkv", "/v/out.mp4", 0, 5, selected);
    expect(continuous.slice(continuous.indexOf("-map"), continuous.indexOf("-map") + 4)).toEqual([
      "-map", "0:1", "-map", "0:2",
    ]);

    const jump = buildJumpCutArgs(
      "/v/in.mkv",
      "/v/out.mp4",
      0,
      [{ startSec: 0, endSec: 2 }, { startSec: 3, endSec: 5 }],
      selected
    );
    const graph = jump[jump.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[0:1]trim=start=0.000:end=2.000");
    // 音频尾多读半条拼缝交叠(SEAM_LEAD_SEC,尾巴让给画面=L-cut),由 acrossfade 抵掉。
    expect(graph).toContain(`[0:2]atrim=start=0.000:end=${(2 + SEAM_LEAD_SEC).toFixed(3)}`);
  });

  it("copy mode: stream copy, no encoder flags", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 10, 20, { mode: "copy" });
    expect(args).toContain("copy");
    expect(args).not.toContain("libx264");
    expect(args).toContain("make_zero");
  });

  it("clamps negative start to zero", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", -2, 8);
    expect(args[args.indexOf("-ss") + 1]).toBe("00:00:00.000");
    expect(args[args.indexOf("-t") + 1]).toBe("00:00:08.000");
  });

  it("rejects inverted/empty ranges", () => {
    expect(() => buildCutArgs("/v/in.mp4", "/v/out.mp4", 30, 30)).toThrow();
    expect(() => buildCutArgs("/v/in.mp4", "/v/out.mp4", 30, 10)).toThrow();
  });

  it("honors custom crf/preset", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { crf: 20, preset: "medium" });
    expect(args[args.indexOf("-crf") + 1]).toBe("20");
    expect(args[args.indexOf("-preset") + 1]).toBe("medium");
  });

  it("vertical: center-crop to 9:16 then 1080×1920", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { vertical: true });
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("crop=w='min(iw,ih*9/16)'");
    expect(vf).toContain("scale=1080:1920");
    expect(vf).toContain("setsar=1");
  });

  it("subtitlePath: appends the subtitles filter after reframing", () => {
    const vf = buildVideoFilters({ vertical: true, subtitlePath: "/tmp/a.ass" });
    expect(vf[vf.length - 1]).toBe("subtitles=filename='/tmp/a.ass'");
    expect(vf[0]).toContain("crop=");
  });

  it("adaptive picture finish runs after geometry and before subtitles", () => {
    const visualEnhance: VisualEnhancePlan = {
      applied: true,
      sampleCount: 8,
      measurements: { lumaLow: 20, lumaAvg: 55, lumaHigh: 105, saturation: 16 },
      adjustments: { brightness: 0.012, contrast: 1.08, saturation: 1.08, gamma: 1.08 },
      reasons: ["underexposed", "flat", "muted"],
    };
    const vf = buildVideoFilters({ vertical: true, visualEnhance, subtitlePath: "/tmp/a.ass" });
    expect(vf.findIndex((filter) => filter.startsWith("eq="))).toBeGreaterThan(vf.findIndex((filter) => filter.startsWith("scale=")));
    expect(vf.findIndex((filter) => filter.startsWith("eq="))).toBeLessThan(vf.findIndex((filter) => filter.startsWith("subtitles=")));
  });

  it("active finish disables copy while a neutral plan preserves it", () => {
    const active: VisualEnhancePlan = {
      applied: true,
      sampleCount: 8,
      measurements: { lumaLow: 20, lumaAvg: 55, lumaHigh: 105, saturation: 16 },
      adjustments: { brightness: 0.012, contrast: 1.08, saturation: 1.08, gamma: 1.08 },
      reasons: ["underexposed"],
    };
    const neutral: VisualEnhancePlan = { ...active, applied: false, adjustments: { brightness: 0, contrast: 1, saturation: 1, gamma: 1 }, reasons: [] };
    expect(buildCutArgs("/i.mp4", "/o.mp4", 0, 5, { mode: "copy", visualEnhance: active })).toContain("libx264");
    expect(buildCutArgs("/i.mp4", "/o.mp4", 0, 5, { mode: "copy", visualEnhance: neutral })).toContain("make_zero");
  });

  it("applies the same finish to the concatenated jump-cut picture", () => {
    const visualEnhance: VisualEnhancePlan = {
      applied: true,
      sampleCount: 8,
      measurements: { lumaLow: 20, lumaAvg: 55, lumaHigh: 105, saturation: 16 },
      adjustments: { brightness: 0.012, contrast: 1.08, saturation: 1.08, gamma: 1.08 },
      reasons: ["underexposed"],
    };
    const args = buildJumpCutArgs("/i.mp4", "/o.mp4", 0, [{ startSec: 0, endSec: 2 }, { startSec: 3, endSec: 5 }], {
      visualEnhance,
      subtitlePath: "/tmp/a.ass",
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[vc]eq=brightness=");
    expect(graph.indexOf("eq=brightness=")).toBeLessThan(graph.indexOf("subtitles=filename="));
  });

  it("jump-cut punch-in alternates the framing on one shared geometry", () => {
    const args = buildJumpCutArgs("/i.mp4", "/o.mp4", 0, [{ startSec: 0, endSec: 2 }, { startSec: 3, endSec: 5 }], {
      punchIn: { width: 1920, height: 1080 },
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    // even piece: only rescaled; odd piece: 4% push-in then cropped back.
    expect(graph).toContain("scale=1920:1080");
    expect(graph).toContain("scale=1996:1122");
    expect(graph).toContain("crop=1920:1080");
    expect(graph.match(/setsar=1/g)).toHaveLength(2);
    expect(graph.match(/crop=1920:1080/g)).toHaveLength(1);
    // No punch-in → exactly the legacy graph (concat needs identical geometry).
    const plain = buildJumpCutArgs("/i.mp4", "/o.mp4", 0, [{ startSec: 0, endSec: 2 }, { startSec: 3, endSec: 5 }], {});
    expect(plain[plain.indexOf("-filter_complex") + 1]).not.toContain("scale=");
  });

  it("jump-cut colour match applies one eq per graded piece", () => {
    const args = buildJumpCutArgs("/i.mp4", "/o.mp4", 0, [{ startSec: 0, endSec: 2 }, { startSec: 3, endSec: 5 }], {
      pieceGrade: [null, { brightness: -0.02, saturation: 1.05 }],
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("eq=brightness=-0.020:saturation=1.050");
    expect(graph.match(/eq=brightness=/g)).toHaveLength(1);
  });

  it("cross-fades pieces when a transition is requested", () => {
    const args = buildJumpCutArgs(
      "/i.mp4", "/o.mp4", 0,
      [{ startSec: 0, endSec: 2 }, { startSec: 3, endSec: 5 }, { startSec: 6, endSec: 8 }],
      { transitionSec: 0.1 }
    );
    const graph = args[args.indexOf("-filter_complex") + 1];
    // 2s pieces: first xfade starts at 2-0.1, second at (2-0.1)+2-0.1.
    expect(graph).toContain("xfade=transition=fade:duration=0.100:offset=1.900");
    expect(graph).toContain("xfade=transition=fade:duration=0.100:offset=3.800");
    expect(graph.match(/acrossfade=d=0\.100/g)).toHaveLength(2);
    // The hard-cut concat path is not used at all.
    expect(graph).not.toContain("concat=n=3");
  });

  it("keeps undefined and explicit SDR color plans on the legacy argument path", () => {
    const legacy = buildCutArgs("/i.mp4", "/o.mp4", 0, 5, { mode: "copy" });
    const sdr = buildCutArgs("/i.mp4", "/o.mp4", 0, 5, { mode: "copy", color: colorPlan("sdr") });
    expect(sdr).toEqual(legacy);
    expect(buildVideoFilters({ color: colorPlan("sdr") })).toEqual([]);
  });

  it("tone-maps PQ before every geometry/finish/text stage, tags SDR, and disables both copy paths", () => {
    const visualEnhance: VisualEnhancePlan = {
      applied: true,
      sampleCount: 8,
      measurements: { lumaLow: 20, lumaAvg: 55, lumaHigh: 105, saturation: 16 },
      adjustments: { brightness: 0.012, contrast: 1.08, saturation: 1.08, gamma: 1.08 },
      reasons: ["underexposed"],
    };
    const options = {
      mode: "copy" as const,
      videoCopy: true,
      color: colorPlan("pq"),
      uiCrop: { topFrac: 0.05, bottomFrac: 0.03 },
      vertical: true,
      autoZoom: { durationSec: 5, fps: 30 },
      visualEnhance,
      subtitlePath: "/tmp/a.ass",
    };
    const filters = buildVideoFilters(options);
    expect(filters[0]).toBe(
      "zscale=pin=bt2020:tin=smpte2084:min=bt2020nc:rin=tv:t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=mobius:desat=2,zscale=p=bt709:t=bt709:m=bt709:r=tv:dither=error_diffusion,format=yuv420p"
    );
    expect(filters.findIndex((filter) => filter.startsWith("crop="))).toBeGreaterThan(0);
    expect(filters.findIndex((filter) => filter.startsWith("zoompan="))).toBeGreaterThan(0);
    expect(filters.findIndex((filter) => filter.startsWith("eq="))).toBeGreaterThan(0);
    expect(filters.findIndex((filter) => filter.startsWith("subtitles="))).toBeGreaterThan(0);

    const args = buildCutArgs("/i.mp4", "/o.mp4", 0, 5, options);
    expect(args).toContain("libx264");
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).not.toEqual(["-c:v", "copy"]);
    expect(args.slice(args.indexOf("-color_primaries"), args.indexOf("-color_primaries") + 8)).toEqual([
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
      "-colorspace", "bt709",
      "-color_range", "tv",
    ]);
  });

  it("keeps HLG tone mapping first on tracked reframes", () => {
    const filters = buildVideoFilters({
      color: colorPlan("hlg"),
      trackPlan: { cropXExpr: "100", cropW: 1080, cropH: 1920, cropY: 0 },
      subtitlePath: "/tmp/a.ass",
    });
    expect(filters[0]).toContain("tonemap=tonemap=mobius");
    expect(filters[1]).toBe("crop=w=1080:h=1920:x='100':y=0");
    expect(filters.findIndex((filter) => filter.startsWith("subtitles="))).toBeGreaterThan(1);
  });

  it("applies the same HDR transform and BT.709 tags to jump cuts", () => {
    const args = buildJumpCutArgs(
      "/i.mp4",
      "/o.mp4",
      0,
      [{ startSec: 0, endSec: 2 }, { startSec: 3, endSec: 5 }],
      { color: colorPlan("hlg"), vertical: true, subtitlePath: "/tmp/a.ass" }
    );
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[vc]zscale=pin=bt2020:tin=arib-std-b67");
    expect(graph.indexOf("zscale=pin=bt2020")).toBeLessThan(graph.indexOf("crop=w='min(iw,ih*9/16)'"));
    expect(graph.indexOf("crop=w='min(iw,ih*9/16)'")).toBeLessThan(graph.indexOf("subtitles=filename="));
    expect(args.slice(args.indexOf("-color_primaries"), args.indexOf("-color_primaries") + 8)).toEqual([
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
      "-colorspace", "bt709",
      "-color_range", "tv",
    ]);
  });

  it("fontsDir: rides along as the subtitles filter's fontsdir", () => {
    const vf = buildVideoFilters({ subtitlePath: "/tmp/a.ass", fontsDir: "C:\\App\\fonts" });
    expect(vf[0]).toBe("subtitles=filename='/tmp/a.ass':fontsdir='C\\:/App/fonts'");
  });

  it("filters force accurate mode even when copy was requested", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { mode: "copy", vertical: true });
    expect(args).toContain("libx264");
    expect(args).not.toContain("make_zero");
  });

  it("smart video copy preserves AAC and the complete audio filter chain", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 10, 20, {
      videoCopy: true,
      denoise: true,
      normalizeLoudness: true,
      muteRanges: [{ startSec: 1, endSec: 2 }],
    });
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual(["-c:v", "copy"]);
    expect(args).not.toContain("libx264");
    expect(args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 2)).toEqual(["-c:a", "aac"]);
    const audio = args[args.indexOf("-af") + 1];
    expect(audio).toContain(DENOISE_FILTER);
    expect(audio).toContain(LOUDNORM_FILTER);
    expect(audio).toContain("volume=enable='between(t,1.000,2.000)':volume=0");
    expect(audio).toContain("afade=t=in");
  });

  it("pixel-changing filters disable smart video copy", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { videoCopy: true, vertical: true });
    expect(args).toContain("libx264");
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual(["-c:v", "libx264"]);
  });

  it("escapes windows drive colons and backslashes for the filter graph", () => {
    expect(escapeFilterPath("C:\\Users\\我\\a.ass")).toBe("C\\:/Users/我/a.ass");
  });
});

describe("loudness normalization", () => {
  it("targets -14 LUFS; the 192kHz leak is capped by the -ar output option, not an in-graph resampler", () => {
    expect(LOUDNORM_FILTER).toContain("loudnorm=I=-14");
    expect(LOUDNORM_FILTER).toContain("TP=-1.5");
    // in-graph aresample breaks channel-layout negotiation with the AAC encoder
    expect(LOUDNORM_FILTER).not.toContain("aresample");
    expect(LOUDNORM_OUT_RATE).toBe("48000");
  });

  it("plain cut: inserts -af loudnorm + -ar before the audio codec when enabled", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { normalizeLoudness: true });
    const af = args.indexOf("-af");
    expect(af).toBeGreaterThan(-1);
    expect(args[af + 1].startsWith(LOUDNORM_FILTER)).toBe(true); // 边缘淡化排在其后
    expect(args[args.indexOf("-ar") + 1]).toBe(LOUDNORM_OUT_RATE);
    expect(af).toBeLessThan(args.indexOf("-c:a")); // filter precedes the encoder
  });

  it("plain cut: 关掉响度后 -af 只剩边缘淡化,无 loudnorm", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5);
    expect(args[args.indexOf("-af") + 1]).toBe("afade=t=in:st=0:d=0.03,afade=t=out:st=4.970:d=0.03");
    expect(args.join(" ")).not.toContain("loudnorm");
  });

  it("plain cut: loudnorm alone forces accurate mode even if copy requested", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { mode: "copy", normalizeLoudness: true });
    expect(args).toContain("libx264");
    expect(args).toContain("-af");
    expect(args).not.toContain("make_zero");
  });

  it("jump cut: normalizes the spliced stream (concat → [araw] → loudnorm → [aout])", () => {
    const segs = [{ startSec: 10, endSec: 12 }, { startSec: 15, endSec: 17 }];
    const args = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, segs, { normalizeLoudness: true });
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain(":c2=qsin[araw]"); // 拼接后的声音 → raw label
    expect(fc).toContain(`[araw]${LOUDNORM_FILTER}[aout]`); // then normalize
    expect(args[args.indexOf("-map") + 1]).toBe("[vout]");
    expect(args).toContain("[aout]"); // final audio map unchanged
    expect(args[args.indexOf("-ar") + 1]).toBe(LOUDNORM_OUT_RATE); // cap the 192kHz output
  });

  it("jump cut: the spliced audio maps straight to [aout] when disabled", () => {
    const segs = [{ startSec: 10, endSec: 12 }, { startSec: 15, endSec: 17 }];
    const fc = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, segs)[
      buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, segs).indexOf("-filter_complex") + 1
    ];
    expect(fc).toContain(":c2=qsin[aout]");
    expect(fc).not.toContain("loudnorm");
  });
});

describe("denoise (基础降噪)", () => {
  it("链路含双高通与 afftdn,不含 aresample", () => {
    expect(DENOISE_FILTER).toContain("highpass=f=80,highpass=f=80");
    expect(DENOISE_FILTER).toContain("afftdn");
    expect(DENOISE_FILTER).not.toContain("aresample");
  });

  it("普通切割:仅降噪 → -af 以降噪链开头(后接边缘淡化),无 -ar,且强制重编码", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { mode: "copy", denoise: true });
    expect(args).toContain("libx264"); // copy 被升级
    expect(args[args.indexOf("-af") + 1].startsWith(DENOISE_FILTER)).toBe(true);
    expect(args).not.toContain("-ar");
  });

  it("普通切割:降噪+响度 → 降噪排在 loudnorm 之前,-ar 照常", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 5, { denoise: true, normalizeLoudness: true });
    expect(args[args.indexOf("-af") + 1].startsWith(`${DENOISE_FILTER},${LOUDNORM_FILTER}`)).toBe(true);
    expect(args[args.indexOf("-ar") + 1]).toBe(LOUDNORM_OUT_RATE);
  });

  it("跳剪:拼接后整段过降噪链([araw] → 降噪,loudnorm → [aout])", () => {
    const segs = [{ startSec: 10, endSec: 12 }, { startSec: 15, endSec: 17 }];
    const args = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, segs, { denoise: true, normalizeLoudness: true });
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain(":c2=qsin[araw]");
    expect(fc).toContain(`[araw]${DENOISE_FILTER},${LOUDNORM_FILTER}[aout]`);
  });

  it("跳剪:仅降噪也走 [araw] 链,不带 loudnorm/-ar", () => {
    const segs = [{ startSec: 10, endSec: 12 }, { startSec: 15, endSec: 17 }];
    const args = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, segs, { denoise: true });
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain(`[araw]${DENOISE_FILTER}[aout]`);
    expect(fc).not.toContain("loudnorm");
    expect(args).not.toContain("-ar");
  });
});

describe("edgeFadeFilters (切点边缘 30ms 淡化防爆音)", () => {
  it("正常段:头淡入 + 尾淡出,尾部时刻 = 段长 - 淡化时长", () => {
    const fades = edgeFadeFilters(2);
    expect(fades).toEqual([
      `afade=t=in:st=0:d=${EDGE_FADE_SEC}`,
      `afade=t=out:st=${(2 - EDGE_FADE_SEC).toFixed(3)}:d=${EDGE_FADE_SEC}`,
    ]);
  });

  it("超短段(≤4×淡化时长)不淡:淡化会吃掉整段能量", () => {
    expect(edgeFadeFilters(0.1)).toEqual([]);
    expect(edgeFadeFilters(0)).toEqual([]);
  });

  it("可以只淡一侧:交叉淡化的接缝不叠首尾淡", () => {
    expect(edgeFadeFilters(2, { in: false, out: true })).toEqual([
      `afade=t=out:st=${(2 - EDGE_FADE_SEC).toFixed(3)}:d=${EDGE_FADE_SEC}`,
    ]);
    expect(edgeFadeFilters(2, { in: true, out: false })).toEqual([`afade=t=in:st=0:d=${EDGE_FADE_SEC}`]);
  });

  it("copy 模式不受影响:流复制无法加滤镜", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 10, 20, { mode: "copy" });
    expect(args.join(" ")).not.toContain("afade");
  });

  it("跳剪:拼缝交给纯音频交叉淡化(画面仍硬切),两端各留 30ms 淡", () => {
    const segs = [{ startSec: 10, endSec: 12 }, { startSec: 15, endSec: 17 }];
    const args = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, segs);
    const fc = args[args.indexOf("-filter_complex") + 1];
    // 画面:纯视频 concat,硬切不变。
    expect(fc).toContain("[v0][v1]concat=n=2:v=1:a=0[vout]");
    // 声音:以画面切点为中心的交叠——前段尾巴多走 SEAM_LEAD_SEC(L-cut),后段
    // 早进 SEAM_LEAD_SEC(J-cut,读的是被切掉的静音);两端淡只留最外。
    expect(fc).toContain(`[0:a:0]atrim=start=0.000:end=${(2 + SEAM_LEAD_SEC).toFixed(3)}`);
    expect(fc).toContain(`[0:a:0]atrim=start=${(5 - SEAM_LEAD_SEC).toFixed(3)}:end=7.000`);
    expect(fc.match(/afade=t=in/g)).toHaveLength(1);
    expect(fc.match(/afade=t=out/g)).toHaveLength(1);
    expect(fc).toContain(`asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${EDGE_FADE_SEC}[a0]`);
    // 等功率 acrossfade,长度 = 画面总长(2+2):各段多读的 seam 被交叠吃掉。
    expect(fc).toContain(`acrossfade=d=${(SEAM_LEAD_SEC * 2).toFixed(3)}:c1=qsin:c2=qsin[aout]`);
  });

  it("seamCrossfades:逐条拼缝取静音长度,不吃进真人声", () => {
    // 静音 0.5s → 交叠用满 2×SEAM_LEAD_SEC(单边各半步)。
    expect(seamCrossfades([{ startSec: 0, endSec: 2 }, { startSec: 2.5, endSec: 4 }])).toEqual([SEAM_LEAD_SEC * 2]);
    // 拼缝静音只剩 0.03s → 单边只能拿 0.03(总长 0.06);下一条 0.5s 的照旧用满。
    expect(
      seamCrossfades([{ startSec: 0, endSec: 2 }, { startSec: 2.5, endSec: 4 }, { startSec: 4.03, endSec: 6 }])
    ).toEqual([SEAM_LEAD_SEC * 2, 0.06]);
    // 单段没有拼缝;重叠段(负静音)、几乎为零的静音(节奏切)都不淡。
    expect(seamCrossfades([{ startSec: 0, endSec: 2 }])).toEqual([]);
    expect(seamCrossfades([{ startSec: 0, endSec: 2 }, { startSec: 1.9, endSec: 4 }])).toEqual([0]);
    expect(seamCrossfades([{ startSec: 0, endSec: 2 }, { startSec: 2, endSec: 4 }])).toEqual([0]);
    // 段本身太短 → 单边量按「不超过该段一半」缩水(0.1s 的段只能让 0.05s)。
    expect(seamCrossfades([{ startSec: 0, endSec: 0.1 }, { startSec: 1, endSec: 4 }])).toEqual([0.1]);
  });

  it("跳剪:拼缝没有静音可借时退回硬接(画面声音一起 concat)", () => {
    const tight = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, [
      { startSec: 10, endSec: 12 },
      { startSec: 12.01, endSec: 14 },
    ]);
    const fc = tight[tight.indexOf("-filter_complex") + 1];
    expect(fc).not.toContain("acrossfade");
    expect(fc).toContain("concat=n=2:v=1:a=1");
    // 剪掉的只有 10ms 静音,两端各留一个 30ms 淡就够了。
    expect(fc.match(/afade=t=in/g)).toHaveLength(1);
    expect(fc.match(/afade=t=out/g)).toHaveLength(1);
  });

  it("跳剪:节奏切(前后同一段连续声音)不交叠,也不在接缝上凹一刀", () => {
    // 一段话被对半切开 → 拼缝零静音:整条退回硬接,内层不叠淡,只有最外两端淡。
    const split = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 0, [
      { startSec: 0, endSec: 4 },
      { startSec: 4, endSec: 8 },
    ]);
    const fc = split[split.indexOf("-filter_complex") + 1];
    expect(fc).toContain("concat=n=2:v=1:a=1");
    expect(fc.match(/afade=t=in/g)).toHaveLength(1);
    expect(fc.match(/afade=t=out/g)).toHaveLength(1);
    // 真静音拼缝 + 节奏拼缝混在一起:前者交叠,后者直接接(逐条独立)。
    const mixed = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 0, [
      { startSec: 0, endSec: 4 },
      { startSec: 5, endSec: 9 },
      { startSec: 9, endSec: 13 },
    ]);
    const mfc = mixed[mixed.indexOf("-filter_complex") + 1];
    expect(mfc).toContain(`[a0][a1]acrossfade=d=${(SEAM_LEAD_SEC * 2).toFixed(3)}:c1=qsin:c2=qsin[as1]`);
    expect(mfc).toContain("[as1][a2]concat=n=2:v=0:a=1[aout]");
    expect(mfc.match(/afade=t=in/g)).toHaveLength(1);
    expect(mfc.match(/afade=t=out/g)).toHaveLength(1);
  });

  it("交叉淡化:等功率 acrossfade,且接缝内部不再叠首尾淡", () => {
    const segs = [
      { startSec: 10, endSec: 12 },
      { startSec: 15, endSec: 17 },
      { startSec: 20, endSec: 22 },
    ];
    const args = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 10, segs, { transitionSec: 0.3 });
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("acrossfade=d=0.300:c1=qsin:c2=qsin");
    expect(fc).not.toContain("c1=tri");
    // Only the two outer ends keep a 30ms fade; the seamed ends would notch
    // the blend (audible dip).
    expect(fc.match(/afade=t=in/g)).toHaveLength(1);
    expect(fc.match(/afade=t=out/g)).toHaveLength(1);
  });
});

describe("metadataArgs (AIGC 隐式标识)", () => {
  it("k=v 对展开;空缺省为空数组", () => {
    expect(metadataArgs({ comment: "AIGC=true; Tool=HotClip" })).toEqual(["-metadata", "comment=AIGC=true; Tool=HotClip"]);
    expect(metadataArgs(undefined)).toEqual([]);
  });

  it("三条出片路径都带 -metadata", () => {
    const meta = { comment: "AIGC=true" };
    const cut = buildCutArgs("/i.mp4", "/o.mp4", 0, 5, { metadata: meta, vertical: true });
    expect(cut.join(" ")).toContain("-metadata comment=AIGC=true");
    const jump = buildJumpCutArgs("/i.mp4", "/o.mp4", 0, [{ startSec: 0, endSec: 2 }, { startSec: 3, endSec: 5 }], { metadata: meta });
    expect(jump.join(" ")).toContain("-metadata comment=AIGC=true");
    const copy = buildCutArgs("/i.mp4", "/o.mp4", 0, 5, { metadata: meta, mode: "copy" });
    expect(copy.join(" ")).toContain("-metadata comment=AIGC=true");
  });
});

describe("parseFfmpegProgress (切片内实时进度)", () => {
  it("解析 out_time_us(微秒)为秒;老字段 out_time_ms 同样按微秒", () => {
    expect(parseFfmpegProgress("frame=100\nout_time_us=2500000\nprogress=continue\n")).toBe(2.5);
    expect(parseFfmpegProgress("out_time_ms=1500000\n")).toBe(1.5);
  });

  it("无进度字段/垃圾块返回 null", () => {
    expect(parseFfmpegProgress("speed=2.5x\n")).toBeNull();
    expect(parseFfmpegProgress("")).toBeNull();
  });
});

describe("横屏运镜(autoZoom 输出源帧尺寸)", () => {
  it("autoZoom 给出源帧尺寸时,横屏出口走 zoompan 而不是 1080×1920 的竖屏 scale", () => {
    const filters = buildVideoFilters({
      autoZoom: { durationSec: 5, fps: 30, punchTo: 1.1, outW: 1920, outH: 1080 },
    });
    const joined = filters.join(",");
    expect(joined).toContain("zoompan=");
    expect(joined).toContain("s=1920x1080");
    expect(joined).not.toContain("scale=1080:1920");
  });

  it("缺省几何仍是竖屏口径(旧行为逐字不变)", () => {
    const filters = buildVideoFilters({ autoZoom: { durationSec: 5, fps: 30 }, vertical: true });
    expect(filters.join(",")).toContain("s=1080x1920");
    expect(filters.join(",")).not.toContain("s=1920x1080");
  });

  it("竖屏 + 源帧几何冲突时按调用方给的走(宽度偶数化)", () => {
    const filters = buildVideoFilters({ autoZoom: { durationSec: 5, fps: 30, outW: 1919, outH: 1079 } });
    expect(filters.join(",")).toContain("s=1918x1078");
  });

  it("punchOnly:只推强调点,不做呼吸(节奏兜底不抢戏)", () => {
    const filters = buildVideoFilters({
      autoZoom: { durationSec: 20, fps: 30, emphasisAtSec: [5, 10, 15], punchOnly: true },
    });
    const z = /zoompan=z='([^']*)'/.exec(filters.join(","))?.[1] ?? "";
    expect(z).toContain("1.0600"); // 推近幅度取呼吸峰值
    expect(z).not.toContain("1.1000"); // 不是强调级别(那是 1.1,抢戏)
  });
});

describe("冷开场接缝过场(buildColdSeamArgs)", () => {
  const base = { headSec: 2.5 };

  it("xfade 交叠在 headSec − duration,acrossfade 同时长,画面音频都不脱节", () => {
    const args = buildColdSeamArgs("/m/hook.mp4", "/m/body.mp4", "/m/out.mp4", { ...base, transition: "fade" });
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain(`xfade=transition=fade:duration=${COLD_SEAM_XFADE_SEC.toFixed(3)}:offset=${(2.5 - COLD_SEAM_XFADE_SEC).toFixed(3)}`);
    expect(fc).toContain(`acrossfade=d=${COLD_SEAM_XFADE_SEC.toFixed(3)}:c1=qsin:c2=qsin`);
    expect(args.slice(args.indexOf("-map"), args.indexOf("-map") + 4)).toEqual(["-map", "[v]", "-map", "[a]"]);
  });

  it("三种风格映射到 xfade 名:甩镜=slideleft、擦除=wipeleft、淡化=fade", () => {
    const name = (transition: ColdSeamTransition): string => {
      const args = buildColdSeamArgs("/a.mp4", "/b.mp4", "/o.mp4", { headSec: 2.5, transition });
      return args[args.indexOf("-filter_complex") + 1];
    };
    expect(name("whip")).toContain("transition=slideleft");
    expect(name("wipe")).toContain("transition=wipeleft");
    expect(name("fade")).toContain("transition=fade");
    expect(coldSeamXfadeName("whip")).toBe("slideleft");
    expect(coldSeamXfadeName("wipe")).toBe("wipeleft");
    expect(coldSeamXfadeName("fade")).toBe("fade");
  });

  it("交叠时长被前段长度封顶(不能吃掉整个迷你片)", () => {
    const args = buildColdSeamArgs("/a.mp4", "/b.mp4", "/o.mp4", { headSec: 0.2, transitionSec: 0.5 });
    const fc = args[args.indexOf("-filter_complex") + 1];
    expect(fc).toContain("duration=0.150");
    expect(fc).toContain("offset=0.050");
  });

  it("AIGC 元数据与编码参数落在拼接产物上", () => {
    const args = buildColdSeamArgs("/a.mp4", "/b.mp4", "/o.mp4", { ...base, metadata: { comment: "AIGC=true" } });
    expect(args.join(" ")).toContain("-metadata comment=AIGC=true");
    expect(args).toContain("libx264");
    expect(args).toContain("+faststart");
  });

  it("pickColdSeamTransition 确定性轮换,数字 id 也能当 seed", () => {
    expect(pickColdSeamTransition(7)).toBe(pickColdSeamTransition(7));
    const seen = new Set([0, 1, 2, 3, 4, 5].map((id) => pickColdSeamTransition(id)));
    expect(seen.size).toBe(COLD_SEAM_TRANSITIONS.length);
    expect(COLD_SEAM_TRANSITIONS).toContain(pickColdSeamTransition("clip-42"));
  });
});

describe("运镜超采样(zoompan/crop 的位置量化)", () => {
  const az = { durationSec: 5, fps: 30 };
  const panExpr = "if(lt(t,1.000),400,500)";

  it("人脸跟随之平移:借 1 像素的源裁窗 + 放大帧上补亚像素余量", () => {
    const filters = buildVideoFilters({
      srcW: 1920,
      srcH: 1080,
      trackPlan: { cropXExpr: panExpr, cropW: 606, cropH: 1080, cropY: 0 },
      autoZoom: az,
    });
    // 整体多裁 2 列、左边从 floor(X)-1 起,exact=1 才不会被色度网格再对齐一次
    expect(filters[0]).toBe(`crop=w=608:h=1080:x='floor(${panExpr})-1':y=0:exact=1`);
    expect(filters[1]).toBe("scale=iw*2:ih*2:flags=lanczos,format=yuv444p");
    // 余量在放大帧上补回:X 的小数部分 × SS,量化细到 1 工作像素(0.89 输出像素)
    expect(filters[2]).toBe(`crop=w=1212:h=2160:x='2*(1+(${panExpr})-floor(${panExpr}))':y=0`);
    expect(filters[3]).toContain("zoompan=");
    expect(filters.indexOf("format=yuv420p")).toBeGreaterThan(filters.findIndex((f) => f.startsWith("zoompan=")));
  });

  it("固定机位:只放大,不借位(没有亚像素余量要补)", () => {
    const filters = buildVideoFilters({
      srcW: 1920,
      srcH: 1080,
      trackPlan: { cropXExpr: "500", cropW: 606, cropH: 1080, cropY: 0 },
      autoZoom: az,
    });
    expect(filters[0]).toBe("crop=w=606:h=1080:x='500':y=0");
    expect(filters[1]).toBe("scale=iw*2:ih*2:flags=lanczos,format=yuv444p");
    expect(filters.join(",")).not.toContain("floor(");
  });

  it("不给源尺寸就不借位——借不借得动无从判断,但放大照做", () => {
    const filters = buildVideoFilters({
      trackPlan: { cropXExpr: panExpr, cropW: 606, cropH: 1080, cropY: 0 },
      autoZoom: az,
    });
    // 裁窗计划的尺寸自己是齐的,超采样不需要源尺寸;借位需要(要保证裁得下)。
    expect(filters[0]).toBe(`crop=w=606:h=1080:x='${panExpr}':y=0`);
    expect(filters[1]).toBe("scale=iw*2:ih*2:flags=lanczos,format=yuv444p");
    expect(filters.join(",")).not.toContain("floor(");
  });

  it("超预算(4K 横屏整帧 33MP)不放大,旧链逐像素不变", () => {
    const filters = buildVideoFilters({
      srcW: 3840,
      srcH: 2160,
      autoZoom: { ...az, outW: 3840, outH: 2160 },
    });
    expect(filters.join(",")).not.toContain("scale=iw*");
    expect(filters.join(",")).not.toContain("format=yuv444p");
    expect(filters.join(",")).toContain("zoompan=");
  });

  it("竖屏居中裁剪:放大层插在裁剪与 zoompan 之间", () => {
    const filters = buildVideoFilters({ srcW: 1920, srcH: 1080, vertical: true, autoZoom: az });
    const joined = filters.join(",");
    expect(joined).toContain("crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)',scale=iw*2:ih*2:flags=lanczos,format=yuv444p,zoompan=");
    expect(joined.endsWith(",setsar=1,format=yuv420p")).toBe(true);
  });

  it("横屏出口:同一层放大,收尾照样回到 420p(正片那边等着拼)", () => {
    const joined = buildVideoFilters({
      srcW: 1920,
      srcH: 1080,
      autoZoom: { ...az, outW: 1920, outH: 1080 },
    }).join(",");
    expect(joined.startsWith("scale=iw*2:ih*2:flags=lanczos,format=yuv444p,zoompan=")).toBe(true);
    expect(joined.endsWith("s=1920x1080:fps=30,setsar=1,format=yuv420p")).toBe(true);
  });

  it("不运镜就没有放大层(关掉运镜的成片一个像素都不该变)", () => {
    const joined = buildVideoFilters({
      srcW: 1920,
      srcH: 1080,
      trackPlan: { cropXExpr: panExpr, cropW: 606, cropH: 1080, cropY: 0 },
    }).join(",");
    expect(joined).not.toContain("scale=iw*");
    expect(joined).not.toContain("zoompan=");
  });
});

describe("环形收口(loop closure)", () => {
  it("收口长度:太短的片子不做,能做的也不吃超过四分之一", () => {
    expect(loopCloseSec(10)).toBe(0); // 没请求
    expect(loopCloseSec(10, 0)).toBe(0);
    expect(loopCloseSec(10, Infinity)).toBe(1); // 病态请求被上限夹住,不炸
    expect(loopCloseSec(10, LOOP_CLOSE_SEC)).toBe(0.3);
    expect(loopCloseSec(0.6, LOOP_CLOSE_SEC)).toBe(0); // 不足 1 秒的成片不收口
    expect(loopCloseSec(0.9, LOOP_CLOSE_SEC)).toBe(0);
    expect(loopCloseSec(1, LOOP_CLOSE_SEC)).toBe(0.25); // 恰好 1 秒 → 只吃四分之一
    expect(loopCloseSec(10, 5)).toBe(1); // 上限 1 秒
    expect(loopCloseSec(2.5, 5)).toBe(0.625); // 长上限被「片长/4」压住
  });

  it("单段成片:开头倒放融回第一帧,声音等功率融合,总长不变", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 10, { loopCloseSec: LOOP_CLOSE_SEC });
    // 跨路取同一段音频(要再把开头叠到末尾)只能走 filter_complex,不再有 -vf/-af
    expect(args).not.toContain("-vf");
    expect(args).not.toContain("-af");
    const graph = args[args.indexOf("-filter_complex") + 1];
    // 偏移量 = 片长 − 收口;倒放的是**开头**那 0.3 秒,走到终点 = 原片第 0 帧
    expect(graph).toBe(
      "[0:v:0]null,split[zl0][zl1];[zl1]trim=end=0.300,setpts=PTS-STARTPTS,reverse[zl2];" +
        "[zl0][zl2]xfade=transition=fade:duration=0.300:offset=9.700[vout];" +
        "[0:a:0]afade=t=in:st=0:d=0.03,afade=t=out:st=9.970:d=0.03,asplit=3[za0][za1][za2];" +
        "[za0]atrim=end=9.700,asetpts=PTS-STARTPTS[zb];" +
        "[za1]atrim=start=9.700:end=10.000,asetpts=PTS-STARTPTS,afade=t=out:st=0:d=0.300:curve=qsin[zt];" +
        "[za2]atrim=end=0.300,asetpts=PTS-STARTPTS,areverse,afade=t=in:st=0:d=0.300:curve=qsin[zh];" +
        "[zt][zh]amix=inputs=2:duration=longest:normalize=0[zm];" +
        "[zb][zm]concat=n=2:v=0:a=1[aout]"
    );
    // 声音跟画面同构:开头也倒放,末样本正好是源片第 0 个样本,重播回开头没有爆点
    expect(graph).toContain("asetpts=PTS-STARTPTS,areverse,afade=t=in");
    // 不用 acrossfade:它按绝对 PTS 对齐,「长段 + 短段」会把声音削成 0.03 秒
    expect(graph).not.toContain("acrossfade");
    expect(args[args.indexOf("-map") + 1]).toBe("[vout]");
    expect(args[args.indexOf("-map", args.indexOf("-map") + 1) + 1]).toBe("[aout]");
    // 重编码路径:收口重排像素,别想走 -c:v copy
    expect(args).toContain("-c:v");
    expect(args).not.toContain("copy");
  });

  it("收口与字幕/水印同路:文字链整条搬进 filter_complex", () => {
    const args = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 8, {
      subtitlePath: "/tmp/a.ass",
      loopCloseSec: LOOP_CLOSE_SEC,
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[0:v:0]subtitles=filename='/tmp/a.ass',split[zl0][zl1]");
    expect(graph).toContain("xfade=transition=fade:duration=0.300:offset=7.700");
  });

  it("不请求收口时一个字节都不变(旧路径原样)", () => {
    const plain = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 10, {});
    expect(plain).toContain("-af");
    expect(plain.join(" ")).not.toContain("split[zl0]");
    const short = buildCutArgs("/v/in.mp4", "/v/out.mp4", 0, 0.6, { loopCloseSec: LOOP_CLOSE_SEC });
    expect(short.join(" ")).not.toContain("split[zl0]");
  });

  it("跳剪成片:收口接在字幕/水印/音频链之后,偏移量按拼接后的总长算", () => {
    const args = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 0, [
      { startSec: 0, endSec: 4 },
      { startSec: 5, endSec: 9 },
    ], { loopCloseSec: LOOP_CLOSE_SEC });
    const graph = args[args.indexOf("-filter_complex") + 1];
    expect(graph).toContain("[vout]split[zl0][zl1];[zl1]trim=end=0.300");
    expect(graph).toContain("xfade=transition=fade:duration=0.300:offset=7.700[vloop]");
    expect(graph).toContain("[aout]asplit=3[za0][za1][za2];[za0]atrim=end=7.700");
    expect(graph).toContain("amix=inputs=2:duration=longest:normalize=0[zm];[zb][zm]concat=n=2:v=0:a=1[aloop]");
    expect(args[args.indexOf("-map") + 1]).toBe("[vloop]");
    expect(args[args.indexOf("-map", args.indexOf("-map") + 1) + 1]).toBe("[aloop]");
  });

  it("跳剪 + 交叉淡化:偏移量扣掉交叠,收口仍落在成片尾端", () => {
    const args = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 0, [
      { startSec: 0, endSec: 4 },
      { startSec: 5, endSec: 9 },
    ], { transitionSec: 0.4, loopCloseSec: LOOP_CLOSE_SEC });
    const graph = args[args.indexOf("-filter_complex") + 1];
    // 8 − 0.4 = 7.6 → 偏移 7.300
    expect(graph).toContain("xfade=transition=fade:duration=0.300:offset=7.300[vloop]");
  });

  it("跳剪不请求收口:映到 [vout]/[aout](旧图原样)", () => {
    const args = buildJumpCutArgs("/v/in.mp4", "/v/out.mp4", 0, [
      { startSec: 0, endSec: 4 },
      { startSec: 5, endSec: 9 },
    ]);
    expect(args[args.indexOf("-map") + 1]).toBe("[vout]");
    expect(args.join(" ")).not.toContain("[vloop]");
  });
});
