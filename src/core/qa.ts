/**
 * 出片自我质检(render QA):成片渲染完成后用一遍 ffmpeg 解码扫描 +
 * 一次切点核对,把「AI 切得好不好」变成机器可核对的报告——黑屏、长静音、
 * 响度/时长偏差、切点压在词中间(半词风险),全部写进 clips.json 的 qa
 * 字段并回传给 MCP/CLI。用户只需要看告警条,不用逐条回放验证。
 *
 * 解析器与判定全部是纯函数(stderr 文本 → 结构化区间 → 报告),可单测;
 * 只有 runClipQa 真正跑 ffmpeg/ffprobe。检测自身失败由调用方兜底置空,
 * 绝不拖垮导出(与封面/SRT 等附属产物同一语义)。
 */
import { spawn } from "child_process";
import { resolveFfmpegPath } from "./binaries";
import { probeMedia } from "./probe";
import { EDGE_FADE_SEC } from "./cut";
import { formatLintIssue, type LintHit } from "./content-lint";
import { peakAt, EDGE_QUIET_PEAK, type PeakTrack } from "./audio-peaks";
import {
  createFrameDiffMeter,
  computeEditMetrics,
  METRONOME_CV,
  type EditMetrics,
} from "./edit-metrics";
import type { TranscriptWord } from "../shared/api-types";
import type { AppLang } from "../shared/ui-lang";

/** 一段被检出的可疑区间(成片输出时间轴,秒)。 */
export interface QaSpan {
  startSec: number;
  endSec: number;
}

/** 单条成片的质检报告(进 clips.json 的 qa 字段)。 */
export interface ClipQaReport {
  /** pass = 全部检查通过;warn = 有告警条目(见 issues)。 */
  status: "pass" | "warn";
  /** 人类可读的告警清单(空数组即通过)。 */
  issues: string[];
  /** 成片实测时长与管线预期时长(秒)。 */
  durationSec: number;
  expectedDurationSec: number;
  /** 黑屏区间(≥0.5s 且画面近全黑)。 */
  blackSpans: QaSpan[];
  /** 长静音区间(≥2s;开了跳剪还剩长静音尤其可疑)。 */
  silenceSpans: QaSpan[];
  /** 像素近乎不变的冻结区间(≥3s);旧回执可能缺省。 */
  frozenSpans?: QaSpan[];
  /** 响度实测(EBU R128);音频扫描失败为 null。 */
  loudness: { integratedLufs: number; truePeakDb: number } | null;
  /** 落在词中间的切点数(0 = 每个切点都在词边界外,无半词风险)。 */
  midWordCuts: number | null;
  /** 平台违禁词命中(标题/钩子/文案/字幕);没跑 lint 为 null。 */
  contentHits: LintHit[] | null;
  /** 最长「无视觉变化」间隔(秒);没做节奏评估(有字幕/运镜兜底)为 null。 */
  pacingGapSec: number | null;
  /** 钩子/标题承诺了、片中转写却没出现的数字类实体;没评估为 null。 */
  hookPayoffMissing: string[] | null;
  /** 人脸取景的采样覆盖率;没跑人脸取景为 null。 */
  subjectCoverage?: SubjectCoverage | null;
  /** 剪辑度量(切点画面变化/镜头节奏/最长静止窗);没量到为 null。 */
  edit?: EditMetrics | null;
  /** 自动修复记录(qa 修复循环执行过才有);见 repair.ts。 */
  repair?: QaRepairRecord;
}

/** qa 修复循环的执行记录(进 clips.json,「AI 又改了什么」要可审计)。 */
export interface QaRepairRecord {
  /** 修复动作的人类可读描述(裁头/裁尾/响度重归一)。 */
  actions: string[];
  /** 修复前的告警清单(与修复后的 issues 对照)。 */
  beforeIssues: string[];
  /** true = 修复后的成片被采纳;false = 修复没让报告变好,保留原片。 */
  applied: boolean;
}

