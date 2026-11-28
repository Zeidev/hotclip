/**
 * Jump-cut planning: remove intra-clip silences so exported clips have the
 * tight rhythm of a human edit instead of the slack of a machine cut.
 *
 * Input: the clip's words (absolute source time). Silence = the gap between
 * consecutive words above a threshold. Output: the kept source segments plus
 * the same words remapped onto the compressed output timeline (for captions).
 * Pure functions — ffmpeg execution lives in cut.ts.
 */
import type { TranscriptWord } from "../shared/api-types";
import { planBeatSnap } from "./beat";
import { peakInRange, snapEdgeToQuiet, type PeakTrack } from "./audio-peaks";
import { hasSpeechInRange, speechAnchorBounds, type SpeechActivitySpan } from "./speech-activity";

export interface KeptSegment {
  /** Absolute source time. */
  startSec: number;
  endSec: number;
}

export interface JumpCutOptions {
  /**
   * Audio peak track for the clip. When present, a word gap is only cut if
   * the region that would be removed is actually quiet — laughter, applause
   * and BGM stings carry no words but must survive.
   */
  peaks?: PeakTrack;
  /** Peak (0..1) above which a gap counts as "not silent" (~-28dBFS). */
  silenceThreshold?: number;
  /**
   * Spans that must be cut regardless of gaps or loudness — filler words and
   * stutters are audible speech, so neither the gap rule nor the silence gate
   * would ever remove them on their own.
   */
  forceCutSpans?: KeptSegment[];
  /** Word-gap cut threshold; pass Infinity to disable gap cuts entirely. */
  gapThresholdSec?: number;
  /**
   * 禁删区间(绝对源时间):情绪事件(笑声/怒吼/掌声峰)前后的停顿是节目
   * 效果——抖包袱前的憋、爆发后的余韵——删掉它们等于删掉喜剧节奏。
   * 待删空隙与任一禁删区间相交时,这个 gap 不剪(仅约束 gap 剪,不影响
   * forceCutSpans——语气词/重录/拼接是明确要删的内容)。
   */
  protectedSpans?: KeptSegment[];
  /**
   * 保留呼吸口(v0.14):每个 gap 剪口在语音尾部多留这么多秒的自然停顿——
   * 长停顿照剪,但剪完不是无缝贴死,句间还有一口气。跳剪「过瘦」是 AI 味
   * 的来源之一(真人剪辑会给呼吸留空)。0/缺省 = 历史紧凑节奏不变。
   */
  breathPadSec?: number;
  /**
   * Trusted VAD spans. A nominally word-free/quiet gap is retained when this
   * independent local signal still detects speech (for example an ASR miss).
   */
  speechSpans?: SpeechActivitySpan[];
  /**
   * Music-bed beat grid in OUTPUT seconds (the bed is looped from output 0 —
   * see beat.ts). Kept-piece starts are pulled BACK onto the nearest beat so a
   * jump cut lands on the music; a backward shift only eats silence the cut was
   * already removing. Absent = no snapping.
   */
  beats?: number[];
  /** Largest backward snap (seconds). Default 0.12 — inaudible on speech. */
  beatMaxShiftSec?: number;
  /**
   * Cross-fade between kept pieces (seconds). 0/unset = hard cut (legacy
   * graph). The output is shorter by `transitionSec * (pieces - 1)`, so the word
   * remap and duration below already account for it.
   */
  transitionSec?: number;
  /**
   * 节奏目标(秒):一个镜头超过这么久就在真实的词间静音处补一刀。gap 剪只删
   * 停顿,**不会**把一个连着说了 20 秒的长镜头拆开——而长镜头正是留存的杀手,
   * 也是画面节奏唯一没法靠静音剪出来的部分。补的刀落在静音里(峰值验证),
   * 绝不落在词中;缺口为零(音频本就连续),所以不需要交叉淡化,听感完全不变,
   * 变的只有画面:多出来的片段让跳剪的推进镜头按奇偶切进去。
   * Infinity/未设 = 不限,成片与历史一致。
   */
  maxShotSec?: number;
}

