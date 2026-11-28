/**
 * Clip cutting: extract [start, end] from a source video via ffmpeg.
 * `buildCutArgs` is a pure function (unit-testable); only `cutClip` executes.
 *
 * Two modes:
 *  - "accurate" (default): re-encode with fast seek + output seek trim.
 *    Frame-accurate boundaries — required for hook-first clips where the
 *    first second matters. veryfast x264 keeps a 60s clip under ~10s encode.
 *  - "copy": stream copy. Near-instant but cuts snap to keyframes (can be
 *    seconds off on livestream VODs with sparse keyframes) — preview only.
 */
import { spawn } from "child_process";
import { withAtomicOutput } from "./atomic-output";
import { writeFile } from "fs/promises";
import { resolve } from "path";
import { resolveFfmpegPath } from "./binaries";
import { toFfmpegTime } from "./time";
import { buildZoomFilter, zoomSupersampleFactor, zoomSupersampleStage, ZOOM_BASE, ZOOM_BREATH } from "./autozoom";
import { blurFillStage, planFill, type FillMode } from "./fill";
import { speedAudioStage, speedVideoStage } from "./speed-ramp";
import { colorOutputArgs, hdrToneMapFilter, type ColorRenderPlan } from "./color";
import { ffmpegAudioStreamSpecifier, ffmpegVideoStreamSpecifier } from "./probe";
import { videoEncoderArgs, type VideoEncoder } from "./video-encoder";
import { visualEnhanceFilter, type VisualEnhancePlan } from "./visual-enhance";
import { pieceColorFilter, type PieceColorGrade } from "./color-match";

/**
 * Social loudness target (EBU R128): -14 LUFS integrated, -1.5 dBTP true-peak
 * ceiling — the level TikTok / Reels / Shorts / 抖音 normalize playback to, so
 * a batch of clips lands at one consistent, platform-friendly volume instead of
 * the source's raw (often too quiet) level.
 *
 * loudnorm runs its analysis at 192kHz internally and would hand that rate to
 * the AAC encoder (which caps at 96kHz). We pin the output rate with the `-ar`
 * output option (see LOUDNORM_OUT_RATE) rather than an in-graph aresample —
 * output-side resampling negotiates the channel layout, an in-graph one does not.
 */
export const LOUDNORM_FILTER = "loudnorm=I=-14:TP=-1.5:LRA=11";
/** Output sample rate forced alongside loudnorm to cap its 192kHz output. */
export const LOUDNORM_OUT_RATE = "48000";
/**
 * 基础降噪链:双 80Hz 高通(24dB/oct,压 50Hz 电流声及其嗡嗡感)+ afftdn
 * 谱减降噪(nr=24 取温和档防真人声伪影,tn=1 随时段跟踪噪底)。合成实测:
 * 静音段底噪 -7.7dB、语音段仅 -0.2dB。定位是零成本基础降噪,不是 AI 修音。
 * 永远排在 loudnorm 之前——先去噪再标准化,否则响度归一会把噪底一起抬起来。
 */
export const DENOISE_FILTER = "highpass=f=80,highpass=f=80,afftdn=nr=24:nf=-40:tn=1";

export function muteRangeFilters(ranges?: Array<{ startSec: number; endSec: number }>): string[] {
  return (ranges ?? [])
    .filter((range) => Number.isFinite(range.startSec) && range.endSec > range.startSec)
    .map((range) => `volume=enable='between(t,${Math.max(0, range.startSec).toFixed(3)},${range.endSec.toFixed(3)})':volume=0`);
}

/**
 * 切点边缘音频淡化时长:重编码切割的边界几乎必然落在波形非零点上,
 * 产生可闻的「咔哒」爆音;30ms 短到听不出淡化,却足以把边界钳到零附近。
 * 跳剪/高潮前置/合集的每段两端各自淡出+淡入,硬切拼缝天然平滑。
 */
export const EDGE_FADE_SEC = 0.03;

/**
 * 段边缘淡入淡出 filter(纯函数)。段太短(≤4×淡化时长)不淡——
 * 淡化会吃掉整段能量,反而比爆音更可闻。
 */
export function edgeFadeFilters(
  durationSec: number,
  sides: { in: boolean; out: boolean } = { in: true, out: true }
): string[] {
  if (!(durationSec > EDGE_FADE_SEC * 4)) return [];
  const fades: string[] = [];
  if (sides.in) fades.push(`afade=t=in:st=0:d=${EDGE_FADE_SEC}`);
  if (sides.out) fades.push(`afade=t=out:st=${(durationSec - EDGE_FADE_SEC).toFixed(3)}:d=${EDGE_FADE_SEC}`);
  return fades;
}

export type CutMode = "accurate" | "copy";

/**
 * 自动运镜规格(见 autozoom.ts)。`outW/outH` 是运镜输出的画面尺寸:
 * 竖屏出口是 1080×1920(zoompan 顶替那一步 scale);横屏出口传**源帧尺寸**,
 * 运镜后的几何与不走运镜时逐像素一致——拼回正片(concat/xfade)要求所有
 * 分片尺寸相同,差一行就整条出片失败。
 */
export interface AutoZoomSpec {
  durationSec: number;
  fps: number;
  emphasisAtSec?: number[];
  punchTo?: number;
  /**
   * 只做强调推近、不做呼吸(节奏兜底用,见 qa.ts pacingPunchPoints):整片没有
   * 字幕/运镜这些持续视觉变化时,在超长的静止窗中点插一次轻推近。推近幅度取
   * 呼吸的峰值而不是强调的 1.1——它是补节奏,不是抢戏。
   */
  punchOnly?: boolean;
  /** 运镜输出宽度;缺省 1080(竖屏出口的目标宽)。 */
  outW?: number;
  /** 运镜输出高度;缺省 1920(竖屏出口的目标高)。 */
  outH?: number;
}