/** 黑屏判定:0.5s 起报(短于此多为正常转场/闪黑)。 */
const BLACK_MIN_SEC = 0.5;
/** 静音判定:-50dB 以下持续 2s 起报。 */
const SILENCE_MIN_SEC = 2;
/** 冻结判定:3s 起报,避开默认 2.2s 标题/钩子停留。 */
const FREEZE_MIN_SEC = 3;
/** 低于此逐帧差异视为同一画面。 */
const FREEZE_NOISE = 0.0005;
/** 响度容差:偏离 -14 LUFS 目标超过 ±2 LU 才告警(loudnorm 单遍本有浮动)。 */
const LOUDNESS_TOLERANCE_LU = 2;
/** 真峰值上限:超过 -1 dBTP 有平台转码削波风险。 */
const TRUE_PEAK_CEILING_DB = -1;
/** 时长偏差容忍(秒):超过多为拼接/剪切错位。 */
const DURATION_TOLERANCE_SEC = 0.75;
/** 切点离词边界的容差:淡化时长再放宽一点,压线不算切进词里。 */
const BOUNDARY_TOLERANCE_SEC = EDGE_FADE_SEC + 0.02;
/** 峰值轨判「发声跨过切点」时两侧各探多远(小于一块,不会跨到邻块)。 */
const CUT_PROBE_SEC = 0.02;
/**
 * 画面节奏告警线(秒):2026 调研口径「有意义的视觉变化间隔 ≤3s,硬顶 5s」
 * (RESEARCH-2026-08-CLIP-QUALITY.md 第三节)。这里取硬顶——只在明显偏慢时
 * 提醒,不对风格化的慢节奏指手画脚。
 */
export const PACING_MAX_GAP_SEC = 5;

/**
 * 钩子兑付校验:钩子/悬念句/标题里承诺的**数字类实体**(价格/百分比/数量)
 * 必须真实出现在切片转写里——制造的信息缺口不兑付,完播率崩、算法降权、
 * 长期掉粉(2026 调研「标题党但不欺骗」的边界)。只核对 ≥2 位的数字串:
 * 单个数字常被转写成汉字(三个方法/3个方法),核对必然误报,宁漏勿误。
 * 返回未兑付的承诺清单(空 = 通过或无可核对项)。纯函数。
 */
export function missingHookPayoffs(hookText: string | undefined, transcriptText: string | undefined): string[] {
  const hook = (hookText ?? "").trim();
  if (!hook || !transcriptText) return [];
  const claims = hook.match(/\d[\d.,]*[%％折万亿]?/g) ?? [];
  // 转写归一:去掉分隔符后按「数字核」查含(「1,999」→「1999」;30% 查「30」尾随%或％)
  const text = transcriptText.replace(/[,，\s]/g, "");
  const missing: string[] = [];
  for (const claim of [...new Set(claims)]) {
    const core = claim.replace(/[^\d.]/g, "").replace(/\.$/, "");
    if (core.replace(/\./g, "").length < 2) continue; // 单位数不核对
    if (!text.includes(core)) missing.push(claim);
  }
  return missing;
}

/** 事件时刻归一到「片头 0、片尾 duration、中间的取正」并去重排序。 */
function visualEventPts(eventsSec: number[], durationSec: number): number[] {
  return [...new Set([0, ...eventsSec.filter((t) => t > 0 && t < durationSec), durationSec])].sort(
    (a, b) => a - b
  );
}

/**
 * 视觉事件序列(拼接缝/跳剪缝/高潮前置接缝等,输出时间轴)→ 最长无变化
 * 间隔。片头片尾各算一个天然事件。纯函数;调用方在有字幕/自动运镜兜底时
 * 不必调用(连续的视觉变化已覆盖节奏)。
 */
export function maxVisualGapSec(eventsSec: number[], durationSec: number): number {
  const pts = visualEventPts(eventsSec, durationSec);
  let maxGap = 0;
  for (let i = 1; i < pts.length; i++) maxGap = Math.max(maxGap, pts[i] - pts[i - 1]);
  return Number(maxGap.toFixed(2));
}

/**
 * 节奏补点:让每一段「无视觉变化间隔」都不超过上限,返回要**插进去**的时刻。
 * 间隔 m 切成 n+1 段,取 n = floor(m/上限)(至少 1),于是每段 m/(n+1) ≤ 上限/2
 * ——留一倍余量,浮点取整再怎么抖也不会压线。只插在两端天然事件之间,不挪动
 * 任何已有事件(切片不能凭空多切一刀,镜头可以动一下)。纯函数。
 */
