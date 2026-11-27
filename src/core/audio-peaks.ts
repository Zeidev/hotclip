/**
 * Per-block audio peak track — the signal layer under jump-cut decisions.
 * A word gap alone doesn't prove silence: laughter, applause, BGM stings and
 * game SFX carry no words but must survive the cut (auto-editor's insight).
 * Peaks (max |sample| per block) are cheap, and unlike RMS they catch short
 * transients that loudness averaging would smear away.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveFfmpegPath } from "./binaries";
import { ffmpegAudioStreamSpecifier } from "./probe";
import { mapToOutputTime } from "./reframe";

const execFileAsync = promisify(execFile);

const SAMPLE_RATE = 16000;
/** Peak blocks per second; fine enough to bound any 0.12s pad region. */
const BLOCKS_PER_SEC = 30;

export interface PeakTrack {
  /** Normalised peak (0..1) per block. */
  values: Float32Array;
  /** Absolute source time of the first block. */
  startSec: number;
  /** Seconds per block. */
  hopSec: number;
}

/**
 * Fold interleaved s16 PCM into per-block max|sample|/32768. Fractional
 * samples-per-block are handled with error accumulation so block boundaries
 * stay aligned with wall-clock time over long inputs (no drift).
 */
export function peaksFromPcm(samples: Int16Array, samplesPerBlock: number): Float32Array {
  if (samples.length === 0 || samplesPerBlock <= 0) return new Float32Array(0);
  const blocks: number[] = [];
  let acc = 0;
  let i = 0;
  while (i < samples.length) {
    acc += samplesPerBlock;
    const end = Math.min(samples.length, Math.round(acc));
    let peak = 0;
    for (; i < end; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    blocks.push(peak / 32768);
    if (end === samples.length) break;
  }
  return Float32Array.from(blocks);
}

/** Max peak within [fromSec, toSec] (absolute source time); 0 when outside. */
export function peakInRange(track: PeakTrack, fromSec: number, toSec: number): number {
  const first = Math.max(0, Math.floor((fromSec - track.startSec) / track.hopSec));
  const last = Math.min(track.values.length - 1, Math.ceil((toSec - track.startSec) / track.hopSec));
  let peak = 0;
  for (let i = first; i <= last; i++) {
    if (track.values[i] > peak) peak = track.values[i];
  }
  return peak;
}

/** 单点峰值(含该时刻的那一块);轨道外 = 0(调用方按「没证据」处理)。 */
export function peakAt(track: PeakTrack, atSec: number): number {
  const i = Math.floor((atSec - track.startSec) / track.hopSec);
  if (i < 0 || i >= track.values.length) return 0;
  return track.values[i];
}

/**
 * 切点必须落在真静音里。词时间戳可能是**估的**(SRT 导入、ASR 无词级时间都
 * 是按字符均分),而峰值轨是真实音频——拿它找边界,不拿时间戳赌。
 */
export const EDGE_QUIET_PEAK = 0.04;
/**
 * 「静音」要有连续长度(≈两块):33ms 单块低值可能只是塞音闭合,不是字间;
 * 再长(0.1s+)在密集的直播口语里常常一整句都找不到,切点就没得挪。
 */
export const EDGE_QUIET_RUN_SEC = 0.06;
/** 吸附最多移动这么多秒——再远就是另一个切点了,不该硬拽。 */
export const EDGE_SNAP_MAX_SEC = 0.4;

/** [atSec, atSec+runSec] 全程低于阈值且被轨道覆盖。没覆盖 ≠ 静音(没有证据)。 */
export function quietRunAt(
  track: PeakTrack,
  atSec: number,
  quietPeak = EDGE_QUIET_PEAK,
  runSec = EDGE_QUIET_RUN_SEC
): boolean {
  const trackEnd = track.startSec + track.values.length * track.hopSec;
  if (atSec < track.startSec - 1e-6 || atSec + runSec > trackEnd + 1e-6) return false;
  return peakInRange(track, atSec, atSec + runSec) <= quietPeak;
}

export interface QuietEdgeSnap {
  sec: number;
  movedSec: number;
}

export interface EdgeSnapOptions {
  /** 平手(两侧同样远)时优先哪一侧。head 往前、tail 往后 = 多留声音。 */
  bias?: "head" | "tail";
  /**
   * 只许往这一侧挪。整条片的头/尾、冷开迷你片两端用它:只会**多保留**声音,
   * 不会把已经算好的边界往里收——往里收就可能又切掉一个词。
   */
  oneWay?: "earlier" | "later";
  maxShiftSec?: number;
  quietPeak?: number;
  minQuietSec?: number;
  /**
   * 切点已经在「静音↔发声」的交界上时不动(词头/句头、词尾)。迷你片两端用它:
   * 词边界本身就该切在那里,再往静音里退只会把长停顿的死气带进开场
   * (实测句间停顿 0.43s,退到静音起点让成片头 0.33s 没声音)。
   */
  skipIfOnset?: boolean;
  /**
   * 挪进静音之后落在哪里:
   * - "quiet-start"(缺省):静音段的起点 —— 整条片的头/尾用它,能把整段停顿
   *   留在片内(切片边界本来就该包含它,剪掉只是把内容往外挪)。
   * - "speech-edge":贴着发声那一侧的边上 —— 迷你片两端用它。开场最贵的
   *   是前几秒,句间 0.43s 的停顿只该留 ~0.06s 引子,不该整段带进开场。
   */
  landing?: "quiet-start" | "speech-edge";
}

/**
 * 切点是不是刚好落在发声的边上:
 * - head:前 ~2 块静、往后一块就响(词头/句头)
 * - tail:前一块还响、往后 ~2 块静(词尾)
 */
export function isSpeechEdge(
  track: PeakTrack,
  atSec: number,
  bias: "head" | "tail",
  quietPeak = EDGE_QUIET_PEAK
): boolean {
  const hop = track.hopSec > 0 ? track.hopSec : 1 / 30;
  // 直接按块号取,不走 peakInRange:它的窗口末端是 ceil,窗口收到 atSec 之前时
  // 仍会把**含 atSec 的那一块**算进来,交界点于是被自己判成「一直在响」。
  const n = track.values.length;
  const onset = Math.floor((atSec - track.startSec) / hop);
  if (onset - 2 < 0 || onset + 1 > n - 1) return false;
  let before = 0;
  for (let i = onset - 2; i < onset; i++) if (track.values[i] > before) before = track.values[i];
  let after = 0;
  for (let i = onset; i <= onset + 1; i++) if (track.values[i] > after) after = track.values[i];
  return bias === "head" ? before <= quietPeak && after > quietPeak : before > quietPeak && after <= quietPeak;
}

/**
 * 把切点挪进最近的静音。成片开头/结尾、冷开迷你片两端都是真实切点,截在半个
 * 词上就是「开场第一声是残词」。本身已经在静音里或是干净的发声交界(传
 * skipIfOnset)→ 原样返回(movedSec = 0),好切点一个都不动;找不到静音也原样
 * 返回(没有证据就不猜)。
 */
export function snapEdgeToQuiet(track: PeakTrack, atSec: number, opts: EdgeSnapOptions = {}): QuietEdgeSnap {
  const {
    bias = "head",
    oneWay,
    maxShiftSec = EDGE_SNAP_MAX_SEC,
    quietPeak = EDGE_QUIET_PEAK,
    minQuietSec = EDGE_QUIET_RUN_SEC,
    skipIfOnset = false,
    landing = "quiet-start",
  } = opts;
  if (skipIfOnset && isSpeechEdge(track, atSec, bias, quietPeak)) return { sec: atSec, movedSec: 0 };
  const hop = track.hopSec > 0 ? track.hopSec : 1 / 30;
  const steps = Math.max(1, Math.round(maxShiftSec / hop));
  const dirs = oneWay === "earlier" ? [-1] : oneWay === "later" ? [1] : bias === "head" ? [-1, 1] : [1, -1];
  let found: number | null = quietRunAt(track, atSec, quietPeak, minQuietSec) ? atSec : null;
  outer: for (let k = 1; found === null && k <= steps; k++) {
    for (const dir of dirs) {
      const t = atSec + dir * k * hop;
      if (quietRunAt(track, t, quietPeak, minQuietSec)) {
        found = t;
        break outer;
      }
    }
  }
  if (found !== null) {
    let sec = found;
    if (landing === "speech-edge") {
      // 顺着静音往发声那一侧滑到边上(仍不越过 maxShiftSec)。词时间是估的时候,
      // 切点常落在整段停顿的深处(实测 0.33s 之外),按整段停顿留就是开场先
      // 静半秒;贴到发声边只留 ~0.06s 引子。
      const onward = bias === "head" ? 1 : -1;
      for (let next = sec + onward * hop; Math.abs(next - atSec) <= maxShiftSec + 1e-9; next += onward * hop) {
        if (!quietRunAt(track, next, quietPeak, minQuietSec)) break;
        sec = next;
      }
    }
    const out = Number(sec.toFixed(3));
    return { sec: out, movedSec: Number((out - atSec).toFixed(3)) };
  }
  return { sec: atSec, movedSec: 0 };
}

/**
 * 相对静音门:附近有多响,切点就得比它低多少倍才算真正落在字与字之间。
 * 直播口语里一整句都没有绝对静音,此时「落在 20% 电平的谷底」听不出断口,
 * 而「落在 100% 电平上」就是硬生生切掉半个音节。
 */
export function relativeQuietPeak(
  track: PeakTrack,
  atSec: number,
  opts: { windowSec?: number; ratio?: number; ceiling?: number } = {}
): number {
  const { windowSec = 0.7, ratio = 0.22, ceiling = 0.2 } = opts;
  const around = peakInRange(track, atSec - windowSec / 2, atSec + windowSec / 2);
  return Math.max(EDGE_QUIET_PEAK, Math.min(ceiling, around * ratio));
}

/**
 * 强制剪除区间(语气词/重录/拼接缝)的两端:这些边界本来取自语时间戳,估的时间
 * 戳会把邻居词的半个音节一起剪掉。切点挪到最近的静音/谷底(两侧都行,取最近的
 * 那个),阈值按区间自身的响度取相对值——密集口语里切在 20% 的谷底听不出断口。
 * 找不到证据(整段都在响)就原样保留,不猜。
 */
export function snapSpansToQuiet(
  track: PeakTrack,
  spans: Array<{ startSec: number; endSec: number }>,
  opts: { maxShiftSec?: number; minQuietSec?: number; ratio?: number; ceiling?: number } = {}
): Array<{ startSec: number; endSec: number }> {
  const { maxShiftSec = 0.25, ...rest } = opts;
  return spans
    .map((s) => {
      const quietPeak = relativeQuietPeak(track, (s.startSec + s.endSec) / 2, rest);
      return {
        startSec: snapEdgeToQuiet(track, s.startSec, { ...rest, quietPeak, bias: "head", maxShiftSec }).sec,
        endSec: snapEdgeToQuiet(track, s.endSec, { ...rest, quietPeak, bias: "tail", maxShiftSec }).sec,
      };
    })
    .filter((s) => s.endSec > s.startSec + 1e-6);
}

/** 一次峰值事件:一段连续的「显著响」区间(笑声/怒吼/掌声的声学代理)。 */
export interface PeakEvent {
  /** 事件内最响那一带的中心时刻(绝对源时间,秒)——打点/运镜强调/闪现窗用它。 */
  atSec: number;
  startSec: number;
  endSec: number;
  /** 事件峰值(0..1)。 */
  peak: number;
  /**
   * 事件「持续能量」分:块均值 × 时长(封顶 EVENT_SUSTAIN_CAP_SEC)。
   *
   * 为什么不按 peak 排:实测同一条切片的前 6 个事件的单块峰值只差 2%
   * (0.536-0.566),按它排等于掷骰子——而且 33ms 的一下爆点(口水/碰麦)
   * 单块峰值能和持续 2.5 秒的大笑齐平。谁才是「最好的那一刻」得看响了多久,
   * 不看那一下有多响。
   */
  score: number;
}

/** 相邻响块间隔小于该值时并成同一事件(笑声中间的换气不该把事件劈两半)。 */
const EVENT_MERGE_GAP_SEC = 0.35;
/** 持续能量的时长封顶:超过它以后比的是平均响度,不是「越长越像爆点」。 */
const EVENT_SUSTAIN_CAP_SEC = 2;
/** 地板永远不低于峰值这个比例:静音占比高的素材不能让底噪也成「事件」。 */
const EVENT_FLOOR_MIN_RATIO = 0.25;

/** 全轨响度水平:块峰值的 p98——个别 33ms 爆点影响不到它。 */
function loudLevel(track: PeakTrack): number {
  const n = track.values.length;
  if (n === 0) return 0;
  const sorted = Array.from(track.values).sort((a, b) => a - b);
  return sorted[Math.min(n - 1, Math.floor(n * 0.98))];
}

/**
 * 从峰值轨提取「峰值事件」:高于全轨响度水平 floorRatio 倍的块聚类成区间,
 * 按持续能量分从高到低返回前 maxEvents 个(见 PeakEvent.score——单块峰值
 * 在同一条片子里几乎拉不开差距,按它排等于随机)。全轨近静音(最高峰 <
 * minPeak)返回空——没有情绪高点可言。纯函数。
 *
 * 阈值取相对值而非绝对 dB:源素材没归一过响度,绝对阈值在小声素材上会漏、
 * 大声素材上会全命中;「相对本片的响度水平」才是稳定的情绪峰代理。
 * 水平取 p98 而不是最高块:最高块是个别 33ms 的爆点(碰麦/口水/关门)时,
 * 以它为基准会把整段真正炸得久的爆发全压在地板下——那正是要闪的那一刻。
 */
export function findPeakEvents(
  track: PeakTrack,
  options: { floorRatio?: number; maxEvents?: number; minPeak?: number } = {}
): PeakEvent[] {
  const { floorRatio = 0.75, maxEvents = 6, minPeak = 0.1 } = options;
  let maxPeak = 0;
  for (const v of track.values) if (v > maxPeak) maxPeak = v;
  if (maxPeak < minPeak) return [];
  const floor = Math.max(loudLevel(track) * floorRatio, maxPeak * EVENT_FLOOR_MIN_RATIO);

  const events: Array<Omit<PeakEvent, "score">> = [];
  let cur: Omit<PeakEvent, "score"> | null = null;
  for (let i = 0; i < track.values.length; i++) {
    const v = track.values[i];
    const t = track.startSec + i * track.hopSec;
    if (v >= floor) {
      if (cur && t - cur.endSec <= EVENT_MERGE_GAP_SEC) {
        cur.endSec = t + track.hopSec;
        if (v > cur.peak) {
          cur.peak = v;
          cur.atSec = t;
        }
      } else {
        if (cur) events.push(cur);
        cur = { atSec: t, startSec: t, endSec: t + track.hopSec, peak: v };
      }
    }
  }
  if (cur) events.push(cur);

  // 持续能量 + 中心时刻(只在这一段里算,峰值事件是稀疏的,不心疼)
  const scored = events.map((e): PeakEvent => {
    const from = Math.max(0, Math.floor((e.startSec - track.startSec) / track.hopSec));
    const to = Math.min(track.values.length, Math.ceil((e.endSec - track.startSec) / track.hopSec));
    let sum = 0;
    let blocks = 0;
    for (let i = from; i < to; i++) {
      sum += track.values[i];
      blocks++;
    }
    const mean = blocks > 0 ? sum / blocks : 0;
    const sec = blocks * track.hopSec;
    // atSec 取「最响那一带」的重心(≥90% 峰值的块),而不是随机的单个块:
    // 同响度的几块连成一片时,落在哪一块纯看浮点噪声。
    let sumT = 0;
    let n = 0;
    for (let i = from; i < to; i++) {
      if (track.values[i] >= e.peak * 0.9) {
        sumT += track.startSec + i * track.hopSec;
        n++;
      }
    }
    return { ...e, atSec: n > 0 ? sumT / n : e.atSec, score: mean * Math.min(sec, EVENT_SUSTAIN_CAP_SEC) };
  });
  return scored.sort((a, b) => b.score - a.score || b.peak - a.peak).slice(0, maxEvents);
}

/** 峰值事件的两种时间坐标:源片绝对时间(要拿它回源片切刀)与输出时间(打点)。 */
export interface PeakEventPair {
  /** 源片绝对秒——爆点闪现回源片切迷你片用它。 */
  srcSec: number;
  /** 成片输出时间轴秒——运镜强调/音效打点用它。 */
  outSec: number;
}

/**
 * 把峰值事件配成 (源时间, 输出时间)。峰值轨是**绝对源时间**(extractPeaks 的
 * 第一块就是 clipStartSec),而 mapToOutputTime 收的是**切片相对**时间——
 * 这里先减掉 clipStartSec 再映射;直接把绝对时间喂进去会多叠一次偏移,
 * 每个事件都落到所有保留段之外,成对结果恒为空(闪现从不触发)。
 * 被剪掉的空隙里的事件没有输出时间,直接丢。transitionSec 是接缝交叉淡化的长度
 * (xfade 会把成片按自身时长缩短),不传它每个接缝后面的事件都会晚 transitionSec。
 * 纯函数。
 */
export function mapPeakEvents(
  track: PeakTrack,
  segments: Array<{ startSec: number; endSec: number }> | null,
  clipStartSec: number,
  clipDurationSec: number,
  transitionSec = 0
): PeakEventPair[] {
  return mapPeakMoments(track, segments, clipStartSec, clipDurationSec, transitionSec).map(({ srcSec, outSec }) => ({
    srcSec,
    outSec,
  }));
}

/** 峰值事件连同它的持续能量分与响区间(闪现挑「最好的那一刻」要用)。 */
export interface PeakMomentPair extends PeakEventPair {
  score: number;
  /** 事件的连续响区间(源片绝对时间)。 */
  startSec: number;
  endSec: number;
  peak: number;
}

/**
 * mapPeakEvents 的完整版:除了 (源时间, 输出时间),还带上打分与响区间。
 * 排序沿用 findPeakEvents 的持续能量序(第一项就是最好的那一刻)。
 */
export function mapPeakMoments(
  track: PeakTrack,
  segments: Array<{ startSec: number; endSec: number }> | null,
  clipStartSec: number,
  clipDurationSec: number,
  transitionSec = 0
): PeakMomentPair[] {
  const pairs: PeakMomentPair[] = [];
  for (const e of findPeakEvents(track)) {
    const relSec = e.atSec - clipStartSec;
    const outSec = segments ? mapToOutputTime(relSec, segments, clipStartSec, transitionSec) : relSec;
    if (outSec === null || outSec < 0 || outSec > clipDurationSec) continue;
    pairs.push({ srcSec: e.atSec, outSec, score: e.score, startSec: e.startSec, endSec: e.endSec, peak: e.peak });
  }
  return pairs;
}

/** Decode [startSec, endSec] to mono 16k PCM and fold into a peak track. */
export async function extractPeaks(
  filePath: string,
  startSec: number,
  endSec: number,
  audioStreamIndex?: number
): Promise<PeakTrack> {
  const args = [
    "-hide_banner",
    "-ss",
    String(Math.max(0, startSec)),
    "-to",
    String(endSec),
    "-i",
    filePath,
    "-map",
    ffmpegAudioStreamSpecifier(audioStreamIndex),
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(SAMPLE_RATE),
    "-f",
    "s16le",
    "-",
  ];
  const { stdout } = await execFileAsync(resolveFfmpegPath(), args, {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  const buf = stdout as unknown as Buffer;
  const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  return {
    values: peaksFromPcm(samples, SAMPLE_RATE / BLOCKS_PER_SEC),
    startSec: Math.max(0, startSec),
    hopSec: 1 / BLOCKS_PER_SEC,
  };
}