export interface CutOptions {
  mode?: CutMode;
  /**
   * Internal smart-render path: copy only the H.264 video stream while audio
   * still receives the normal fades/filters and AAC encoding. Callers must
   * prove keyframe alignment first; any pixel-changing filter disables it.
   */
  videoCopy?: boolean;
  /** ffprobe global stream index selected for the source picture. */
  videoStreamIndex?: number;
  /** ffprobe global stream index selected for source audio. */
  audioStreamIndex?: number;
  /** x264 CRF for accurate mode (lower = better); default 18 (visually lossless-ish). */
  crf?: number;
  /** x264 preset for accurate mode; default "veryfast". */
  preset?: string;
  /** Per-run encoder probe result. Hardware failures transparently retry with libx264. */
  encoder?: VideoEncoder;
  /** Crop away static screen-recording chrome first (fractions of height). */
  uiCrop?: { topFrac: number; bottomFrac: number };
  /**
   * Face-tracking reframe: crop x follows a piecewise-linear expression in t.
   * Replaces uiCrop+vertical (their geometry is folded into the plan).
   */
  trackPlan?: { cropXExpr: string; cropW: number; cropH: number; cropY: number };
  /** Reframe to 9:16 vertical (center crop → 1080×1920). Requires re-encode. */
  vertical?: boolean;
  /**
   * 竖屏重构时空出来的边怎么处理:`crop`(缺省,居中裁掉两侧)或 `blur`
   * (整帧缩到宽度居中,底下垫模糊放大版)。需要 srcW/srcH 判画幅(见 fill.ts)。
   */
  fillMode?: FillMode;
  /**
   * 自动运镜:成片叠一层缓慢推拉(见 autozoom.ts)。需要源帧率——
   * zoompan 不传 fps 会把素材重采样到 25fps。字段齐全才生效。
   */
  autoZoom?: AutoZoomSpec;
  /**
   * 源画面尺寸(像素)。运镜前的超采样要按它算像素预算,竖屏居中裁剪的尺寸
   * 也要靠它推出来;不传就当「尺寸未知」——不放大,退回逐像素等价的旧链。
   */
  srcW?: number;
  srcH?: number;
  /** Conservative source-measured picture correction; neutral/skipped plans add no filter. */
  visualEnhance?: VisualEnhancePlan | null;
  /** HDR sources are tone-mapped to a tagged SDR output before any geometric or finishing filters. */
  color?: ColorRenderPlan;
  /** Burn an .ass karaoke subtitle file via libass. Requires re-encode. */
  subtitlePath?: string;
  /** Directory holding bundled fonts for libass (subtitles filter fontsdir). */
  fontsDir?: string;
  /** Normalize output audio to the -14 LUFS social target (EBU R128 loudnorm). */
  normalizeLoudness?: boolean;
  /** 基础降噪:压直播回放常见的底噪/电流声(高通×2 + afftdn,先于 loudnorm)。 */
  denoise?: boolean;
  /** Clip-output-relative ranges whose spoken audio should be muted. */
  muteRanges?: Array<{ startSec: number; endSec: number }>;
  /** 品牌水印:PNG 烧进画面一角(在字幕之上)。 */
  watermark?: WatermarkSpec;
  /**
   * Jump-cut only: alternate pieces get a mild push-in, so a same-angle splice
   * reads as a re-take instead of a stutter. Every piece is scaled to the same
   * even target geometry (concat requires identical frames); omit the field and
   * the graph is byte-for-byte what it was before.
   */
  punchIn?: { width: number; height: number; scale?: number };
  /**
   * Cross-fade between kept pieces (seconds). 0/unset = the legacy hard-cut
   * `concat` graph. The spliced picture and audio shrink by
   * `transitionSec * (pieces - 1)`, which `computeJumpCut` already accounts for.
   */
  transitionSec?: number;
  /**
   * Jump-cut only: per-piece colour correction against the first kept piece.
   * One entry per segment (null = leave it alone). Empty/absent changes nothing.
   */
  pieceGrade?: Array<PieceColorGrade | null>;
  /**
   * 环形收口的长度(秒,见 loopCloseSec)。0/缺省 = 不做,成片与历史逐字节一致。
   * 只对「从头播到尾」的成片成立——冷开场/爆点前置会在正片前接一段迷你片,
   * 那时成片的第一帧不是正片的第一帧,收口会收错地方。
   */
  loopCloseSec?: number;
  /**
   * 变速倍率(见 speed-ramp.ts):画面 setpts 放在滤镜链最末尾(字幕烧完之后,
   * 字幕跟着画面一起快),声音 atempo 放在音频链末尾(保音高)。倍率 1 或缺省
   * = 不变速,链路逐字节不变。环形收口按源时长倒放,两者不能同时生效。
   */
  speedRate?: number;
  /** 容器元数据(如 AIGC 隐式标识);copy 模式同样写入。 */
  metadata?: Record<string, string>;
}

/** Alternate jump-cut pieces push in by this factor (4% reads as a re-take). */
export const PUNCH_IN_SCALE = 1.04;

/**
 * 跳剪拼缝处音频交叠的**单边**提前/延后量(秒)。
 *
 * 画面照旧硬切(跳剪的意义所在),声音跨过拼缝做一次**以画面切点为中心**的等功率
 * 交叠:前段声音多走 lead 秒(画面已经切了、声音还在 = L-cut),后段声音早进 lead
 * 秒(声音先起、画面还没切 = J-cut)。交叠总长 = 2×lead,两头读的都是被切掉的那段
 * 静音,所以总长仍等于画面总长,字词/字幕的时间轴一个点都不动(内容映射不变,
 * 交叠只改电平包络)。
 *
 * 为什么够得着 150ms:前段让出的那半段是它自己的尾音 + 呼吸口,后段提前的那半段
 * 全落在被删掉的静音里,两边「有声的部分」在交叠窗里只是擦肩——前段尾音先淡出、
 * 后段起音后淡入,不会叠成两句话同时在说。
 */
export const SEAM_LEAD_SEC = 0.15;

/**
 * 每条拼缝的交叠长度(0 = 这条拼缝不交叠)。交叠靠「多读被切掉的那段静音」
 * 换来的,所以最多只有那条静音那么长;静音几乎为零(节奏切把一段话对半切,
 * 前后本就连续)或任一段太短(会被交叠吃掉)时就别淡。逐条独立:一条拼缝
 * 淡不了,不该把别的拼缝也拖成硬接。
 */
export function seamCrossfades(
  segments: Array<{ startSec: number; endSec: number }>,
  leadSec: number = SEAM_LEAD_SEC
): number[] {
  const out: number[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const gap = segments[i + 1].startSec - segments[i].endSec;
    const prevLen = segments[i].endSec - segments[i].startSec;
    const nextLen = segments[i + 1].endSec - segments[i + 1].startSec;
    // 单边量:不能超过那条静音(前后两头读的都在这段里),也不能超过任一段的
    // 一半(交叠吃掉整段,拼缝就没有干净的声音了)
    const lead = Math.max(0, Math.min(leadSec, gap, prevLen / 2, nextLen / 2));
    const rounded = Math.floor(lead * 2 * 1000) / 1000;
    out.push(rounded >= 0.02 ? rounded : 0);
  }
  return out;
}

/**
 * 环形收口的默认长度:最后这么多秒折回开头那一帧。选段时 AI 评审已经判定过
 * 「最后一句绕回第一句」(candidate.loop),但那个标记此前只参与排序加分,成片
 * 本身照旧硬邦邦地停在最后一个音节上——重播时就是一次「跳回开头」。收口把这
 * 0.3 秒接起来:观众看到的是结尾融进了开头,而不是一个切点。
 */
export const LOOP_CLOSE_SEC = 0.3;

/** 收口长度上限——再长就不是收口,是把整条片子倒放了一遍。 */
const LOOP_CLOSE_MAX_SEC = 1;
/** 短过这个长度就不值得收口:那不是片子,是一次闪。 */
const MIN_LOOP_CLOSE_DURATION_SEC = 1;
/** 收口自身的最短长度:再短就是一次闪,不是融合。 */
const MIN_LOOP_CLOSE_SEC = 0.12;

/**
 * 实际做的收口长度(秒);0 = 不做。成片至少要 1 秒,收口最多吃片长的四分之一
 * (片长 1 秒时收口缩到 0.25 秒),短到 0.12 秒以下干脆不做——那不是收口,是闪
 * 一下。纯函数,判据与渲染无关,测试直接断言。
 */