export function pacingPunchPoints(
  eventsSec: number[],
  durationSec: number,
  maxGapSec: number = PACING_MAX_GAP_SEC
): number[] {
  if (!(durationSec > 0) || !(maxGapSec > 0)) return [];
  const pts = visualEventPts(eventsSec, durationSec);
  const out: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const from = pts[i - 1];
    const gap = pts[i] - from;
    if (!(gap > maxGapSec)) continue;
    const n = Math.max(1, Math.floor(gap / maxGapSec));
    for (let k = 1; k <= n; k++) out.push(Number((from + (gap * k) / (n + 1)).toFixed(2)));
  }
  return out;
}

/** blackdetect 输出解析:`black_start:1.2 black_end:2.0 ...`(同行成对)。 */
export function parseBlackSpans(stderr: string): QaSpan[] {
  const spans: QaSpan[] = [];
  const re = /black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g;
  for (let m = re.exec(stderr); m; m = re.exec(stderr)) {
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      spans.push({ startSec: start, endSec: end });
    }
  }
  return spans;
}

/**
 * silencedetect 输出解析:start/end 分行出现,按序配对。收尾只有 start
 * 没 end(静音贯穿到片尾)时,用 streamEndSec 闭合;不传则丢弃不完整对。
 */
export function parseSilenceSpans(stderr: string, streamEndSec?: number): QaSpan[] {
  const spans: QaSpan[] = [];
  let open: number | null = null;
  const re = /silence_(start|end):\s*(-?[\d.]+)/g;
  for (let m = re.exec(stderr); m; m = re.exec(stderr)) {
    const v = Number(m[2]);
    if (!Number.isFinite(v)) continue;
    if (m[1] === "start") {
      open = v;
    } else if (open !== null) {
      if (v > open) spans.push({ startSec: Math.max(0, open), endSec: v });
      open = null;
    }
  }
  if (open !== null && streamEndSec !== undefined && streamEndSec > open) {
    spans.push({ startSec: Math.max(0, open), endSec: streamEndSec });
  }
  return spans;
}

/** freezedetect 输出解析;冻结延续到 EOF 时用 streamEndSec 闭合。 */
export function parseFreezeSpans(stderr: string, streamEndSec?: number): QaSpan[] {
  const spans: QaSpan[] = [];
  let open: number | null = null;
  const re = /lavfi\.freezedetect\.freeze_(start|end):\s*(-?[\d.]+)/g;
  for (let m = re.exec(stderr); m; m = re.exec(stderr)) {
    const value = Number(m[2]);
    if (!Number.isFinite(value)) continue;
    if (m[1] === "start") {
      open = value;
    } else if (open !== null) {
      if (value > open) spans.push({ startSec: Math.max(0, open), endSec: value });
      open = null;
    }
  }
  if (open !== null && streamEndSec !== undefined && streamEndSec > open) {
    spans.push({ startSec: Math.max(0, open), endSec: streamEndSec });
  }
  return spans;
}

export interface SubjectCoverage {
  sampledFrames: number;
  clippedFrames: number;
  severeFrames: number;
  clippedRatio: number;
  worstVisibleFraction: number;
}

/** Aggregate crop-planner face visibility after jump-cut filtering. */
export function summarizeSubjectCoverage(
  samples: Array<{ minVisibleFraction: number }>
): SubjectCoverage | null {
  const valid = samples
    .map((sample) => Math.min(1, Math.max(0, sample.minVisibleFraction)))
    .filter(Number.isFinite);
  if (valid.length === 0) return null;
  const clippedFrames = valid.filter((fraction) => fraction < 0.9).length;
  const severeFrames = valid.filter((fraction) => fraction < 0.6).length;
  return {
    sampledFrames: valid.length,
    clippedFrames,
    severeFrames,
    clippedRatio: Number((clippedFrames / valid.length).toFixed(3)),
    worstVisibleFraction: Number(Math.min(...valid).toFixed(3)),
  };
}

/**
 * ebur128 汇总解析:取末尾 Summary 的整片响度与真峰值。
 * 形如 `I: -14.1 LUFS` / `Peak: -1.3 dBFS`(peak=true 时为真峰值)。
 */