/** Subtract cut spans from kept segments (interval difference). Pure. */
export function subtractSpans(segments: KeptSegment[], spans: KeptSegment[], minKeepSec = 0.12): KeptSegment[] {
  if (spans.length === 0) return segments;
  const out: KeptSegment[] = [];
  for (const seg of segments) {
    let pieces: KeptSegment[] = [{ ...seg }];
    for (const span of spans) {
      const next: KeptSegment[] = [];
      for (const p of pieces) {
        if (span.endSec <= p.startSec || span.startSec >= p.endSec) {
          next.push(p);
          continue;
        }
        if (span.startSec > p.startSec) next.push({ startSec: p.startSec, endSec: span.startSec });
        if (span.endSec < p.endSec) next.push({ startSec: span.endSec, endSec: p.endSec });
      }
      pieces = next;
    }
    out.push(...pieces.filter((p) => p.endSec - p.startSec >= minKeepSec));
  }
  return out;
}

export interface JumpCutPlan {
  segments: KeptSegment[];
  /** Words shifted onto the output timeline (t=0 at clip start). */
  words: TranscriptWord[];
  /**
   * Output-time positions where a splice happened (segment 2+ starts).
   * Caption line breaking must break here — the silence that used to separate
   * these sentences no longer exists on the compressed timeline.
   */
  breaks: number[];
  /** Total seconds removed. */
  removedSec: number;
  /** Output duration (sum of kept segments). */
  durationSec: number;
  /** Gaps that would have been removed but trusted speech evidence retained. */
  speechProtectedGaps?: number;
  /** 为压住长镜头而补的刀数(节奏目标 maxShotSec)。缺省/0 = 没补。 */
  longShotsSplit?: number;
}

/** Word gaps longer than this get cut. */
const GAP_THRESHOLD_SEC = 0.6;
/** 「保留呼吸口」的默认留白量(加在语音尾部 PAD_AFTER 之上)。 */
export const BREATH_PAD_SEC = 0.25;
/** Breathing room kept around speech on both sides of a cut. */
const PAD_BEFORE_SEC = 0.12;
const PAD_AFTER_SEC = 0.18;
/** Lead-in / tail padding at the clip boundaries. */
const LEAD_IN_SEC = 0.15;
const TAIL_SEC = 0.3;
/** Default peak above which a gap is loud enough to keep (~-28dBFS). */
const SILENCE_PEAK_THRESHOLD = 0.04;
/** Splices removing less than this are churn, not rhythm — fill them back. */
const MIN_CUT_SEC = 0.2;
/** 节奏补刀后每段的最短长度:再短就是碎镜头,不如让这一镜长着。 */
const MIN_TEMPO_PIECE_SEC = 0.8;
/** 能下节奏刀的最小词间空隙:比这更窄就当成连续语流,不切。 */
const MIN_TEMPO_GAP_SEC = 0.08;
/** 每段源片最多补的刀数(防病态输入把一段话切碎)。 */
const MAX_TEMPO_SPLITS_PER_SEGMENT = 64;
/** 数本地信息密度用的半窗(秒):这个窗口里词越少,越适合下刀。 */
const TEMPO_DENSITY_WINDOW_SEC = 2.5;
/**
 * 找缝的搜索范围 = 目标的最后这一段。只在「接近目标」的范围里挑缝,密度项
 * 才不会把刀拖到半个镜头之外(理论上最远可以拖到 from,那就不是节奏目标了)。
 */
const TEMPO_SEARCH_FRAC = 0.3;

/**
 * 密度曲线:成片两端比中段切得密。
 *  - 开场 3 秒最多 3 秒一镜:前 3 秒还没换过一次画面,留存就掉在那了;
 *  - 收口 5 秒最多 4 秒一镜:结尾利落,循环回放时不留拖尾。
 * 中段仍由品类档(genreMaxShotSec)说话——曲线只收紧、不放松,所以
 * 「把一件事说完」的品类(节奏档 = ∞)从头到尾一个字节都不动。
 */
export interface ShotDensity {
  /** 开场这几秒… */
  openSec: number;
  /** …每镜最长这么多秒。 */
  openShotSec: number;
  /** 收口这几秒… */
  closeSec: number;
  /** …每镜最长这么多秒。 */
  closeShotSec: number;
}

/** 见 ShotDensity 注释;纯函数由此取参,测试也直接断言这份表。 */
export const SHOT_DENSITY: ShotDensity = {
  openSec: 3,
  openShotSec: 3,
  closeSec: 5,
  closeShotSec: 4,
};

/**
 * 成片首尾也是真实切点:整条片的开头/结尾截在半个音节上,观众第一耳朵就听
 * 出来。词时间戳可能是估的(SRT 导入按字符均分),峰值轨是真音频——首端只往
 * **前**挪、尾端只往**后**挪,挪进验证过的静音,所以只会多保留声音,不会多剪
 * 一个词;挪不动(附近没有静音)就原样不动。
 */