export function loopCloseSec(durationSec: number, requested?: number): number {
  const want = Math.min(requested ?? 0, LOOP_CLOSE_MAX_SEC);
  if (!(want > 0) || !Number.isFinite(want)) return 0;
  if (!(durationSec >= MIN_LOOP_CLOSE_DURATION_SEC)) return 0;
  const sec = Math.min(want, durationSec / 4);
  return Number((sec >= MIN_LOOP_CLOSE_SEC ? sec : 0).toFixed(3));
}

/**
 * 环形收口的画面段(纯函数)。`inLabel` 为空 = 接在调用方那条链后面(逗号延续),
 * 否则从 `[inLabel]` 起新链;`outLabel` 是收口后的输出标签。
 *
 * 做法:把成片一分为二,取**开头**那 L 秒倒放,叠到末尾与正片交叉淡化,偏移量
 * 落在「片长 − L」。倒放的开头走到终点正好是原片第 0 帧,所以成片最后一帧就是
 * 第一帧(收口判据「首末帧相似度」= 1),而总长一帧不变——重播时接缝在肉眼上
 * 不存在,只是一次 L 秒的融合。倒放只倒帧序,画面内容照旧,字幕/水印跟着平稳过渡。
 *
 * 倒的是**开头**不是结尾:倒结尾的话,倒放段走到终点是「结尾的第一帧」,收口
 * 只是把片尾又演了一遍,最后一帧还不是第一帧(第一版就是这么写错的,探针量出来
 * 首末帧差异 4.28 > 不做的 1.91 才发现)。
 */
export function loopCloseVideoStage(
  inLabel: string,
  outLabel: string,
  durationSec: number,
  closeSec: number
): string {
  const offset = Math.max(0, durationSec - closeSec).toFixed(3);
  const head = inLabel === "" ? "split" : `${inLabel}split`;
  return (
    `${head}[zl0][zl1];` +
    // trim 只取开头 L 秒再倒放:reverse 要把整段读进内存,不先裁就把成片全缓存一遍
    `[zl1]trim=end=${closeSec.toFixed(3)},setpts=PTS-STARTPTS,reverse[zl2];` +
    `[zl0][zl2]xfade=transition=fade:duration=${closeSec.toFixed(3)}:offset=${offset}${outLabel}`
  );
}

/**
 * 环形收口的声音段(纯函数),与画面段同构:把成片一分为二,取**开头** L 秒倒放
 * 叠到末尾与正片等功率交叉淡化,总长一秒不差地等于 `durationSec`,末样本正好落
 * 在源片第 0 个样本上(重播回到开头是样本连续的,没有接缝爆点)。
 *
 * 声音也倒放:画面那 L 秒本来就是倒着走的(见 loopCloseVideoStage),声音跟着倒
 * 才对得上口型,听感是一次有意的「倒带」;不倒放的话收口只能融进开头那 L 秒的
 * **正向**声音,结尾停在源片第 L 秒,重播回第 0 秒就是一次爆点。倒放段只回卷
 * 开头 L 秒,不是整句人声倒着念。
 *
 * 这里不用 acrossfade:它按输入的绝对 PTS 对齐,输出长度取决于两段的相对长短
 * (实测 A=6s + B=0.3s → 0.03s,B=3s → 2.74s),收口这种「一段很长 + 一段很
 * 短」的形状会直接把声音削没。所以自己搭:x 取片头正片 → 淡出的片尾 + 淡入的
 * 倒放片头 → 等功率混音(长度 L)→ 拼回片头。
 * (qsin:两段不同时刻的人声互不相关,线性淡化会在交叠处掉 ~3dB;`normalize=0`
 * 因为淡入淡出本就互补,amix 默认再除 2 会把整段压低一半。)
 */
export function loopCloseAudioStage(
  inLabel: string,
  outLabel: string,
  durationSec: number,
  closeSec: number
): string {
  const close = closeSec.toFixed(3);
  const offset = Math.max(0, durationSec - closeSec).toFixed(3);
  const head = inLabel === "" ? "asplit=3" : `${inLabel}asplit=3`;
  return (
    `${head}[za0][za1][za2];` +
    // 片头正片:收口区之前的部分,原样保留
    `[za0]atrim=end=${offset},asetpts=PTS-STARTPTS[zb];` +
    // 片尾:等功率淡出
    `[za1]atrim=start=${offset}:end=${durationSec.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=out:st=0:d=${close}:curve=qsin[zt];` +
    // 片头 L 秒倒放:等功率淡入,走到终点即源片第 0 个样本
    `[za2]atrim=end=${close},asetpts=PTS-STARTPTS,areverse,afade=t=in:st=0:d=${close}:curve=qsin[zh];` +
    `[zt][zh]amix=inputs=2:duration=longest:normalize=0[zm];` +
    `[zb][zm]concat=n=2:v=0:a=1${outLabel}`
  );
}

/**
 * yuv420p needs even dimensions; concat needs all pieces identical. Round DOWN
 * so a crop can never ask for more rows/columns than the scaled frame has
 * ("Failed to inject frame into filter network" when it does).
 */
export function evenFrame(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/**
 * 运镜(zoompan)输入那一帧的尺寸——超采样的像素预算按它算。拿不到尺寸
 * (调用方没传源画面尺寸)返回 null:无从判断放不放得下,就不放大。
 * 竖屏居中裁剪走的是动态表达式,这里按源尺寸估一份:估错最多让预算差几
 * 个百分点,12MP 的门槛离 1080p 的两三倍还远。纯函数。
 */
function zoomFrameSize(options: CutOptions, panning: boolean): { w: number; h: number } | null {
  const track = options.trackPlan;
  if (track) return { w: track.cropW + (panning ? 2 : 0), h: track.cropH };
  const srcW = options.srcW ?? 0;
  const srcH = options.srcH ?? 0;
  if (!(srcW > 0) || !(srcH > 0)) return null;
  const ui = options.uiCrop;
  const tall =
    ui && (ui.topFrac > 0 || ui.bottomFrac > 0)
      ? srcH * Math.max(0.2, 1 - ui.topFrac - ui.bottomFrac)
      : srcH;
  if (!options.vertical) return { w: srcW, h: tall };
  return { w: Math.min(srcW, (tall * 9) / 16), h: Math.min(tall, (srcW * 16) / 9) };
}

/** -metadata k=v 参数对(纯函数,cut 与 audiogram 共用)。 */
export function metadataArgs(metadata?: Record<string, string>): string[] {
  return Object.entries(metadata ?? {}).flatMap(([k, v]) => ["-metadata", `${k}=${v}`]);
}

/** 解析 ffmpeg -progress 输出块里的 out_time_us/out_time_ms → 已编码秒数。 */
export function parseFfmpegProgress(chunk: string): number | null {
  // out_time_us 是微秒;老字段 out_time_ms 名字带 ms 实际也是微秒(ffmpeg 历史坑)
  const m = chunk.match(/out_time_us=(\d+)/) ?? chunk.match(/out_time_ms=(\d+)/);
  if (!m) return null;
  const us = Number(m[1]);
  return Number.isFinite(us) ? us / 1_000_000 : null;
}

/**
 * spawn 版 ffmpeg 执行:-progress pipe:1 流式回报已编码秒数(切片内实时
 * 进度),stderr 只留尾部(报错定位),AbortSignal 直接 kill 子进程。
 * cut/jump-cut/audiogram 三条出片路径共用。
 */
export async function runFfmpeg(
  args: string[],
  opts: { signal?: AbortSignal; onTimeSec?: (sec: number) => void } = {}
): Promise<void> {
  opts.signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), ["-progress", "pipe:1", "-nostats", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    });
    let processError: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const forceStop = (): void => {
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
      killTimer.unref();
    };
    opts.signal?.addEventListener("abort", forceStop, { once: true });
    let stderrTail = "";
    child.stderr.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
    child.stdout.on("data", (d: Buffer) => {
      const sec = parseFfmpegProgress(d.toString());
      if (sec !== null) opts.onTimeSec?.(sec);
    });
    // Abort emits error before close. Wait for close before a caller removes or
    // publishes the output (especially important while Windows holds the file).
    child.on("error", (e) => { processError = e; });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", forceStop);
      if (opts.signal?.aborted) reject(opts.signal.reason ?? new Error("export cancelled"));
      else if (processError) reject(processError);
      else if (code === 0) resolve();
      else reject(new Error(stderrTail.split("\n").slice(-6).join("\n") || `ffmpeg exited ${code}`));
    });
  });
}