export function parseLoudnessSummary(stderr: string): ClipQaReport["loudness"] {
  const iMatches = [...stderr.matchAll(/I:\s*(-?[\d.]+)\s*LUFS/g)];
  const pMatches = [...stderr.matchAll(/Peak:\s*(-?[\d.]+)\s*dBFS/g)];
  if (iMatches.length === 0 || pMatches.length === 0) return null;
  const integratedLufs = Number(iMatches[iMatches.length - 1][1]);
  const truePeakDb = Number(pMatches[pMatches.length - 1][1]);
  if (!Number.isFinite(integratedLufs) || !Number.isFinite(truePeakDb)) return null;
  return { integratedLufs, truePeakDb };
}

/**
 * 切点核对(纯函数):每个保留段的起止点(源时间轴)是否切进了发声中间——
 * 跳剪与镜头吸附都带词边界守卫,这里是「信任但要验证」的复核。
 * words 与 segments 都用源片绝对时间。
 *
 * 有峰值轨时**按真音频判**:词时间戳可能是估的(SRT 导入按字符均分),「恰好
 * 落在词边界」完全可能落在真语音里,旧判据因此报 0 而观众听到半截词。真音频
 * 在切点两侧都还在响 = 那一下切进了发声中间;没有峰值证据才退回词边界判据。
 */
export function countMidWordCuts(
  words: TranscriptWord[],
  segments: QaSpan[],
  toleranceSec = BOUNDARY_TOLERANCE_SEC,
  peaks?: PeakTrack
): number {
  if (words.length === 0 || segments.length === 0) return 0;
  const cuts = segments.flatMap((s) => [s.startSec, s.endSec]);
  let hits = 0;
  for (const t of cuts) {
    if (peaks) {
      // 两侧各探 20ms(小于一块):发声跨过切点才算切词;落在静音/谷底不算
      const sounding =
        peakAt(peaks, t - CUT_PROBE_SEC) > EDGE_QUIET_PEAK && peakAt(peaks, t + CUT_PROBE_SEC) > EDGE_QUIET_PEAK;
      if (sounding) hits += 1;
      continue;
    }
    const inside = words.some((w) => w.startSec + toleranceSec < t && t < w.endSec - toleranceSec);
    if (inside) hits += 1;
  }
  return hits;
}

/** 判定输入(全部由调用方备好,便于单测)。 */
export interface QaAssessment {
  durationSec: number;
  expectedDurationSec: number;
  blackSpans: QaSpan[];
  silenceSpans: QaSpan[];
  frozenSpans?: QaSpan[];
  loudness: ClipQaReport["loudness"];
  /** 出片时开了响度标准化才核对 -14 LUFS 目标。 */
  loudnessNormalized: boolean;
  midWordCuts: number | null;
  /** 平台违禁词命中(调用方用 content-lint 扫好传入);缺省 = 没扫。 */
  contentHits?: LintHit[] | null;
  /** 最长无视觉变化间隔(maxVisualGapSec 算好传入);缺省 = 不评估节奏。 */
  pacingGapSec?: number | null;
  /** 未兑付的钩子承诺(missingHookPayoffs 算好传入);缺省 = 不评估。 */
  hookPayoffMissing?: string[] | null;
  /** 人脸取景样本的主体覆盖汇总;缺省 = 未使用人脸取景。 */
  subjectCoverage?: SubjectCoverage | null;
  /** 剪辑度量(edit-metrics.ts 算好传入);缺省 = 没量。
   *  注意是「另外量」而不是替代 pacingGapSec:那条按剪辑计划算最大静止窗,
   *  这条按成片画面实测,两者口径不同,不互相顶替。 */
  editMetrics?: EditMetrics | null;
  /** 告警句式语言;缺省 zh(CLI/MCP 不传,回执与既有版本逐字节相同)。 */
  lang?: AppLang;
}

const fmtSec = (v: number): string => v.toFixed(1);
/** 土耳其语小数用逗号(1,5 sn),不共用 fmtSec 的点号口径。 */
const trSec = (v: number): string => v.toFixed(1).replace(".", ",");
/** 土耳其语百分比同样用逗号小数(6,1)。 */
const trPct = (v: number): string => v.toFixed(1).replace(".", ",");
const trNum = (v: number): string => v.toFixed(2).replace(".", ",");

/**
 * 告警句式三语表。质检报告是给创作者读的(与 AIGC 标记、成片包目录名同一类),
 * 跟随界面语言而非转写语言;zh 分支逐字保留旧文案,三个语言都不共用模板,
 * 免得改土耳其语时动了中文回执的字节。
 */