export function snapOuterEdgesToQuiet(segments: KeptSegment[], track: PeakTrack): KeptSegment[] {
  if (segments.length === 0) return segments;
  const out = segments.map((s) => ({ ...s }));
  const head = snapEdgeToQuiet(track, out[0].startSec, { bias: "head", oneWay: "earlier" });
  if (head.movedSec !== 0) out[0].startSec = head.sec;
  const last = out.length - 1;
  const tail = snapEdgeToQuiet(track, out[last].endSec, { bias: "tail", oneWay: "later" });
  if (tail.movedSec !== 0) out[last].endSec = tail.sec;
  return out;
}

/**
 * 超长镜头切到哪里:目标时刻往前找一处**真实静音**(词间空隙,峰值验证),
 * 取最宽的那条缝的中线。缝宽相同时选**周围词最稀**的那条(词/秒≈信息密度,
 * 刀要落在信息最少的窗口里),再相同才看谁离目标近。找不到缝时,只有在真音频
 * (peaks)证明目标附近本来就安静时才切在那儿——没有实测音频就宁可不切,
 * 绝不在词里下刀。返回 null = 这个镜头就这么长,不动。
 */
function tempoSplitPoint(
  from: number,
  target: number,
  to: number,
  words: TranscriptWord[],
  peaks: PeakTrack | undefined,
  silenceThreshold: number
): number | null {
  const lo = Math.max(from + MIN_TEMPO_PIECE_SEC, target - (target - from) * TEMPO_SEARCH_FRAC);
  const hi = Math.min(to - MIN_TEMPO_PIECE_SEC, target);
  if (lo >= hi) return null;
  let best: { at: number; gap: number; density: number; dist: number } | null = null;
  for (let i = 0; i + 1 < words.length; i++) {
    const end = words[i].endSec;
    const start = words[i + 1].startSec;
    const gap = start - end;
    if (gap < MIN_TEMPO_GAP_SEC || end < lo || end > hi) continue;
    // 缝里必须真的是静音(笑声/掌声/BGM 在音频里很响,却一个词都没有)
    if (peaks && peakInRange(peaks, end, start) >= silenceThreshold) continue;
    const at = (end + start) / 2;
    // 中线越过 hi 就等于切出了超标的镜头,宁可换一条缝
    if (at > hi) continue;
    const dist = Math.abs(at - target);
    let density = 0;
    for (const x of words) {
      if (x.endSec > at - TEMPO_DENSITY_WINDOW_SEC && x.startSec < at + TEMPO_DENSITY_WINDOW_SEC) density++;
    }
    if (
      !best ||
      gap > best.gap + 1e-6 ||
      (Math.abs(gap - best.gap) <= 1e-6 &&
        (density < best.density - 1e-6 || (Math.abs(density - best.density) <= 1e-6 && dist < best.dist)))
    ) {
      best = { at, gap, density, dist };
    }
  }
  if (best) return best.at;
  if (peaks && peakInRange(peaks, hi - MIN_TEMPO_GAP_SEC, hi + MIN_TEMPO_GAP_SEC) < silenceThreshold) return hi;
  return null;
}

/** 这一刀的目标时长:中段用品类档,开场/收口按密度曲线收紧(取最严的那个)。 */
function shotCapAt(u: number, totalSec: number, baseSec: number, density?: ShotDensity): number {
  if (!density) return baseSec;
  let cap = baseSec;
  if (u < density.openSec) cap = Math.min(cap, density.openShotSec);
  if (totalSec - u < density.closeSec) cap = Math.min(cap, density.closeShotSec);
  return cap;
}

/**
 * 节奏目标:把超过目标时长的镜头在词间静音处切开,直到每一镜都不超标。
 * 音频取自同一段源、缺口为零,所以各段首尾相接,声音一个样本都不变——这是
 * 纯画面节奏的补刀(cut.ts 里多出来的片段会按奇偶吃到推进镜头)。
 * 切点必须留够 MIN_TEMPO_PIECE_SEC,以免切出碎镜头;纯函数。
 *
 * `density`(可选)是密度曲线:开场与收口的目标比中段更短——前几秒必须换过一次
 * 画面(留住人的是开场),最后几秒切得利落(循环点不拖尾巴)。`totalSec` 是成片
 * 总长估算,用来定位「最后几秒」;缺省按源段总长。
 */