/** 水印参数(widthPx 由调用方按输出宽度算好传入)。 */
export interface WatermarkSpec {
  path: string;
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  /** 0..1。 */
  opacity: number;
  /** 缩放到的目标宽度(像素)。 */
  widthPx: number;
}

/** 水印距画面边缘的像素间距。 */
const WM_MARGIN = 44;

/**
 * 水印的两段 filter:source(movie 源读 PNG + 透明度 + 缩放)与 overlay
 * (按角落定位)。拆开返回,方便 -vf 与 filter_complex 两条路径各自组装。
 */
export function watermarkStages(wm: WatermarkSpec): { source: string; overlay: string } {
  const alpha = wm.opacity < 1 ? `,colorchannelmixer=aa=${wm.opacity.toFixed(3)}` : "";
  const pos = {
    "top-left": `${WM_MARGIN}:${WM_MARGIN}`,
    "top-right": `W-w-${WM_MARGIN}:${WM_MARGIN}`,
    "bottom-left": `${WM_MARGIN}:H-h-${WM_MARGIN}`,
    "bottom-right": `W-w-${WM_MARGIN}:H-h-${WM_MARGIN}`,
  }[wm.corner];
  return {
    source: `movie='${escapeFilterPath(wm.path)}',format=rgba${alpha},scale=${wm.widthPx}:-1`,
    overlay: `overlay=${pos}:format=auto`,
  };
}

/**
 * 把线性 -vf 链与水印合成为最终 -vf 表达式。无水印时保持原样;有水印时
 * 用 movie 源在 -vf 内部起第二路输入(字幕之后叠加,logo 永远在最上层)。
 */
export function composeVideoFilter(filters: string[], wm?: WatermarkSpec): string {
  if (!wm) return filters.join(",");
  const main = filters.length > 0 ? filters.join(",") : "copy";
  const s = watermarkStages(wm);
  return `${main}[main];${s.source}[wm];[main][wm]${s.overlay}`;
}

/**
 * ffmpeg filter-graph path escaping for the subtitles filter: forward slashes
 * everywhere, escape the Windows drive colon, guard stray quotes.
 */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/** Compose the -vf chain for reframing + caption burn-in. Empty = no filter. */
export function buildVideoFilters(options: CutOptions): string[] {
  const filters: string[] = [];
  const toneMap = options.color ? hdrToneMapFilter(options.color) : null;
  // HDR transfer/primaries must be normalized while pixels still represent the
  // untouched source. Geometry, zoom, picture finishing and text all operate on
  // the resulting SDR signal, preventing overlays from being tone-mapped too.
  if (toneMap) filters.push(toneMap);
  const enhance = visualEnhanceFilter(options.visualEnhance);
  // 自动运镜:zoompan 顶替 scale 那一步(它自己出目标尺寸);返回 null 就照旧。
  // 输出尺寸默认竖屏目标 1080×1920;横屏出口由 caller 传源帧尺寸过来,
  // 运镜后的几何才和「不走运镜」时一致(拼回正片靠尺寸完全相同)。
  const az = options.autoZoom;
  const zoomW = evenFrame(az?.outW && az.outW > 0 ? az.outW : 1080);
  const zoomH = evenFrame(az?.outH && az.outH > 0 ? az.outH : 1920);
  const zoom = az
    ? buildZoomFilter(az.durationSec, az.fps, zoomW, zoomH, {
        emphasisAtSec: az.emphasisAtSec,
        punchTo: az.punchTo,
        ...(az.punchOnly ? { breathZoom: ZOOM_BASE, emphasisZoom: ZOOM_BREATH } : {}),
      })
    : null;
  // 运镜的位置量化只到「色度网格」:zoompan 的窗口坐标取整后按 2 像素对齐,
  // crop 的 x 同样被对齐到 2 像素(yuv420p)。1080p 竖屏裁 606 宽再放到 1080,
  // 1 源像素 = 1.78 输出像素 → 每 3.56 输出像素才走一格,观感就是「冻一阵、
  // 再跳一下」。中间垫一层放大的 444p 工作帧,量化细到 1 工作像素(见
  // autozoom.ts ZOOM_SS):444p 让色度网格消失,放大帧自己的整像素就是新网格。
  const track = options.trackPlan;
  const panning = track ? /\bt\b/.test(track.cropXExpr) : false;
  const frame = zoom ? zoomFrameSize(options, panning) : null;
  const ss = frame ? zoomSupersampleFactor(frame.w, frame.h) : 1;
  const ssStage = zoomSupersampleStage(ss);
  // 借 1 像素:窗口左边从 floor(X)-1 起、整体多裁 2 列,放大的工作帧上再把
  // 亚像素余量补回去——位置量化从 2 源像素(3.56 输出像素)降到 1 工作像素。
  // 借不动(源宽不够、没有平移)就退回旧链:宁可有抖动,也不裁到画面外。
  const borrow = track !== undefined && panning && ssStage !== "" && (options.srcW ?? 0) >= track.cropW + 2;
  /** 真的垫过工作帧的链路,收尾才需要转回 420p(concat/xfade/编码器都要)。 */
  const ssUsed = ssStage !== "";
  const ssTail = ssUsed ? ["format=yuv420p"] : [];
  const toVertical = zoom
    ? [zoom, "setsar=1", ...ssTail]
    : ["scale=1080:1920:flags=lanczos", "setsar=1"];
  if (track) {
    if (borrow) {
      filters.push(
        `crop=w=${track.cropW + 2}:h=${track.cropH}:x='floor(${track.cropXExpr})-1':y=${track.cropY}:exact=1`,
        ssStage,
        `crop=w=${ss * track.cropW}:h=${ss * track.cropH}:x='${ss}*(1+(${track.cropXExpr})-floor(${track.cropXExpr}))':y=0`
      );
    } else {
      // 固定机位:没有亚像素余量要补,放大帧只治 zoompan 自己的色度网格对齐
      filters.push(
        `crop=w=${track.cropW}:h=${track.cropH}:x='${track.cropXExpr}':y=${track.cropY}`,
        ...(ssUsed ? [ssStage] : [])
      );
    }
    filters.push(...toVertical);
    if (enhance) filters.push(enhance);
    if (options.subtitlePath) {
      const fonts = options.fontsDir ? `:fontsdir='${escapeFilterPath(options.fontsDir)}'` : "";
      filters.push(`subtitles=filename='${escapeFilterPath(options.subtitlePath)}'${fonts}`);
    }
    const speedStage = speedVideoStage(options.speedRate);
    if (speedStage) filters.push(speedStage);
    return filters;
  }
  const ui = options.uiCrop;
  if (ui && (ui.topFrac > 0 || ui.bottomFrac > 0)) {
    // strip static screen-recording chrome BEFORE any reframe; keep dims even
    const keep = Math.max(0.2, 1 - ui.topFrac - ui.bottomFrac);
    filters.push(`crop=w=iw:h='floor(ih*${keep.toFixed(4)}/2)*2':x=0:y='floor(ih*${ui.topFrac.toFixed(4)}/2)*2'`);
  }
  const fill = planFill({
    mode: options.fillMode,
    vertical: Boolean(options.vertical),
    hasTrack: Boolean(track),
    hasZoom: Boolean(zoom),
    srcW: options.srcW,
    srcH: options.srcH,
    outW: zoomW,
    outH: zoomH,
  });
  if (options.vertical && fill === "blur") {
    // 模糊填边:整帧缩到宽度居中,底下垫一层放大裁满的模糊压暗版(见 fill.ts)。
    // 不走居中裁剪,所以那一步的尺寸表达式和超采样都不需要。
    filters.push(blurFillStage(zoomW, zoomH));
  } else if (options.vertical) {
    // Center crop to exactly 9:16 (whichever axis binds), then normalize size.
    // 居中裁剪的尺寸是动态表达式,超采样用不太精确的那份估算(只是像素预算)。
    filters.push(
      "crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)'",
      ...(ssUsed ? [ssStage] : []),
      ...toVertical
    );
  } else if (zoom) {
    // 横屏运镜:zoompan 自带输出尺寸,不再叠竖屏 scale——画幅、帧率、
    // 像素格式全部保持源样,正片那边照旧是源尺寸,两边能拼到一起。
    filters.push(...(ssUsed ? [ssStage] : []), zoom, "setsar=1", ...ssTail);
  }
  if (enhance) filters.push(enhance);
  if (options.subtitlePath) {
    const fonts = options.fontsDir ? `:fontsdir='${escapeFilterPath(options.fontsDir)}'` : "";
    filters.push(`subtitles=filename='${escapeFilterPath(options.subtitlePath)}'${fonts}`);
  }
  // 变速:放最末尾,字幕按源时间烧完再整体压缩时间戳
  const speed = speedVideoStage(options.speedRate);
  if (speed) filters.push(speed);
  return filters;
}