interface QaText {
  durationMismatch(actualSec: number, expectedSec: number, deltaSec: number): string;
  black(count: number, longestSec: number): string;
  silence(count: number, longestSec: number): string;
  frozen(count: number, longestSec: number): string;
  loudness(integratedLufs: number, devLu: number): string;
  truePeak(peakDb: number, ceilingDb: number): string;
  midWordCuts(count: number): string;
  pacing(gapSec: number): string;
  hookUnpaid(list: string): string;
  faceClipped(ratio: number, worst: number): string;
  invisibleCuts(count: number, minChangePct: number): string;
  metronome(cv: number): string;
}
const QA_TEXT: Record<AppLang, QaText> = {
  zh: {
    durationMismatch: (a, e, d) => `成片时长 ${fmtSec(a)}s 与预期 ${fmtSec(e)}s 偏差 ${fmtSec(d)}s`,
    black: (n, l) => `检测到黑屏 ${n} 段(最长 ${fmtSec(l)}s)`,
    silence: (n, l) => `检测到长静音 ${n} 段(最长 ${fmtSec(l)}s)`,
    frozen: (n, l) => `检测到画面冻结 ${n} 段(最长 ${fmtSec(l)}s,建议回放核对)`,
    loudness: (v, d) => `响度 ${fmtSec(v)} LUFS 偏离 -14 目标 ${fmtSec(d)} LU`,
    truePeak: (p, c) => `真峰值 ${fmtSec(p)} dBTP 超过 ${c} 上限(平台转码有削波风险)`,
    midWordCuts: (n) => `${n} 处切点落在词中间(可能出现半词,建议回放核对)`,
    pacing: (g) => `画面 ${fmtSec(g)}s 无视觉变化(节奏偏慢,建议开启自动运镜或字幕)`,
    hookUnpaid: (list) =>
      `钩子/标题承诺的「${list}」未在片中出现(不兑付=标题党,完播率与账号权重双降,建议改钩子或换切点)`,
    faceClipped: (ratio, worst) =>
      `竖屏取景有 ${(ratio * 100).toFixed(0)}% 采样帧未完整保留人脸(最差 ${(worst * 100).toFixed(0)}%,建议检查构图)`,
    invisibleCuts: (n, pct) =>
      `有 ${n} 处切点画面几乎没变(最不明显的一刀只动了 ${pct.toFixed(1)}% 的画面,剪了等于没剪)`,
    metronome: (cv) =>
      `镜头长度几乎一样(变异系数 ${cv.toFixed(2)}),节奏像节拍器(建议长短镜头交替)`,
  },
  en: {
    durationMismatch: (a, e, d) => `Clip length ${fmtSec(a)}s differs from the expected ${fmtSec(e)}s by ${fmtSec(d)}s`,
    black: (n, l) => `Black frames in ${n} span(s) (longest ${fmtSec(l)}s)`,
    silence: (n, l) => `Long silence in ${n} span(s) (longest ${fmtSec(l)}s)`,
    frozen: (n, l) => `Frozen picture in ${n} span(s) (longest ${fmtSec(l)}s, check on playback)`,
    loudness: (v, d) => `Loudness ${fmtSec(v)} LUFS is ${fmtSec(d)} LU off the -14 target`,
    truePeak: (p, c) => `True peak ${fmtSec(p)} dBTP is above the ${c} ceiling (platform transcoding may clip)`,
    midWordCuts: (n) => `${n} cut(s) land mid-word (half-words may show, check on playback)`,
    pacing: (g) => `No visual change for ${fmtSec(g)}s (pacing looks slow — turn on auto pan/zoom or captions)`,
    hookUnpaid: (list) =>
      `The hook/title promises "${list}" but the clip never delivers it (an unpaid promise reads as clickbait; completion and account weight both drop — change the hook or the cut)`,
    faceClipped: (ratio, worst) =>
      `${(ratio * 100).toFixed(0)}% of sampled frames do not keep the whole face in frame (worst ${(worst * 100).toFixed(0)}%, check the framing)`,
    invisibleCuts: (n, pct) =>
      `The picture barely changes at ${n} cut(s) (the flattest moves only ${pct.toFixed(1)}% of the frame — a cut nobody sees)`,
    metronome: (cv) =>
      `Shots are near-identical in length (coefficient of variation ${cv.toFixed(2)}) — the rhythm reads metronomic (alternate long and short)`,
  },
  tr: {
    durationMismatch: (a, e, d) => `Klip süresi ${trSec(a)} sn, beklenen ${trSec(e)} sn (${trSec(d)} sn sapma)`,
    black: (n, l) => `Kara kare ${n} yerde bulundu (en uzun ${trSec(l)} sn)`,
    silence: (n, l) => `Uzun sessizlik ${n} yerde var (en uzun ${trSec(l)} sn)`,
    frozen: (n, l) => `Donmuş görüntü ${n} yerde (en uzun ${trSec(l)} sn, oynatıp kontrol edin)`,
    loudness: (v, d) => `Ses yüksekliği ${trSec(v)} LUFS, -14 hedefinden ${trSec(d)} LU sapıyor`,
    truePeak: (p, c) => `Gerçek tepe ${trSec(p)} dBTP, ${c} sınırının üstünde (platform dönüştürürken kırpılma riski)`,
    midWordCuts: (n) => `${n} kesim noktası kelimenin ortasına düşüyor (yarım kelime görünebilir, oynatıp kontrol edin)`,
    pacing: (g) => `${trSec(g)} sn boyunca görüntüde değişim yok (tempo yavaş — otomatik kaydırma/yakınlaştırma veya altyazı açın)`,
    hookUnpaid: (list) =>
      `Kanca/başlık "${list}" diye söz veriyor ama klip bunu karşılamıyor (söz tutulmazsa tıklama tuzağı; izlenme tamamlama ve hesap ağırlığı düşer — kancayı ya da kesimi değiştirin)`,
    faceClipped: (ratio, worst) =>
      `Dikey kadrajda örneklenen karelerin %${(ratio * 100).toFixed(0)}'inde yüz tam görünmüyor (en kötü %${(worst * 100).toFixed(0)}, çerçeveyi kontrol edin)`,
    invisibleCuts: (n, pct) =>
      `${n} kesimde görüntü neredeyse hiç değişmiyor (en silik kesim karenin yalnızca %${trPct(pct)}'ini oynatıyor — kimsenin görmediği bir kesim)`,
    metronome: (cv) =>
      `Plan uzunlukları birbirine çok yakın (değişim katsayısı ${trNum(cv)}) — ritim metronom gibi (uzun ve kısa planları karıştırın)`,
  },
};