export function splitLongSegments(
  segments: KeptSegment[],
  maxShotSec: number,
  words: TranscriptWord[],
  peaks?: PeakTrack,
  silenceThreshold = SILENCE_PEAK_THRESHOLD,
  density?: ShotDensity,
  totalSec?: number
): KeptSegment[] {
  if (!(maxShotSec > 0) || !Number.isFinite(maxShotSec) || segments.length === 0) return segments;
  const total = totalSec ?? segments.reduce((acc, s) => acc + (s.endSec - s.startSec), 0);
  const out: KeptSegment[] = [];
  let u = 0; // 这一刀落在成片的第几秒:决定它吃中段档还是开场/收口档
  for (const seg of segments) {
    let cursor = seg.startSec;
    // 保险丝:每段最多补这么多刀,防止病态输入(极短目标)切到天荒地老
    for (let guard = 0; guard < MAX_TEMPO_SPLITS_PER_SEGMENT; guard++) {
      const cap = shotCapAt(u, total, maxShotSec, density);
      if (seg.endSec - cursor <= cap) break;
      const at = tempoSplitPoint(cursor, cursor + cap, seg.endSec, words, peaks, silenceThreshold);
      if (at === null) break;
      out.push({ startSec: cursor, endSec: at });
      u += at - cursor;
      cursor = at;
    }
    out.push({ startSec: cursor, endSec: seg.endSec });
    u += seg.endSec - cursor;
  }
  return out;
}

/** Merge kept segments whose separating cut is too short to be worth a splice. */
export function mergeShortCuts(segments: KeptSegment[], minCutSec = MIN_CUT_SEC): KeptSegment[] {
  if (segments.length < 2) return segments;
  const out: KeptSegment[] = [{ ...segments[0] }];
  for (let i = 1; i < segments.length; i++) {
    const prev = out[out.length - 1];
    if (segments[i].startSec - prev.endSec < minCutSec) {
      prev.endSec = Math.max(prev.endSec, segments[i].endSec);
    } else {
      out.push({ ...segments[i] });
    }
  }
  return out;
}