/** Build the ffmpeg argument list for one cut. Pure — no I/O. */
export function buildCutArgs(
  inputPath: string,
  outputPath: string,
  startSec: number,
  endSec: number,
  options: CutOptions = {}
): string[] {
  if (!(endSec > startSec)) {
    throw new Error(`invalid cut range: start=${startSec} end=${endSec}`);
  }
  const filters = buildVideoFilters(options);
  const start = Math.max(0, startSec);
  const duration = endSec - start;
  // 环形收口要重排尾段画面并跨路取音频,所以它自己也强制重编码。
  const loop = loopCloseSec(duration, options.loopCloseSec);
  // 收口按源时长倒放尾段,变速会改掉时长——两者同时出现是调用方的错,
  // 与其出一版接错的片子,不如当场报错(调用方有回退路径)
  if (loop > 0 && speedVideoStage(options.speedRate)) {
    throw new Error("speedRate cannot be combined with loopCloseSec");
  }
  // Any video filter — or an audio filter (loudnorm/denoise) — forces a
  // re-encode, so silently upgrade copy → accurate.
  const mode =
    filters.length > 0 || options.watermark || options.normalizeLoudness || options.denoise || loop > 0
      ? "accurate"
      : (options.mode ?? "accurate");

  // Fast seek: -ss BEFORE -i jumps by keyframe index (instant even at hour 3
  // of a VOD); the decoder then trims precisely inside the segment. Input
  // seeking also resets PTS to ~0, which is exactly what the clip-relative
  // ASS karaoke timestamps assume.
  // 变速时 `-t` 必须量**源时间**,所以挪到 `-i` 前面(输入侧:最多读多少源)。
  // 放在输出侧量的是输出时间:setpts 把时间戳压扁后,ffmpeg 要读到输出时间走完
  // 整个切片才收手,实际多吃 `时长 × 倍率` 的源——3 秒的迷你片会变成 4.2 秒的
  // 内容压成 3 秒,计划时长/字幕/交叠全对不上。`-ss` 仍是输入侧定位(关键帧跳
  // 转),两者合起来就是「从 start 起读 duration 秒源」。
  const common = speedVideoStage(options.speedRate)
    ? ["-hide_banner", "-y", "-ss", toFfmpegTime(start), "-t", toFfmpegTime(duration), "-i", inputPath]
    : ["-hide_banner", "-y", "-ss", toFfmpegTime(start), "-i", inputPath, "-t", toFfmpegTime(duration)];
  const maps = [
    "-map", ffmpegVideoStreamSpecifier(options.videoStreamIndex),
    "-map", ffmpegAudioStreamSpecifier(options.audioStreamIndex, 0, true),
  ];

  if (mode === "copy") {
    return [...common, ...maps, "-c", "copy", "-avoid_negative_ts", "make_zero", ...metadataArgs(options.metadata), outputPath];
  }

  const crf = Number.isFinite(options.crf) ? String(options.crf) : "18";
  const preset = options.preset ?? "veryfast";
  const copyVideo = Boolean(options.videoCopy && filters.length === 0 && !options.watermark);
  // 音频链固定顺序:降噪 → 响度标准化(loudnorm 必须看到去噪后的音频)
  // → 边缘淡化(放最后,loudnorm 的动态增益才不会把淡化抬回去)
  const speedAudio = speedAudioStage(options.speedRate);
  const audioChain = [
    ...(options.denoise ? [DENOISE_FILTER] : []),
    ...(options.normalizeLoudness ? [LOUDNORM_FILTER] : []),
    ...muteRangeFilters(options.muteRanges),
    ...edgeFadeFilters(duration),
    // 变速放最后:淡入淡出按源时间做完,再连画面一起压缩时间轴
    ...(speedAudio ? [speedAudio] : []),
  ];
  // 环形收口:画面倒放融回第一帧,声音等功率融合。尾段倒放要求「同一条流取两
  // 支」,线性 -vf/-af 里没有跨路输入,所以这一条整体走 filter_complex——视频
  // 链照抄 -vf 的那串(含水印的 movie 源),音频链照抄 -af 的那串。
  if (loop > 0) {
    const vChain = filters.length > 0 || options.watermark ? composeVideoFilter(filters, options.watermark) : "null";
    const aChain = audioChain.length > 0 ? audioChain.join(",") : "anull";
    return [
      ...common,
      "-filter_complex",
      [
        `[${ffmpegVideoStreamSpecifier(options.videoStreamIndex)}]${vChain},${loopCloseVideoStage("", "[vout]", duration, loop)}`,
        `[${ffmpegAudioStreamSpecifier(options.audioStreamIndex)}]${aChain},${loopCloseAudioStage("", "[aout]", duration, loop)}`,
      ].join(";"),
      "-map", "[vout]",
      "-map", "[aout]",
      ...videoEncoderArgs(options.encoder ?? "libx264", Number(crf), preset),
      "-pix_fmt", "yuv420p",
      ...(options.color ? colorOutputArgs(options.color) : []),
      ...(options.normalizeLoudness ? ["-ar", LOUDNORM_OUT_RATE] : []),
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      ...metadataArgs(options.metadata),
      outputPath,
    ];
  }
  return [
    ...common,
    ...maps,
    ...(filters.length > 0 || options.watermark ? ["-vf", composeVideoFilter(filters, options.watermark)] : []),
    ...(copyVideo
      ? ["-c:v", "copy"]
      : [...videoEncoderArgs(options.encoder ?? "libx264", Number(crf), preset), "-pix_fmt", "yuv420p"]),
    ...(options.color ? colorOutputArgs(options.color) : []),
    ...(audioChain.length > 0 ? ["-af", audioChain.join(",")] : []),
    ...(options.normalizeLoudness ? ["-ar", LOUDNORM_OUT_RATE] : []),
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    ...metadataArgs(options.metadata),
    outputPath,
  ];
}