/** 纯判定:各项实测 → 告警清单与状态。 */
export function assessClipQa(input: QaAssessment): ClipQaReport {
  const issues: string[] = [];
  const lang = input.lang ?? "zh";
  const t = QA_TEXT[lang];
  const delta = Math.abs(input.durationSec - input.expectedDurationSec);
  if (input.expectedDurationSec > 0 && delta > DURATION_TOLERANCE_SEC) {
    issues.push(t.durationMismatch(input.durationSec, input.expectedDurationSec, delta));
  }
  if (input.blackSpans.length > 0) {
    const longest = Math.max(...input.blackSpans.map((s) => s.endSec - s.startSec));
    issues.push(t.black(input.blackSpans.length, longest));
  }
  if (input.silenceSpans.length > 0) {
    const longest = Math.max(...input.silenceSpans.map((s) => s.endSec - s.startSec));
    issues.push(t.silence(input.silenceSpans.length, longest));
  }
  if ((input.frozenSpans?.length ?? 0) > 0) {
    const longest = Math.max(...input.frozenSpans!.map((s) => s.endSec - s.startSec));
    issues.push(t.frozen(input.frozenSpans!.length, longest));
  }
  if (input.loudnessNormalized && input.loudness) {
    const dev = Math.abs(input.loudness.integratedLufs - -14);
    if (dev > LOUDNESS_TOLERANCE_LU) {
      issues.push(t.loudness(input.loudness.integratedLufs, dev));
    }
    if (input.loudness.truePeakDb > TRUE_PEAK_CEILING_DB) {
      issues.push(t.truePeak(input.loudness.truePeakDb, TRUE_PEAK_CEILING_DB));
    }
  }
  if ((input.midWordCuts ?? 0) > 0) {
    issues.push(t.midWordCuts(input.midWordCuts!));
  }
  if ((input.pacingGapSec ?? 0) > PACING_MAX_GAP_SEC) {
    issues.push(t.pacing(input.pacingGapSec!));
  }
  if ((input.hookPayoffMissing?.length ?? 0) > 0) {
    issues.push(t.hookUnpaid(input.hookPayoffMissing!.join(lang === "zh" ? "、" : ", ")));
  }
  if (input.subjectCoverage && (input.subjectCoverage.clippedRatio >= 0.15 || input.subjectCoverage.severeFrames >= 2)) {
    issues.push(t.faceClipped(input.subjectCoverage.clippedRatio, input.subjectCoverage.worstVisibleFraction));
  }
  const lintIssue = formatLintIssue(input.contentHits ?? [], lang);
  if (lintIssue) issues.push(lintIssue);
  // 剪辑度量:画面没变的切点一刀一刀都是白剪;镜头一样长像节拍器。
  // 「最长静止窗」不在这里告警——按计划算的那条(pacingGapSec)已经管,
  // 实测这条只作连续量进报告(96×96 上字幕/运镜会被平均掉)。
  if (input.editMetrics && input.editMetrics.invisibleCuts > 0) {
    issues.push(t.invisibleCuts(input.editMetrics.invisibleCuts, (input.editMetrics.minCutChange ?? 0) * 100));
  }
  if (input.editMetrics && input.editMetrics.cuts >= 5 && input.editMetrics.cv !== null && input.editMetrics.cv < METRONOME_CV) {
    issues.push(t.metronome(input.editMetrics.cv));
  }
  return {
    status: issues.length > 0 ? "warn" : "pass",
    issues,
    durationSec: Number(input.durationSec.toFixed(3)),
    expectedDurationSec: Number(input.expectedDurationSec.toFixed(3)),
    blackSpans: input.blackSpans.map((s) => ({ startSec: Number(s.startSec.toFixed(2)), endSec: Number(s.endSec.toFixed(2)) })),
    silenceSpans: input.silenceSpans.map((s) => ({ startSec: Number(s.startSec.toFixed(2)), endSec: Number(s.endSec.toFixed(2)) })),
    frozenSpans: (input.frozenSpans ?? []).map((s) => ({ startSec: Number(s.startSec.toFixed(2)), endSec: Number(s.endSec.toFixed(2)) })),
    loudness: input.loudness
      ? { integratedLufs: Number(input.loudness.integratedLufs.toFixed(1)), truePeakDb: Number(input.loudness.truePeakDb.toFixed(1)) }
      : null,
    midWordCuts: input.midWordCuts,
    contentHits: input.contentHits ?? null,
    pacingGapSec: input.pacingGapSec ?? null,
    hookPayoffMissing: input.hookPayoffMissing ?? null,
    subjectCoverage: input.subjectCoverage ?? null,
    edit: input.editMetrics ?? null,
  };
}