export function computeJumpCut(
  words: TranscriptWord[],
  clipStartSec: number,
  clipEndSec: number,
  options: JumpCutOptions = {}
): JumpCutPlan {
  const { peaks, silenceThreshold = SILENCE_PEAK_THRESHOLD, forceCutSpans = [], gapThresholdSec = GAP_THRESHOLD_SEC, protectedSpans = [], breathPadSec = 0, speechSpans } = options;
  // 呼吸口加在语音尾部:剪掉的区间相应缩短,句尾多留一口气
  const padAfter = PAD_AFTER_SEC + Math.max(0, breathPadSec);
  const transitionSec = Math.max(0, options.transitionSec ?? 0);
  const inClip = words.filter((w) => w.endSec > clipStartSec && w.startSec < clipEndSec);
  if (inClip.length === 0) {
    let full: KeptSegment = { startSec: clipStartSec, endSec: clipEndSec };
    if (peaks) full = snapOuterEdgesToQuiet([full], peaks)[0];
    const durationSec = full.endSec - full.startSec;
    return {
      segments: [full], words: [], breaks: [], durationSec,
      removedSec: Math.max(0, clipEndSec - clipStartSec - durationSec),
      ...(speechSpans !== undefined ? { speechProtectedGaps: 0 } : {}),
    };
  }

  let segments: KeptSegment[] = [];
  let speechProtectedGaps = 0;
  const speechAnchors = speechSpans ? speechAnchorBounds(speechSpans, inClip) : {};
  const speechStart = speechAnchors.startSec === undefined ? Infinity : speechAnchors.startSec - 0.08;
  let segStart = Math.max(clipStartSec, Math.min(inClip[0].startSec - LEAD_IN_SEC, speechStart));
  let prevEnd = inClip[0].endSec;
  for (let i = 1; i < inClip.length; i++) {
    const w = inClip[i];
    const gap = w.startSec - prevEnd;
    if (gap > gapThresholdSec) {
      // AND gate: the removed span must be word-free AND acoustically quiet.
      const removedFrom = prevEnd + padAfter;
      const removedTo = w.startSec - PAD_BEFORE_SEC;
      const quiet =
        !peaks || removedTo <= removedFrom || peakInRange(peaks, removedFrom, removedTo) < silenceThreshold;
      // 情绪守卫:待删空隙撞上禁删区间(情绪事件 ±保护半径)就不剪
      const protectedGap = protectedSpans.some((p) => p.startSec < removedTo && p.endSec > removedFrom);
      const speechProtected = speechSpans !== undefined && hasSpeechInRange(speechSpans, removedFrom, removedTo);
      if (quiet && !protectedGap && speechProtected) speechProtectedGaps++;
      if (quiet && !protectedGap && !speechProtected) {
        segments.push({ startSec: segStart, endSec: Math.min(prevEnd + padAfter, clipEndSec) });
        segStart = Math.max(w.startSec - PAD_BEFORE_SEC, prevEnd + padAfter);
      }
    }
    prevEnd = Math.max(prevEnd, w.endSec);
  }
  const speechEnd = speechAnchors.endSec === undefined ? -Infinity : speechAnchors.endSec + 0.12;
  segments.push({ startSec: segStart, endSec: Math.min(Math.max(prevEnd + TAIL_SEC, speechEnd), clipEndSec) });
  // merge first, subtract after — a forced cut (filler ≈0.15s) must never be
  // "filled back" by the short-cut smoothing pass
  segments = mergeShortCuts(segments);
  segments = subtractSpans(segments, forceCutSpans);
  // 首尾补进真静音:尾部 TAIL_SEC 常被 clipEndSec 夹掉,末尾词就被切在半个
  // 音节上(实测尾部 452.78 切在真人声里,静音要到 452.87 才开始)
  if (peaks && segments.length > 0) segments = snapOuterEdgesToQuiet(segments, peaks);
  // 节奏补刀排在拍点吸附之前:吸附按段落起点把镜头拉回节拍上,而补出来的刀
  // 正是新镜头起点——先补刀,吸附才能把每一镜都落在节拍上。
  let longShotsSplit = 0;
  if (options.maxShotSec !== undefined && Number.isFinite(options.maxShotSec)) {
    const before = segments.length;
    // 成片总长估算:密度曲线靠它定位「最后几秒」。补刀只走硬切路径,那时
    // transitionSec 为 0,这个数就是精确值。
    const totalSec =
      segments.reduce((acc, s) => acc + (s.endSec - s.startSec), 0) -
      transitionSec * Math.max(0, segments.length - 1);
    segments = splitLongSegments(segments, options.maxShotSec, inClip, peaks, silenceThreshold, SHOT_DENSITY, totalSec);
    longShotsSplit = segments.length - before;
  }
  // Beat snap runs before the word remap below, so captions, breaks, duration
  // and the removed-time receipt all follow the snapped timeline. 判据在成片
  // 时间轴上:beat 来自 BGM 文件,而段是源片时间(见 beat.ts 头部)。
  if (options.beats && options.beats.length > 0) {
    segments = planBeatSnap(segments, options.beats, {
      maxShiftSec: options.beatMaxShiftSec ?? 0.12,
      transitionSec,
    }).segments;
  }

  const durationSec = Math.max(
    0,
    segments.reduce((acc, s) => acc + (s.endSec - s.startSec), 0) - transitionSec * Math.max(0, segments.length - 1)
  );
  // 首尾补静音会让成片比原切片略长 → 净删除量取 0 兜底(回执不能出现负数)
  const removedSec = Math.max(0, clipEndSec - clipStartSec - durationSec);

  // Remap words onto the compressed output timeline.
  const remapped: TranscriptWord[] = [];
  const breaks: number[] = [];
  let outOffset = 0;
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    if (si > 0) breaks.push(outOffset);
    for (const w of inClip) {
      if (w.startSec >= seg.startSec - 1e-6 && w.startSec < seg.endSec) {
        remapped.push({
          text: w.text,
          startSec: outOffset + (w.startSec - seg.startSec),
          endSec: outOffset + Math.min(w.endSec, seg.endSec) - seg.startSec,
          // 说话人标注跟着词走——丢了它,压缩时间轴上的字幕就没法按人上色/打标签
          ...(w.speaker !== undefined ? { speaker: w.speaker } : {}),
          ...(w.timingSource !== undefined ? { timingSource: w.timingSource } : {}),
        });
      }
    }
    outOffset += seg.endSec - seg.startSec - (si < segments.length - 1 ? transitionSec : 0);
  }
  return {
    segments, words: remapped, breaks, removedSec, durationSec,
    ...(speechSpans !== undefined ? { speechProtectedGaps } : {}),
    ...(longShotsSplit > 0 ? { longShotsSplit } : {}),
  };
}