/**
 * Jump-cut arg builder: keep only `segments` (absolute source time) of one
 * clip and splice them in a single filter_complex pass — trim/atrim → concat
 * → optional reframe + caption burn-in. Fast seek still applies: we seek to
 * the clip start and express segment times relative to the seek point.
 */
export function buildJumpCutArgs(
  inputPath: string,
  outputPath: string,
  clipStartSec: number,
  segments: Array<{ startSec: number; endSec: number }>,
  options: CutOptions = {}
): string[] {
  if (segments.length === 0) throw new Error("jump cut requires at least one segment");
  // 跳切自己拼时间轴(逐段 trim + concat + 交叠),变速的 setpts 没有落点;而且
  // 计划时长/字幕/运镜都按变速前的秒数算过。与其出一版速度没变的片子(静默
  // 丢弃),不如当场报错——调用方有回退路径。
  if (speedVideoStage(options.speedRate)) {
    throw new Error("speedRate is not supported by jump cuts");
  }
  // 首段可能被「补进静音」拉到切片起点之前(见 gaps.snapOuterEdgesToQuiet):
  // seek 取两者较小值,否则首个 trim 的 start 被夹到 0、补静音的那一段被悄悄
  // 丢掉,成片比计划短一截,字幕/运镜/时长全部对不上。
  const seek = Math.max(0, Math.min(clipStartSec, segments[0].startSec));
  const lastEnd = segments[segments.length - 1].endSec;
  const readDuration = lastEnd - seek + 0.5; // small margin past the tail

  const parts: string[] = [];
  const videoLabels: string[] = [];
  const audioLabels: string[] = [];
  const videoInput = ffmpegVideoStreamSpecifier(options.videoStreamIndex);
  const audioInput = ffmpegAudioStreamSpecifier(options.audioStreamIndex);
  const transition = Math.max(0, Math.min(options.transitionSec ?? 0, 0.5));
  const crossfading = transition > 0 && segments.length > 1;
  // 纯音频拼缝淡化仅在硬切路径上做:交叉淡化时画面本身已经交叠,acrossfade
  // 已经包住接缝。
  const seams = crossfading ? [] : seamCrossfades(segments);
  const durations = segments.map((s) => Math.max(0, s.endSec - s.startSec));
  const anySeam = seams.some((s) => s > 0);
  const punch = options.punchIn;
  const punchW = punch ? evenFrame(punch.width) : 0;
  const punchH = punch ? evenFrame(punch.height) : 0;
  const punchScale = punch?.scale ?? PUNCH_IN_SCALE;
  segments.forEach((s, i) => {
    const a = Math.max(0, s.startSec - seek);
    const b = Math.max(a, s.endSec - seek);
    const visual = [`trim=start=${a.toFixed(3)}:end=${b.toFixed(3)}`, "setpts=PTS-STARTPTS"];
    // Colour match before any geometry: eq operates on the source frame.
    const grade = pieceColorFilter(options.pieceGrade?.[i]);
    if (grade) visual.push(grade);
    if (punch) {
      if (i % 2 === 1) {
        // Odd pieces push in; even pieces only rescale to the same target, so
        // the splice alternates between two framing sizes. setsar=1 on both:
        // scale normalizes SAR to 1:1 while trim/crop keep the source's, and
        // concat rejects pieces whose SAR differs even at identical size.
        visual.push(`scale=${evenFrame(punch.width * punchScale)}:${evenFrame(punch.height * punchScale)}:flags=bicubic`);
        visual.push(`crop=${punchW}:${punchH}`, "setsar=1");
      } else {
        visual.push(`scale=${punchW}:${punchH}`, "setsar=1");
      }
    }
    parts.push(`[${videoInput}]${visual.join(",")}[v${i}]`);
    // 每段两端 30ms 淡化:相邻段的淡出+淡入在拼缝处相接,消掉跳剪爆音。
    // 但拼缝已经另有交代时不能再叠:交叠区里叠首尾淡会凹一刀(听感是「抖一下」),
    // 而节奏切(前后本是同一段连续声音)连淡都是多余的。只在「这条拼缝既没
    // 交叠、又真的删掉了一段声音」时,才给两侧各留 30ms。
    const last = i === segments.length - 1;
    const seamBefore = i === 0 ? 0 : (seams[i - 1] ?? 0);
    const seamAfter = last ? 0 : (seams[i] ?? 0);
    const gapBefore = i === 0 ? 0 : segments[i].startSec - segments[i - 1].endSec;
    const gapAfter = last ? 0 : segments[i + 1].startSec - segments[i].endSec;
    // 画面交叉淡化时接缝由 xfade 交代,内层再叠淡会在交叠区凹一刀,两侧都不淡。
    const fades = edgeFadeFilters(b - a, {
      in: i === 0 || (!crossfading && seamBefore === 0 && gapBefore > 0.02),
      out: last || (!crossfading && seamAfter === 0 && gapAfter > 0.02),
    });
    const fadeSuffix = fades.length > 0 ? `,${fades.join(",")}` : "";
    // 拼缝交叠(以画面切点为中心):前段尾巴多读 seamAfter/2(L-cut:画面切了声音
    // 还在),后段早进 seamBefore/2(J-cut:声音先起画面还没切)。两头读到的都是被
    // 切掉的那段静音,acrossfade 再从两边各吃掉交叠总长,所以总长仍等于画面总长。
    const leadOut = seamAfter > 0 ? seamAfter / 2 : 0;
    const leadIn = seamBefore > 0 ? seamBefore / 2 : 0;
    const audioStart = Math.max(0, a - leadIn);
    parts.push(
      `[${audioInput}]atrim=start=${audioStart.toFixed(3)}:end=${(b + leadOut).toFixed(3)},asetpts=PTS-STARTPTS${fadeSuffix}[a${i}]`
    );
    videoLabels.push(`[v${i}]`);
    audioLabels.push(`[a${i}]`);
  });
  const post = buildVideoFilters(options);
  const wm = options.watermark;
  const concatOut = post.length > 0 || wm ? "[vc]" : "[vout]";
  // Process the *spliced* audio (denoise/loudnorm must see the final
  // concatenated stream, not each segment) — concat → [araw] → chain → [aout].
  const audioChain = [
    ...(options.denoise ? [DENOISE_FILTER] : []),
    ...(options.normalizeLoudness ? [LOUDNORM_FILTER] : []),
    ...muteRangeFilters(options.muteRanges),
  ];
  const audioOut = audioChain.length > 0 ? "[araw]" : "[aout]";
  if (crossfading) {
    // Cross-fade chain: xfade overlaps picture, acrossfade overlaps audio, and
    // both shorten the timeline by the same amount, so they stay in sync.
    let videoLabel = "[v0]";
    let audioLabel = "[a0]";
    let cumulative = durations[0];
    for (let i = 1; i < segments.length; i++) {
      const last = i === segments.length - 1;
      const offset = Math.max(0, cumulative - transition).toFixed(3);
      parts.push(
        `${videoLabel}[v${i}]xfade=transition=fade:duration=${transition.toFixed(3)}:offset=${offset}${last ? concatOut : `[vx${i}]`}`
      );
      parts.push(
        // qsin = equal-power: a linear (tri) cross-fade dips ~3 dB where two
        // uncorrelated voices overlap, which reads as a hiccup at every seam.
        `${audioLabel}[a${i}]acrossfade=d=${transition.toFixed(3)}:c1=qsin:c2=qsin${last ? audioOut : `[ax${i}]`}`
      );
      videoLabel = `[vx${i}]`;
      audioLabel = `[ax${i}]`;
      cumulative += durations[i] - transition;
    }
  } else if (anySeam) {
    // 硬切画面 + 连续声音:画面走纯视频 concat,声音逐拼缝处理——有静音可借
    // 的拼缝转 acrossfade(等功率),没有的(节奏切,前后本就连续)直接接。
    parts.push(`${videoLabels.join("")}concat=n=${segments.length}:v=1:a=0${concatOut}`);
    let audioLabel = audioLabels[0];
    for (let i = 1; i < segments.length; i++) {
      const last = i === segments.length - 1;
      const out = last ? audioOut : `[as${i}]`;
      const d = seams[i - 1] ?? 0;
      parts.push(
        d > 0
          ? // qsin = equal-power,理由同下面的交叉淡化:线性淡化在交叠处掉 ~3dB。
            `${audioLabel}${audioLabels[i]}acrossfade=d=${d.toFixed(3)}:c1=qsin:c2=qsin${out}`
          : // 纯音频 concat:同一条声音被对半切开,接回去本来就连着。
            `${audioLabel}${audioLabels[i]}concat=n=2:v=0:a=1${out}`
      );
      audioLabel = `[as${i}]`;
    }
  } else {
    // concat 的 v/a 输入必须逐段交替([v0][a0][v1][a1]…)。
    const paired = segments.map((_, i) => `[v${i}][a${i}]`).join("");
    parts.push(`${paired}concat=n=${segments.length}:v=1:a=1${concatOut}${audioOut}`);
  }
  if (wm) {
    // 水印永远最后叠(在字幕之上):后处理链 → [vmain],movie 源 → [wm],overlay 收口
    const s = watermarkStages(wm);
    const mainLabel = post.length > 0 ? "[vmain]" : "[vc]";
    if (post.length > 0) parts.push(`[vc]${post.join(",")}[vmain]`);
    parts.push(`${s.source}[wm]`);
    parts.push(`${mainLabel}[wm]${s.overlay}[vout]`);
  } else if (post.length > 0) {
    parts.push(`[vc]${post.join(",")}[vout]`);
  }
  if (audioChain.length > 0) parts.push(`[araw]${audioChain.join(",")}[aout]`);

  // 环形收口接在最后(字幕/水印/音频链之后):收的是成片的第一帧与最后一帧。
  // 拼接后的总长要按交叠扣一遍,收口的偏移量才落在真正的「片长 − L」上。
  const outputDurationSec =
    durations.reduce((acc, d) => acc + d, 0) - transition * Math.max(0, segments.length - 1);
  const loop = loopCloseSec(outputDurationSec, options.loopCloseSec);
  let videoOutput = "[vout]";
  let audioOutput = "[aout]";
  if (loop > 0) {
    parts.push(loopCloseVideoStage("[vout]", "[vloop]", outputDurationSec, loop));
    parts.push(loopCloseAudioStage("[aout]", "[aloop]", outputDurationSec, loop));
    videoOutput = "[vloop]";
    audioOutput = "[aloop]";
  }

  const crf = Number.isFinite(options.crf) ? String(options.crf) : "18";
  const preset = options.preset ?? "veryfast";
  return [
    "-hide_banner", "-y",
    "-ss", toFfmpegTime(seek),
    "-i", inputPath,
    "-t", toFfmpegTime(readDuration),
    "-filter_complex", parts.join(";"),
    "-map", videoOutput,
    "-map", audioOutput,
    ...videoEncoderArgs(options.encoder ?? "libx264", Number(crf), preset),
    "-pix_fmt", "yuv420p",
    ...(options.color ? colorOutputArgs(options.color) : []),
    ...(options.normalizeLoudness ? ["-ar", LOUDNORM_OUT_RATE] : []),
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    ...metadataArgs(options.metadata),
    outputPath,
  ];
}