/** stderr 收集上限:detect 行 + ebur128 汇总远小于此,防素材异常刷爆内存。 */
const STDERR_CAP = 4 * 1024 * 1024;
/** 灰度帧流尺寸(单帧 9KB)。96×96 足够量「画面变没变」,又不把整条流留在内存里。 */
const FRAME_TRACK_W = 96;
const FRAME_TRACK_H = 96;
const FRAME_BYTES = FRAME_TRACK_W * FRAME_TRACK_H;

/** 一遍解码的产出:检测文本 + 逐帧画面变化。 */
export interface ClipScan {
  /** 完整 stderr(blackdetect/silencedetect 行散布全程,ebur128 汇总在末尾)。 */
  stderr: string;
  /** 逐帧「变化像素占比」(相邻帧,96×96 灰度;见 edit-metrics.ts)。 */
  frameDiffs: number[];
}

/**
 * 解码扫描一遍成片,两个输出:检测流写 null(复用 stderr 管道,不落盘)、
 * 灰度帧流走 stdout 且逐帧差分当场算掉(见 edit-metrics.ts 的差分器)。
 * 加这一路是白捡的——本来就整片解一遍,灰度流顺着同一条解码走,不再多跑一遍 ffmpeg。
 */
export async function scanClip(path: string, signal?: AbortSignal): Promise<ClipScan> {
  const args = [
    "-hide_banner", "-nostats",
    "-i", path,
    "-vf", `blackdetect=d=${BLACK_MIN_SEC}:pix_th=0.10,freezedetect=n=${FREEZE_NOISE}:d=${FREEZE_MIN_SEC}`,
    "-af", `silencedetect=n=-50dB:d=${SILENCE_MIN_SEC},ebur128=peak=true`,
    "-f", "null", "pipe:2",
    "-map", "0:v:0",
    "-vf", `scale=${FRAME_TRACK_W}:${FRAME_TRACK_H},format=gray`,
    "-an",
    "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ];
  return await new Promise<ClipScan>((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"], signal });
    const meter = createFrameDiffMeter(FRAME_BYTES);
    const frameDiffs: number[] = [];
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      for (const v of meter.push(d)) frameDiffs.push(v);
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += d.toString();
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) resolve({ stderr, frameDiffs });
      else reject(new Error(`qa scan exited ${code}`));
    });
  });
}