/** Execute a jump cut. Throws with ffmpeg's stderr tail on failure. */
export async function cutJumpClip(
  inputPath: string,
  outputPath: string,
  clipStartSec: number,
  segments: Array<{ startSec: number; endSec: number }>,
  options: CutOptions = {},
  signal?: AbortSignal,
  onTimeSec?: (sec: number) => void
): Promise<void> {
  await withAtomicOutput(outputPath, async (temporaryPath) => {
    const args = buildJumpCutArgs(inputPath, temporaryPath, clipStartSec, segments, options);
    try {
      await runFfmpeg(args, { signal, onTimeSec });
    } catch (e) {
      if (options.encoder && options.encoder !== "libx264" && !signal?.aborted) {
        await runFfmpeg(
          buildJumpCutArgs(inputPath, temporaryPath, clipStartSec, segments, { ...options, encoder: "libx264" }),
          { signal, onTimeSec }
        );
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      const tail = msg.split("\n").slice(-6).join("\n");
      throw new Error(`ffmpeg jump cut failed (${segments.length} segments): ${tail}`);
    }
  }, signal);
}

/** Execute one cut. Throws with ffmpeg's stderr tail on failure. */
export async function cutClip(
  inputPath: string,
  outputPath: string,
  startSec: number,
  endSec: number,
  options: CutOptions = {},
  signal?: AbortSignal,
  onTimeSec?: (sec: number) => void
): Promise<"copy" | "encode"> {
  return withAtomicOutput(outputPath, async (temporaryPath) => {
    const args = buildCutArgs(inputPath, temporaryPath, startSec, endSec, options);
    try {
      await runFfmpeg(args, { signal, onTimeSec });
      return options.videoCopy ? "copy" : "encode";
    } catch (e) {
      // Smart video copy is an optimization only. Container/bitstream quirks can
      // still reject an otherwise eligible stream, so retry the proven accurate
      // path before considering hardware-encoder fallback.
      if (options.videoCopy && !signal?.aborted) {
        try {
          await runFfmpeg(
            buildCutArgs(inputPath, temporaryPath, startSec, endSec, { ...options, videoCopy: false }),
            { signal, onTimeSec }
          );
          return "encode";
        } catch (accurateError) {
          e = accurateError;
        }
      }
      if (options.encoder && options.encoder !== "libx264" && !signal?.aborted) {
        await runFfmpeg(
          buildCutArgs(inputPath, temporaryPath, startSec, endSec, { ...options, videoCopy: false, encoder: "libx264" }),
          { signal, onTimeSec }
        );
        return "encode";
      }
      const msg = e instanceof Error ? e.message : String(e);
      // ffmpeg errors bury the cause at the end of stderr — surface only the tail
      const tail = msg.split("\n").slice(-6).join("\n");
      throw new Error(`ffmpeg cut failed (${toFfmpegTime(startSec)}→${toFfmpegTime(endSec)}): ${tail}`);
    }
  }, signal);
}

/** concat demuxer 列表文件内容(路径里的单引号按其语法转义)。 */
export function buildConcatList(paths: string[]): string {
  return paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

/**
 * 拼接参数:同一管线导出的分片编码参数一致,流复制(-c copy)秒级完成、
 * 零画质损失;硬切衔接(合集/高潮前置的通行做法,转场要整体重编码)。
 * metadata 用于把容器元数据(如 AIGC 隐式标识)补到拼接产物上。
 */
export function buildConcatArgs(listPath: string, outputPath: string, metadata?: Record<string, string>): string[] {
  return ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", ...metadataArgs(metadata), outputPath];
}

/** 把多条已导出分片按序流复制拼接。列表文件落在输出旁,跑完即删。 */
export async function concatClips(
  paths: string[],
  outputPath: string,
  signal?: AbortSignal,
  metadata?: Record<string, string>
): Promise<void> {
  if (paths.length < 2) throw new Error("concat requires at least two clips");
  await withAtomicOutput(outputPath, async (temporaryPath) => {
    const listPath = `${temporaryPath}.list.txt`;
    await writeFile(listPath, buildConcatList(paths.map((path) => resolve(path))), "utf8");
    await runFfmpeg(buildConcatArgs(listPath, temporaryPath, metadata), { signal });
  }, signal);
}

/**
 * 冷开场接缝的过场时长(秒)。0.24 秒:短到读作「一下」,又长到眼睛看得见
 * ——迷你片和正片口径不同,硬切只是「画面忽然换了」,这个交叠才是剪出来的
 * 过场。定位与 EDGE_FADE_SEC(30ms 消爆音)完全不同:那个是听不见的技术
 * 接缝,这个是给观众看的叙事接缝。
 */
export const COLD_SEAM_XFADE_SEC = 0.24;

/** 冷开场接缝的过场风格。由切片 id 确定性轮换:同一片段每次出片一致。 */
export type ColdSeamTransition = "whip" | "wipe" | "fade";

export const COLD_SEAM_TRANSITIONS: readonly ColdSeamTransition[] = ["whip", "wipe", "fade"];

/**
 * 风格 → xfade 转场名。whip(甩镜)用快速横向推近似:0.24 秒的 slideleft
 * 在成片里就是「镜头横向一甩」的观感;真甩镜要运动模糊,那需要第二遍
 * 重编码,不值得(接缝本身已经重编码一次了)。
 */
export function coldSeamXfadeName(transition: ColdSeamTransition): string {
  if (transition === "whip") return "slideleft";
  if (transition === "wipe") return "wipeleft";
  return "fade";
}

/** 按 seed(切片 id)确定性挑一种过场——同一片段重导不会换风格。 */
export function pickColdSeamTransition(
  seed: string | number,
  variants: readonly ColdSeamTransition[] = COLD_SEAM_TRANSITIONS
): ColdSeamTransition {
  const key = String(seed);
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return variants[hash % variants.length];
}

/**
 * 冷开场接缝的过场参数:两段各解一码,xfade 交叠画面、acrossfade 交叠音频
 * (两者缩短的时间轴长度相同,所以音画不脱节)。
 * 输出总长 = headSec + 正片时长 − duration,caller 必须把 coldOpenSec 记成
 * `headSec − duration`,下游(词平移、封面时刻、质检预期时长、音效接缝)才对得上。
 * 纯函数,可单测。
 */
export function buildColdSeamArgs(
  headPath: string,
  bodyPath: string,
  outputPath: string,
  options: {
    /** 前段(迷你片)时长,秒。 */
    headSec: number;
    transitionSec?: number;
    transition?: ColdSeamTransition;
    crf?: number;
    preset?: string;
    encoder?: VideoEncoder;
    metadata?: Record<string, string>;
  }
): string[] {
  // 交叠不能吃掉前段:留 50ms 余量,没余量就取这段能承受的最大值
  const dur = Math.max(0.05, Math.min(options.transitionSec ?? COLD_SEAM_XFADE_SEC, Math.max(0.05, options.headSec - 0.05)));
  const offset = Math.max(0, options.headSec - dur).toFixed(3);
  const name = coldSeamXfadeName(options.transition ?? "fade");
  const crf = Number.isFinite(options.crf) ? String(options.crf) : "18";
  const preset = options.preset ?? "veryfast";
  return [
    "-hide_banner", "-y",
    "-i", headPath,
    "-i", bodyPath,
    "-filter_complex",
    `[0:v][1:v]xfade=transition=${name}:duration=${dur.toFixed(3)}:offset=${offset}[v];` +
      `[0:a][1:a]acrossfade=d=${dur.toFixed(3)}:c1=qsin:c2=qsin[a]`,
    "-map", "[v]",
    "-map", "[a]",
    ...videoEncoderArgs(options.encoder ?? "libx264", Number(crf), preset),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    ...metadataArgs(options.metadata),
    outputPath,
  ];
}

/**
 * 冷开场接缝重编码成过场。concatClips 是零损失的硬切,这条是要看得见的
 * 交叠——代价是接缝那一遍整体重编码。硬件编码器失败时回退 libx264。
 */
export async function crossfadeClips(
  headPath: string,
  bodyPath: string,
  outputPath: string,
  options: Parameters<typeof buildColdSeamArgs>[3],
  signal?: AbortSignal
): Promise<void> {
  await withAtomicOutput(outputPath, async (temporaryPath) => {
    try {
      await runFfmpeg(buildColdSeamArgs(headPath, bodyPath, temporaryPath, options), { signal });
    } catch (e) {
      if (options.encoder && options.encoder !== "libx264" && !signal?.aborted) {
        await runFfmpeg(
          buildColdSeamArgs(headPath, bodyPath, temporaryPath, { ...options, encoder: "libx264" }),
          { signal }
        );
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`ffmpeg cold-open crossfade failed: ${msg.split("\n").slice(-6).join("\n")}`);
    }
  }, signal);
}