/** 只要检测文本的老入口(帧流丢掉)。 */
export async function scanClipMedia(path: string, signal?: AbortSignal): Promise<string> {
  return (await scanClip(path, signal)).stderr;
}

export interface RunClipQaOptions {
  /** 管线预期成片时长(切片时长 + 高潮前置迷你片)。 */
  expectedDurationSec: number;
  /** 出片是否开了响度标准化(决定是否核对 -14 LUFS)。 */
  loudnessNormalized: boolean;
  /** 切片覆盖的词(源片绝对时间);缺省跳过切点核对。 */
  words?: TranscriptWord[];
  /** 实际保留的源片段(跳剪后多段);与 words 同为源片绝对时间。 */
  segments?: QaSpan[];
  /** 额外的真实切点(冷开迷你片两端等);只取其起止点参与切点核对。 */
  cutSpans?: QaSpan[];
  /** 切片的真音频峰值轨(绝对源时间):有它时切点核对按真发声判,不信词时间。 */
  peaks?: PeakTrack;
  /** 平台违禁词命中(content-lint 扫标题/钩子/文案/字幕的结果)。 */
  contentHits?: LintHit[] | null;
  /** 最长无视觉变化间隔(调用方按剪辑计划算好);缺省 = 不评估节奏。 */
  pacingGapSec?: number | null;
  /** 未兑付的钩子承诺(missingHookPayoffs 算好传入);缺省 = 不评估。 */
  hookPayoffMissing?: string[] | null;
  /** 已按最终保留片段过滤的人脸覆盖汇总。 */
  subjectCoverage?: SubjectCoverage | null;
  /** 成片输出时间轴上的真实切点(跳剪缝/拼接缝/冷开接缝;不是运镜补点):
   *  给了才量切点画面变化与镜头节奏。 */
  cutTimesSec?: number[];
  /** 告警句式语言(界面语言);缺省 zh,CLI/MCP 回执不变。 */
  lang?: AppLang;
  signal?: AbortSignal;
}

/** 对一条成片跑完整质检:解码扫描 + ffprobe 时长 + 切点核对 → 报告。 */
export async function runClipQa(path: string, opts: RunClipQaOptions): Promise<ClipQaReport> {
  const [scan, info] = await Promise.all([scanClip(path, opts.signal), probeMedia(path)]);
  const { stderr } = scan;
  return assessClipQa({
    durationSec: info.durationSec,
    expectedDurationSec: opts.expectedDurationSec,
    blackSpans: parseBlackSpans(stderr),
    silenceSpans: parseSilenceSpans(stderr, info.durationSec),
    frozenSpans: parseFreezeSpans(stderr, info.durationSec),
    loudness: parseLoudnessSummary(stderr),
    loudnessNormalized: opts.loudnessNormalized,
    midWordCuts: opts.words && (opts.segments || opts.cutSpans)
      ? countMidWordCuts(
          opts.words,
          [...(opts.segments ?? []), ...(opts.cutSpans ?? [])],
          undefined,
          opts.peaks
        )
      : null,
    contentHits: opts.contentHits,
    pacingGapSec: opts.pacingGapSec,
    hookPayoffMissing: opts.hookPayoffMissing,
    subjectCoverage: opts.subjectCoverage,
    editMetrics:
      info.fps > 0 && scan.frameDiffs.length > 0
        ? computeEditMetrics({
            frameDiffs: scan.frameDiffs,
            fps: info.fps,
            cutTimesSec: opts.cutTimesSec ?? [],
            durationSec: info.durationSec,
          })
        : null,
    lang: opts.lang,
  });
}
